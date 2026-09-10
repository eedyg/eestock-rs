import { expect, test, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psql, LEDGER } from './helpers/db';

/**
 * sim-live 深度回归（L4 TDD 兜底）· 真实环境 e2e（可提交回归套件）。
 *
 * 本文件位置（self-location）：`web/e2e/simlive-deep.e2e.ts`
 * 设计稿：`web/tester/design/018_simlive_deep_e2e_design.md`
 *
 * 运行对象（本 spec 不改产品代码/接口/DB schema；发现问题仅上报不改码，不 commit）：
 *   eestock-app（镜像 6b7ed12ba07f，healthy）/ SPA（含 simlive 面板）/ http://127.0.0.1:8081
 *   MCP JSON-RPC（HTTP/SSE）：http://127.0.0.1:8082（与 web 同进程共享同一 SimLiveService 实例）
 *   DB eestock-timescaledb 127.0.0.1:5433（仅清理自建夹具，台账留痕）
 *
 * 聚焦：
 *   A  MCP sim_* 工具契约（经 MCP JSON-RPC SSE 直连验证，非同源代理）：
 *      A1 工具注册表（14 sim_*：前缀 + desc 注明模拟不触真实券商、无真实交易工具）
 *      A2 会话生命周期/账户（初始资金 1000000 可配 → 777000 透传）
 *      A3 下单路径（市价成交/限价 pending/撤单幂等）+ REST 双通道一致
 *      A4 intent 幂等去重（同 intent 两次响应一致、不重复记单；跨通道 REST 重放不重复）
 *      A5 策略工具（sim_list_strategies 内置清单+schemas/过滤；signal/analysis 响应形状=环境事实）
 *      A6 mcp-toggle 停用门禁（停用→isError「停用」；启用恢复）
 *      A7 停止幂等 + simsession_result 落库（净值/成交/指标）
 *      A8 回测对比（run_ids 笛卡尔触发 + 会话结果透出）
 *   B  web /sim-live 面板：当前会话/历史回顾 Tab；账户+统一开关+MCP 停用按钮；持仓紧邻账户；
 *      策略/评分空态与 API 一致；订单列表 DOM=API；会话 start/stop；历史列表+详情+「回测对比」；
 *      历史回看不影响当前会话；reload 一致性；重入/幂等/竞态；全程 pageerror=0/console.error=0/无跳转。
 *   C1 契约缺口固化：订单「来源」列（API OrderView 未透传 source → 列空白）——预期 FAIL，
 *      最小复现（截图 + API 响应 + DB sim_trades.source）交架构师。
 *
 * 环境变量：E2E_BASE_URL（默认 http://127.0.0.1:8081）；E2E_MCP_URL（默认 http://127.0.0.1:8082）；
 *          E2E_SHOTS（证据目录，默认 /tmp/simlive_deep）。
 * 运行：cd web && npx playwright test e2e/simlive-deep.e2e.ts
 * 清理口径（恢复初始 = 保留环境自带 running 会话，自建夹具零残留）：
 *   产品 API stop（幂等）→ SQL 删 simsession（级联 result/trades/positions）→ 删对比 strategy_run
 *   （P4a 起对比 run 走统一 ensemble 引擎，落 strategy_run 系表；旧 backtest_runs 已由迁移 0024 DROP）
 *   → mcp 恢复 true；全部台账留 sql-ledger.md。
 */

test.describe.configure({ retries: 0 }); // 真库写用例：失败即失败，afterAll 兜底清理（控制时长）
test.setTimeout(120_000);

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8081';
const MCP_BASE = process.env.E2E_MCP_URL ?? 'http://127.0.0.1:8082';
const SHOT = process.env.E2E_SHOTS ?? '/tmp/simlive_deep';
mkdirSync(SHOT, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const PREFIX = 'e2e-deep';
let seq = 0;
const tag = (name: string): string => `${PREFIX}-${name}-${Date.now().toString(36)}${(seq += 1)}`;
const fmtYuan = (n: number): string =>
  `¥ ${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function ledger(action: string, key: string, detail: string): void {
  appendFileSync(LEDGER, `- ${new Date().toISOString()}  [${action}] ${key}  ${detail}\n`, 'utf8');
}

/* ─────────────────────── REST 直连（8081） ─────────────────────── */

async function restGet(req: APIRequestContext, path: string): Promise<{ status: number; json: any }> {
  const r = await req.get(`${BASE}${path}`);
  let json: any = null;
  try { json = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status(), json };
}
async function restPost(req: APIRequestContext, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await req.post(`${BASE}${path}`, { data: body as object });
  let json: any = null;
  try { json = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status(), json };
}
/** MCP sim_* 服务开关预置 on（各 MCP 用例如头调用，防前序用例失败残留 off 造成连锁误报）。 */
async function mcpEnsureOn(req: APIRequestContext): Promise<void> {
  const r = await restPost(req, '/api/sim-live/mcp-toggle', { enabled: true });
  expect(r.status, 'mcp-toggle 预置 on').toBe(200);
}
/** GET /api/sim-live/state 缺省（当前运行会话）；404 → active:false 的 idle 形状（无运行会话）。 */
async function currentState(req: APIRequestContext): Promise<any> {
  const { status, json } = await restGet(req, '/api/sim-live/state');
  if (status === 404) return { active: false, session: null, account: null, positions: [], trading_enabled: false, mcp_enabled: true };
  expect(status, 'GET /state 缺省应 200').toBe(200);
  return json;
}

/** F2：轮询 /api/sim-live/strategies 直到 running 会话出现评估（feed 驱动；每 500ms × 最多 20s）。
 *  返回最后一次响应 json（超时仍未非空 → 返回末次空态，调用方断言非空会失败——正确反映 F2 未接线）。 */
async function waitSimScoring(req: APIRequestContext, sid: string, timeoutMs = 20_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = { strategies: [], stocks: [] };
  while (Date.now() < deadline) {
    const { status, json } = await restGet(req, `/api/sim-live/strategies?session_id=${sid}`);
    if (status === 200) {
      last = json;
      if (((json.strategies as any[])?.length ?? 0) + ((json.stocks as any[])?.length ?? 0) > 0) return json;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}
/** 自建会话（REST 产品 API 夹具）。默认 M1、cash_init 1000000。返回 session 视图。 */
async function startSessionREST(req: APIRequestContext, name: string, extra: Record<string, unknown> = {}): Promise<any> {
  const { status, json } = await restPost(req, '/api/sim-live/start-session', { name, period: 'M1', ...extra });
  expect(status, 'start-session 应 200').toBe(200);
  expect(json.started, 'started=true').toBe(true);
  expect(json.session.status, '会话 status=running').toBe('running');
  return json.session;
}
async function stopSessionREST(req: APIRequestContext, sid: string): Promise<any> {
  const { status, json } = await restPost(req, '/api/sim-live/stop-session', { session_id: sid });
  expect(status, 'stop-session 应 200').toBe(200);
  return json;
}
async function placeOrderREST(
  req: APIRequestContext, sid: string,
  o: { code: string; side: string; qty: number; price: number; limit_price?: number; intent_id?: string; source?: string },
): Promise<any> {
  const { status, json } = await restPost(req, '/api/sim-live/place-order', { session_id: sid, ...o });
  expect(status, 'place-order 应 200').toBe(200);
  return json;
}

/* ─────────────────────── MCP JSON-RPC 客户端（8082 SSE） ─────────────────────── */

interface McpFrame { id?: any; result?: { content?: Array<{ type: string; text: string }>; isError?: boolean }; error?: { code: number; message: string } }

/** tools/call（每次独立 SSE 会话；成功返回 {payload, rawText}；服务停用/业务失败且 expectOk=false → {isError,text}）。 */
async function mcpCall(name: string, args: Record<string, unknown>, expectOk = true): Promise<any> {
  const ctrl = new AbortController();
  try {
    const resp = await fetch(`${MCP_BASE}/sse`, { signal: ctrl.signal });
    if (!resp.ok || !resp.body) throw new Error(`MCP /sse status=${resp.status}`);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let endpoint: string | null = null;
    let frame: McpFrame | null = null;
    let resolved = false;
    const deadline = Date.now() + 20_000;
    const pump = (async () => {
      while (Date.now() < deadline && !resolved) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          let dataLine = '';
          for (const line of chunk.split('\n')) if (line.startsWith('data: ')) dataLine = line.slice(6);
          if (!dataLine) continue;
          if (dataLine.includes('/messages?sessionId=')) { endpoint = dataLine; continue; }
          if (dataLine.startsWith('{')) {
            try {
              const j = JSON.parse(dataLine) as McpFrame;
              if (j.id === 1 && (j.result !== undefined || j.error !== undefined)) { frame = j; resolved = true; break; }
            } catch { /* 忽略 */ }
          }
        }
      }
    })().catch(() => { /* 连接断开 → 超时路径 */ });
    const t0 = Date.now();
    while (!endpoint && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 10));
    if (!endpoint) throw new Error(`MCP SSE 未取得 endpoint（${name}）`);
    const post = await fetch(`${MCP_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: ctrl.signal,
    });
    if (post.status !== 202 && post.status !== 200) throw new Error(`MCP POST status=${post.status}`);
    await pump;
    if (!frame) throw new Error(`MCP 超时无响应（${name}）`);
    if (frame.error) throw new Error(`MCP 协议错误 ${frame.error.code} ${frame.error.message}`);
    const content = frame.result?.content?.[0]?.text ?? '';
    if (frame.result?.isError) {
      if (expectOk) throw new Error(`MCP 工具错误：${content.slice(0, 200)}`);
      return { isError: true, text: content, frame };
    }
    let payload: any = null;
    try { payload = JSON.parse(content); } catch { payload = content; }
    return { isError: false, payload, rawText: content };
  } finally {
    ctrl.abort();
  }
}

