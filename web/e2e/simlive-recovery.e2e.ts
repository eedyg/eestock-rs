import { expect, test, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psql, LEDGER } from './helpers/db';

/**
 * sim-live 深度回归 · 实时落盘 + 真机容器重启恢复续跑（可提交 e2e 回归套件）。
 *
 * 本文件位置（self-location）：`web/e2e/simlive-recovery.e2e.ts`
 * 设计稿：`web/tester/design/020_simlive_recovery_e2e_design.md`
 *
 * 运行对象（本 spec 不改产品代码/接口/DB schema；发现问题仅上报不改码，不 commit）：
 *   eestock-app（镜像 4326afb96060）/ SPA（含 /sim-live 面板）/ http://127.0.0.1:8081
 *   DB eestock-timescaledb 127.0.0.1:5433（仅清理自建夹具，台账留痕）
 *   真机重启：`docker restart eestock-app`（有 docker 权限；恢复为容器 down/up）。
 *
 * 验收口径（真实/LIVE）：
 *   T1 实时落盘：start-session(带 strategies 含 params/stocks/weights) + place-order(买 510880)
 *      → DB simsession_state 有 state（cash/positions/net_value_series/strategy_configs/orders…）；
 *      feed(process_bar) 后 state 更新（updated_at 前进）。
 *   T2 重启恢复（核心·真机）：快照 A → docker restart → healthy → 会话仍 running 且被恢复：
 *      账户/持仓/PnL/策略配置与快照 A 一致；/state、/strategies、/sessions/{id} 不 500；
 *      feed 续跑（评分非空 / state 继续落盘 / 可再下单）。
 *   T3 幂等：已恢复会话二次重启不重复（无重复订单/成交/持仓、无双重扣款）。
 *   T4 无 state → ended：预置 running 会话清空 simsession_state → 重启 → ended + note（不崩）；
 *      已 ended 会话再次重启不再收敛。
 *   全程 pageerror=0 / console.error=0（重启窗口不挂页面；网络断开不产生页面错误）。
 *
 * 结构说明：真机重启用例为「单流程」串行（R0 基线后一个 test 内完成 T1→T4，含 4 次 docker
 * restart）。原因：Playwright 在用例失败后回收 worker（新进程 + 旧 worker afterAll 清理夹具），
 * 拆分多 test 会因观察项 FAIL 中断后续重启用例；单流程内用 expect.soft 记录观察项（产品发现
 * 记为 FAIL 证据）并继续收敛 T3/T4，证据在 test 内联落盘（防 afterAll 跨 worker 覆盖）。
 *
 * 环境变量：E2E_BASE_URL（默认 http://127.0.0.1:8081）；E2E_SHOTS（证据目录，默认 /tmp/simlive_recovery）。
 * 运行：cd web && npx playwright test e2e/simlive-recovery.e2e.ts --workers=1 --retries=0
 * 清理口径（恢复初始 = 基线 0 running / 0 state / ended 行数与 R0 一致）：
 *   产品 API stop（幂等）→ SQL 删 simsession（级联 state/result/trades/positions）；台账留 sql-ledger.md。
 */

test.describe.configure({ retries: 0 }); // 真机重启用例：失败即失败，绝不在重启中途自动重试；afterAll 兜底清理
test.setTimeout(600_000);

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8081';
const SHOT = process.env.E2E_SHOTS ?? '/tmp/simlive_recovery';
mkdirSync(SHOT, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const PREFIX = 'e2e-rec';
let seq = 0;
const tag = (name: string): string => `${PREFIX}-${name}-${Date.now().toString(36)}${(seq += 1)}`;
const fmtYuan = (n: number): string =>
  `¥ ${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function ledger(action: string, key: string, detail: string): void {
  appendFileSync(LEDGER, `- ${new Date().toISOString()}  [${action}] ${key}  ${detail}\n`, 'utf8');
}

/* ─────────────────────── DB 工具（复用 helpers/db psql） ─────────────────────── */

function dbStateJson(sid: string): any {
  const row = psql(`SELECT state_json::text FROM simsession_state WHERE session_id=${q(sid)};`);
  return row ? JSON.parse(row) : null;
}
function dbStateUpdatedAt(sid: string): string | null {
  return psql(`SELECT updated_at::text FROM simsession_state WHERE session_id=${q(sid)};`) || null;
}
function dbLatestClose(code: string): number {
  return Number(psql(`SELECT close FROM kline_accurate WHERE code=${q(code)} AND period='M1' ORDER BY ts DESC LIMIT 1;`));
}
function dbCount(sql: string): number {
  return Number(psql(sql));
}
function dbRunningSessionIds(): string[] {
  const rows = psql(`SELECT id FROM simsession WHERE status='running' ORDER BY start_ts;`);
  return rows ? rows.split('\n').filter(Boolean) : [];
}

/* ─────────────────────── 一致性复算工具 ─────────────────────── */

const EPS = 1e-6;
function close(a: number | undefined, b: number | undefined, eps = EPS): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Math.abs(a - b) < eps;
}
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) o[k] = canon((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}
const jsonEq = (a: unknown, b: unknown): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/* ─────────────────────── REST 工具 ─────────────────────── */

async function restGet(ctx: APIRequestContext, path: string): Promise<{ status: number; json: any }> {
  const r = await ctx.get(`${BASE}${path}`);
  let json: any = null;
  try { json = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status(), json };
}
async function restPost(ctx: APIRequestContext, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await ctx.post(`${BASE}${path}`, { data: body as object });
  let json: any = null;
  try { json = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status(), json };
}
/** 轮询 /strategies 直到该会话出现策略评估（feed 驱动；500ms × 最多 timeoutMs）。 */
async function waitSimScoring(ctx: APIRequestContext, sid: string, timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = { strategies: [], stocks: [] };
  while (Date.now() < deadline) {
    const { status, json } = await restGet(ctx, `/api/sim-live/strategies?session_id=${sid}`);
    if (status === 200) {
      last = json;
      if (((json.strategies as any[])?.length ?? 0) + ((json.stocks as any[])?.length ?? 0) > 0) return json;
    }
    await sleepMs(500);
  }
  return last;
}

/* ─────────────────────── 真机 docker 重启工具 ─────────────────────── */

interface RestartRecord {
  healthyAfterSec: number;
  recoveryLog: string;
  recovered: number | null;
  degraded: number | null;
  httpReady: boolean;
}
function dockerHealth(): string {
  try { return execSync(`docker inspect -f '{{.State.Health.Status}}' eestock-app`, { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}
function parseRecoveryLog(text: string): { recovered: number | null; degraded: number | null } {
  const lines = text.split('\n').filter((l) => l.includes('sim-live 启动恢复完成'));
  const last = lines.length ? lines[lines.length - 1]! : '';
  const rec = last.match(/"recovered":"?(\d+)"?/);
  const deg = last.match(/"degraded":"?(\d+)"?/);
  return { recovered: rec ? Number(rec[1]) : null, degraded: deg ? Number(deg[1]) : null };
}
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** docker restart eestock-app → 等 healthy → 等 HTTP 可服务；返回记录（含启动恢复日志解析）。 */
async function restartApp(): Promise<RestartRecord> {
  const t0 = Date.now();
  const before = new Date().toISOString();
  execSync('docker restart eestock-app', { stdio: 'pipe', timeout: 90_000 });
  let health = 'unknown';
  while (Date.now() - t0 < 150_000) {
    await sleepMs(1000);
    health = dockerHealth();
    if (health === 'healthy') break;
  }
  let httpReady = false;
  for (let i = 0; i < 30 && !httpReady; i++) {
    await sleepMs(1000);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${BASE}/api/sim-live/sessions`, { signal: ctrl.signal });
      clearTimeout(timer);
      httpReady = res.status < 500;
    } catch { /* 尚未就绪 */ }
  }
  let logs = '';
  try { logs = execSync(`docker logs eestock-app --since ${before} 2>&1`, { encoding: 'utf8', timeout: 15_000 }); } catch { /* 日志暂不可读 */ }
  const parsed = parseRecoveryLog(logs);
  return {
    healthyAfterSec: Math.round((Date.now() - t0) / 1000),
    recoveryLog: logs.split('\n').filter((l) => l.includes('sim-live 启动恢复完成')).join('\n').slice(0, 600),
    recovered: parsed.recovered,
    degraded: parsed.degraded,
    httpReady,
  };
}

