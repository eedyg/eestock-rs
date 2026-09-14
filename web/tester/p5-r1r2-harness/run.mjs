/**
 * P5-F-1 R1/R2：**真渲染几何**红测试 runner（chromium + 真实产品组件 + 真鼠标拖拽）。
 *
 * 本文件位置：`web/tester/p5-r1r2-harness/run.mjs`
 * 页面：`web/tester/p5-r1r2-harness/index.html`（先 `vite build` 到临时目录，再由本地随机端口静态服务）
 * 运行（须在 `web/` 下）：`node tester/p5-r1r2-harness/run.mjs`
 *
 * 性质：**只读 + 页面内桩**。合成数据 + 本地随机端口 + 桩「PUT」（页面内）⇒ **0 出网、0 写请求**；
 * 不触碰线上 8081/8082（不重启 PID）。
 *
 * 判据（当前实现预期红；修（架构裁决 2026-09-15：① 基线取载荷域内值 / ② 基准为余量吸收项 /
 * ③ 依赖完整性）后必须转绿）：
 *  - HY：卫生（0 非本地请求、0 真实写、0 pageerror）+ 栈/pane 契约存在（判据可测前提）；
 *  - R1-G1：600px、父层回执只改卫星高度 ⇒ 拖拽回弹（拖中 ≠ 回执后）；
 *  - R1-G2：连续第二次「卫星↔卫星」拖拽 ⇒ 同上；
 *  - R1-G3：父层只改卫星高度（无拖拽）⇒ 渲染必须采用回执值（依赖完整性）；
 *  - R2-G1：越域（1800px）连续同向 ≥1px 拖拽 ⇒ 载荷每次都变化（无死区）；
 *  - R2-G2：越域 + 以**真实服务端值**重载 ⇒ 屏幕不得跳变（实测 20px）、屏幕-载荷偏差 ≤61px（记录）。
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';
const REPO = '/home/eestock/workspace/git/eestock/eestock-rs';
const HERE = path.join(WEB, 'tester', 'p5-r1r2-harness');
const require = createRequire(WEB + '/package.json');
const { chromium } = require('playwright');

const outDir = process.env.P5_HARNESS_OUT ?? path.join(REPO, 'tester', 'evidence', '279_p5f1_r1r2_red');
const dist = process.env.P5_HARNESS_DIST ?? '/tmp/p5-r1r2-dist';

// ── 1) 构建（真实产品组件 + 真实 Tailwind）────────────────────────────────────
fs.rmSync(dist, { recursive: true, force: true });
const build = spawnSync(
  path.join(WEB, 'node_modules/.bin/vite'),
  ['build', '--config', path.join(HERE, 'vite.config.mjs')],
  { cwd: WEB, encoding: 'utf8', env: { ...process.env, P5_HARNESS_DIST: dist } },
);
if (build.status !== 0) {
  console.error(build.stdout ?? '');
  console.error(build.stderr ?? '');
  throw new Error(`harness 构建失败（exit ${build.status}）`);
}

// ── 2) 本地随机端口静态服务（仅本机；结束即关闭）─────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = path.join(dist, decodeURIComponent(u.pathname));
  if (u.pathname === '/') p = path.join(dist, 'index.html');
  fs.readFile(p, (e, b) => {
    if (e) {
      res.statusCode = 404;
      res.end('nf');
      return;
    }
    res.setHeader('content-type', MIME[path.extname(p)] ?? 'application/octet-stream');
    res.end(b);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const ORIGIN = `http://127.0.0.1:${port}/`;

// ── 3) 浏览器 + 页面辅助 ──────────────────────────────────────────────────────
const browser = await chromium.launch();
const consoleMsgs = [];
const externalRequests = [];
const checks = [];
const raw = {};

function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

async function open({ avail, serverHeights }) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: Math.max(900, avail + 360) },
    deviceScaleFactor: 1,
  });
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(ORIGIN)) externalRequests.push({ url: u, method: r.method() });
  });
  const q = new URLSearchParams({ avail: String(avail) });
  if (serverHeights) q.set('server', JSON.stringify(serverHeights));
  await page.goto(`${ORIGIN}?${q.toString()}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.__r1r2 && document.querySelector('[data-mp-stack]')), null, {
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => {
      const h = window.__r1r2.domHeights();
      const keys = Object.keys(h);
      return keys.length === 4 && keys.every((k) => h[k] > 0);
    },
    null,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(1200); // 卫星实例/同步组稳定
  return page;
}

const dom = (page) => page.evaluate(() => window.__r1r2.domHeights());
const payloads = (page) => page.evaluate(() => window.__r1r2.payloads());
const declared = (page) => page.evaluate(() => window.__r1r2.declaredHeights());

/** 真鼠标拖拽：mousedown(分隔条) → mousemove(+dy) → 读「拖中」→ mouseup → 等防抖+回执 → 读「拖后」。 */
async function drag(page, key, dy) {
  const pt = await page.evaluate((k) => window.__r1r2.sepPoint(k), key);
  if (!pt) throw new Error(`缺少分隔条 ${key}`);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.move(pt.x, pt.y + dy, { steps: 8 });
  const during = await dom(page);
  await page.mouse.up();
  await page.waitForTimeout(800); // ≥ DRAG_DEBOUNCE_MS(300) + 回执 settle
  const after = await dom(page);
  return { during, after };
}