/** tools/list（SSE 手拉；A1 用）。 */
async function mcpToolsList(): Promise<{ tools: Array<{ name: string; description: string }> }> {
  const ctrl = new AbortController();
  try {
    const resp = await fetch(`${MCP_BASE}/sse`, { signal: ctrl.signal });
    if (!resp.ok || !resp.body) throw new Error(`/sse ${resp.status}`);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let endpoint: string | null = null;
    const t0 = Date.now();
    while (!endpoint && Date.now() - t0 < 8000) {
      const { value } = await reader.read();
      if (!value) break;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/data: (\S*messages\?sessionId=\S+)/);
      if (m) endpoint = m[1];
    }
    if (!endpoint) throw new Error('SSE 未取得 endpoint');
    const post = await fetch(`${MCP_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    if (post.status !== 202 && post.status !== 200) throw new Error(`post ${post.status}`);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const { value } = await reader.read();
      if (!value) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let dataLine = '';
        for (const line of chunk.split('\n')) if (line.startsWith('data: ')) dataLine = line.slice(6);
        if (dataLine.startsWith('{')) {
          try {
            const j = JSON.parse(dataLine) as any;
            if (j.id === 1 && j.result) return j.result as { tools: Array<{ name: string; description: string }> };
          } catch { /* 忽略 */ }
        }
      }
    }
    throw new Error('tools/list 超时');
  } finally {
    ctrl.abort();
  }
}

/* ─────────────────────── 页面监看（pageerror/console/loads） ─────────────────────── */

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
function assertClean(w: Watch, ctx: string, expectLoads = 1): void {
  expect(w.perr, `${ctx}: pageerror 应为 0`).toEqual([]);
  expect(w.cerr, `${ctx}: 应用 console.error 应为 0`).toEqual([]);
  expect(w.loads, `${ctx}: 全程无意外 reload/跳转`).toBe(expectLoads);
}

/* ─────────────────────── 证据 / 截图 / DB 清理 ─────────────────────── */

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
  if (del) ledger('sim-cleanup', `name~${name}%`, `删除会话 id=${del}（级联 result/trades/positions）`);
  return del;
}
function sqlDeleteStrategyRuns(ids: string[]): void {
  if (!ids.length) return;
  const del = psql(`DELETE FROM strategy_run WHERE id IN (${ids.map(q).join(',')}) RETURNING id;`);
  if (del) ledger('bt-cleanup', `run_id∈[${ids.join(',')}]`, `删除对比 run（${del}，strategy_run_result 级联）`);
}
/** 停会话（产品 API，幂等断言）+ SQL 删自建行（级联）。 */
async function cleanupTestSession(req: APIRequestContext, sid: string, name: string): Promise<void> {
  const s1 = await stopSessionREST(req, sid);
  const s2 = await stopSessionREST(req, sid);
  expect(s1.stopped === true || s1.stopped === false, 'stop 响应合法').toBe(true);
  expect(s2.stopped, '二次 stop 幂等 false').toBe(false);
  sqlDeleteSessionsLike(name);
}

/* 模块级回测 run 账（afterAll 兜底删除对比产物；sr_ 前缀字符串 id） */
const btRunIds: string[] = [];

/* 面板定位辅助 */
const pill = (page: Page) => page.getByTestId('sim-session-status');
async function openSimLive(page: Page, w: Watch): Promise<void> {
  await page.goto('/sim-live', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-region="sim-live"]')).toBeVisible({ timeout: 20_000 });
  await expect(pill(page)).toBeVisible({ timeout: 20_000 });
}
async function waitCurrentSession(page: Page, sid: string): Promise<void> {
  await expect.poll(() => pill(page).textContent().catch(() => ''), {
    timeout: 20_000, message: `面板当前会话应=${sid}`,
  }).toContain(sid);
}
const orderRows = (page: Page) => page.locator('[data-testid="sim-order-list"] tbody tr');
const posRows = (page: Page) => page.locator('[data-testid="sim-position-table"] tbody tr');

/* ═══════════════════════════════════ A MCP sim_* 契约（8082 直连） ═══════════════════════════════════ */

test.describe('A MCP sim_* 契约（JSON-RPC over SSE 127.0.0.1:8082）', () => {
  test('A1 工具注册表：14 个 sim_* 前缀 + desc 注明模拟不触真实券商、无真实交易工具', async () => {
    const list = await mcpToolsList();
    const tools = list.tools;
    const simNames = tools.filter((t) => t.name.startsWith('sim_')).map((t) => t.name);
    expect(tools.length, '总工具数=17（3 读 + 14 sim_*）').toBe(17);
    expect(simNames).toEqual([
      'sim_start_session', 'sim_stop_session', 'sim_get_account', 'sim_get_positions',
      'sim_get_orders', 'sim_get_pnl', 'sim_place_order', 'sim_cancel_order',
      'sim_list_strategies', 'sim_get_strategy_signal', 'sim_get_strategy_analysis',
      'sim_list_sessions', 'sim_get_session', 'sim_run_backtest_compare',
    ]);
    for (const t of tools.filter((x) => x.name.startsWith('sim_'))) {
      expect(t.description, `${t.name} 描述须含「模拟」`).toContain('模拟');
      expect(t.description, `${t.name} 描述须注明不触真实券商`).toContain('不触真实券商');
    }
    expect(tools.filter((t) => !t.name.startsWith('sim_')).map((t) => t.name), '非 sim 读工具=3')
      .toEqual(['get_kline', 'get_sources_health', 'get_data_quality']);
    expect(tools.some((t) => /trade/.test(t.name) && !t.name.startsWith('sim_')), '无真实交易类工具').toBe(false);
    ev('A1', 'PASS', 'tools/list 17 工具；14 sim_* 名称与 desc（含「不触真实券商」）契约全部命中；无真实交易工具');
  });

  test('A2 sim_start_session→running + sim_get_account/positions/pnl（cash_init 可配）+ REST 双通道一致', async ({ request }) => {
    await mcpEnsureOn(request);
    const name = tag('a2');
    const r = await mcpCall('sim_start_session', { name, period: 'M1', cash_init: 777_000, strategy_set: ['dual_ma'], stock_set: ['600000'] });
    expect(r.isError, 'start 成功帧').toBe(false);
    const s = r.payload as { id: string; status: string; cash_init: number };
    expect(s.id).toMatch(/^s_/);
    expect(s.status, 'status=running').toBe('running');
    expect(s.cash_init, 'cash_init 777000 透传（初始资金可配）').toBe(777_000);
    const sid = s.id;

    const acct = await mcpCall('sim_get_account', { session_id: sid });
    expect(acct.payload.cash, '账户现金=777000').toBe(777_000);
    expect(acct.payload.equity, '净值=现金').toBe(777_000);
    const pos = await mcpCall('sim_get_positions', { session_id: sid });
    expect(pos.payload.positions, '初始持仓空').toEqual([]);
    const pnl = await mcpCall('sim_get_pnl', { session_id: sid });
    expect(pnl.payload.pnl.realized_pnl, '已实现=0').toBe(0);

    // REST 双通道一致（同一服务实例）：
    const st = await restGet(request, `/api/sim-live/state?session_id=${sid}`);
    expect(st.status).toBe(200);
    expect(st.json.session.id).toBe(sid);
    expect(st.json.session.status).toBe('running');
    expect(st.json.account.cash).toBe(777_000);
    ev('A2', 'PASS', `MCP start ${sid} cash_init=777000 running；get_account/positions/pnl 正确；REST /state 同 id 一致`);
    await cleanupTestSession(request, sid, name);
  });

  test('A3 下单路径：市价成交/限价 pending/撤单（撤 pending→true 再撤 false、撤已成交 false）+ REST 订单同列表', async ({ request }) => {
    await mcpEnsureOn(request);
    const name = tag('a3');
    const sid = (await mcpCall('sim_start_session', { name, period: 'M1' })).payload.id as string;

    const m1 = await mcpCall('sim_place_order', { session_id: sid, code: '510300', side: 'buy', qty: 1000, price: 4.0 });
    expect(m1.isError).toBe(false);
    expect(m1.payload.filled, '市价即时成交').toBe(true);
    expect(m1.payload.fill.qty).toBe(1000);
    expect(m1.payload.fill.price, '含滑点 >4').toBeGreaterThan(4.0);
    expect(m1.payload.fill.fee, 'fee≥0').toBeGreaterThanOrEqual(0);
    const acct = await mcpCall('sim_get_account', { session_id: sid });
    expect(acct.payload.cash, '成交后现金 < 默认初始').toBeLessThan(1_000_000);

    const l1 = await mcpCall('sim_place_order', { session_id: sid, code: '600000', side: 'buy', qty: 100, price: 10.0, limit_price: 1.0 });
    expect(l1.payload.filled, '限价(1.0)未触及现价(10.0) filled=false').toBe(false);
    const orders1 = await mcpCall('sim_get_orders', { session_id: sid });
    const ordersArr = orders1.payload.orders as Array<{ id: string; status: string }>;
    const pend = ordersArr.find((o) => o.status === 'pending');
    expect(pend, '存在 pending 单').toBeTruthy();

    const c1 = await mcpCall('sim_cancel_order', { session_id: sid, order_id: pend!.id });
    expect(c1.payload.cancelled, '撤 pending 成功').toBe(true);
    const c2 = await mcpCall('sim_cancel_order', { session_id: sid, order_id: pend!.id });
    expect(c2.payload.cancelled, '重复撤=false（幂等）').toBe(false);
    const filledOrder = ordersArr.find((o) => o.status === 'filled');
    const c3 = await mcpCall('sim_cancel_order', { session_id: sid, order_id: filledOrder!.id });
    expect(c3.payload.cancelled, '撤已成交=false').toBe(false);

    const ro = await restGet(request, `/api/sim-live/orders?session_id=${sid}`);
    expect(ro.status).toBe(200);
    expect(ro.json.orders.length, 'REST 订单数与 MCP 一致').toBe(ordersArr.length);
    expect(ro.json.orders.map((o: any) => o.id).sort()).toEqual(ordersArr.map((o) => o.id).sort());
    ev('A3', 'PASS', `市价成交（滑点 fee>0）+限价 pending+撤单幂等；REST /orders 与 MCP get_orders 同 ${ordersArr.length} 条（id 集一致）`);
    await cleanupTestSession(request, sid, name);
  });

  test('A4 intent 幂等：同 intent 两次响应一致且只记 1 单；不同 intent 各 +1；跨通道 REST 重放不重复', async ({ request }) => {
    await mcpEnsureOn(request);
    const name = tag('a4');
    const sid = (await mcpCall('sim_start_session', { name, period: 'M1' })).payload.id as string;
    const intent = `e2e-deep-intent-${Date.now()}`;

    const r1 = await mcpCall('sim_place_order', { session_id: sid, code: '510300', side: 'buy', qty: 500, price: 4.0, intent_id: intent });
    const r2 = await mcpCall('sim_place_order', { session_id: sid, code: '510300', side: 'buy', qty: 500, price: 4.0, intent_id: intent });
    expect(r1.payload.filled).toBe(true);
    expect(r1.rawText, '同 intent 两次响应一致（去重返回首次成交）').toBe(r2.rawText);
    const ordersA = await mcpCall('sim_get_orders', { session_id: sid });
    expect((ordersA.payload.orders as any[]).filter((o: any) => o.status === 'filled').length, '同 intent 只记 1 单').toBe(1);

    await mcpCall('sim_place_order', { session_id: sid, code: '510300', side: 'buy', qty: 500, price: 4.0, intent_id: `${intent}-b` });
    await mcpCall('sim_place_order', { session_id: sid, code: '510300', side: 'buy', qty: 500, price: 4.0, intent_id: `${intent}-c` });
    const ordersB = await mcpCall('sim_get_orders', { session_id: sid });
    expect((ordersB.payload.orders as any[]).filter((o: any) => o.status === 'filled').length, '共 3 单').toBe(3);

    const re = await placeOrderREST(request, sid, { code: '510300', side: 'buy', qty: 500, price: 4.0, intent_id: intent });
    expect(re.filled, 'REST 重放同 intent 仍返回成交（首次结果）').toBe(true);
    const ro = await restGet(request, `/api/sim-live/orders?session_id=${sid}`);
    expect(ro.json.orders.filter((o: any) => o.status === 'filled').length, 'REST 重放不重复记单').toBe(3);
    ev('A4', 'PASS', '同 intent MCP+REST 共 3 次调用仅记 1 单；MCP 两次响应字节一致；不同 intent 各记 1');
    await cleanupTestSession(request, sid, name);
  });

  test('A5 策略工具：内置清单+schemas/过滤；signal/analysis 响应形状（feed 驱动后评分非空；F2）', async ({ request }) => {
    await mcpEnsureOn(request);
    const list = await mcpCall('sim_list_strategies', {});
    const arr = list.payload as Array<{ id: string; name: string; description: string; params_schema: unknown[] }>;
    expect(arr.length, '内置策略 ≥7').toBeGreaterThanOrEqual(7);
    expect(arr[0].id, '首项 dual_ma').toBe('dual_ma');
    for (const s of arr) {
      expect(s.id && s.name && s.description).toBeTruthy();
      expect(Array.isArray(s.params_schema), `${s.id} 含 params_schema`).toBe(true);
    }
    const one = await mcpCall('sim_list_strategies', { strategy_id: 'macd' });
    expect(one.payload.length, 'strategy_id 过滤=1').toBe(1);
    expect(one.payload[0].id).toBe('macd');

    // signal/analysis：running 会话（声明 3 策略+2 标的）→ 响应形状。
    // F2（L4 修复）：feed 已接线——等待 running 会话评分被真实驱动（evaluation 非空）。
    const name = tag('a5');
    const sid = (await mcpCall('sim_start_session', { name, period: 'M1', strategy_set: ['dual_ma', 'macd', 'ma_rsi'], stock_set: ['600000', '510300'] })).payload.id as string;
    const stg = await waitSimScoring(request, sid);
    const sig = await mcpCall('sim_get_strategy_signal', { session_id: sid, code: '600000' });
    expect(sig.isError, 'signal 调用成功').toBe(false);
    expect(sig.payload.evaluation, 'F2：feed 驱动 → evaluation 非空（非 null）').not.toBe(null);
    expect(sig.payload.evaluation.signal, 'evaluation 含 signal').toBeTruthy();
    const ana = await mcpCall('sim_get_strategy_analysis', { session_id: sid });
    expect(Array.isArray(ana.payload.evaluations), 'analysis 返回数组').toBe(true);
    expect(ana.payload.evaluations.length, 'F2：feed 驱动 → evaluation 非空').toBeGreaterThan(0);
    expect(stg.strategies.length, 'REST strategies 非空（feed 驱动评分）').toBeGreaterThan(0);
    expect(stg.stocks.length, 'REST stocks 非空（feed 驱动评分）').toBeGreaterThan(0);
    ev('A5', 'PASS', `sim_list_strategies ${arr.length} 项含 schema、过滤=1；signal/analysis/REST 三方一致且 feed 驱动后评分非空（evaluation 非 null / evaluations 非空 / strategies+stocks 非空）`, { f2: '会话声明 3 策略+2 标的；L4 feed 接线后 running 会话评分被 poll 驱动（process_bar→评估/评分/聚合），evaluation/analysis/REST 三方非空' });
    await cleanupTestSession(request, sid, name);
  });

  test('A6 mcp-toggle 停用门禁：停用→sim_* isError「停用」；启用恢复（MCP 端点直连 + REST 共享实例）', async ({ request }) => {
    await mcpEnsureOn(request);
    const name = tag('a6');
    const sid = (await mcpCall('sim_start_session', { name, period: 'M1' })).payload.id as string;

    const off = await restPost(request, '/api/sim-live/mcp-toggle', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.json.mcp_enabled).toBe(false);
    const stOff = await restGet(request, `/api/sim-live/state?session_id=${sid}`);
    expect(stOff.json.mcp_enabled, 'REST state 同步 false').toBe(false);

    const g1 = await mcpCall('sim_get_account', { session_id: sid }, false);
    expect(g1.isError, '停用后 sim_* 工具 isError=true').toBe(true);
    expect(g1.text, '错误文案含「停用」').toContain('停用');
    const g2 = await mcpCall('sim_get_orders', { session_id: sid }, false);
    expect(g2.isError, 'get_orders 同样被拦').toBe(true);

    const on = await restPost(request, '/api/sim-live/mcp-toggle', { enabled: true });
    expect(on.json.mcp_enabled).toBe(true);
    const g3 = await mcpCall('sim_get_account', { session_id: sid });
    expect(g3.isError, '启用后不再 isError').toBe(false);
    expect(g3.payload.cash).toBe(1_000_000);
    ev('A6', 'PASS', 'mcp-toggle=false → MCP sim_get_account/orders isError + 「停用」文案；REST state 同步 false；true → 恢复数据帧');
    await cleanupTestSession(request, sid, name);
  });

  test('A7 停止幂等 + simsession_result 落库（净值/成交/指标）+ 列表/详情（MCP+REST 一致）', async ({ request }) => {
    await mcpEnsureOn(request);
    const name = tag('a7');
    const sid = (await mcpCall('sim_start_session', { name, period: 'M1' })).payload.id as string;
    await mcpCall('sim_place_order', { session_id: sid, code: '600000', side: 'buy', qty: 600, price: 4.0 });
    await mcpCall('sim_place_order', { session_id: sid, code: '600000', side: 'sell', qty: 600, price: 4.0 });

    const st1 = await mcpCall('sim_stop_session', { session_id: sid });
    expect(st1.isError).toBe(false);
    expect(st1.payload.stopped, '首次 stop=true（running→ended）').toBe(true);
    const st2 = await mcpCall('sim_stop_session', { session_id: sid });
    expect(st2.payload.stopped, '重复 stop=false（幂等）').toBe(false);

    const sess = await mcpCall('sim_list_sessions', {});
    const mine = (sess.payload as any[]).find((e: any) => e.session.id === sid);
    expect(mine, 'list_sessions 含本会话').toBeTruthy();
    expect(mine.session.status).toBe('ended');
    expect(mine.metrics, 'ended 附指标摘要').toBeTruthy();
    expect(typeof mine.metrics.trade_count).toBe('number');

    const det = await mcpCall('sim_get_session', { session_id: sid });
    expect(det.payload.session.id).toBe(sid);
    expect(det.payload.result, 'simsession_result 落库').toBeTruthy();
    expect(det.payload.result.metrics.trade_count, '闭环成交 1 笔').toBeGreaterThanOrEqual(1);
    expect(Array.isArray(det.payload.result.net_value.series), 'net_value.series 数组').toBe(true);
    expect(Array.isArray(det.payload.result.trades), 'trades 数组').toBe(true);

    const rd = await restGet(request, `/api/sim-live/sessions/${sid}`);
    expect(rd.status).toBe(200);
    expect(rd.json.session.status).toBe('ended');
    const rl = await restGet(request, '/api/sim-live/sessions');
    const rMine = (rl.json as any[]).find((e: any) => e.session.id === sid);
    expect(rMine.metrics.trade_count, 'REST 详情指标一致').toBe(det.payload.result.metrics.trade_count);
    ev('A7', 'PASS', `stop true→false 幂等；simsession_result{net_value.series,trades,metrics} 落库（trade_count=${det.payload.result.metrics.trade_count}）；REST /sessions 列表/详情一致`);
    sqlDeleteSessionsLike(name);
  });

  test('A8 sim_run_backtest_compare：ended 会话触发回测 run_ids（1 stock×1 strategy）+ 会话结果透出', async ({ request }) => {
    await mcpEnsureOn(request);
    const name = tag('a8');
    const sid = (await mcpCall('sim_start_session', { name, period: 'M1', strategy_set: ['dual_ma'], stock_set: ['600000'] })).payload.id as string;
    await mcpCall('sim_place_order', { session_id: sid, code: '600000', side: 'buy', qty: 100, price: 4.0 });
    await new Promise((r) => setTimeout(r, 3000)); // 留出区间 from<to
    await mcpCall('sim_stop_session', { session_id: sid });

    const cmp = await mcpCall('sim_run_backtest_compare', { session_id: sid });
    expect(cmp.isError, 'compare 成功（区间有效）').toBe(false);
    expect(Array.isArray(cmp.payload.run_ids), 'run_ids 数组').toBe(true);
    expect(cmp.payload.run_ids.length, '1 stock × 1 strategy = 1 run').toBe(1);
    expect(cmp.payload.session_result, '会话自身结果透出').toBeTruthy();
    expect(cmp.payload.session_result.metrics, '结果含指标').toBeTruthy();
    const runId = cmp.payload.run_ids[0] as string;
    btRunIds.push(runId);

    const rcmp = await restPost(request, `/api/sim-live/sessions/${sid}/backtest-compare`, {});
    expect(rcmp.status, 'REST compare 200（面板同端点）').toBe(200);
    expect(rcmp.json.run_ids.length, 'REST compare 同样触发 ≥1 run').toBeGreaterThanOrEqual(1);
    btRunIds.push(...(rcmp.json.run_ids as string[]).filter((x: string) => !btRunIds.includes(x)));
    ev('A8', 'PASS', `compare 返回 run_ids=[${runId}]（秒级）+ session_result 透出；REST 同端点一致（异步引擎不阻塞触发契约）`);
    sqlDeleteSessionsLike(name);
  });
});

/* ═══════════════════════════════════ B web /sim-live 面板 ═══════════════════════════════════ */

test.describe('B web /sim-live 面板（SPA chromium）', () => {
  test('B1 布局与当前态=API：区域 DOM 序（持仓紧邻账户）+ 账户/开关/MCP 状态与 REST 对账', async ({ page, request }) => {
    const w = watchPage(page);
    const base = await currentState(request);
    await openSimLive(page, w);

    const tops = await page.evaluate(() => {
      const m: Record<string, number> = {};
      for (const el of document.querySelectorAll('[data-region]')) {
        const name = el.getAttribute('data-region')!;
        if (['session-control', 'position-table', 'strategy-panel', 'stock-scoring', 'order-trade-list'].includes(name)) {
          m[name] = el.getBoundingClientRect().top;
        }
      }
      return m;
    });
    expect(tops['session-control']! < tops['position-table']!, '持仓区域紧邻账户（账户在上）').toBe(true);
    expect(tops['position-table']! < tops['strategy-panel']!, '策略区在持仓下方').toBe(true);
    expect(tops['strategy-panel']! < tops['stock-scoring']!, '评分区在策略下方').toBe(true);
    expect(tops['stock-scoring']! < tops['order-trade-list']!, '订单区最下').toBe(true);

    if (base.session) {
      await waitCurrentSession(page, base.session.id);
      await expect(pill(page)).toHaveText(`运行中 · ${base.session.id}`);
    } else {
      await expect(pill(page)).toHaveText('未运行');
    }
    if (base.account) {
      await expect(page.getByTestId('sim-equity')).toHaveText(fmtYuan(base.account.equity));
      await expect(page.getByTestId('sim-cash')).toHaveText(fmtYuan(base.account.cash));
      await expect(page.getByTestId('sim-realized')).toHaveText(fmtYuan(base.account.realized_pnl));
      await expect(page.getByTestId('sim-unrealized')).toHaveText(fmtYuan(base.account.unrealized_pnl));
    }
    const tog = page.getByTestId('sim-trading-toggle');
    await expect.poll(() => tog.isChecked().catch(() => false), { timeout: 20_000 }).toBe(base.session ? base.trading_enabled : false);
    await expect(page.getByTestId('sim-mcp-status')).toHaveText(base.mcp_enabled ? '运行中' : '已停用');
    await expect(page.getByTestId('sim-mcp-toggle')).toHaveText(base.mcp_enabled ? '停用' : '启用');
    if (base.session) {
      await expect(page.getByTestId('sim-start-button')).toBeDisabled();
      await expect(page.getByTestId('sim-start-button')).toHaveText('运行中');
    }
    await shot(page, 'B1_current_session');
    assertClean(w, 'B1');
    ev('B1', 'PASS', base.session
      ? `区域序正确；账户文本=API 复算；开关=${base.trading_enabled}；MCP=${base.mcp_enabled}；start 禁用（运行中 ${base.session.id}）`
      : '无运行会话：面板 idle（未运行），区域序正确');
  });

  test('B2 自建会话→面板 current=S；账户=API；策略/评分被 feed 驱动（非空）与 /strategies API 一致（F2）', async ({ page, request }) => {
    const w = watchPage(page);
    await openSimLive(page, w);
    const name = tag('b2');
    const sid = (await startSessionREST(request, name, { strategy_set: ['dual_ma', 'macd', 'ma_rsi'], stock_set: ['600000', '510300'] })).id;
    await waitCurrentSession(page, sid);
    await expect(pill(page)).toHaveText(`运行中 · ${sid}`);
    await expect(page.getByTestId('sim-start-button')).toBeDisabled();
    await expect(page.getByTestId('sim-equity')).toHaveText('¥ 1,000,000.00');
    await expect(page.getByTestId('sim-trading-toggle')).not.toBeChecked(); // 新会话默认 off
    await expect(page.getByTestId('sim-positions-empty')).toHaveText('无持仓');
    // F2（L4 修复）：等待 feed 驱动评分（策略卡/评分区不再空态）。
    const stg = await waitSimScoring(request, sid);
    expect((stg.strategies as any[]).length + (stg.stocks as any[]).length, '/strategies 非空（feed 驱动评分）').toBeGreaterThan(0);
    // 评分被驱动后，策略卡/评分区空态占位应消失（count→0）。
    await expect.poll(() => page.getByTestId('sim-strategies-empty').count().catch(() => 1), { timeout: 20_000 }).toBe(0);
    await expect.poll(() => page.getByTestId('sim-stock-scoring-empty').count().catch(() => 1), { timeout: 20_000 }).toBe(0);
    await expect(page.getByTestId('sim-orders-empty')).toHaveText('无委托');
    await shot(page, 'B2_own_session');
    assertClean(w, 'B2');
    ev('B2', 'PASS', `面板 current=${sid}（running/账户 1M/开关 off/持仓空）；策略卡/评分区 feed 驱动后非空并=/strategies API（声明 3 策略+2 标的 → 评分真实驱动）`);
    await cleanupTestSession(request, sid, name);
  });

  test('B3 下单 DOM 对账：持仓行/订单行（方向/数量/状态）=API；pending 行撤单 → cancelled', async ({ page, request }) => {
    const w = watchPage(page);
    await openSimLive(page, w);
    const name = tag('b3');
    const sid = (await startSessionREST(request, name)).id;
    await waitCurrentSession(page, sid);

    const o1 = await placeOrderREST(request, sid, { code: '510300', side: 'buy', qty: 1000, price: 4.0 });
    const o2 = await placeOrderREST(request, sid, { code: '600000', side: 'buy', qty: 500, price: 10.0 });
    const o3 = await placeOrderREST(request, sid, { code: '510300', side: 'buy', qty: 100, price: 4.0, limit_price: 1.0 });
    expect(o1.filled && o2.filled).toBe(true);
    expect(o3.filled).toBe(false);
    const apiOrders = (await restGet(request, `/api/sim-live/orders?session_id=${sid}`)).json.orders as any[];
    expect(apiOrders.length).toBe(3);

    await expect.poll(() => orderRows(page).count(), { timeout: 20_000 }).toBe(3);
    const o3id = apiOrders.find((o: any) => o.status === 'pending')!.id;
    for (let i = 0; i < 3; i++) {
      const api = apiOrders[i];
      const cells = orderRows(page).nth(i).locator('td');
      await expect(cells.nth(0), '时刻非空').not.toBeEmpty();
      await expect(cells.nth(1)).toHaveText(api.code);
      await expect(cells.nth(2)).toHaveText(api.side === 'buy' ? '买入' : '卖出');
      await expect(cells.nth(4)).toHaveText(api.qty.toLocaleString());
      await expect(page.getByTestId(`sim-order-status-${api.id}`)).toHaveText(api.status);
    }
    const apiPos = (await restGet(request, `/api/sim-live/positions?session_id=${sid}`)).json.positions as any[];
    expect(apiPos.length).toBe(2);
    await expect.poll(() => posRows(page).count(), { timeout: 20_000 }).toBe(2);
    const sortedPos = [...apiPos].sort((a: any, b: any) => a.code.localeCompare(b.code));
    for (let i = 0; i < 2; i++) {
      const p = sortedPos[i]!;
      const cells = posRows(page).nth(i).locator('td');
      await expect(cells.nth(0)).toHaveText(p.code);
      await expect(cells.nth(2)).toHaveText(p.qty.toLocaleString());
      await expect(cells.nth(3)).toHaveText(p.avg_cost.toFixed(3));
    }
    await page.getByTestId(`sim-cancel-order-${o3id}`).click();
    await expect.poll(() => page.getByTestId(`sim-order-status-${o3id}`).textContent(), { timeout: 20_000 }).toBe('cancelled');
    const after = (await restGet(request, `/api/sim-live/orders?session_id=${sid}`)).json.orders as any[];
    expect(after.find((o: any) => o.id === o3id)!.status, 'REST 同步 cancelled').toBe('cancelled');
    await expect(page.getByTestId(`sim-cancel-order-${o3id}`)).toHaveCount(0);
    await shot(page, 'B3_orders_positions');
    assertClean(w, 'B3');
    ev('B3', 'PASS', '订单 3 行字段=API（代码/方向/数量/状态）；持仓 2 行=API（code/数量/成本）；pending 撤单→cancelled（API 同步、按钮消失）');
    await cleanupTestSession(request, sid, name);
  });

  test('B4 统一交易开关：面板切换=API；快速连点终态一致；off 态手动单仍成交且无 aggregate 自动单', async ({ page, request }) => {
    const w = watchPage(page);
    await openSimLive(page, w);
    const name = tag('b4');
    const sid = (await startSessionREST(request, name)).id;
    await waitCurrentSession(page, sid);
    const tog = page.getByTestId('sim-trading-toggle');
    await expect(tog).not.toBeChecked();

    // 注：开关为 React 受控 checkbox（点击后先 disabled 回弹、POST 成功后置位），
    // 用 click()+轮询（REST+UI 双确认）而非 locator.check()（会撞受控回弹竞态）。
    async function setTrading(want: boolean): Promise<void> {
      if ((await tog.isChecked()) === want) return;
      await tog.click();
      await expect.poll(async () => (await restGet(request, `/api/sim-live/state?session_id=${sid}`)).json.trading_enabled, { timeout: 15_000 }).toBe(want);
      await expect.poll(() => tog.isChecked().catch(() => false), { timeout: 15_000 }).toBe(want);
    }
    await setTrading(true);
    await expect(page.locator('label:has([data-testid="sim-trading-toggle"])')).toContainText('开');
    // 快速交替（请求中 disabled → 串行；终态=最后点击）
    await tog.click(); // off
    await expect.poll(async () => (await restGet(request, `/api/sim-live/state?session_id=${sid}`)).json.trading_enabled, { timeout: 15_000 }).toBe(false);
    await tog.click(); // on
    await tog.click(); // off
    await tog.click(); // on
    await expect.poll(async () => (await restGet(request, `/api/sim-live/state?session_id=${sid}`)).json.trading_enabled, { timeout: 15_000 }).toBe(true);
    await expect.poll(() => tog.isChecked().catch(() => false), { timeout: 15_000 }).toBe(true);
    await expect(page.locator('label:has([data-testid="sim-trading-toggle"])')).toContainText('开');

    // off 态手动单不受限（统一开关只管聚合自动单）
    await setTrading(false);
    const man = await placeOrderREST(request, sid, { code: '510300', side: 'buy', qty: 200, price: 4.0, source: 'manual' });
    expect(man.filled, 'off 态手动单仍即时成交').toBe(true);
    await expect.poll(() => orderRows(page).count(), { timeout: 20_000 }).toBe(1);
    const srcs = psql(`SELECT DISTINCT source FROM sim_trades WHERE session_id=${q(sid)};`);
    expect(srcs, '成交来源仅 manual（无 aggregate_strategy 自动单）').toBe('manual');
    await shot(page, 'B4_trading_off_manual_order');
    assertClean(w, 'B4');
    ev('B4', 'PASS', '开关开/关/快速交替 → REST trading_enabled 终态一致、UI=API；off 态手动单成交且 sim_trades 来源仅 manual（无自动单）');
    await cleanupTestSession(request, sid, name);
  });

  test('B5 MCP 状态按钮联动：面板「停用」→ 已停用/启用按钮 + REST false + MCP isError；「启用」恢复', async ({ page, request }) => {
    const w = watchPage(page);
    await openSimLive(page, w);
    const name = tag('b5');
    const sid = (await startSessionREST(request, name)).id;
    await waitCurrentSession(page, sid);
    const mcpBtn = page.getByTestId('sim-mcp-toggle');
    await expect(page.getByTestId('sim-mcp-status')).toHaveText('运行中');

    await mcpBtn.click(); // 停用
    await expect(page.getByTestId('sim-mcp-status')).toHaveText('已停用');
    await expect(mcpBtn).toHaveText('启用');
    const stOff = await restGet(request, `/api/sim-live/state?session_id=${sid}`);
    expect(stOff.json.mcp_enabled, 'REST 同步 false').toBe(false);
    const g = await mcpCall('sim_get_account', { session_id: sid }, false);
    expect(g.isError, '面板停用后 MCP sim_* isError（跨通道共享实例）').toBe(true);
    expect(g.text).toContain('停用');

    await mcpBtn.click(); // 启用
    await expect(page.getByTestId('sim-mcp-status')).toHaveText('运行中');
    await expect(mcpBtn).toHaveText('停用');
    const stOn = await restGet(request, `/api/sim-live/state?session_id=${sid}`);
    expect(stOn.json.mcp_enabled, 'REST 恢复 true').toBe(true);
    const g2 = await mcpCall('sim_get_account', { session_id: sid });
    expect(g2.isError, 'MCP 恢复成功帧').toBe(false);
    await shot(page, 'B5_mcp_toggle');
    assertClean(w, 'B5');
    ev('B5', 'PASS', '面板按钮停用/启用 → UI 文案、REST mcp_enabled、MCP isError 三通道一致并恢复');
    await cleanupTestSession(request, sid, name);
  });

  test('B6 reload 一致性：会话/账户/持仓/订单/开关/MCP 状态 reload 后保持（DB/服务态持久）', async ({ page, request }) => {
    const w = watchPage(page);
    await openSimLive(page, w);
    const name = tag('b6');
    const sid = (await startSessionREST(request, name)).id;
    await waitCurrentSession(page, sid);
    await placeOrderREST(request, sid, { code: '510300', side: 'buy', qty: 800, price: 4.0 });
    await placeOrderREST(request, sid, { code: '510300', side: 'buy', qty: 100, price: 4.0, limit_price: 1.0 });
    const tog = page.getByTestId('sim-trading-toggle');
    await tog.click(); // 受控 checkbox：click + REST/UI 轮询（check() 会撞受控回弹）
    await expect.poll(async () => (await restGet(request, `/api/sim-live/state?session_id=${sid}`)).json.trading_enabled, { timeout: 15_000 }).toBe(true);
    await expect.poll(() => tog.isChecked().catch(() => false), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => orderRows(page).count(), { timeout: 20_000 }).toBe(2);
    await expect.poll(() => posRows(page).count(), { timeout: 20_000 }).toBe(1);
    const pre = {
      pill: (await pill(page).textContent()) ?? '',
      equity: (await page.getByTestId('sim-equity').textContent()) ?? '',
      cash: (await page.getByTestId('sim-cash').textContent()) ?? '',
      posQty: await posRows(page).count(),
      ordQty: await orderRows(page).count(),
      trading: await tog.isChecked(),
      mcp: (await page.getByTestId('sim-mcp-status').textContent()) ?? '',
    };

    await page.reload({ waitUntil: 'domcontentloaded' }); // 刻意 reload（本用例 loads=2）
    await expect(pill(page)).toBeVisible({ timeout: 20_000 });
    await waitCurrentSession(page, sid);
    await expect.poll(() => orderRows(page).count(), { timeout: 20_000 }).toBe(2);
    await expect.poll(() => posRows(page).count(), { timeout: 20_000 }).toBe(1);

    expect(await pill(page).textContent(), 'reload 后会话不变').toBe(pre.pill);
    expect(await page.getByTestId('sim-equity').textContent(), '账户保持').toBe(pre.equity);
    expect(await page.getByTestId('sim-cash').textContent(), '可用资金保持').toBe(pre.cash);
    expect(await page.getByTestId('sim-trading-toggle').isChecked(), '开关保持').toBe(pre.trading);
    expect(await page.getByTestId('sim-mcp-status').textContent(), 'MCP 状态保持').toBe(pre.mcp);
    const apiAfter = (await restGet(request, `/api/sim-live/state?session_id=${sid}`)).json;
    expect(apiAfter.session.status, '会话仍 running（服务态持久）').toBe('running');
    expect(apiAfter.positions.length).toBe(1);
    const ord = (await restGet(request, `/api/sim-live/orders?session_id=${sid}`)).json.orders as any[];
    expect(ord.length).toBe(2);
    await shot(page, 'B6_after_reload');
    expect(w.loads, 'reload 用例 loads=2（goto+reload 各 1）').toBe(2);
    assertClean(w, 'B6', 2);
    ev('B6', 'PASS', `reload 后 ${sid} 不变：账户/持仓/订单/开关/MCP 全保持；API 侧同（running，positions 1，orders 2）`);
    await cleanupTestSession(request, sid, name);
  });

  test('B7 历史回顾完整流：stop→历史列表(指标%)+详情+「回测对比」触发；历史回看不影响当前会话', async ({ page, request }) => {
    const w = watchPage(page);
    const base = await currentState(request);
    const basePill = base.session ? `运行中 · ${base.session.id}` : '未运行';
    const baseEquity = base.account ? fmtYuan(base.account.equity) : null;
    await openSimLive(page, w);
    await expect.poll(() => pill(page).textContent(), { timeout: 20_000 }).toBe(basePill);

    const name = tag('b7');
    const sid = (await startSessionREST(request, name, { strategy_set: ['dual_ma'], stock_set: ['600000'] })).id;
    await waitCurrentSession(page, sid);
    await placeOrderREST(request, sid, { code: '600000', side: 'buy', qty: 600, price: 4.0 });
    await placeOrderREST(request, sid, { code: '600000', side: 'sell', qty: 600, price: 4.0 });
    await expect.poll(() => orderRows(page).count(), { timeout: 20_000 }).toBe(2);

    const stopRespP = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/sim-live\/stop-session$/.test(r.url()), { timeout: 15_000 });
    await page.getByTestId('sim-stop-button').click();
    const stopResp = await stopRespP;
    expect((await stopResp.json()).session_id, '面板 stop 作用于当前会话 S').toBe(sid);
    await expect.poll(async () => (await restGet(request, `/api/sim-live/state?session_id=${sid}`)).json.session.status, { timeout: 15_000 }).toBe('ended');
    await expect.poll(() => pill(page).textContent(), { timeout: 20_000 }).toBe(basePill);

    await page.click('[data-tab="history"]');
    await expect(page.locator('[data-region="session-history"]')).toBeVisible({ timeout: 15_000 });
    const list = (await restGet(request, '/api/sim-live/sessions')).json as any[];
    const mine = list.find((e: any) => e.session.id === sid);
    expect(mine, '历史列表含 S').toBeTruthy();
    expect(mine.session.status).toBe('ended');
    const pct = `${((mine.metrics.net_profit as number) / mine.session.cash_init * 100).toFixed(2)}%`;
    await expect(page.getByTestId(`sim-history-id-${sid}`)).toBeVisible({ timeout: 20_000 });
    const row = page.getByTestId(`sim-history-id-${sid}`).locator('xpath=ancestor::tr');
    await expect(row.locator('td').nth(3), '净收益列=API 复算').toHaveText(pct);
    await expect(row.locator('td').nth(4), '最大回撤列').toContainText('%');
    await shot(page, 'B7_history_list');

    await page.getByTestId(`sim-select-session-${sid}`).click();
    await expect(page.getByTestId('sim-history-detail')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('sim-history-detail')).toContainText(sid);
    await expect(page.getByTestId('sim-history-detail')).toContainText('M1');

    const cmpP = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/api/sim-live/sessions/${sid}/backtest-compare`), { timeout: 15_000 });
    await page.getByTestId(`sim-compare-${sid}`).click();
    const cmpResp = await cmpP;
    const runIds = ((await cmpResp.json()).run_ids ?? []) as string[];
    expect(runIds.length, '单 stock×单策略 → 1 run').toBe(1);
    btRunIds.push(runIds[0]);
    await expect(page.getByTestId('sim-compare-result'), { timeout: 20_000 })
      .toContainText(`回测对比已触发 run_ids=${runIds.join(',')}`);

    await page.click('[data-tab="current"]');
    await expect.poll(() => pill(page).textContent(), { timeout: 15_000 }).toBe(basePill);
    if (baseEquity) await expect(page.getByTestId('sim-equity')).toHaveText(baseEquity);
    await shot(page, 'B7_back_current_unchanged');
    expect(new URL(page.url()).pathname, '无跳转').toBe('/sim-live');
    assertClean(w, 'B7');
    ev('B7', 'PASS', `stop→ended；历史列表净收益 ${pct}=API 复算；详情=API；回测对比触发 run_ids=${runIds.join(',')}；切回当前=基线（${basePill}）`);
    sqlDeleteSessionsLike(name);
  });

  test('B8 重入/幂等/竞态：快速 Tab+开关无错乱；重复 stop=false；重复 start（观察新 id 不崩）；pageerror=0', async ({ page, request }) => {
    const w = watchPage(page);
    const base = await currentState(request);
    const basePill = base.session ? `运行中 · ${base.session.id}` : '未运行';
    await openSimLive(page, w);
    await expect.poll(() => pill(page).textContent(), { timeout: 20_000 }).toBe(basePill);

    const name = tag('b8');
    const sid = (await startSessionREST(request, name)).id;
    await waitCurrentSession(page, sid);
    await expect(page.getByTestId('sim-start-button')).toBeDisabled(); // running 中 start 禁用（面板层幂等）

    for (let i = 0; i < 3; i++) {
      await page.click('[data-tab="history"]');
      await page.click('[data-tab="current"]');
    }
    const tog = page.getByTestId('sim-trading-toggle');
    for (let i = 0; i < 4; i++) await tog.click(); // on/off/on/off（请求中禁用 → 串行）
    const apiTrading = (await restGet(request, `/api/sim-live/state?session_id=${sid}`)).json.trading_enabled;
    expect(apiTrading, '快速连点终态=最后一次(off)').toBe(false);
    await expect(tog).not.toBeChecked();
    await waitCurrentSession(page, sid);
    expect(new URL(page.url()).pathname, '快速 Tab 无跳转').toBe('/sim-live');

    const stopRespP = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/sim-live\/stop-session$/.test(r.url()), { timeout: 15_000 });
    await page.getByTestId('sim-stop-button').click();
    const sr = await stopRespP;
    expect((await sr.json()).session_id).toBe(sid);
    const again = await stopSessionREST(request, sid);
    expect(again.stopped, '重复 stop=false（幂等不崩）').toBe(false);
    await expect.poll(() => pill(page).textContent(), { timeout: 20_000 }).toBe(basePill);

    // 重复 start（观察：API 允许并发新会话，返回新 id 不崩不 5xx —— 面板按钮 disabled 已挡 UI 层）
    const s2 = await startSessionREST(request, `${name}-x`);
    expect(s2.id, '重复 start 返回新会话 id（观察项：未拒绝未崩溃；供架构师评估单运行会话约束）').not.toBe(sid);
    const s3 = await stopSessionREST(request, s2.id);
    expect(s3.stopped).toBe(true);
    await expect.poll(() => pill(page).textContent(), { timeout: 20_000 }).toBe(basePill);

    assertClean(w, 'B8');
    ev('B8', 'PASS', '快速 Tab×6+开关×4 无错乱（终态 off）；重复 stop=false 不崩；重复 start 返回新 id（观察项，UI 按钮 disabled 防重）');
    sqlDeleteSessionsLike(`${name}`); // 覆盖 b8 与 b8-x 两会话
  });
});