/* ─────────────────────── 页面监看（pageerror/console） ─────────────────────── */

interface Watch { perr: string[]; cerr: string[]; netErrs: string[]; loads: number }
function watchPage(page: Page): Watch {
  const w: Watch = { perr: [], cerr: [], netErrs: [], loads: 0 };
  page.on('pageerror', (e) => w.perr.push(String(e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) w.netErrs.push(m.text().slice(0, 200));
    else w.cerr.push(m.text().slice(0, 300));
  });
  page.on('load', () => { w.loads += 1; });
  return w;
}
const pill = (page: Page) => page.getByTestId('sim-session-status');
const posRows = (page: Page) => page.locator('[data-testid="sim-position-table"] tbody tr');
async function openSimLive(page: Page): Promise<void> {
  await page.goto('/sim-live', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-region="sim-live"]')).toBeVisible({ timeout: 20_000 });
  await expect(pill(page)).toBeVisible({ timeout: 20_000 });
}

/* ─────────────────────── 证据 / 清理 ─────────────────────── */

const evidence: Array<Record<string, string>> = [];
let shotNo = 0;
async function shot(page: Page, name: string): Promise<string> {
  const p = resolve(SHOT, `${String(shotNo++).padStart(2, '0')}_${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}
function ev(caseName: string, pass: string, note: string, extra: Record<string, string> = {}): void {
  evidence.push({ case: caseName, pass, note, ...extra });
}
function sqlDeleteSessionsLike(name: string): string {
  const del = psql(`DELETE FROM simsession WHERE name LIKE ${q(`${name}%`)} RETURNING id;`);
  if (del) ledger('sim-cleanup', `name~${name}%`, `删除会话 id=${del}（级联 state/result/trades/positions）`);
  return del;
}
/** 停会话（产品 API；幂等）+ SQL 删自建行（级联）。返回删除行 id 列表。 */
async function stopAndDelete(ctx: APIRequestContext, sid: string, namePrefix: string): Promise<string> {
  await restPost(ctx, '/api/sim-live/stop-session', { session_id: sid }).catch(() => {});
  return sqlDeleteSessionsLike(namePrefix);
}
/** 硬断言 vs 软断言收口：软断言失败记入观察列表（继续执行）。 */
function softAssert(pass: boolean, label: string, detail: string, observations: string[]): void {
  expect.soft(pass, `${label}：${detail}`).toBe(true);
  if (!pass) observations.push(`${label}：${detail}`);
}

const strategyInputs = [
  { id: 'dual_ma', params: { fast: 5, slow: 20, position_pct: 1 }, stocks: ['510880'], weight: 2, stock_weights: { '510880': 1.5 } },
  { id: 'macd', params: { fast: 12, slow: 26, signal: 9 }, stocks: ['510050'], weight: 0.5, stock_weights: { '510050': 0.8 } },
];

/* ═══════════════════════════════════ R0 前置/基线 ═══════════════════════════════════ */

test('R0 前置：docker 可用 + app healthy + 基线干净（无 running/无 state/无同名残留/无内存 running）', async () => {
  const dockerOk = (() => { try { execSync('docker ps --format "{{.Names}}"', { encoding: 'utf8' }); return true; } catch { return false; } })();
  expect(dockerOk, 'docker 命令可用（需 docker 权限执行 docker restart）').toBe(true);
  const health = dockerHealth();
  expect(health, 'eestock-app 当前 healthy').toBe('healthy');
  const ctx = await pwRequest.newContext({ baseURL: BASE, timeout: 15_000 });
  // ① 兜底：停掉 DB 内遗留同名 running + 应用内存中的当前 running 会话（异常中断残留会挡 start 409）
  const leftover = psql(`SELECT id FROM simsession WHERE name LIKE ${q(`${PREFIX}%`)} AND status='running';`);
  if (leftover) {
    for (const id of leftover.split('\n')) {
      if (!id.trim()) continue;
      await restPost(ctx, '/api/sim-live/stop-session', { session_id: id.trim() }).catch(() => {});
    }
  }
  const cur = await restGet(ctx, '/api/sim-live/state');
  let hygieneRestart = false;
  if (cur.status === 200 && cur.json?.session?.id) {
    // 产品 stop 需 DB 行仍在才能完整置 ended；行已删（异常中断残留）时内存无法经 API 清理
    // → 卫生重启一次（DB 已干净，重启后内存为空），保证后续 start 不 409。
    await restPost(ctx, '/api/sim-live/stop-session', { session_id: cur.json.session.id as string }).catch(() => {});
    await sleepMs(500);
    const again = await restGet(ctx, '/api/sim-live/state');
    if (again.status !== 404) {
      hygieneRestart = true;
      const hr = await restartApp();
      ev('R0-hygiene-restart', hr.recovered === 0 && hr.degraded === 0 ? 'PASS' : 'OBSERVE',
        `清理异常中断内存残留：卫生重启 healthy ${hr.healthyAfterSec}s（DB 干净 recovered=${hr.recovered} degraded=${hr.degraded}）`);
    }
  }
  const del = sqlDeleteSessionsLike(PREFIX);
  // ② 基线复核（DB + 内存）
  const running = dbCount(`SELECT count(*) FROM simsession WHERE status='running';`);
  const stateRows = dbCount(`SELECT count(*) FROM simsession_state;`);
  expect(running, '基线：无 running 会话（单运行会话约束的前置）').toBe(0);
  expect(stateRows, '基线：simsession_state 无残留').toBe(0);
  const idle = await restGet(ctx, '/api/sim-live/state');
  expect(idle.status, '基线：应用内存无 running（/state idle 404）').toBe(404);
  await ctx.dispose().catch(() => {});
  ev('R0', 'PASS', `docker 可用、app healthy；基线 running=0 state=0、内存无 running${hygieneRestart ? '（卫生重启 1 次清理残留）' : ''}；同名残留清理=${del || '无'}`);
});

/* ═══════════════════════ 真机恢复回归（单流程：T1→T4，含 4 次 docker restart） ═══════════════════════ */

test('T1~T4 恢复回归单流程：实时落盘→重启恢复→幂等→无state降级→ended幂等（真机 4× docker restart）', async ({ page }) => {
  const observations: string[] = []; // 软断言观察项（产品不一致记录，FAIL 证据）
  const ctx0 = await pwRequest.newContext({ baseURL: BASE, timeout: 20_000 });
  const baselineEnded = dbCount(`SELECT count(*) FROM simsession WHERE status='ended';`);
  const sessionNames: string[] = []; // 自建会话名（兜底清理用）

  try {
    /* ═══════════ T1 实时落盘（无重启） ═══════════ */
    const nameA = tag('t1');
    sessionNames.push(nameA);
    const st = await restPost(ctx0, '/api/sim-live/start-session', {
      name: nameA, period: 'M1', cash_init: 1_000_000, strategies: strategyInputs,
    });
    expect(st.status, 'start-session 200').toBe(200);
    expect(st.json.started, 'started=true').toBe(true);
    const sidA = st.json.session.id as string;
    expect(sidA).toMatch(/^s_/);
    expect(st.json.session.status, 'running').toBe('running');
    expect(st.json.session.strategy_set, '派生 strategy_set').toEqual(['dual_ma', 'macd']);
    expect(st.json.session.stock_set, '派生 stock_set').toEqual(['510880', '510050']);
    const close880A = dbLatestClose('510880');
    const close050A = dbLatestClose('510050');

    const up1 = dbStateUpdatedAt(sidA);
    expect(up1, 'start 后 simsession_state 已写').not.toBeNull();
    const st1 = dbStateJson(sidA);
    expect(close(st1.cash, 1_000_000), '初始 state.cash=cash_init').toBe(true);
    expect(st1.net_value_series.length, '净值序列含初始点').toBeGreaterThanOrEqual(1);
    expect(st1.strategy_configs.length, 'strategy_configs 2 条落盘').toBe(2);

    const scored1 = await waitSimScoring(ctx0, sidA);
    expect((scored1.strategies as any[]).length + (scored1.stocks as any[]).length, 'feed 驱动 → 评分非空').toBeGreaterThan(0);
    const up2 = dbStateUpdatedAt(sidA);
    expect(new Date(up2!).getTime(), 'process_bar 后 state updated_at 前进').toBeGreaterThan(new Date(up1!).getTime());

    const po1 = await restPost(ctx0, '/api/sim-live/place-order', {
      session_id: sidA, code: '510880', side: 'buy', qty: 3000, price: close880A, source: 'manual',
    });
    expect(po1.status, 'place-order 200').toBe(200);
    expect(po1.json.filled, '市价即时成交').toBe(true);
    expect(po1.json.fill.qty, '成交数量').toBe(3000);
    const up3 = dbStateUpdatedAt(sidA);
    expect(new Date(up3!).getTime(), '下单后 state updated_at 再前进').toBeGreaterThan(new Date(up2!).getTime());

    const sv1 = await restGet(ctx0, `/api/sim-live/state?session_id=${sidA}`);
    expect(sv1.status, '/state 200').toBe(200);
    const accA = sv1.json.account as any;
    expect(close(accA.cash, 1_000_000 - 3000 * po1.json.fill.price - po1.json.fill.fee), '现金=初始−成交额−费用').toBe(true);
    expect(accA.total_fee, '费用=5').toBe(5);
    expect(sv1.json.positions.length, '持仓 1 条').toBe(1);
    expect(sv1.json.positions[0].code, '持仓 510880').toBe('510880');
    const stDbA = dbStateJson(sidA);
    expect(stDbA, 'DB simsession_state 行存在').toBeTruthy();
    expect(close(stDbA.cash, accA.cash), 'DB state.cash=账户现金').toBe(true);
    expect(stDbA.positions.length, 'DB state.positions 1 条').toBe(1);
    expect(close(stDbA.positions[0].qty, 3000), 'DB state.positions.qty=3000').toBe(true);
    expect(stDbA.orders.length, 'DB state.orders 1 条').toBe(1);
    expect(stDbA.orders[0].status, 'DB state.orders.status').toBe('Filled');
    expect(stDbA.trading_enabled, 'DB state.trading_enabled=false').toBe(false);
    const dm = stDbA.strategy_configs.find((c: any) => c.id === 'dual_ma');
    expect(dm, 'dual_ma 配置落盘').toBeTruthy();
    expect(close(dm.params.fast, 5) && close(dm.params.slow, 20), 'dual_ma params 落盘').toBe(true);
    expect(close(dm.weight, 2) && close(dm.stock_weights['510880'], 1.5), 'dual_ma weight/stock_weights 落盘').toBe(true);
    expect(JSON.stringify(dm.stocks), 'dual_ma stocks 落盘').toBe(JSON.stringify(['510880']));
    const mc = stDbA.strategy_configs.find((c: any) => c.id === 'macd');
    expect(mc, 'macd 配置落盘').toBeTruthy();
    expect(close(mc.weight, 0.5) && close(mc.stock_weights['510050'], 0.8), 'macd weight/stock_weights 落盘').toBe(true);
    const ordA = await restGet(ctx0, `/api/sim-live/orders?session_id=${sidA}`);
    const stgA = await restGet(ctx0, `/api/sim-live/strategies?session_id=${sidA}`);
    expect(ordA.json.orders.length, 'REST orders 1 条').toBe(1);
    expect(stgA.json.strategies.length, '/strategies 策略 2 条').toBe(2);
    const snapA = {
      session: sv1.json.session, account: accA, positions: sv1.json.positions, pnl: sv1.json.pnl,
      orders: ordA.json.orders, strategies: stgA.json.strategies,
      db: { cash: stDbA.cash, realized_pnl: stDbA.realized_pnl, total_fee: stDbA.total_fee, positions: stDbA.positions, net_value_series: stDbA.net_value_series, strategy_configs: stDbA.strategy_configs, orders: stDbA.orders, trading_enabled: stDbA.trading_enabled, latest_prices: stDbA.latest_prices },
      dbUpdatedAt: up3,
      trades: dbCount(`SELECT count(*) FROM sim_trades WHERE session_id=${q(sidA)};`),
      posRows: dbCount(`SELECT count(*) FROM sim_positions WHERE session_id=${q(sidA)};`),
      closes: { '510880': close880A, '510050': close050A },
    };
    expect(snapA.trades, 'sim_trades 落 1 行').toBe(1);
    expect(snapA.posRows, 'sim_positions 落 1 行').toBe(1);
    ev('T1', 'PASS', `start(2 策略含 params/stocks/weight/stock_weights)+买 510880×3000 → simsession_state 落盘完整运行态；feed process_bar 后 updated_at 前进`, { sid: sidA });

    /* ═══════════ T2 重启恢复（核心·真机，restart #1） ═══════════ */
    await ctx0.dispose().catch(() => {});
    const rr1 = await restartApp();
    expect(rr1.healthyAfterSec, 'T2 容器恢复 healthy（≤150s）').toBeLessThan(150);
    const okR1 = rr1.recovered !== null && rr1.degraded !== null && rr1.recovered >= 1 && rr1.degraded === 0;
    expect(okR1, `T2 重启日志 recovered>=1 且 degraded=0（实际 recovered=${rr1.recovered} degraded=${rr1.degraded}）`).toBe(true);
    ev('T2-docker', 'PASS', `restart#1 healthy ${rr1.healthyAfterSec}s；恢复日志 recovered=${rr1.recovered} degraded=${rr1.degraded}`, { log: rr1.recoveryLog.slice(0, 400) });

    const ctx1 = await pwRequest.newContext({ baseURL: BASE, timeout: 20_000 });
    try {
      const det1 = await restGet(ctx1, `/api/sim-live/sessions/${sidA}`);
      expect(det1.status, 'T2 GET /sessions/{id} 不 500').toBe(200);
      expect(det1.json.session.id, 'T2 会话 id 不变').toBe(sidA);
      expect(det1.json.session.status, 'T2 会话恢复且仍 running').toBe('running');
      const stt1 = await restGet(ctx1, `/api/sim-live/state?session_id=${sidA}`);
      expect(stt1.status, 'T2 GET /state 200（非“会话不存在”）').toBe(200);
      expect(stt1.json.active, 'T2 /state active=true').toBe(true);
      const stg1 = await restGet(ctx1, `/api/sim-live/strategies?session_id=${sidA}`);
      const pos1 = await restGet(ctx1, `/api/sim-live/positions?session_id=${sidA}`);
      const ord1 = await restGet(ctx1, `/api/sim-live/orders?session_id=${sidA}`);
      const pnl1 = await restGet(ctx1, `/api/sim-live/pnl?session_id=${sidA}`);
      expect([stg1.status, pos1.status, ord1.status, pnl1.status], 'T2 /strategies /positions /orders /pnl 不 500').toEqual([200, 200, 200, 200]);

      // 账户对账（hard：cash/equity/market_value/realized/total_fee；soft 观察：unrealized）
      const bAcc1 = stt1.json.account as any;
      for (const k of ['cash', 'equity', 'market_value', 'realized_pnl', 'total_fee']) {
        expect(close(accA[k], bAcc1[k]), `T2 account.${k} 与快照 A 一致`).toBe(true);
      }
      softAssert(close(accA.unrealized_pnl, bAcc1.unrealized_pnl), 'T2 观察-account.unrealized_pnl',
        `快照 A=${accA.unrealized_pnl} → 恢复后=${bAcc1.unrealized_pnl}`, observations);
      const pnlB1 = pnl1.json.pnl as any; // /pnl 端点响应 {pnl:{…}, session_id}
      expect(close(snapA.pnl.realized_pnl, pnlB1.realized_pnl), 'T2 pnl.realized_pnl 一致').toBe(true);
      expect(close(snapA.pnl.total_fee, pnlB1.total_fee), 'T2 pnl.total_fee 一致').toBe(true);
      softAssert(close(snapA.pnl.unrealized_pnl, pnlB1.unrealized_pnl), 'T2 观察-pnl.unrealized_pnl',
        `快照 A=${snapA.pnl.unrealized_pnl} → 恢复后=${pnlB1.unrealized_pnl}`, observations);
      softAssert(close(snapA.pnl.net_profit, pnlB1.net_profit), 'T2 观察-pnl.net_profit',
        `快照 A=${snapA.pnl.net_profit} → 恢复后=${pnlB1.net_profit}`, observations);

      // 持仓对账（latest 按 DB 最新 close 复算）
      const closesB: Record<string, number> = { '510880': dbLatestClose('510880'), '510050': dbLatestClose('510050') };
      const sortP = (a: any[]) => [...a].sort((x, y) => String(x.code).localeCompare(String(y.code)));
      const [pa, pb] = [sortP(snapA.positions), sortP(stt1.json.positions)];
      expect(pb.length, 'T2 持仓条数一致').toBe(pa.length);
      for (let i = 0; i < pa.length; i++) {
        const A = pa[i]!; const B = pb[i]!;
        expect(B.code, 'T2 持仓 code').toBe(A.code);
        expect(close(B.qty, A.qty) && close(B.avg_cost, A.avg_cost), `T2 持仓 ${A.code} qty/avg_cost 一致`).toBe(true);
        expect(close(B.latest, closesB[A.code] ?? 0), `T2 持仓 ${A.code} latest=DB 最新 close`).toBe(true);
        expect(close(B.market_value, B.qty * (closesB[A.code] ?? 0), 1e-3), `T2 持仓 ${A.code} market_value`).toBe(true);
        expect(close(B.unrealized_pnl, B.qty * ((closesB[A.code] ?? 0) - B.avg_cost), 1e-3), `T2 持仓 ${A.code} unrealized`).toBe(true);
      }

      // 订单一致
      expect(ord1.json.orders.length, 'T2 订单条数一致').toBe(snapA.orders.length);
      expect(JSON.stringify(canon(ord1.json.orders)), 'T2 订单集一致').toBe(JSON.stringify(canon(snapA.orders)));

      // 策略配置跨重启一致 + 评分续跑 + DB state 继续落盘
      const cfgOf = (arr: any[]) => [...arr].map((s: any) => ({ strategy_id: s.strategy_id, config: s.config }))
        .sort((x, y) => x.strategy_id.localeCompare(y.strategy_id));
      expect(cfgOf(stg1.json.strategies).length, 'T2 策略数一致').toBe(cfgOf(snapA.strategies).length);
      expect(JSON.stringify(canon(cfgOf(stg1.json.strategies))), 'T2 策略配置(含 params/stocks/weight) 一致').toBe(JSON.stringify(canon(cfgOf(snapA.strategies))));
      const scored2 = await waitSimScoring(ctx1, sidA);
      expect((scored2.strategies as any[]).length, 'T2 feed 续跑：评分非空').toBeGreaterThan(0);
      const dbB1 = dbStateJson(sidA);
      expect(dbB1, 'T2 DB state 行存在').toBeTruthy();
      expect(dbCount(`SELECT count(*) FROM simsession_state WHERE session_id=${q(sidA)};`), 'T2 state 仍 1 行（upsert 幂等）').toBe(1);
      for (const k of ['cash', 'realized_pnl', 'total_fee']) expect(jsonEq(snapA.db[k], dbB1[k]), `T2 DB state.${k} 一致`).toBe(true);
      for (const k of ['positions', 'net_value_series', 'orders', 'strategy_configs', 'latest_prices', 'trading_enabled']) {
        expect(jsonEq(snapA.db[k], dbB1[k]), `T2 DB state.${k} 一致`).toBe(true);
      }
      expect(new Date(dbStateUpdatedAt(sidA)!).getTime(), 'T2 重启后 state 继续落盘（updated_at>快照 A）')
        .toBeGreaterThan(new Date(snapA.dbUpdatedAt).getTime());

      // 恢复后可继续交易（续跑）：买 510050 ×2000
      const po2 = await restPost(ctx1, '/api/sim-live/place-order', {
        session_id: sidA, code: '510050', side: 'buy', qty: 2000, price: closesB['510050'], source: 'manual',
      });
      expect(po2.status, 'T2 恢复后 place-order 200').toBe(200);
      expect(po2.json.filled, 'T2 恢复后下单仍即时成交').toBe(true);
      const ord2 = await restGet(ctx1, `/api/sim-live/orders?session_id=${sidA}`);
      expect(ord2.json.orders.length, 'T2 订单 2 条').toBe(2);
      expect(dbCount(`SELECT count(*) FROM sim_trades WHERE session_id=${q(sidA)};`), 'T2 sim_trades 2 行').toBe(2);
      expect(dbCount(`SELECT count(*) FROM sim_positions WHERE session_id=${q(sidA)};`), 'T2 sim_positions 2 行').toBe(2);
      const stt1b = await restGet(ctx1, `/api/sim-live/state?session_id=${sidA}`);
      expect(close((stt1b.json.account as any).cash, bAcc1.cash - 2000 * po2.json.fill.price - po2.json.fill.fee), 'T2 续跑下单后现金递减').toBe(true);

      // T2 UI：恢复会话面板可见、账户=API、持仓 2 行；pageerror/cerr=0
      const w2 = watchPage(page);
      await openSimLive(page);
      await expect(pill(page)).toHaveText(`运行中 · ${sidA}`);
      await expect(page.getByTestId('sim-equity')).toHaveText(fmtYuan((stt1b.json.account as any).equity));
      await expect(posRows(page)).toHaveCount(2);
      await shot(page, 'T2_recovered_session_panel');
      expect(w2.perr, 'T2-UI pageerror=0').toEqual([]);
      expect(w2.cerr, 'T2-UI console.error=0').toEqual([]);
      expect(new URL(page.url()).pathname, 'T2 无跳转').toBe('/sim-live');

      // 快照 B（T3 幂等基准）
      const stDbB = dbStateJson(sidA);
      const snapB = {
        account: stt1b.json.account, positions: stt1b.json.positions, pnl: stt1b.json.pnl,
        orders: ord2.json.orders,
        db: { cash: stDbB.cash, realized_pnl: stDbB.realized_pnl, total_fee: stDbB.total_fee, positions: stDbB.positions, net_value_series: stDbB.net_value_series, strategy_configs: stDbB.strategy_configs, orders: stDbB.orders, trading_enabled: stDbB.trading_enabled, latest_prices: stDbB.latest_prices },
        trades: 2, posRows: 2,
      };
      const obsFail = observations.length;
      ev('T2', obsFail === 0 ? 'PASS' : 'FAIL', obsFail === 0
        ? `restart#1 recovered=${rr1.recovered} degraded=0；账户/持仓/订单/策略配置/DB state 全与快照 A 一致；feed 续跑（评分非空、updated_at 前进）且可再下单（510050×2000→orders/trades/positions=2）`
        : `restart#1 核心恢复一致（running/不 500/持仓/订单/配置/DB state），但账户级 PnL 与快照 A 不一致：${observations.slice(-3).join('；')} —— 最小复现：买 510880 持 3000 后 docker restart → /state、/pnl 的 unrealized/net_profit 翻转；DB state.latest_prices=${JSON.stringify(dbB1.latest_prices)}。交架构师裁决`, { sid: sidA });

      /* ═══════════ T3 幂等（restart #2：recovered 会话二次重启不重复） ═══════════ */
      await ctx1.dispose().catch(() => {});
      const rr2 = await restartApp();
      const okR2 = rr2.recovered !== null && rr2.degraded !== null && rr2.recovered >= 1 && rr2.degraded === 0;
      expect(okR2, `T3 二次重启 recovered>=1 degraded=0（实际 recovered=${rr2.recovered} degraded=${rr2.degraded}）`).toBe(true);
      const ctx2 = await pwRequest.newContext({ baseURL: BASE, timeout: 20_000 });
      try {
        const det2 = await restGet(ctx2, `/api/sim-live/sessions/${sidA}`);
        expect(det2.status, 'T3 /sessions/{id} 200').toBe(200);
        expect(det2.json.session.status, 'T3 仍 running').toBe('running');
        const stt2 = await restGet(ctx2, `/api/sim-live/state?session_id=${sidA}`);
        const ord3 = await restGet(ctx2, `/api/sim-live/orders?session_id=${sidA}`);
        const pnl2 = await restGet(ctx2, `/api/sim-live/pnl?session_id=${sidA}`);
        expect([stt2.status, ord3.status, pnl2.status], 'T3 端点不 500').toEqual([200, 200, 200]);
        const bAcc2 = stt2.json.account as any;
        for (const k of ['cash', 'equity', 'market_value', 'realized_pnl', 'total_fee']) {
          expect(close(snapB.account[k], bAcc2[k]), `T3 account.${k} 与快照 B 一致`).toBe(true);
        }
        softAssert(close(snapB.account.unrealized_pnl, bAcc2.unrealized_pnl), 'T3 观察-account.unrealized_pnl',
          `快照 B=${snapB.account.unrealized_pnl} → 二次重启后=${bAcc2.unrealized_pnl}`, observations);
        const pnlB2 = pnl2.json.pnl as any;
        softAssert(close(snapB.pnl.unrealized_pnl, pnlB2.unrealized_pnl), 'T3 观察-pnl.unrealized_pnl',
          `快照 B=${snapB.pnl.unrealized_pnl} → 二次重启后=${pnlB2.unrealized_pnl}`, observations);
        softAssert(close(snapB.pnl.net_profit, pnlB2.net_profit), 'T3 观察-pnl.net_profit',
          `快照 B=${snapB.pnl.net_profit} → 二次重启后=${pnlB2.net_profit}`, observations);
        // 持仓/订单对账
        const [pa2, pb2] = [sortP(snapB.positions), sortP(stt2.json.positions)];
        expect(pb2.length, 'T3 持仓条数一致').toBe(pa2.length);
        for (let i = 0; i < pa2.length; i++) {
          expect(pb2[i]!.code, 'T3 持仓 code').toBe(pa2[i]!.code);
          expect(close(pb2[i]!.qty, pa2[i]!.qty) && close(pb2[i]!.avg_cost, pa2[i]!.avg_cost), `T3 持仓 ${pa2[i]!.code} 一致`).toBe(true);
        }
        expect(JSON.stringify(canon(ord3.json.orders)), 'T3 订单集与快照 B 一致').toBe(JSON.stringify(canon(snapB.orders)));
        // 无重复
        expect(ord3.json.orders.length, 'T3 订单仍 2 条（无重复记单）').toBe(2);
        expect(dbCount(`SELECT count(*) FROM sim_trades WHERE session_id=${q(sidA)};`), 'T3 sim_trades 仍 2').toBe(2);
        expect(dbCount(`SELECT count(*) FROM sim_positions WHERE session_id=${q(sidA)};`), 'T3 sim_positions 仍 2').toBe(2);
        expect(dbCount(`SELECT count(*) FROM simsession_state WHERE session_id=${q(sidA)};`), 'T3 state 仍 1 行').toBe(1);
        expect(close(bAcc2.cash, snapB.account.cash), 'T3 cash 与快照 B 一致（无双重扣款）').toBe(true);
        const w3 = watchPage(page);
        await page.goto('/sim-live', { waitUntil: 'domcontentloaded' });
        await expect(pill(page)).toHaveText(`运行中 · ${sidA}`);
        await expect(posRows(page)).toHaveCount(2);
        await shot(page, 'T3_idempotent_restart_panel');
        expect(w3.perr, 'T3-UI pageerror=0').toEqual([]);
        expect(w3.cerr, 'T3-UI console.error=0').toEqual([]);
        const obsT3 = observations.length;
        ev('T3', obsT3 === 0 ? 'PASS' : 'FAIL', obsT3 === 0
          ? `restart#2 recovered=${rr2.recovered} degraded=${rr2.degraded}；会话 running、orders/trades/positions/state 行数与快照 B 全等（不重复）、cash 无双重扣款；account/pnl 与 B 全一致`
          : `restart#2 无重复（orders/trades/positions/state 行数不变、无双重扣款、账户 cash 一致），但账户级 PnL 与快照 B 不一致（同上根因：恢复路径用落盘 latest_prices=0 反推未实现盈亏，随持仓增加偏差累积）：${observations.slice(-3).join('；')}`, { sid: sidA, trades: '2', posRows: '2' });
      } finally {
        await ctx2.dispose().catch(() => {});
      }

      /* ═══════════ T4 无 state → ended + ended 幂等 ═══════════ */
      // 停/删 A：必须用「restart#2 之后新建」的 context（跨重启旧 ctx keep-alive 不可靠，
      // 静默失败会让 A 留在内存 → start B 409）。
      const ctxStop = await pwRequest.newContext({ baseURL: BASE, timeout: 20_000 });
      try {
        const sA1 = await restPost(ctxStop, '/api/sim-live/stop-session', { session_id: sidA });
        expect(sA1.status, 'T4 stop A 200').toBe(200);
        expect(sA1.json?.stopped === true || sA1.json?.stopped === false, 'T4 stop A 响应合法').toBe(true);
        const idlePre = await restGet(ctxStop, '/api/sim-live/state');
        if (idlePre.status === 200 && idlePre.json?.session?.id) {
          await restPost(ctxStop, '/api/sim-live/stop-session', { session_id: idlePre.json.session.id as string }).catch(() => {});
          await sleepMs(800);
        }
      } finally {
        await ctxStop.dispose().catch(() => {});
      }
      const delA = sqlDeleteSessionsLike(nameA);
      expect(delA, 'T4 A 行已删').toBeTruthy();
      expect(dbRunningSessionIds(), 'T4 前置：无 running').toEqual([]);
      expect(dbCount(`SELECT count(*) FROM simsession_state;`), 'T4 前置：state 清零').toBe(0);
      const ctxPreB = await pwRequest.newContext({ baseURL: BASE, timeout: 20_000 });
      try {
        const idlePre2 = await restGet(ctxPreB, '/api/sim-live/state');
        expect(idlePre2.status, 'T4 前置：应用无内存 running（/state idle 404）').toBe(404);
      } finally {
        await ctxPreB.dispose().catch(() => {});
      }

      // 建降级会话 B：running + 初始落盘 state → 清空其 simsession_state（模拟无运行态遗留）。
      // 注意：B 不带 strategies/stock_set（空标的 → feed_targets 自动配置为空、feed 不评估该会话），
      // 否则 feed 会在删除后 ≤5s 内再评估并重新落盘 state（删不掉），退化用例即失真。
      const nameB = tag('t4b');
      sessionNames.push(nameB);
      const ctx3 = await pwRequest.newContext({ baseURL: BASE, timeout: 20_000 });
      let sidB = '';
      try {
        const stB = await restPost(ctx3, '/api/sim-live/start-session', {
          name: nameB, period: 'M1', cash_init: 500_000,
        });
        expect(stB.status, 'T4 start B 200').toBe(200);
        expect(stB.json.session.status, 'T4 B running').toBe('running');
        sidB = stB.json.session.id as string;
        expect(dbCount(`SELECT count(*) FROM simsession_state WHERE session_id=${q(sidB)};`), 'T4 B state 行存在').toBe(1);
        const delState = psql(`DELETE FROM simsession_state WHERE session_id=${q(sidB)} RETURNING session_id;`);
        expect(delState, 'T4 清空 B 的 simsession_state').toBe(sidB);
        expect(dbCount(`SELECT count(*) FROM simsession_state WHERE session_id=${q(sidB)};`), 'T4 B state 已清空').toBe(0);
      } finally {
        await ctx3.dispose().catch(() => {});
      }

      // restart #3 → B 降级 ended + 注解
      const rr3 = await restartApp();
      const okR3 = rr3.degraded === 1 && rr3.recovered === 0;
      expect(okR3, `T4 降级重启 recovered=0 degraded=1（实际 recovered=${rr3.recovered} degraded=${rr3.degraded}）`).toBe(true);
      ev('T4-degrade-docker', rr3.degraded === 1 && rr3.recovered === 0 ? 'PASS' : 'OBSERVE',
        `restart#3 healthy ${rr3.healthyAfterSec}s；恢复日志 recovered=${rr3.recovered} degraded=${rr3.degraded}`);
      const ctx4 = await pwRequest.newContext({ baseURL: BASE, timeout: 20_000 });
      try {
        const detB = await restGet(ctx4, `/api/sim-live/sessions/${sidB}`);
        expect(detB.status, 'T4 /sessions/{idB} 200（非 500）').toBe(200);
        expect(detB.json.session.status, 'T4 B 已 ended').toBe('ended');
        expect(detB.json.result, 'T4 降级结果已落库').toBeTruthy();
        const note = JSON.stringify(detB.json.result);
        expect(note, 'T4 降级注解含「恢复降级」').toContain('恢复降级');
        expect(note, 'T4 降级注解含「中断」').toContain('中断');
        expect(detB.json.session.end_ts, 'T4 B end_ts 已置').toBeTruthy();
        const listB = await restGet(ctx4, '/api/sim-live/sessions');
        const hit = (listB.json as any[]).find((e: any) => e.session.id === sidB);
        expect(hit, 'T4 历史列表含 B').toBeTruthy();
        expect(hit.session.status, 'T4 列表 B=ended').toBe('ended');
        const idleState = await restGet(ctx4, '/api/sim-live/state');
        expect(idleState.status, 'T4 /state 缺省 404（idle，非 500）').toBe(404);
        const idleStg = await restGet(ctx4, '/api/sim-live/strategies');
        expect(idleStg.status, 'T4 /strategies 缺省 404（idle，非 500）').toBe(404);

        // restart #4 → ended 幂等（recovered=0 degraded=0）
        await ctx4.dispose().catch(() => {});
        const rr4 = await restartApp();
        ev('T4-ended-idem-docker', rr4.recovered === 0 && rr4.degraded === 0 ? 'PASS' : 'OBSERVE',
          `restart#4 healthy ${rr4.healthyAfterSec}s；恢复日志 recovered=${rr4.recovered} degraded=${rr4.degraded}`);
        const okR4 = rr4.recovered === 0 && rr4.degraded === 0;
        expect(okR4, `T4 ended 幂等重启 recovered=0 degraded=0（实际 recovered=${rr4.recovered} degraded=${rr4.degraded}）`).toBe(true);
        const ctx5 = await pwRequest.newContext({ baseURL: BASE, timeout: 20_000 });
        try {
          const detB2 = await restGet(ctx5, `/api/sim-live/sessions/${sidB}`);
          expect(detB2.status, 'T4 再重启后 /sessions/{idB} 200').toBe(200);
          expect(detB2.json.session.status, 'T4 B 仍 ended').toBe('ended');
          expect(JSON.stringify(detB2.json.result), 'T4 降级注解保持不变').toContain('恢复降级');
          const idleState2 = await restGet(ctx5, '/api/sim-live/state');
          expect(idleState2.status, 'T4 再重启后 /state 404 idle（不崩）').toBe(404);
          // UI：无运行会话面板 idle
          const w4 = watchPage(page);
          await openSimLive(page);
          await expect(pill(page)).toHaveText('未运行');
          await shot(page, 'T4_idle_no_running');
          expect(w4.perr, 'T4-UI pageerror=0').toEqual([]);
          expect(w4.cerr, 'T4-UI console.error=0').toEqual([]);
          ev('T4', 'PASS', `B(${sidB}) state 清空后 restart#3 → degraded=1 → ended + 注解（恢复降级/中断），/sessions/{idB} 200 不 500；无 running 时 /state、/strategies idle 404；restart#4 → recovered=0 degraded=0（ended 不再收敛）`, { sidB, degradedResult: note.slice(0, 200) });
        } finally {
          await ctx5.dispose().catch(() => {});
        }
        await stopAndDelete(ctx4, sidB, nameB);
      } finally {
        await ctx4.dispose().catch(() => {});
      }

      /* ═══════════ 终态复核 + 证据（test 内联落盘，防 worker 回收覆盖） ═══════════ */
      const runningAfter = dbRunningSessionIds();
      const stateAfter = dbCount(`SELECT count(*) FROM simsession_state;`);
      const endedAfter = dbCount(`SELECT count(*) FROM simsession WHERE status='ended';`);
      expect(runningAfter, '终态：无 running 残留').toEqual([]);
      expect(stateAfter, '终态：simsession_state 清零').toBe(0);
      expect(endedAfter, '终态：ended 行数回基线').toBe(baselineEnded);
      const dockerEv = execSync(`docker inspect --format '{{.State.Status}} {{.State.Health.Status}} started={{.State.StartedAt}} image={{.Image}}' eestock-app`, { encoding: 'utf8' }).trim();
      const logTail = execSync(`docker logs eestock-app --since 30m 2>&1 | grep 'sim-live 启动恢复完成' | tail -6`, { encoding: 'utf8' }).trim();
      writeFileSync(resolve(SHOT, 'evidence.json'), JSON.stringify({
        file: resolve(here, 'simlive-recovery.e2e.ts'),
        design: 'web/tester/design/020_simlive_recovery_e2e_design.md',
        env: { base: BASE, shots: SHOT, container: dockerEv },
        evidence,
        observations,
        cleanup: { deleted: `${sessionNames.length} 会话`, runningAfter, stateAfter, endedAfter, baselineEnded },
        restartLogTail: logTail,
      }, null, 2), 'utf8');
      ledger('simlive-recovery-e2e', 'flow-done', `终态 running=${runningAfter.length} state=${stateAfter} ended=${endedAfter}（基线 ${baselineEnded}）`);
    } finally {
      await ctx1.dispose().catch(() => {});
    }
  } finally {
    await ctx0.dispose().catch(() => {});
  }
});

