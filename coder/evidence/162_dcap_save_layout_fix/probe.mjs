/**
 * 阶段 2 真渲染验收（临时构建 /tmp/fix162/dist + 临时预览 127.0.0.1:18092；/api、/ws 代理到线上只读 8081）。
 * 只发 GET（非 GET 一律浏览器侧本地兑现或 abort，绝不落盘/落库）。
 * 判据（用户需求 + 02-spec §6「配置保存不得重建 pane」）：
 *  - 保存 dcap 参数 / MA 窗口后：**分隔线位置不变（±1px = 用户拖拽过的 pane 高度保持）**；
 *  - **图表根元素身份不变（无整图 remount）**、pane 数不变、无残留线；
 *  - DCAP 开/关仍可逆（分隔线 1↔2）、关态不产生空 pane；
 *  - warmup 变化（n_l/m）走余额补取（多一次 /api/kline GET），仍不 remount。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/x.js');
const { chromium } = require('@playwright/test');

const BASE = process.env.BASE ?? 'http://127.0.0.1:18092';
const OUT = process.env.OUT ?? '/tmp/fix162';
const out = {
  base: BASE,
  t0: new Date().toISOString(),
  puts: [],
  nonGetOther: [],
  kline: [],
  scenarios: {},
  checks: [],
};
const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail });

/** 主图区形态：分隔线位置（相对 main-chart 顶）+ 图表根元素身份（无 remount 判据）+ 残留线。 */
const PROBE = () => {
  const main = document.querySelector('[data-region="main-chart"]');
  if (!main) return { error: 'main-chart 缺失' };
  const mr = main.getBoundingClientRect();
  const host = main.querySelector('[k-line-chart-id]');
  const kc = host ? host.firstElementChild : null;
  if (!host || !kc) return { error: 'klinecharts 未渲染' };
  const isSep = (el) => {
    const w = el.firstElementChild;
    return !!w && w.style && w.style.cursor === 'ns-resize';
  };
  const seps = Array.from(kc.children).filter(isSep).map((el) => {
    const r = el.getBoundingClientRect();
    return { top: +(r.top - mr.top).toFixed(2), h: +r.height.toFixed(2) };
  });
  const stray = [];
  for (const el of Array.from(main.querySelectorAll('*'))) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const bt = parseFloat(cs.borderTopWidth || '0');
    const opaque = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
    if (isSep(el)) continue;
    if ((bt > 0 && cs.borderTopStyle !== 'none' && r.width >= 0.9 * mr.width) || (r.height <= 3 && opaque)) {
      stray.push({ tag: el.tagName, kind: bt > 0 ? `border-top ${cs.borderTopWidth}` : `bg ${cs.backgroundColor}`, h: +r.height.toFixed(2) });
    }
  }
  // DCAP（最后一个内容 pane）canvas 像素指纹（证明 override 真重算）
  const paneEls = Array.from(kc.children).filter((el) => el.querySelector && el.querySelector('canvas'));
  const lastCanvas = paneEls.length ? paneEls[paneEls.length - 1].querySelector('canvas') : null;
  let dcapHash = null;
  if (lastCanvas) {
    try {
      dcapHash = lastCanvas.toDataURL('image/png').length + ':' + lastCanvas.toDataURL('image/png').slice(-64);
    } catch {
      dcapHash = 'unavailable';
    }
  }
  const charts = (globalThis.__CHARTS__ ?? []).filter((c) => {
    try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; }
  });
  const chart = charts[charts.length - 1] ?? null;
  let panes = null;
  let inds = null;
  let dcapResult = null;
  if (chart) {
    panes = (chart.getPaneOptions() ?? []).map((p) => {
      let dom = null;
      try { dom = +chart.getDom(p.id).getBoundingClientRect().height.toFixed(2); } catch { dom = null; }
      return { id: p.id, height: p.height, dom, inds: (chart.getIndicators({ paneId: p.id }) ?? []).map((i) => i.name) };
    });
    inds = (chart.getIndicators() ?? []).map((i) => ({
      name: i.name, paneId: i.paneId, precision: i.precision, calcParams: i.calcParams,
      figKeys: (i.figures ?? []).map((f) => f.key),
    }));
    const d = (chart.getIndicators({ name: 'DCAP' }) ?? [])[0];
    if (d && Array.isArray(d.result)) {
      const pick = (k) => d.result.map((r) => r?.[k]).filter((v) => typeof v === 'number' && Number.isFinite(v));
      const line = (k) => {
        const a = pick(k);
        return { n: a.length, head: a.slice(0, 3).map((v) => +v.toFixed(10)), tail: a.slice(-3).map((v) => +v.toFixed(10)) };
      };
      const z = pick('zero');
      dcapResult = { n: d.result.length, s: line('s'), m: line('m'), l: line('l'), zeroAllZero: z.length > 0 && z.every((v) => v === 0) };
    }
  }
  return {
    inits: globalThis.__KC_INITS__ ?? null,
    chartCount: (globalThis.__CHARTS__ ?? []).length,
    panes,
    inds,
    dcapResult,
    mainH: +mr.height.toFixed(2),
    kcTagged: kc.getAttribute('data-probe-tag'),
    kcInDom: !!document.querySelector('[k-line-chart-id] > [data-probe-tag="1"]'),
    hostCount: main.querySelectorAll('[k-line-chart-id]').length,
    separators: seps,
    strayLines: stray,
    paneCount: seps.length + 1 - 1, // 内容 pane 数 = 分隔线数 + ... 仅记录分隔线数
    dcapHash,
  };
};