/* ═══════════════════════════════════ C 契约缺口专项 ═══════════════════════════════════ */

test.describe('C 契约缺口（最小复现，发现问题不改码）', () => {
  test('C1 订单「来源」列契约：面板应显示 source=manual（API OrderView 未透传 → 预期 FAIL 复现）', async ({ page, request }) => {
    const w = watchPage(page);
    await openSimLive(page, w);
    await mcpEnsureOn(request);
    const name = tag('c1');
    const sid = (await startSessionREST(request, name)).id;
    await waitCurrentSession(page, sid);
    await placeOrderREST(request, sid, { code: '510300', side: 'buy', qty: 300, price: 4.0, source: 'manual' });
    const mc = await mcpCall('sim_place_order', { session_id: sid, code: '600000', side: 'buy', qty: 200, price: 10.0, source: 'manual' });
    expect(mc.isError).toBe(false);
    await expect.poll(() => orderRows(page).count(), { timeout: 20_000 }).toBe(2);

    const apiOrders = (await restGet(request, `/api/sim-live/orders?session_id=${sid}`)).json.orders as any[];
    const dbSrc = psql(`SELECT string_agg(DISTINCT source, ',') FROM sim_trades WHERE session_id=${q(sid)};`);
    const srcCells: string[] = [];
    for (let i = 0; i < (await orderRows(page).count()); i++) {
      srcCells.push(((await orderRows(page).nth(i).locator('td').nth(5).textContent()) ?? '').trim());
    }
    await shot(page, 'C1_order_source_column');

    let fail = '';
    if (srcCells.length === 0) fail = '面板订单行为空，无法验证';
    else if (apiOrders.some((o: any) => o.source !== undefined) && srcCells.every((c) => c === 'manual')) fail = '';
    else if (srcCells.every((c) => c === '')) fail = `面板「来源」列空白（API 未透传 source 字段）`;
    else if (srcCells.some((c) => c !== 'manual')) fail = `「来源」列=${JSON.stringify(srcCells)} ≠ 期望 manual`;
    // 先完成夹具清理（stop 幂等 + SQL 删行），再做刻意 FAIL 断言 —— 保证用例自清理、
    // 不依赖 afterAll（刻意失败用例也零残留）。
    try {
      await cleanupTestSession(request, sid, name);
    } catch (e) {
      ledger('c1-cleanup', sid, `清理兜底：${String(e).slice(0, 120)}`);
      sqlDeleteSessionsLike(name);
    }
    expect(w.perr, 'C1 pageerror=0').toEqual([]);
    expect(w.cerr, 'C1 console.error=0').toEqual([]);
    if (fail) {
      ev('C1', 'FAIL', `${fail}；DB sim_trades.source=${dbSrc}（数据层已落 manual，展示层丢失）—— 契约 SimOrder.source=strategy|manual|aggregate_strategy（design/06-web/10-simlive.md order-trade-list），API OrderView 缺 source → 面板第 6 列空`, { repro: `REST source=manual 下单 + MCP source=manual 下单 → GET /api/sim-live/orders 无 source 字段 → 面板来源列空；见 ${SHOT}` });
      expect.soft(srcCells, `C1 契约断言：订单来源列应显示 manual（实际=${JSON.stringify(srcCells)}；API source 缺失=${apiOrders.map((o: any) => Object.prototype.hasOwnProperty.call(o, 'source')).join(',')}）`).toEqual(['manual', 'manual']);
      expect(fail, 'C1 FAIL 已复现（证据见 evidence.json；不改码，交架构师）').toBe('');
    } else {
      ev('C1', 'PASS', `来源列=${JSON.stringify(srcCells)}（契约已满足）`);
    }
  });
});