const PERIODS = ['15m', '1h', '5m', '1d'];
const maxAbs = (a, b) => Math.max(...PERIODS.map((p) => Math.abs((a[p] ?? 0) - (b[p] ?? 0))));
const sumOf = (h) => PERIODS.reduce((acc, p) => acc + (h[p] ?? 0), 0);
const eqMsg = (a, b) => `A=${JSON.stringify(a)} B=${JSON.stringify(b)}`;

// ── 4) 场景 A：600px —— R1（父层回执只改卫星高度 ⇒ 回弹）────────────────────────
// 「服务端配置」= 当前持久化布局（Σ=600）：这是 reload 后的真实状态，也是回执只改卫星高度的前提。
const PERSISTED_600 = { '15m': 294, '1h': 97, '5m': 97, '1d': 112 };
{
  const page = await open({ avail: 600, serverHeights: PERSISTED_600 });
  const initial = await dom(page);
  raw.R1_initial = initial;
  check(
    'R1-G0 前置：服务端配置（持久化布局）⇒ 逐值渲染（±1px）',
    maxAbs(initial, PERSISTED_600) <= 1,
    eqMsg(initial, PERSISTED_600),
  );

  const s1 = await drag(page, '1h|5m', 15);
  raw.R1_drag1 = s1;
  const adopted1 = maxAbs(s1.after, s1.during) <= 1;
  check(
    'R1-G1 父层回执只改卫星高度 ⇒ 拖中与回执后必须一致（600px；P5 验收实测 during{294,112,82,112} → after{294,97,97,112} 回弹）',
    adopted1,
    `拖中=${JSON.stringify(s1.during)} 回执后=${JSON.stringify(s1.after)} 差=${maxAbs(s1.during, s1.after)}px`,
  );

  const s2 = await drag(page, '5m|1d', 10);
  raw.R1_drag2 = s2;
  check(
    'R1-G2 连续第二次「卫星↔卫星」拖拽 ⇒ 拖中与回执后必须一致（不得回弹到请求前分配）',
    maxAbs(s2.after, s2.during) <= 1,
    `拖中=${JSON.stringify(s2.during)} 回执后=${JSON.stringify(s2.after)} 差=${maxAbs(s2.during, s2.after)}px`,
  );

  // 依赖完整性：父层**只改卫星高度**（无拖拽）⇒ 渲染必须采用回执值
  //
  // ⚠️ **期望值推导（修正算术错误 + 加强判据，架构裁决 2026-09-15 显式授权）**：
  // 本探针的 `setHeights({1h:112, 5m:82})` 是**合并**进父层当前 props（= 两次拖拽后的载荷
  // `{15m:294,1h:112,5m:92,1d:102}`）⇒ 请求变为 `{15m:294,1h:112,5m:82,1d:102}`，**Σ请求 = 590 < 可用 600**。
  // 按 02-spec §6.1「D ≤ H ⇒ 按配置 px 直用，**余量由分配算法吸收**」+ 裁决 ②（`fit` 模式下基准 =
  // **余量吸收项** = 可用 − Σ卫星）⇒ 基准 = 600 − (112+82+102) = **304**（**不是**回执前的屏幕值 294）。
  // ⇒ 期望**不得**写成 `{...before, 1h:112, 5m:82}`：那是「旧屏幕基准 + 新卫星回执」的混合态，
  //    任何满足 §6.1 的实现在此都必然 FAIL（旧断言即此算术错误）。基准必须按余量规则**重算**。
  const before = await dom(page);
  await page.evaluate(() => window.__r1r2.setHeights({ '1h': 112, '5m': 82 }));
  await page.waitForTimeout(400);
  const after = await dom(page);
  // 期望由**请求值**推导（不取自 `after`，避免自我循环）：1h/5m = 回执值；1d = 本探针未改动 ⇒ 保持回执前值。
  const expectedSats = { '1h': 112, '5m': 82, '1d': before['1d'] };
  const expectedBase = 600 - (expectedSats['1h'] + expectedSats['5m'] + expectedSats['1d']); // 余量吸收项
  const expectAdopted = { '15m': expectedBase, ...expectedSats };
  const g3 = {
    satsAdopted: Math.abs(after['1h'] - expectedSats['1h']) <= 1 && Math.abs(after['5m'] - expectedSats['5m']) <= 1,
    baseAbsorbs: Math.abs(after['15m'] - expectedBase) <= 1,
    sumEqualsAvailable: sumOf(after) === 600,
  };
  raw.R1_onlySatellitePropChange = { before, after, expectedSats, expectedBase, expectAdopted, g3 };
  check(
    'R1-G3 依赖完整性：父层只改卫星高度（无拖拽）⇒ 分配必须重算：① 卫星逐值采用回执 ∧ ② 基准 == 可用 − Σ卫星 ∧ ③ Σ分配 == 可用',
    g3.satsAdopted && g3.baseAbsorbs && g3.sumEqualsAvailable,
    `回执前=${JSON.stringify(before)} 实际=${JSON.stringify(after)} 判据=${JSON.stringify(g3)}` +
      `（期望：1h=112, 5m=82, 15m=600−Σ卫星=${expectedBase}, Σ=600；基准必须 ≠ 回执前屏幕值 ${before['15m']}）`,
  );

  const ev = await page.evaluate(() => window.__r1r2.measure());
  raw.R1_measure = ev;
  fs.mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, 'R1_echo_snapback_600.png'), fullPage: true });
  await page.close();
}