const page_ = null;
function diag(label, p) {
  return `[${label}] ${JSON.stringify(p)}`;
}

async function tagRoot(page) {
  await page.evaluate(() => {
    const kc = document.querySelector('[data-region="main-chart"] [k-line-chart-id]')?.firstElementChild;
    if (kc) kc.setAttribute('data-probe-tag', '1');
  });
}

async function dragFirstSeparator(page, dy) {
  const handle = await page.evaluate(() => {
    const main = document.querySelector('[data-region="main-chart"]');
    const kc = main?.querySelector('[k-line-chart-id]')?.firstElementChild;
    if (!kc) return null;
    const sep = Array.from(kc.children).find((el) => {
      const w = el.firstElementChild;
      return !!w && w.style && w.style.cursor === 'ns-resize';
    });
    const w = sep?.firstElementChild;
    if (!w) return null;
    const r = w.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!handle) return false;
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x, handle.y + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  return true;
}

/** 面板开关是幂等的：仅在未打开时点开（保存会自动收起）。 */
const dcapPanel = (page) => page.getByRole('group', { name: 'DCAP 参数' });
const maPanel = (page) => page.getByRole('group', { name: 'MA 窗口配置' });

async function openPanel(page, toggle, group) {
  if (!(await group(page).isVisible().catch(() => false))) {
    await page.getByRole('button', { name: toggle }).click();
    await group(page).waitFor({ timeout: 5000 });
  }
  await page.waitForTimeout(150);
}

async function saveDcap(page, changes) {
  await openPanel(page, 'DCAP 配置', dcapPanel);
  for (const [key, value] of Object.entries(changes)) {
    const input = page.getByTestId(`dcap-input-${key}`);
    await input.fill(String(value));
  }
  await dcapPanel(page).getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(900);
  // 保存成功后面板自动收起；若仍在（保存失败）则手动收起并留证
  if (await dcapPanel(page).isVisible().catch(() => false)) {
    out.panelStillOpen = (out.panelStillOpen ?? []).concat([JSON.stringify(changes)]);
    await page.getByRole('button', { name: 'DCAP 配置' }).click();
    await page.waitForTimeout(200);
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const page = await ctx.newPage();
page.on('pageerror', (e) => out.pageErrors.push?.(String(e)) || (out.pageErrors = out.pageErrors ?? [], out.pageErrors.push(String(e))));

// 只读保证：任何非 GET → 本地兑现（/api/config/{dcap,ma}）或 abort；GET /api/kline 记录
await page.route('**/*', async (route, req) => {
  const url = req.url();
  const method = req.method();
  if (method === 'GET') {
    if (url.includes('/api/kline')) out.kline.push(url.replace(BASE, ''));
    return route.continue();
  }
  if (url.includes('/api/config/dcap') || url.includes('/api/config/ma')) {
    out.puts.push({ url: url.replace(BASE, ''), body: req.postData() });
    return route.fulfill({ status: 200, contentType: 'application/json', body: req.postData() ?? '{}' });
  }
  out.nonGetOther.push(`${method} ${url}`);
  return route.abort();
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.locator('[data-testid="kline-chart"] canvas').first().waitFor({ timeout: 30_000 });
await page.waitForTimeout(1500);
await tagRoot(page);

// ── 场景 A：DCAP 关态，拖高 VOL 副图 → 保存 r_s（参数变化） ──
{
  const s = {};
  s.dcapOff = (await page.getByRole('button', { name: 'DCAP', exact: true }).getAttribute('aria-pressed')) === 'false';
  s.dragged = await dragFirstSeparator(page, -140);
  s.before = await page.evaluate(PROBE);
  await page.screenshot({ path: `${OUT}/A1-dragged.png` });
  await saveDcap(page, { r_s: 1.25 });
  s.after = await page.evaluate(PROBE);
  await page.screenshot({ path: `${OUT}/A2-after-save.png` });
  s.heightDelta = (s.after.separators?.[0]?.top ?? -1) - (s.before.separators?.[0]?.top ?? -1);
  out.scenarios.A_dcap_off_save_r_s = s;
  check('A. 保存 dcap 参数后分隔线位置不变（±1px）', Math.abs(s.heightDelta) <= 1, diag('A', s));
  check('A. 无整图 remount（图表根元素身份保持 + init 计数不变）', s.after.kcInDom === true && s.after.inits === s.before.inits, `inits ${s.before.inits}→${s.after.inits}`);
  check('A. 无残留水平线', (s.after.strayLines ?? []).length === 0, diag('A', s));
  check('A. 关态保存不误建 DCAP pane（分隔线数不变）', s.after.separators.length === s.before.separators.length, diag('A', s));
  const volInd = s.after.inds?.find((i) => i.name === 'VOL');
  check('A. 内置 VOL 未被空 calcParams 覆盖（保留模板默认 [5,10,20]）',
    JSON.stringify(volInd?.calcParams) === JSON.stringify([5, 10, 20]), JSON.stringify(volInd));
  check('A. DCAP 关态：无 DCAP 指标（不残留空 pane）', s.after.inds?.find((i) => i.name === 'DCAP') === undefined, JSON.stringify(s.after.inds?.map((i) => i.name)));
}

// ── 场景 C：DCAP 开态，拖高 VOL+DCAP → 保存 r_m（参数变化） ──
{
  const s = {};
  await page.getByRole('button', { name: 'DCAP', exact: true }).click();
  await page.waitForTimeout(1500);
  s.sepsAfterEnable = (await page.evaluate(PROBE)).separators.length;
  // 拖第一条分隔线（candle|VOL）与最后一条（VOL|DCAP）
  await dragFirstSeparator(page, -110);
  await page.mouse.move(0, 0);
  const lastHandle = await page.evaluate(() => {
    const main = document.querySelector('[data-region="main-chart"]');
    const kc = main?.querySelector('[k-line-chart-id]')?.firstElementChild;
    const seps = Array.from(kc?.children ?? []).filter((el) => {
      const w = el.firstElementChild;
      return !!w && w.style && w.style.cursor === 'ns-resize';
    });
    const w = seps.at(-1)?.firstElementChild;
    if (!w) return null;
    const r = w.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (lastHandle) {
    await page.mouse.move(lastHandle.x, lastHandle.y);
    await page.mouse.down();
    await page.mouse.move(lastHandle.x, lastHandle.y - 90, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  await tagRoot(page);
  s.before = await page.evaluate(PROBE);
  await page.screenshot({ path: `${OUT}/C1-dragged-dcap-on.png` });
  await saveDcap(page, { r_s: 1.5 });
  s.after = await page.evaluate(PROBE);
  await page.screenshot({ path: `${OUT}/C2-after-save.png` });
  s.deltas = s.before.separators.map((b, i) => +(s.after.separators[i].top - b.top).toFixed(2));
  out.scenarios.C_dcap_on_save_r_s = s;
  check('C. DCAP 开：保存参数后**两条分隔线位置均不变**（±1px）', s.deltas.every((d) => Math.abs(d) <= 1), diag('C', s));
  check('C. 无整图 remount（init 计数不变）', s.after.kcInDom === true && s.after.inits === s.before.inits, `inits ${s.before.inits}→${s.after.inits}`);
  check('C. pane 数不变（分隔线 2 条：candle|VOL|DCAP）', s.after.separators.length === 2, diag('C', s));
  const dB = s.before.inds?.find((i) => i.name === 'DCAP');
  const dA = s.after.inds?.find((i) => i.name === 'DCAP');
  check('C. DCAP 仍为独立副图 pane（paneId 不变、无 paneId=candle_pane）', !!dB && !!dA && dB.paneId === dA.paneId && dA.paneId !== 'candle_pane', `before=${dB?.paneId} after=${dA?.paneId}`);
  check('C. override 未丢模板属性：precision=5、figures=[s,m,l,zero] 不变',
    dA?.precision === 5 && JSON.stringify(dA?.figKeys) === JSON.stringify(['s', 'm', 'l', 'zero']),
    `precision=${dA?.precision} figKeys=${JSON.stringify(dA?.figKeys)}`);
  check('C. calcParams 已按新 r_s 更新', JSON.stringify(dA?.calcParams) === JSON.stringify([8, 36, 66, 1.5, 1, 1, 1, 3]), JSON.stringify(dA?.calcParams));
  check('C. DCAP 线值按新参数重算（s/m/l 采样变化，zero 恒 0）',
    JSON.stringify(s.before.dcapResult) !== JSON.stringify(s.after.dcapResult) && s.after.dcapResult?.zeroAllZero === true,
    `before=${JSON.stringify(s.before.dcapResult)} after=${JSON.stringify(s.after.dcapResult)}`);
  check('C. pane id 集合不变（无销毁重建）且渲染高度逐值不变（±1px）',
    JSON.stringify(s.before.panes?.map((p) => p.id)) === JSON.stringify(s.after.panes?.map((p) => p.id)) &&
      s.before.panes.every((p, i) => Math.abs((s.after.panes[i]?.dom ?? -1) - (p.dom ?? -1)) <= 1),
    `before=${JSON.stringify(s.before.panes)} after=${JSON.stringify(s.after.panes)}`);
  check('C. 无残留水平线', s.after.strayLines.length === 0, diag('C', s));
}

// ── 场景 B：DCAP 开态，保存 m（warmup 变化：m 3→5）→ 不得整图 remount ──
{
  const s = {};
  const klineBefore = out.kline.length;
  await tagRoot(page);
  s.before = await page.evaluate(PROBE);
  const bm = await page.getByRole('button', { name: 'DCAP', exact: true }).getAttribute('aria-pressed');
  await saveDcap(page, { m: 5 });
  await page.waitForTimeout(1200);
  s.after = await page.evaluate(PROBE);
  s.klineRequestsAfter = out.kline.slice(klineBefore);
  s.deltas = s.before.separators.map((b, i) => +(s.after.separators[i].top - b.top).toFixed(2));
  s.dcapPressed = bm;
  await page.screenshot({ path: `${OUT}/B1-after-save-m.png` });
  out.scenarios.B_warmup_change_save_m = s;
  check('B. warmup 变化（m 3→5）后**不 remount**（init 计数不变 + 根元素身份保持）', s.after.kcInDom === true && s.after.inits === s.before.inits, `inits ${s.before.inits}→${s.after.inits}`);
  check('B. warmup 变化后分隔线位置不变（±1px）', s.deltas.every((d) => Math.abs(d) <= 1), diag('B', s));
  check(
    'B. 触发过一次 /api/kline 补取（warmup 差额，非整图重建）',
    s.klineRequestsAfter.filter((u) => u.includes('/api/kline')).length >= 1,
    JSON.stringify(s.klineRequestsAfter),
  );
}

// ── 场景 T：内置指标勾选（BOLL/MACD）开/关：模板默认参数保留 + pane 可逆 ──
{
  const s = {};
  s.base = await page.evaluate(PROBE);
  await page.getByRole('button', { name: 'BOLL', exact: true }).click();
  await page.waitForTimeout(900);
  s.bollOn = await page.evaluate(PROBE);
  s.bollInd = s.bollOn.inds?.find((i) => i.name === 'BOLL');
  await page.getByRole('button', { name: 'BOLL', exact: true }).click();
  await page.waitForTimeout(900);
  s.bollOff = await page.evaluate(PROBE);
  out.scenarios.T_builtin_toggle = s;
  check('T. 开 BOLL：保留模板默认 calcParams（非空，未被 [] 覆盖）', (s.bollInd?.calcParams?.length ?? 0) > 0, JSON.stringify(s.bollInd));
  check('T. 开 BOLL：分隔线 +1（独立副图 pane）且不 remount',
    s.bollOn.separators.length === s.base.separators.length + 1 && s.bollOn.inits === s.base.inits, `seps ${s.base.separators.length}→${s.bollOn.separators.length}, inits ${s.base.inits}→${s.bollOn.inits}`);
  check('T. 关 BOLL：分隔线回到原值、无空 pane 残留、不 remount',
    s.bollOff.separators.length === s.base.separators.length && s.bollOff.inds?.find((i) => i.name === 'BOLL') === undefined && s.bollOff.inits === s.base.inits,
    `seps ${s.bollOff.separators.length}, inits ${s.bollOff.inits}`);
}

// ── 场景 M：MA 窗口变化（参数热更新） ──
{
  const s = {};
  await tagRoot(page);
  s.before = await page.evaluate(PROBE);
  await openPanel(page, 'MA 配置', maPanel);
  await page.getByLabel('MA 窗口 1').fill('7');
  await maPanel(page).getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(900);
  if (await maPanel(page).isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'MA 配置' }).click();
    await page.waitForTimeout(200);
  }
  s.after = await page.evaluate(PROBE);
  s.deltas = s.before.separators.map((b, i) => +(s.after.separators[i].top - b.top).toFixed(2));
  await page.screenshot({ path: `${OUT}/M1-after-ma-save.png` });
  out.scenarios.M_ma_windows_save = s;
  check('M. MA 窗口变化后不 remount（init 计数不变）', s.after.kcInDom === true && s.after.inits === s.before.inits, `inits ${s.before.inits}→${s.after.inits}`);
  check('M. MA 指标仍叠主图且 calcParams 已更新', s.after.inds?.filter((i) => i.name === 'MA')[0]?.paneId === 'candle_pane' && JSON.stringify(s.after.inds?.filter((i) => i.name === 'MA')[0]?.calcParams) === JSON.stringify([7, 10, 20]), JSON.stringify(s.after.inds?.filter((i) => i.name === 'MA')[0]));
  check('M. MA 窗口变化后分隔线位置不变（±1px）', s.deltas.every((d) => Math.abs(d) <= 1), diag('M', s));

  // DCAP 关：分隔线 2 → 1（可逆、无空 pane 残留）
  await page.getByRole('button', { name: 'DCAP', exact: true }).click();
  await page.waitForTimeout(1200);
  s.dcapOff = await page.evaluate(PROBE);
  await page.getByRole('button', { name: 'DCAP', exact: true }).click();
  await page.waitForTimeout(1200);
  s.dcapOnAgain = await page.evaluate(PROBE);
  await page.screenshot({ path: `${OUT}/M2-dcap-toggle.png` });
  check('M. DCAP 关 → 分隔线回到 1 条（无空 pane）', s.dcapOff.separators.length === 1, diag('M-off', s.dcapOff));
  check('M. DCAP 重开 → 回到 2 条', s.dcapOnAgain.separators.length === 2, diag('M-on', s.dcapOnAgain));
  check('M. DCAP 开关全程无残留线', s.dcapOff.strayLines.length === 0 && s.dcapOnAgain.strayLines.length === 0, diag('M', s));
}

out.t1 = new Date().toISOString();
out.pageErrors = out.pageErrors ?? [];
check('全程无页面错误', out.pageErrors.length === 0, JSON.stringify(out.pageErrors));
check('只读保证：无非 GET 外发（PUT /api/config/* 全被本地兑现）', out.nonGetOther.length === 0, JSON.stringify(out.nonGetOther));
out.summary = { total: out.checks.length, failed: out.checks.filter((c) => !c.ok).length };

fs.writeFileSync(`${OUT}/probe-result.json`, JSON.stringify(out, null, 2));
console.log(`checks: ${out.summary.total - out.summary.failed}/${out.summary.total} passed`);
for (const c of out.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' ← ' + c.detail}`);
console.log('kline requests:', JSON.stringify(out.kline));
console.log('putIntercepted:', JSON.stringify(out.puts.map((p) => p.body)));
await browser.close();
process.exit(out.summary.failed === 0 ? 0 : 1);
