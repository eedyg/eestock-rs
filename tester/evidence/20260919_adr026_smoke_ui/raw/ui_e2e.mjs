/* ADR-026 回测工作台 UI 端到端（真浏览器 Chromium / Playwright，非 jsdom）
 * 用法: node ui_e2e.mjs <outdir>
 * 只读观测：点击左侧 run 行、切 Tab、读 DOM、截图。不修改任何数据。
 */
import { chromium } from 'file:///home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] ?? '.';
const BASE = 'http://127.0.0.1:8081';
const S1 = 'sr_1789787931919_000001';   // S1 新建 run（新写路径，trades 带 reason）
const HIST = 'sr_1789738328788_000005'; // 历史 run（reason 缺省 => 来源列应为「未记录」）

fs.mkdirSync(OUT, { recursive: true });

const checks = [];
function check(id, name, pass, detail) {
  checks.push({ id, name, pass: !!pass, detail: String(detail) });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${id} | ${name} | ${detail}`);
}

const consoleAll = [];
const consoleErrors = [];
const pageErrors = [];
const netAll = [];
const netFailed = [];
const reqStarts = new Map();

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 1, locale: 'zh-CN' });
const page = await ctx.newPage();

page.on('console', (m) => {
  const rec = { type: m.type(), text: m.text(), loc: m.location() };
  consoleAll.push(rec);
  if (m.type() === 'error') consoleErrors.push(rec);
});
page.on('pageerror', (e) => pageErrors.push({ name: e.name, message: e.message, stack: (e.stack ?? '').split('\n').slice(0, 6).join('\n') }));
page.on('request', (r) => reqStarts.set(r, Date.now()));
page.on('requestfailed', (r) => {
  const rec = { url: r.url(), method: r.method(), status: null, failure: r.failure()?.errorText ?? 'requestfailed', ms: Date.now() - (reqStarts.get(r) ?? Date.now()), kind: 'requestfailed' };
  netFailed.push(rec); netAll.push(rec);
});
page.on('response', async (r) => {
  const rec = { url: r.url(), method: r.request().method(), status: r.status(), failure: null, ms: Date.now() - (reqStarts.get(r.request()) ?? Date.now()), kind: 'response' };
  netAll.push(rec);
  if (r.status() >= 400) netFailed.push(rec);
});

async function waitChart() {
  await page.waitForSelector('[data-testid="wb-kline-chart"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="wb-kline-chart"] canvas', { timeout: 30000 });
  // 等成交明细 note 收敛（非 loading 文案）+ 图表 rAF 绘制
  for (let i = 0; i < 40; i++) {
    const t = await page.locator('[data-testid="wb-fills-note"]').first().innerText().catch(() => '');
    if (t && !t.includes('加载中')) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(2000);
}

async function selectRun(id) {
  const row = page.locator(`[data-testid="wb-run-select-${id}"]`);
  await row.waitFor({ state: 'visible', timeout: 30000 });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  const rid = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const respWait = page.waitForResponse((r) => new RegExp(`/api/workbench/runs/${rid}/(result|fills|audit)`).test(r.url()) && r.status() === 200, { timeout: 30000 });
  await respWait;
  await page.waitForSelector('[data-testid="wb-result"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="wb-run-title"]', { timeout: 30000 });
  const title = await page.locator('[data-testid="wb-run-title"]').innerText();
  check('__SEL__', `选中 run 行并完成结果取数`, true, `selected=${id} title="${title}"`);
}

// ---------------------------------------------------------------- load page
await page.goto(`${BASE}/backtest-workbench`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-testid="workbench-page"]', { timeout: 60000 });
await page.waitForSelector(`[data-testid="wb-run-select-${S1}"]`, { timeout: 60000 });
check('A00', '页面加载 /backtest-workbench + 左侧运行列表渲染', true, 'workbench-page + wb-run-list 可见，S1 run 行存在');

// ================================================================ S1 run
await selectRun(S1);
await waitChart();

// --- K 线 + fills 标记
const lineChart = page.locator('[data-testid="wb-kline-chart"]');
check('A01', '结果视图正常出图：K 线容器 + canvas 存在', await lineChart.isVisible(), 'wb-kline-chart visible=true, canvas count=' + (await lineChart.locator('canvas').count()));
const canvasBox = await lineChart.locator('canvas').first().boundingBox();
check('A02', 'K 线 canvas 尺寸合理（>200x100）', canvasBox && canvasBox.width > 200 && canvasBox.height > 100, JSON.stringify(canvasBox));
await lineChart.screenshot({ path: path.join(OUT, 's1_canvas_kline.png') });
const fillsNote = await page.locator('[data-testid="wb-fills-note"]').first().innerText();
const fillsMatch = fillsNote.match(/成交\s*(\d+)\s*笔/);
check('A03', '/fills 标记来源计数可见（成交 N 笔，来自精确源 /fills）', !!fillsMatch && Number(fillsMatch[1]) > 0, `wb-fills-note="${fillsNote}"`);
const hasFillErr = await page.locator('[data-testid="wb-fills-error"]').count();
check('A04', '无成交明细加载失败提示', hasFillErr === 0, `wb-fills-error count=${hasFillErr}`);

// --- 交易明细 Tab（默认激活）：审计摘要行 + warning + 来源列
const auditSummary = page.locator('[data-testid="wb-audit-summary"]');
check('A05', '交易明细 Tab 出「审计摘要行」（wb-audit-summary）', await auditSummary.isVisible(), `text="${(await auditSummary.innerText()).replace(/\n/g, ' / ')}"`);
const auditCash = await page.locator('[data-testid="wb-audit-cash"]').innerText();
check('A06', '审计摘要含现金消耗/计划批数/买入成交/未执行挂单', /现金消耗/.test(auditCash) && /计划批数/.test(auditCash) && /买入成交/.test(auditCash) && /未执行挂单/.test(auditCash), auditCash);
const warnCount = await page.locator('[data-testid^="wb-audit-warning-"]').count();
const warnTexts = await page.locator('[data-testid^="wb-audit-warning-"]').allInnerTexts();
check('A07', 'warning 展示（本条 run 预期 ORDERS_UNEXECUTED）', warnCount >= 1 && warnTexts.some((t) => /挂单未成交/.test(t)), `count=${warnCount} texts=${JSON.stringify(warnTexts)}`);
const auditErrCount = await page.locator('[data-testid="wb-audit-error"]').count();
check('A08', '无审计加载失败', auditErrCount === 0, `wb-audit-error count=${auditErrCount}`);

const tradesTable = page.locator('[data-testid="wb-trades-table"]');
const headers = await tradesTable.locator('thead th').allInnerTexts();
check('A09', '交易明细表含「来源」列', headers.includes('来源'), `headers=${JSON.stringify(headers)}`);
const srcCount = await page.locator('[data-testid^="wb-trade-source-"]').count();
const srcLabels = await page.locator('[data-testid^="wb-trade-source-"]').allInnerTexts();
const allowed = ['正常', '止损', '期末强平'];
check('A10', 'S1 run 来源列显示 正常/止损/期末强平 之一（新写路径 reason 生效）', srcCount > 0 && srcLabels.every((l) => allowed.includes(l.trim())), `rows=${srcCount} labels=${JSON.stringify(srcLabels)}`);
check('A11', 'S1 run 来源列无「未记录」', !srcLabels.some((l) => l.includes('未记录')), `labels=${JSON.stringify(srcLabels)}`);
await page.locator('[data-testid="wb-result"]').screenshot({ path: path.join(OUT, 's1_tab_trades.png') });

// --- 8 项绩效 Tab
await page.locator('[data-testid="wb-tab-metrics"]').click();
await page.waitForSelector('[data-testid="wb-metrics-table"]', { timeout: 20000 });
await page.waitForTimeout(800);
const metricRows = await page.locator('[data-testid="wb-metrics-table"] tbody tr').count();
const basisText = await page.locator('[data-testid="wb-metrics-basis"]').innerText();
check('A12', '8 项绩效表 = 8 行', metricRows === 8, `rows=${metricRows}`);
check('A13', '口径注存在且含「口径」「初始资金」「分母」', /口径/.test(basisText) && /初始资金/.test(basisText) && /分母/.test(basisText), basisText);
const deployedText = await page.locator('[data-testid="wb-metrics-deployed"]').innerText();
check('A14', '资金投入率并列披露（含名义投入 + 含佣金占用两个口径）', /资金投入率（名义投入/.test(deployedText) && /含佣金/.test(deployedText), deployedText);
await page.locator('[data-testid="wb-result"]').screenshot({ path: path.join(OUT, 's1_tab_metrics.png') });

// ================================================================ 历史 run
await selectRun(HIST);
await waitChart();
check('A15', '历史 run 结果视图仍正常渲染（K 线 canvas 存在）', await page.locator('[data-testid="wb-kline-chart"] canvas').count() > 0, `run=${HIST}`);
const histFills = await page.locator('[data-testid="wb-fills-note"]').first().innerText();
await lineChart.screenshot({ path: path.join(OUT, 'hist_canvas_kline.png') });
const histAudit = page.locator('[data-testid="wb-audit-summary"]');
const histAuditVisible = await histAudit.isVisible().catch(() => false);
const histAuditText = histAuditVisible ? await histAudit.innerText() : (await page.locator('[data-testid="wb-audit-unrecorded"]').innerText().catch(() => ''));
const histWarn = await page.locator('[data-testid^="wb-audit-warning-"]').allInnerTexts();
check('A16', '历史 run 交易明细 Tab 出审计摘要（兼容性回归：非报错）', histAuditVisible, `auditText="${histAuditText.replace(/\n/g, ' / ')}" warnings=${JSON.stringify(histWarn)}`);
const histSrc = await page.locator('[data-testid^="wb-trade-source-"]').allInnerTexts();
check('A17', '历史 run 来源列显示「未记录」（无 reason 字段，属预期）', histSrc.length > 0 && histSrc.every((l) => l.trim() === '未记录'), `rows=${histSrc.length} labels=${JSON.stringify(histSrc)}`);
await page.locator('[data-testid="wb-result"]').screenshot({ path: path.join(OUT, 'hist_tab_trades.png') });
await page.locator('[data-testid="wb-tab-metrics"]').click();
await page.waitForSelector('[data-testid="wb-metrics-table"]', { timeout: 20000 });
await page.waitForTimeout(600);
const histMetricRows = await page.locator('[data-testid="wb-metrics-table"] tbody tr').count();
const histDeployed = await page.locator('[data-testid="wb-metrics-deployed"]').innerText();
check('A18', '历史 run 8 项绩效 8 行 + 资金投入率可用', histMetricRows === 8 && /资金投入率/.test(histDeployed), `rows=${histMetricRows} deployed="${histDeployed}"`);
await page.locator('[data-testid="wb-result"]').screenshot({ path: path.join(OUT, 'hist_tab_metrics.png') });
check('A19', '历史 run fills note 可见', histFills.length > 0, `wb-fills-note="${histFills}"`);

// ================================================================ console / network
await page.waitForTimeout(1000);
check('A20', 'console error 清单为空', consoleErrors.length === 0, `count=${consoleErrors.length} ${JSON.stringify(consoleErrors.slice(0, 8))}`);
check('A21', 'pageerror 清单为空', pageErrors.length === 0, `count=${pageErrors.length} ${JSON.stringify(pageErrors.slice(0, 8))}`);
check('A22', '失败请求清单为空（HTTP>=400 或 requestfailed）', netFailed.length === 0, `count=${netFailed.length} ${JSON.stringify(netFailed.slice(0, 12))}`);

fs.writeFileSync(path.join(OUT, 'console_all.json'), JSON.stringify(consoleAll, null, 2));
fs.writeFileSync(path.join(OUT, 'console_errors.json'), JSON.stringify(consoleErrors, null, 2));
fs.writeFileSync(path.join(OUT, 'pageerrors.json'), JSON.stringify(pageErrors, null, 2));
fs.writeFileSync(path.join(OUT, 'network_all.json'), JSON.stringify(netAll, null, 2));
fs.writeFileSync(path.join(OUT, 'network_failed.json'), JSON.stringify(netFailed, null, 2));
fs.writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify(checks, null, 2));

await browser.close();

const failed = checks.filter((c) => !c.pass);
console.log(`\nSUMMARY: ${checks.length} checks, ${failed.length} failed`);
if (failed.length) console.log('FAILED: ' + failed.map((f) => f.id).join(', '));
process.exit(failed.length ? 1 : 0);
