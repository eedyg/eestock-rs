// tester 真渲染验收（ADR-024 P4+P6 并批重验 ⑥）——Playwright + 第二 app 实例（临时库 + 0027）。
// 非生产代码：只在 web/tester/ 下，不参与构建（vite build 只收 src/）。
//
// 前置（由 tester 在外部准备）：
//   • 临时库（含 0027）+ 已 succeeded 的 chunked run（>5000 bar，含 fills）
//   • 第二 app 实例监听 127.0.0.1:18083（static_dir=web/dist）
// 用法：RID=sr_xxx BASE=http://127.0.0.1:18083 node web/tester/p4p6-render/run.mjs
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18083';
const RID = process.env.RID;
if (!RID) { console.error('缺 RID'); process.exit(2); }

const outDir = process.env.OUT_DIR ?? '/tmp/p4p6_render';
mkdirSync(outDir, { recursive: true });

const log = (...a) => console.log('[render]', ...a);
const requests = [];
const consoleErrors = [];
const failures = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('request', (r) => requests.push(r.url()));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

// 反向对照（NEG=abort-fills）：掐断 /fills ⇒ K 线成交明细必须显式报错（断言非空转）。
const NEG = process.env.NEG;
if (NEG === 'abort-fills') {
  await page.route('**/fills*', (route) => route.abort('failed'));
}

function check(name, cond, detail = '') {
  log(cond ? `PASS ${name}` : `FAIL ${name} ${detail}`);
  if (!cond) failures.push(`${name} ${detail}`);
}

try {
  await page.goto(`${BASE}/backtest-workbench`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="wb-run-list"]', { timeout: 20000 });
  // 选中本次真实 run（RunList 里的 select 按钮）
  await page.waitForSelector(`[data-testid="wb-run-select-${RID}"]`, { timeout: 20000 });
  await page.click(`[data-testid="wb-run-select-${RID}"]`);
  await page.waitForSelector('[data-testid="wb-result"]', { timeout: 30000 });
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="wb-result-skeleton"]'),
    null, { timeout: 30000 });

  if (NEG === 'abort-fills') {
    await page.waitForSelector('[data-testid="wb-fills-error"]', { timeout: 20000 });
    const errTxt = (await page.textContent('[data-testid="wb-fills-error"]')) ?? '';
    const okNote = await page.$('[data-testid="wb-fills-note"] >> text=成交 200 笔');
    check('反向对照：掐断 /fills ⇒ 显式报错（非静默）', errTxt.length > 0 && okNote === null, JSON.stringify(errTxt));
    await page.screenshot({ path: `${outDir}/neg_abort_fills.png`, fullPage: true });
    writeFileSync(`${outDir}/neg_summary.json`, JSON.stringify({ rid: RID, neg: NEG, errTxt, failures }, null, 2));
    throw new Error(NEG === 'abort-fills' && failures.length ? 'NEG_FAIL' : '__NEG_DONE__');
  }

  const title = (await page.textContent('[data-testid="wb-run-title"]')) ?? '';
  check('结果页标题可见', title.length > 0, JSON.stringify(title));

  // ── 抽样标注（曲线走 /curve，downsampled/original_bars 必须显式）──
  const agg = (await page.textContent('[data-testid="wb-aggregate-sampling"]')) ?? '';
  const eq = (await page.textContent('[data-testid="wb-equity-sampling"]')) ?? '';
  check('总分曲线标注「共 N bar」', /共\s*7953\s*bar/.test(agg), JSON.stringify(agg));
  check('净值曲线标注「共 N bar」', /共\s*7953\s*bar/.test(eq), JSON.stringify(eq));
  check('服务端抽样标注可读', /抽样|共\s*\d+\s*bar/.test(agg), JSON.stringify(agg));

  // ── K 线买卖标记：来自 /fills 精确源（笔记显式写出）──
  const fillsNote = (await page.textContent('[data-testid="wb-fills-note"]')) ?? '';
  check('K线成交笔数来自 /fills（精确源）', /成交\s*200\s*笔/.test(fillsNote) && fillsNote.includes('/fills'),
        JSON.stringify(fillsNote));

  // ── 逐bar评分：长区间不得静默截断（has_more/next_offset 被消费）──
  await page.click('[data-testid="wb-tab-perbar"]');
  await page.waitForSelector('[data-testid="wb-perbar-more-note"]', { timeout: 20000 });
  const more = (await page.textContent('[data-testid="wb-perbar-more-note"]')) ?? '';
  check('长区间出现 has_more 覆盖提示', /已加载\s*5000\s*\/\s*共\s*7953\s*根/.test(more), JSON.stringify(more));
  check('提示含未加载根数', /未加载\s*2953\s*根/.test(more), JSON.stringify(more));
  const loaded0 = (await page.textContent('[data-testid="wb-perbar-loaded"]')) ?? '';
  check('首屏只渲染 5000 行（未静默全量）', loaded0.trim() === '5000', JSON.stringify(loaded0));

  // 消费 next_offset：点「加载更多」→ 拉满 7953，提示消失
  await page.click('[data-testid="wb-perbar-more-note"] button');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="wb-perbar-loaded"]')?.textContent?.trim() === '7953',
    null, { timeout: 30000 });
  const moreGone = await page.$('[data-testid="wb-perbar-more-note"]');
  check('加载更多后拉满 7953 且提示消失', moreGone === null);

  // ── 事件日志：走 /bars 分页 + 覆盖提示（不抽样）──
  await page.click('[data-testid="wb-tab-events"]');
  await page.waitForSelector('[data-testid="wb-event-log-coverage"]', { timeout: 20000 });
  const cov = (await page.textContent('[data-testid="wb-event-log-coverage"]')) ?? '';
  check('事件日志覆盖范围显式标注', /已加载\s*\d+\s*\/\s*共\s*7953\s*根\s*bar/.test(cov), JSON.stringify(cov));

  await page.screenshot({ path: `${outDir}/workbench_result.png`, fullPage: true });

  // ── 网络面：真实取数路径 = /curve + /bars + /fills（无 /result 全量回归）──
  const hits = (p) => requests.filter((u) => u.includes(p)).length;
  const net = {
    curve: hits('/curve?'),
    bars: hits('/bars?'),
    fills: hits('/fills'),
    result: hits('/result'),
  };
  log('网络命中', JSON.stringify(net));
  check('页面真实调用 /curve', net.curve > 0);
  check('页面真实调用 /bars?kind=per_bar', net.bars > 0);
  check('页面真实调用 /fills', net.fills > 0);
  check('无 console 错误', consoleErrors.length === 0, JSON.stringify(consoleErrors));

  writeFileSync(`${outDir}/requests.json`, JSON.stringify(requests, null, 2));
  writeFileSync(`${outDir}/summary.json`, JSON.stringify({ rid: RID, base: BASE, net, title, agg, eq, fillsNote, more, cov, consoleErrors, failures }, null, 2));
} catch (e) {
  if (e?.message !== '__NEG_DONE__') failures.push('exception: ' + (e?.stack ?? String(e)));
  console.error('[render] EXCEPTION', e);
  try { await page.screenshot({ path: `${outDir}/failure.png`, fullPage: true }); } catch {}
} finally {
  await browser.close();
}

console.log(failures.length === 0 ? 'RENDER_PASS' : `RENDER_FAIL n=${failures.length}`);
for (const f of failures) console.log('  -', f);
process.exit(failures.length === 0 ? 0 : 1);