// ── 5) 场景 B：1800px —— R2（无死区 + 重载无跳变）──────────────────────────────
{
  const page = await open({ avail: 1800 });
  const initial = await dom(page);
  raw.R2_initial = initial;
  check(
    'R2-G0 前置：越域（1800 − 3×180 = 1260 > 1200：基准吸收余量）',
    initial['15m'] > 1200 && sumOf(initial) === 1800,
    `初始=${JSON.stringify(initial)} Σ=${sumOf(initial)}`,
  );

  const r1 = await drag(page, '15m|1h', 1);
  const r2 = await drag(page, '15m|1h', 1);
  const r3 = await drag(page, '15m|1h', 1);
  const pls3 = await payloads(page);
  raw.R2_drags = [r1, r2, r3];
  raw.R2_payloads_monotonic = pls3;
  const hs = pls3.map((p) => p['1h']);
  const brief = (pls) => JSON.stringify(pls.map((p) => ({ '15m': p['15m'], '1h': p['1h'], '5m': p['5m'], '1d': p['1d'] })));
  const monotonic = hs.length === 3 && hs[0] === 179 && hs[1] === 178 && hs[2] === 177;
  check(
    'R2-G1 越域：连续同向 ≥1px 拖拽 ⇒ 载荷必须每次都变化（不得「拖了载荷不变」＝死区）',
    monotonic,
    `载荷 1h 序列=${JSON.stringify(hs)}（期望 [179,178,177]；载荷序列=${brief(pls3)}）`,
  );
  for (let i = 1; i < pls3.length; i++) {
    const same =
      pls3[i]['15m'] === pls3[i - 1]['15m'] &&
      pls3[i]['1h'] === pls3[i - 1]['1h'] &&
      pls3[i]['5m'] === pls3[i - 1]['5m'] &&
      pls3[i]['1d'] === pls3[i - 1]['1d'];
    check(`R2-G1b 载荷 #${i + 1} 必须 ≠ 载荷 #${i}（任何 ≥1px 拖拽都不得零效果）`, !same, JSON.stringify(pls3[i]));
  }

  // 反向 −20：与 P5 验收一致的「分叉放大」步（屏幕与服务端分叉 ⇒ 重载跳变 20px）
  const r4 = await drag(page, '15m|1h', -20);
  const pls = await payloads(page);
  raw.R2_drag_diverging = r4;
  raw.R2_payloads = pls;

  const ev = await page.evaluate(() => window.__r1r2.measure());
  raw.R2_measure = ev;
  await page.screenshot({ path: path.join(outDir, 'R2_avail1800_deadzone.png'), fullPage: true });
  await page.close();

  // 以**真实服务端值**（= 末次载荷）重载 ⇒ 屏幕不得跳变
  const serverValue = (({ '15m': a, '1h': b, '5m': c, '1d': d }) => ({ '15m': a, '1h': b, '5m': c, '1d': d }))(
    pls.at(-1),
  );
  const screenAfterDrag = r4.after;
  const reloadPage = await open({ avail: 1800, serverHeights: serverValue });
  const screenReloaded = await dom(reloadPage);
  const jump = maxAbs(screenAfterDrag, screenReloaded);
  raw.R2_reload = { serverValue, screenAfterDrag, screenReloaded, jump };
  check(
    'R2-G2 以真实服务端值重载 ⇒ 屏幕不得跳变（P5 验收实测 20px；裁决 ② 只允许「屏幕 vs 载荷」≤61px 的偏差）',
    jump <= 1,
    `拖后屏幕=${JSON.stringify(screenAfterDrag)} 服务端值=${JSON.stringify(serverValue)} 重载屏幕=${JSON.stringify(screenReloaded)} 跳变=${jump}px`,
  );
  const deviation = Math.max(...PERIODS.map((p) => Math.abs((screenAfterDrag[p] ?? 0) - (serverValue[p] ?? 0))));
  raw.R2_deviation = deviation;
  check(
    'R2-G3 已知且允许的偏差：屏幕分配 vs 持久化载荷 ≤61px（记录实测值）',
    deviation <= 61,
    `实测偏差=${deviation}px（屏幕=${JSON.stringify(screenAfterDrag)} 载荷=${JSON.stringify(serverValue)}）`,
  );
  const payloadErrors = await reloadPage.evaluate(() => window.__r1r2.payloadErrors());
  check('R2-G4 载荷恒合法：桩「PUT」不得收到域外 heights', payloadErrors.length === 0, JSON.stringify(payloadErrors));
  await reloadPage.close();
}

