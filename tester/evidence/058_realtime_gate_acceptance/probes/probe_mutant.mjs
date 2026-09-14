/**
 * 反向证据探针（tester 自建）—— 变异注入后断言必须变红（鉴别力），还原后必须回绿。
 * MODE=gate ：把门控拆掉（阈值恒 15s）⇒ 非交易时段空转重连断言必须红
 * MODE=merge：把同 ts 幂等合并拆掉（同 ts 一律覆盖写）⇒ 幂等（不写/不 emit）断言必须红
 */
import { chromium } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@playwright/test/index.mjs';

const BASE = 'http://127.0.0.1:18211';
const H = (p) => `${BASE}/__h/index.html${p}`;
const MODE = process.env.MODE ?? 'gate';
const LABEL = process.env.LABEL ?? (process.env.MUTANT ? 'MUTANT' : 'PRISTINE');
const TRADING = new Date('2026-09-14T02:00:00Z');
const OFFHOURS = new Date('2026-09-12T02:00:00Z');
const checks = [];
const check = (n, ok, d) => { checks.push({ n, ok: !!ok, d }); console.log(`[${ok ? 'ok  ' : 'FAIL'}] ${LABEL} ${n} :: ${JSON.stringify(d)?.slice(0, 240)}`); };

const browser = await chromium.launch();
async function open(clock) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let conns = 0;
  page.on('websocket', () => { conns += 1; });
  await page.clock.install({ time: clock });
  await page.clock.pauseAt(clock);
  await page.goto(H('?code=518880&period=15m'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__H__?.dataLen() > 0 && window.__H__.status() === 'open', null, { timeout: 20000 });
  await page.waitForTimeout(2000);
  return { page, connsSoFar: () => conns };
}

if (MODE === 'gate') {
  // 非交易时段：15s 内不得重连
  const { page, connsSoFar } = await open(OFFHOURS);
  await page.clock.fastForward(20_000);
  await page.waitForTimeout(700);
  const s = await page.evaluate(() => ({ status: window.__H__.status(), conns: window.__H__.conns() }));
  check('非交易时段静默 20s：不得重连（门控 300s）且状态仍 open', s.conns === 1 && s.status === 'open', { wsEvents: connsSoFar(), ...s });
  // 交易时段对照：15s 必须自愈（两态对称，证明鉴别力来自门控而非"阈值太大没到"）
  const t = await open(TRADING);
  await t.page.clock.fastForward(16_000);
  await t.page.waitForTimeout(700);
  const st2 = await t.page.evaluate(() => ({ status: window.__H__.status(), conns: window.__H__.conns() }));
  check('交易时段静默 16s：必须离开 open（对照）', st2.status !== 'open', st2);
  await page.context().close(); await t.page.context().close();
} else {
  const { page } = await open(TRADING);
  const last = await page.evaluate(() => window.__H__.lastBar());
  const a = await page.evaluate(() => ({ len: window.__H__.dataLen(), rt: window.__H__.rtCount() }));
  await page.evaluate((b) => window.__H__.inject({ type: 'bar', code: window.__H__.code, period: window.__H__.period, bar: b }), last);
  await page.waitForTimeout(700);
  const b = await page.evaluate(() => ({ len: window.__H__.dataLen(), rt: window.__H__.rtCount(), close: window.__H__.lastBar()?.close }));
  check('同 ts 且 OHLCV 完全一致：不写、不 emit（长度与 rtCount 均不变）', b.len === a.len && b.rt === a.rt, { before: a, after: b });
  // 对照：同 ts 值变必须覆盖（证明鉴别力来自"值一致"分支，而非整个同 ts 分支）
  const changed = { ...last, close: (last.close ?? 1) + 0.02 };
  await page.evaluate((x) => window.__H__.inject({ type: 'bar', code: window.__H__.code, period: window.__H__.period, bar: x }), changed);
  await page.waitForTimeout(700);
  const c = await page.evaluate(() => ({ len: window.__H__.dataLen(), rt: window.__H__.rtCount(), close: window.__H__.lastBar()?.close }));
  check('同 ts 值变：必须覆盖（rtCount +1、长度不变、close 更新）（对照）', c.rt === b.rt + 1 && c.len === b.len && c.close === changed.close, { before: b, after: c });
  await page.context().close();
}
await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n[${LABEL}] checks: ${checks.length - failed.length}/${checks.length} passed; failed=${failed.map((f) => f.n).join(' | ') || 'none'}`);