/* ═══════════════════════════════════ afterAll 兜底清理 ═══════════════════════════════════ */

test.afterAll(async () => {
  // 若主流程硬失败中断（进程回收/异常），兜底停删夹具并补写最小证据（不覆盖主流程内联证据）。
  const ctx = await pwRequest.newContext({ baseURL: BASE, timeout: 20_000 });
  const leftover = psql(`SELECT id FROM simsession WHERE name LIKE ${q(`${PREFIX}%`)} AND status='running';`);
  if (leftover) {
    for (const id of leftover.split('\n')) {
      if (!id.trim()) continue;
      await restPost(ctx, '/api/sim-live/stop-session', { session_id: id.trim() }).catch(() => {});
    }
  }
  const del = sqlDeleteSessionsLike(PREFIX);
  await ctx.dispose().catch(() => {});
  const runningAfter = dbRunningSessionIds().length;
  const stateAfter = dbCount(`SELECT count(*) FROM simsession_state;`);
  appendFileSync(LEDGER, `- ${new Date().toISOString()}  [simlive-recovery-e2e] afterAll 清理 running=${runningAfter} state=${stateAfter} deleted=${del || '0'}\n`, 'utf8');
  const evFile = resolve(SHOT, 'evidence.json');
  if (!existsSync(evFile)) {
    writeFileSync(evFile, JSON.stringify({ file: resolve(here, 'simlive-recovery.e2e.ts'), note: '主流程未完成证据内联落盘（可能硬失败中断）', evidence, cleanup: { deleted: del || '0', runningAfter, stateAfter } }, null, 2), 'utf8');
  }
});