// ── 6) 卫生 + 契约前置 ────────────────────────────────────────────────────────
check(
  'HY1 零出网 / 零写请求：非本地请求 == 0（桩「PUT」只进页面内存）',
  externalRequests.length === 0,
  JSON.stringify(externalRequests.slice(0, 5)),
);
const pageErrors = consoleMsgs.filter((m) => m.startsWith('[pageerror]'));
check('HY2 零 pageerror（拖拽/回执不得抛穿页面）', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 5)));

await browser.close();
server.close();

// ── 7) 证据落盘 ───────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.ok);
const evidence = {
  url: ORIGIN,
  generatedAt: new Date().toISOString(),
  available: { short: 600, tall: 1800 },
  checks,
  raw,
  externalRequests,
  console: consoleMsgs.slice(0, 50),
  screenshotDir: outDir,
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'p5_r1r2_harness.json'), JSON.stringify(evidence, null, 2));
console.log(`\n合计：${checks.length} 检查 / ${checks.length - failed.length} PASS / ${failed.length} FAIL`);
console.log(`非本地请求 = ${externalRequests.length}；pageerror = ${pageErrors.length}`);
console.log(`evidence = ${path.join(outDir, 'p5_r1r2_harness.json')}`);
process.exitCode = failed.length === 0 ? 0 : 1;