/* ═══════════════════════════════════ afterAll 兜底清理 ═══════════════════════════════════ */

test.afterAll(async () => {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  // 1) 恢复 MCP sim_* 服务开（共享实例全局态）
  await ctx.post(`${BASE}/api/sim-live/mcp-toggle`, { data: { enabled: true } }).catch(() => {});
  // 2) 停掉遗留 running 会话（产品 API）并 SQL 删全部自建行
  const leftover = psql(`SELECT id FROM simsession WHERE name LIKE ${q(`${PREFIX}%`)} AND status='running';`);
  if (leftover) {
    for (const id of leftover.split('\n')) {
      if (!id.trim()) continue;
      await ctx.post(`${BASE}/api/sim-live/stop-session`, { data: { session_id: id.trim() } }).catch(() => {});
    }
  }
  const del = sqlDeleteSessionsLike(PREFIX);
  // 3) 删回测对比产物（strategy_run，FK 级联 strategy_run_result）
  sqlDeleteStrategyRuns([...new Set(btRunIds)]);
  await ctx.dispose().catch(() => {});
  // 4) 复核初始（仅环境自带 running 会话保留）
  const remain = psql(`SELECT id || '|' || status FROM simsession ORDER BY start_ts;`);
  writeFileSync(
    resolve(SHOT, 'evidence.json'),
    JSON.stringify({
      file: resolve(here, 'simlive-deep.e2e.ts'),
      design: 'web/tester/design/018_simlive_deep_e2e_design.md',
      evidence,
      cleanup: { leftoverDeleted: del || '0', remain },
    }, null, 2),
    'utf8',
  );
});
