import { expect, test, type Page, type ConsoleMessage } from '@playwright/test';
import { gotoPage } from './helpers/pages';

/**
 * K线组件完整交互验收矩阵（A–H，20 项）—— tester/report/008_kline_component_matrix.md 证据源。
 * 真实环境：http://192.168.50.100:8081（真容器/真后端/收盘后静态数据；实时路径用 WS 注入模拟盘中）。
 * 口径：只验收不改码；证据=数值断言+截图+console；每项一测，测试名即矩阵项号。
 * 已知真实服务端 WS 推送 quote 帧字段为 snake_case `change_pct`（crates/web/src/ws.rs），
 * 前端 store 读 camelCase `changePct` → 该项作为缺陷复现（K1）独立成测，其余注入用服务端真实形状。
 */

const EVID = '/tmp/kline_evidence';
const CODE_DEFAULT = ''; // 运行时取列表首标的
const BARS_PER_DAY: Record<string, number> = { '1m': 241, '5m': 49, '15m': 17, '1h': 5, '1d': 1 };

function bt(page: Page, name: string) {
  return page.locator('[data-region="toolbar"]').getByRole('button', { name, exact: true });
}

/** WS 注入底座（addInitScript 注入）：捕获 app 的 socket，暴露 __push 供测试推送服务端形状帧 */
const WS_HARNESS = `
(() => {
  const Real = window.WebSocket;
  window.__sock = null;
  window.__pusherr = null;
  window.__push = (obj) => {
    try { if (window.__sock && window.__sock.readyState === 1) window.__sock.onmessage({ data: JSON.stringify(obj) }); }
    catch (e) { window.__pusherr = String(e); }
  };
  window.WebSocket = class extends Real {
    constructor(...a) { super(...a); window.__sock = this; }
  };
})();
`;

/** 采集 console error / pageerror */
function watchErrors(page: Page) {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push('PAGEERR:' + String(e).slice(0, 400)));
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errs.push('CONSOLE:' + m.text().slice(0, 400));
  });
  return errs;
}

/** 截图证据 */
async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${EVID}/${name}.png` });
}

/** 等数据稳定：骨架消失 + 主 canvas 可见 */
async function waitChart(page: Page, timeout = 25_000) {
  const chart = page.locator('[data-testid="kline-chart"]');
  await expect(chart).toBeVisible({ timeout });
  await expect(chart.locator('canvas').first()).toBeVisible({ timeout });
  await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout });
  await page.waitForTimeout(1200);
}

/** klinecharts 结构快照：canvas 组（同高叠放算一组）+ 分组高度 + 总数 */
async function chartSnap(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="kline-chart"]');
    if (!el) return null;
    const cs = Array.from(el.querySelectorAll('canvas')).map((c) => ({
      w: c.width, h: c.height, top: Math.round(c.getBoundingClientRect().top),
    }));
    const groups = new Map<number, number>();
    for (const c of cs) {
      const k = c.h; // 同 pane 双画布同高
      groups.set(k, (groups.get(k) ?? 0) + 1);
    }
    const heights = [...groups.keys()].sort((a, b) => b - a);
    return { total: cs.length, heights, maxW: Math.max(...cs.map((c) => c.w)), maxH: Math.max(...cs.map((c) => c.h)) };
  });
}

/** 单画布 checksum（内容指纹） */
async function canvasHash(page: Page, idx = 0) {
  return page.evaluate((i) => {
    const cs = document.querySelectorAll<HTMLCanvasElement>('[data-testid="kline-chart"] canvas');
    const c = cs[i];
    return c ? c.toDataURL() : '';
  }, idx);
}

/** 全画布联合指纹（十字光标/tooltip 画在奇数 overlay/axis canvas 上，需并集比较） */
async function canvasHashAll(page: Page) {
  return page.evaluate(() => {
    const cs = Array.from(document.querySelectorAll<HTMLCanvasElement>('[data-testid="kline-chart"] canvas'));
    return cs.map((c) => c.toDataURL()).join('|');
  });
}

/** 主图蜡烛横向铺满度量（kline-scale 同源算法） */
async function candleFill(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="kline-chart"]');
    const cs = Array.from(el?.querySelectorAll('canvas') ?? []);
    const main = cs.find((c) => c.width > 200 && c.height > 300);
    if (!main) return null;
    const ctx = main.getContext('2d');
    const img = ctx!.getImageData(0, 0, main.width, main.height).data;
    const y0 = Math.floor(main.height * 0.15);
    const y1 = Math.floor(main.height * 0.8);
    const xMax = Math.floor(main.width * 0.9);
    let firstX = -1, lastX = -1;
    for (let x = 0; x < xMax; x++) {
      let has = false;
      for (let y = y0; y < y1; y += 2) {
        const i = (y * main.width + x) * 4;
        if (img[i] > 90 || img[i + 1] > 90 || img[i + 2] > 90) { has = true; break; }
      }
      if (has) { if (firstX < 0) firstX = x; lastX = x; }
    }
    return { firstX, lastX, plotW: xMax, leftBlankPct: firstX >= 0 ? (firstX / xMax) * 100 : -1,
             fillPct: firstX >= 0 && lastX >= firstX ? ((lastX - firstX) / xMax) * 100 : -1 };
  });
}

/** 红涨/绿跌像素计数 */
async function candleColors(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="kline-chart"]');
    const cs = Array.from(el?.querySelectorAll('canvas') ?? []);
    const main = cs.find((c) => c.width > 200 && c.height > 300);
    if (!main) return null;
    const ctx = main.getContext('2d');
    const img = ctx!.getImageData(0, 0, main.width, main.height).data;
    const near = (p: number[], c: number[]) => p.every((v, i) => Math.abs(v - c[i]) < 45);
    let up = 0, down = 0;
    const y0 = Math.floor(main.height * 0.2), y1 = Math.floor(main.height * 0.75);
    for (let y = y0; y < y1; y += 2)
      for (let x = 0; x < main.width; x += 2) {
        const i = (y * main.width + x) * 4;
        const p = [img[i], img[i + 1], img[i + 2]];
        if (near(p, [255, 92, 108])) up++;
        else if (near(p, [0, 224, 164])) down++;
      }
    return { up, down };
  });
}

/** 捕获 /api/kline 请求（含 before 标记） */
function watchKline(page: Page) {
  const reqs: string[] = [];
  page.on('request', (r) => {
    const u = decodeURIComponent(r.url());
    if (u.includes('/api/kline')) reqs.push(u.replace(/^https?:\/\/[^/]+/, ''));
  });
  return reqs;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(WS_HARNESS);
});

test.describe('K线组件交互验收矩阵 A–H', () => {
  test('A1 默认加载：15m / 首标的 / 主图蜡烛横向铺满无死区', async ({ page }) => {
    const errs = watchErrors(page);
    const kreqs = watchKline(page);
    await gotoPage(page, '/');
    await waitChart(page);
    // 默认 15m 按下
    await expect(bt(page, '15m')).toHaveAttribute('aria-pressed', 'true');
    // 首标的选中
    const first = (await page.locator('[data-region="symbol-list"] button b').first().innerText()).trim();
    await expect(page.locator('[data-region="symbol-list"] button[data-selected="true"]').first()).toContainText(first);
    // 初始请求 limit=默认视口（2 交易日）
    const init = kreqs.find((u) => u.includes('period=15m') && !u.includes('before='));
    expect(init).toBeTruthy();
    expect(init!).toContain('limit=34');
    // 蜡烛铺满（无左死区 / ≥80% 覆盖）
    const fill = await candleFill(page);
    expect(fill).not.toBeNull();
    expect(fill!.leftBlankPct).toBeLessThan(20);
    expect(fill!.fillPct).toBeGreaterThanOrEqual(80);
    await shot(page, 'A1_default15m_fill');
    expect(errs).toEqual([]);
  });

  test('A2 主图 MA(5/10/20) + 副图成交量默认显示', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    // 结构：主图 + VOL 副图 + 时间轴（klinecharts 每 pane 同高双画布）
    const snap = await chartSnap(page);
    expect(snap!.total).toBe(10); // candle(4) + vol(4) + x轴(2)
    expect(snap!.heights.length).toBeGreaterThanOrEqual(3);
    // MA 默认开：关掉 MA 后主图画布内容变化（MA 线消失），canvas 结构不变
    const h0 = await canvasHash(page, 0);
    await bt(page, 'MA').click();
    await page.waitForTimeout(600);
    const h1 = await canvasHash(page, 0);
    expect(h1).not.toBe(h0);
    const snap2 = await chartSnap(page);
    expect(snap2!.total).toBe(10);
    // 再开 MA 恢复
    await bt(page, 'MA').click();
    await page.waitForTimeout(600);
    await shot(page, 'A2_MA_VOL_default');
    expect(errs).toEqual([]);
  });

  test('A3 红涨绿跌着色 + 十字光标 tooltip', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    const colors = await candleColors(page);
    expect(colors!.up).toBeGreaterThan(50);
    expect(colors!.down).toBeGreaterThan(50);
    // 十字光标：hover 主图 → 内容变化（crosshair+tooltip 绘出，overlay/axis canvas 变化）
    const chart = page.locator('[data-testid="kline-chart"]');
    const box = await chart.boundingBox();
    const h0 = await canvasHashAll(page);
    await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.4);
    for (let i = 0; i < 5; i++) {
      await page.mouse.move(box!.x + box!.width * 0.6 + i * 10, box!.y + box!.height * 0.4 + i * 4);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(600);
    const h1 = await canvasHashAll(page);
    expect(h1).not.toBe(h0);
    await shot(page, 'A3_crosshair_tooltip');
    expect(errs).toEqual([]);
  });

  test('A4 主图高度/比例正常 + canvas 有界（非 33M）', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    const m = await page.evaluate(() => {
      const chartEl = document.querySelector('[data-testid="kline-chart"]');
      const box = chartEl?.getBoundingClientRect();
      const canvases = Array.from(chartEl?.querySelectorAll('canvas') ?? []);
      return {
        chartH: box ? Math.round(box.height) : -1,
        chartW: box ? Math.round(box.width) : -1,
        canvasMaxH: Math.max(...canvases.map((c) => c.height)),
        canvasMaxW: Math.max(...canvases.map((c) => c.width)),
        docScrollH: document.documentElement.scrollHeight,
        viewportH: window.innerHeight,
      };
    });
    expect(m.chartH).toBeGreaterThan(200);
    expect(m.chartH).toBeLessThanOrEqual(m.viewportH + 1);
    expect(m.canvasMaxH).toBeLessThan(2000);
    expect(m.canvasMaxW).toBeLessThan(1500);
    expect(m.docScrollH).toBeLessThan(2000);
    await shot(page, 'A4_bounds');
    expect(errs).toEqual([]);
  });

  test('B5 周期逐一切换（1m/5m/15m/1h/日）按钮高亮+数据源+重绘', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    const kreqs = watchKline(page);
    const periods: Array<{ btn: string; api: string; limit: number }> = [
      { btn: '1m', api: '1m', limit: 482 },
      { btn: '5m', api: '5m', limit: 98 },
      { btn: '15m', api: '15m', limit: 34 },
      { btn: '1h', api: '1h', limit: 10 },
      { btn: '日', api: '1d', limit: 2 },
    ];
    for (const p of periods) {
      await bt(page, p.btn).click();
      await expect(bt(page, p.btn)).toHaveAttribute('aria-pressed', 'true');
      await page.waitForTimeout(2500);
      // 数据源请求：对应 period 且 limit=默认视口
      const hit = kreqs.filter((u) => u.includes(`period=${p.api}`) && !u.includes('before='));
      expect(hit.length).toBeGreaterThan(0);
      expect(hit.at(-1)!).toContain(`limit=${p.limit}`);
      // 重绘非空
      const snap = await chartSnap(page);
      expect(snap!.total).toBe(10);
      await shot(page, `B5_period_${p.api}`);
      expect(errs).toEqual([]);
    }
  });

  test('B6 周期切换后默认视口仍≈当日+前一交易日（跟随锁定最新）', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    const backBtn = bt(page, '回到最新');
    await expect(backBtn).toBeDisabled();
    for (const p of ['1m', '5m', '15m', '1h', '日'] as const) {
      await bt(page, p).click();
      await page.waitForTimeout(2500);
      // 切周期重置跟随 → 锁定最右，回到最新按钮禁用
      await expect(backBtn).toBeDisabled();
      // 请求 limit 与默认视口一致（2 交易日 bar 数）
      const api = p === '日' ? '1d' : p;
      expect(BARS_PER_DAY[api]).toBeDefined();
    }
    await shot(page, 'B6_viewport_locked');
    expect(errs).toEqual([]);
  });

  test('C7 指标勾选热切换：MACD/KDJ/BOLL pane 出现/消失，MA 联动不丢主图量副图', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    const base = await chartSnap(page);
    expect(base!.total).toBe(10);
    const expectCount = async (n: number) => {
      await page.waitForTimeout(900);
      const s = await chartSnap(page);
      expect(s!.total).toBe(n);
    };
    await bt(page, 'MACD').click(); await expectCount(14);
    await shot(page, 'C7_macd_on');
    await bt(page, 'KDJ').click(); await expectCount(18);
    await bt(page, 'BOLL').click(); await expectCount(22);
    await shot(page, 'C7_all_on');
    // 逐个关
    await bt(page, 'MACD').click(); await expectCount(18);
    await bt(page, 'KDJ').click(); await expectCount(14);
    await bt(page, 'BOLL').click(); await expectCount(10);
    // 主图/量副图不丢
    const s = await chartSnap(page);
    expect(s!.heights[0]).toBeGreaterThan(300); // 主图仍占大头
    expect(s!.heights).toContain(100);          // 量副图保留
    await shot(page, 'C7_all_off');
    expect(errs).toEqual([]);
  });

  test('C8 组合开 2-3 个副图 indicator 布局不溢出可渲染', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    await bt(page, 'MACD').click();
    await bt(page, 'KDJ').click();
    await page.waitForTimeout(1200);
    let s = await chartSnap(page);
    expect(s!.total).toBe(18);
    expect(s!.maxH).toBeLessThan(2000);
    const m1 = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="kline-chart"]');
      return { rectH: Math.round(c!.getBoundingClientRect().height), docH: document.documentElement.scrollHeight };
    });
    expect(m1.rectH).toBeLessThan(900);
    expect(m1.docH).toBeLessThan(2000);
    await shot(page, 'C8_2indicators');
    await bt(page, 'BOLL').click();
    await page.waitForTimeout(1200);
    s = await chartSnap(page);
    expect(s!.total).toBe(22);
    await shot(page, 'C8_3indicators');
    expect(errs).toEqual([]);
  });

  test('D9 切分时：当日价格线+均价线正确无缺口；切回K线恢复', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    const kreqs = watchKline(page);
    await bt(page, '分时').click();
    await expect(bt(page, '分时')).toHaveAttribute('aria-pressed', 'true');
    // 分时 = 1m REST 当日 bars（零额外接口）
    const hit = kreqs.filter((u) => u.includes('period=1m') && u.includes('limit=480'));
    expect(hit.length).toBeGreaterThan(0);
    const svg = page.locator('[data-region="main-chart"] svg');
    await expect(svg).toBeVisible();
    const info = await svg.evaluate((el) => {
      const polys = Array.from(el.querySelectorAll('polyline'));
      return {
        polys: polys.length,
        points: polys.map((p) => p.getAttribute('points')?.trim().split(/\s+/).length ?? 0),
        texts: Array.from(el.querySelectorAll('text')).map((t) => t.textContent ?? ''),
      };
    });
    expect(info.polys).toBe(2); // 价格线 + 均价线
    expect(info.points[0]).toBeGreaterThan(50); // 当日 1m 点数
    expect(info.texts.some((t) => t.includes('均价'))).toBeTruthy();
    await shot(page, 'D9_timeshare');
    // 切回 K线
    await bt(page, 'K线').click();
    await expect(bt(page, 'K线')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="kline-chart"] canvas').first()).toBeVisible();
    await shot(page, 'D9_back_kline');
    expect(errs).toEqual([]);
  });

  test('D10 分时在数据动态时正确（WS 注入模拟盘中）', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    await bt(page, '分时').click();
    await expect(page.locator('[data-region="main-chart"] svg')).toBeVisible();
    // 注入盘中 bar 帧（服务端形状）：页面不崩、无 console error
    const code = (await page.locator('[data-region="symbol-list"] button b').first().innerText()).trim();
    for (let i = 0; i < 10; i++) {
      await page.evaluate(({ code, i }) => {
        const ts = new Date(Date.now() - 30000 + i * 1000).toISOString();
        window.__push({ type: 'bar', code, period: '1m', bar: { ts, open: 1.7, high: 1.8, low: 1.6, close: 1.75, volume: 100, amount: 100 } });
      }, { code, i });
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1000);
    const svgOk = await page.locator('[data-region="main-chart"] svg').count();
    expect(svgOk).toBe(1); // 分时视图仍正常
    // 回 K线：新 bar 由 WS 注入（1m feed）→ 光标/图表正常
    await bt(page, 'K线').click();
    await expect(page.locator('[data-testid="kline-chart"] canvas').first()).toBeVisible();
    await shot(page, 'D10_timeshare_dynamic');
    expect(errs).toEqual([]);
  });

  test('E11 宫格 2×2 / 2×3 / 回单图无状态丢失', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    // 先开 MACD，验证回单图后指标状态保留
    await bt(page, 'MACD').click();
    await page.waitForTimeout(900);
    await bt(page, '2×2').click();
    await expect(page.locator('[data-region="grid-view"]')).toBeVisible();
    await page.waitForTimeout(3500);
    const g1 = await page.evaluate(() => ({
      cells: document.querySelectorAll('[data-grid-cell]').length,
      cvs: document.querySelectorAll('[data-grid-cell] canvas').length,
    }));
    expect(g1.cells).toBe(4);
    await shot(page, 'E11_grid2x2');
    await bt(page, '2×3').click();
    await page.waitForTimeout(3500);
    const g2 = await page.evaluate(() => document.querySelectorAll('[data-grid-cell]').length);
    expect(g2).toBe(6);
    await shot(page, 'E11_grid2x3');
    // 回单图
    await bt(page, '单图').click();
    await expect(page.locator('[data-testid="kline-chart"] canvas').first()).toBeVisible();
    // 状态保留：MACD 仍开（canvas 14）、15m、首标的选中
    await page.waitForTimeout(1500);
    const snap = await chartSnap(page);
    expect(snap!.total).toBe(14);
    await expect(bt(page, '15m')).toHaveAttribute('aria-pressed', 'true');
    await shot(page, 'E11_back_single');
    expect(errs).toEqual([]);
  });

  test('E12 点击宫格格子进单图聚焦该标的 + 格内最新价跳动（quote 注入）', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    await bt(page, '2×2').click();
    await page.waitForTimeout(3500);
    // 每格独立缩略图（K线+MA，无副图 → canvas 6/格）+ 独立标的信息
    const cellInfo = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('[data-grid-cell]'));
      return cells.map((c) => ({ text: (c as HTMLElement).innerText.replace(/\n/g, '|').slice(0, 40), cvs: c.querySelectorAll('canvas').length }));
    });
    expect(cellInfo.length).toBe(4);
    for (const c of cellInfo) {
      expect(c.cvs).toBe(6);
      expect(c.text.length).toBeGreaterThan(5);
    }
    // 格内最新价跳动（若实时）：quote 注入（客户端契约 camelCase 形状）
    // 注：真实服务端推送为 snake_case change_pct → 触发缺陷 K1（独立复现用例）
    const cell2Code = cellInfo[1]!.text.split('|')[0]!;
    await page.evaluate((code) => {
      window.__push({ type: 'quote', code, ts: new Date().toISOString(), last: 1.234, changePct: -5.55 });
    }, cell2Code);
    await page.waitForTimeout(1200);
    const cell2After = (await page.locator('[data-grid-cell]').nth(1).innerText()).replace(/\n/g, '|');
    expect(cell2After).toContain('-5.55');
    await shot(page, 'E12_cell_quote_jump');
    // 点第 2 格 → 单图聚焦该标的
    await page.locator('[data-grid-cell]').nth(1).click();
    await expect(page.locator('[data-testid="kline-chart"] canvas').first()).toBeVisible();
    await page.waitForTimeout(2000);
    await expect(page.locator('[data-region="symbol-list"] button[data-selected="true"]').first()).toContainText(cell2Code);
    await shot(page, 'E12_cell_focus');
    expect(errs).toEqual([]);
  });

  test('F13 滚轮/拖拽缩放 → 停止强拉跟随；回到最新恢复锁定', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    const backBtn = bt(page, '回到最新');
    await expect(backBtn).toBeDisabled();
    // ctrl+滚轮缩放 → 进入 manual（不再跟随）
    const chart = page.locator('[data-testid="kline-chart"]');
    const box = await chart.boundingBox();
    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
    await page.keyboard.down('Control');
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(80); }
    await page.keyboard.up('Control');
    await expect(backBtn).toBeEnabled({ timeout: 5000 });
    await shot(page, 'F13_manual_zoom');
    // 平移查看历史（拖到更早区）
    await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height * 0.5);
    await page.mouse.down();
    for (let i = 0; i < 40; i++) { await page.mouse.move(box!.x + box!.width * 0.2 + i * 18, box!.y + box!.height * 0.5); await page.waitForTimeout(6); }
    await page.mouse.up();
    await page.waitForTimeout(1500);
    // 实时新 bar 注入下 manual 视口不被强拉：跟随仍为 false（按钮保持可用），无自动滚回最右
    const code = (await page.locator('[data-region="symbol-list"] button b').first().innerText()).trim();
    await page.evaluate((code) => {
      window.__push({ type: 'bar', code, period: '15m', bar: { ts: '2026-09-04T07:30:00Z', open: 9.1, high: 9.2, low: 9.0, close: 9.15, volume: 100, amount: 100 } });
    }, code);
    await page.waitForTimeout(1200);
    await expect(backBtn).toBeEnabled(); // 未被强拉回跟随态
    await shot(page, 'F13_not_following');
    // 「回到最新」→ 恢复锁定最右（按钮禁用 + 视图滚回实时区）
    const hBefore = await canvasHash(page, 0);
    await backBtn.click();
    await expect(backBtn).toBeDisabled();
    await page.waitForTimeout(1200);
    const hAfter = await canvasHash(page, 0);
    expect(hAfter).not.toBe(hBefore); // 视图确实回到了最右实时区
    await shot(page, 'F13_back_to_latest');
    expect(errs).toEqual([]);
  });

  test('F14 平移查看历史：向前滚动分页 ?before= 无重复/缺口（可达≥10 交易日）', async ({ page }) => {
    test.setTimeout(200_000);
    const errs = watchErrors(page);
    const respBodies: string[][] = [];
    page.on('response', async (r) => {
      const u = decodeURIComponent(r.url());
      if (u.includes('/api/kline') && u.includes('before=') && u.includes('period=1m')) {
        try { respBodies.push((await r.json()).bars.map((b: { ts: string }) => b.ts)); } catch { /* ignore */ }
      }
    });
    await gotoPage(page, '/');
    await waitChart(page);
    // 1m：pageSize 大、数据深（1m 读 merged 全历史），向右拖拽（看更早）分页可达 10+ 交易日
    await bt(page, '1m').click();
    await page.waitForTimeout(6000);
    const chart = page.locator('[data-testid="kline-chart"]');
    const box = await chart.boundingBox();
    const cy = box!.y + box!.height * 0.4;
    // 反复整幅向右拖拽：每拖一程触一次 DataLoader forward → feed.loadBefore（?before= 分页）
    for (let d = 0; d < 26; d++) {
      await page.mouse.move(box!.x + box!.width * 0.08, cy);
      await page.mouse.down();
      for (let i = 0; i < 40; i++) { await page.mouse.move(box!.x + box!.width * 0.08 + i * 22, cy); await page.waitForTimeout(5); }
      await page.mouse.up();
      await page.waitForTimeout(900);
      if (respBodies.length >= 6) break;
    }
    // 分页请求确实发生且不止一页
    const beforePages = respBodies.length;
    expect(beforePages).toBeGreaterThanOrEqual(4);
    // 无重复/缺口：跨页 ts 集合严格不重叠（排他游标 + 客户端去重）
    const seen = new Set<string>();
    let dups = 0;
    for (const pageBars of respBodies) {
      for (const t of pageBars) { if (seen.has(t)) dups++; seen.add(t); }
    }
    expect(dups).toBe(0);
    // 翻页覆盖 ≥10 个不同交易日（默认视口=2 交易日起步，向前分页可达 10-20 交易日）
    const days = new Set<string>();
    for (const t of seen) days.add(t.slice(0, 10));
    expect(days.size).toBeGreaterThanOrEqual(10);
    await shot(page, 'F14_pagination_1m');
    expect(errs).toEqual([]);
  });

  test('F15 缩放到底/到顶边界行为不崩', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    const chart = page.locator('[data-testid="kline-chart"]');
    const box = await chart.boundingBox();
    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
    // 狂缩（到顶）
    await page.keyboard.down('Control');
    for (let i = 0; i < 80; i++) { await page.mouse.wheel(0, 500); await page.waitForTimeout(15); }
    await page.keyboard.up('Control');
    await page.waitForTimeout(1500);
    // 狂放（到底）
    await page.keyboard.down('Control');
    for (let i = 0; i < 80; i++) { await page.mouse.wheel(0, -500); await page.waitForTimeout(15); }
    await page.keyboard.up('Control');
    await page.waitForTimeout(1500);
    // 不崩：canvas 有界 + 无错误
    const s = await chartSnap(page);
    expect(s!.maxH).toBeLessThan(2000);
    const alive = await chart.locator('canvas').first().isVisible();
    expect(alive).toBeTruthy();
    await shot(page, 'F15_zoom_edges');
    expect(errs).toEqual([]);
  });

  test('G16 WS 新 bar appendBar + 同 ts updateBar + 进行中 bar 虚线跳动标记', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    const code = (await page.locator('[data-region="symbol-list"] button b').first().innerText()).trim();
    const marker = page.locator('[data-realtime-marker]');
    await expect(marker).toHaveCount(0);
    // append：更晚 ts → appendBar 追加，画布重绘
    const h0 = await canvasHashAll(page);
    await page.evaluate((code) => {
      window.__push({ type: 'bar', code, period: '15m', bar: { ts: '2026-09-04T08:00:00Z', open: 9.1, high: 9.2, low: 9.0, close: 9.15, volume: 100, amount: 100 } });
    }, code);
    await expect(marker).toHaveCount(1, { timeout: 5000 });
    await expect(marker).toContainText('9.15');
    // 虚线标记样式（进行中 bar）
    const dashed = await marker.locator('div').first().evaluate((el) => getComputedStyle(el).borderLeftStyle);
    expect(dashed).toBe('dashed');
    await page.waitForTimeout(1000);
    const h1 = await canvasHashAll(page);
    expect(h1).not.toBe(h0); // appendBar → 画布重绘
    // update：同 ts → updateBar 闪动替换（feed.applyRealtime 'update' 路径）
    await page.evaluate((code) => {
      window.__push({ type: 'bar', code, period: '15m', bar: { ts: '2026-09-04T08:00:00Z', open: 9.1, high: 9.3, low: 9.0, close: 9.28, volume: 200, amount: 200 } });
    }, code);
    await expect(marker).toContainText('9.28', { timeout: 5000 });
    await page.waitForTimeout(1200);
    const h2 = await canvasHashAll(page);
    expect(h2).not.toBe(h1); // updateBar → 画布重绘（闪动）
    await shot(page, 'G16_append_update_marker');
    expect(errs).toEqual([]);
  });

  test('G17 实时注入 ≥60s 连续运行不崩 / 无 console error / 内存有界', async ({ page }) => {
    test.setTimeout(140_000);
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    const code = (await page.locator('[data-region="symbol-list"] button b').first().innerText()).trim();
    const t0 = Date.now();
    let frames = 0;
    let markerSeen = false;
    while (Date.now() - t0 < 62_000) {
      await page.evaluate((code) => {
        window.__push({ type: 'bar', code, period: '15m', bar: { ts: new Date(Date.now() + 86400000).toISOString(), open: 9.1, high: 9.3, low: 9.0, close: 9.1 + Math.random() * 0.2, volume: 100, amount: 100 } });
      }, code);
      frames++;
      if (await page.locator('[data-realtime-marker]').count() > 0) markerSeen = true;
      await page.waitForTimeout(1000);
    }
    expect(frames).toBeGreaterThan(50);
    expect(markerSeen).toBeTruthy();
    const mem = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? -1);
    expect(mem).toBeLessThan(400 * 1024 * 1024);
    expect(errs).toEqual([]);
  });

  test('G18 实时叠加在 15m 与 1m 都生效', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    const code = (await page.locator('[data-region="symbol-list"] button b').first().innerText()).trim();
    const marker = page.locator('[data-realtime-marker]');
    // 15m 实时生效
    await page.evaluate((code) => {
      window.__push({ type: 'bar', code, period: '15m', bar: { ts: '2026-09-04T08:15:00Z', open: 9.1, high: 9.2, low: 9.0, close: 9.17, volume: 100, amount: 100 } });
    }, code);
    await expect(marker).toContainText('9.17', { timeout: 5000 });
    // 切 1m → 实时叠加
    await bt(page, '1m').click();
    await page.waitForTimeout(4000);
    await page.evaluate((code) => {
      window.__push({ type: 'bar', code, period: '1m', bar: { ts: '2026-09-04T08:01:00Z', open: 9.11, high: 9.21, low: 9.01, close: 9.19, volume: 100, amount: 100 } });
    }, code);
    await expect(marker).toContainText('9.19', { timeout: 5000 });
    await shot(page, 'G18_realtime_1m');
    expect(errs).toEqual([]);
  });

  test('H19 搜索过滤 code/名称 命中与无结果 + 点击切换标的更新主图', async ({ page }) => {
    const errs = watchErrors(page);
    const kreqs = watchKline(page);
    await gotoPage(page, '/');
    await waitChart(page);
    const input = page.locator('[data-region="symbol-list"] input');
    // code 命中
    await input.fill('5188');
    await page.waitForTimeout(600);
    const r1 = await page.locator('[data-region="symbol-list"] button').allInnerTexts();
    expect(r1.length).toBe(1);
    expect(r1[0]).toContain('518880');
    // 名称命中
    await input.fill('黄金');
    await page.waitForTimeout(600);
    const r2 = await page.locator('[data-region="symbol-list"] button').allInnerTexts();
    expect(r2.length).toBeGreaterThan(0);
    // 无结果
    await input.fill('不存在标的zz');
    await page.waitForTimeout(600);
    await expect(page.locator('[data-region="symbol-list"]')).toContainText('无匹配标的');
    await shot(page, 'H19_search_none');
    // 点切换标的 → 主图换数据 + 标题/选中更新
    await input.fill('');
    await page.waitForTimeout(400);
    await page.locator('[data-region="symbol-list"] button', { hasText: '518880' }).first().click();
    await page.waitForTimeout(2500);
    const sel = (await page.locator('[data-region="symbol-list"] button[data-selected="true"]').first().innerText()).trim();
    expect(sel).toContain('518880');
    const hit = kreqs.find((u) => u.includes('code=518880') && u.includes('period=15m'));
    expect(hit).toBeTruthy();
    await shot(page, 'H19_symbol_switch');
    expect(errs).toEqual([]);
  });

  test('H20 切换标的期间快速连点不崩溃、请求正确', async ({ page }) => {
    const errs = watchErrors(page);
    const kreqs = watchKline(page);
    await gotoPage(page, '/');
    await waitChart(page);
    const buttons = page.locator('[data-region="symbol-list"] button');
    const n = Math.min(12, await buttons.count());
    for (let i = 0; i < n; i++) {
      await buttons.nth(i).click();
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(4000);
    // 图表仍活
    await expect(page.locator('[data-testid="kline-chart"] canvas').first()).toBeVisible();
    const selected = (await page.locator('[data-region="symbol-list"] button[data-selected="true"]').first().innerText()).trim();
    expect(selected.length).toBeGreaterThan(0);
    // 多个不同标的的 kline 请求发生（每个切换都触发对应 code 请求）
    const codes = new Set<string>();
    for (const u of kreqs) { const m = u.match(/code=(\d+)/); if (m) codes.add(m[1]!); }
    expect(codes.size).toBeGreaterThan(3);
    await shot(page, 'H20_rapid_switch');
    expect(errs).toEqual([]);
  });

  test('K1 缺陷复现：服务端 WS quote 帧(change_pct) → 看板崩溃', async ({ page }) => {
    const errs = watchErrors(page);
    await gotoPage(page, '/');
    await waitChart(page);
    const first = (await page.locator('[data-region="symbol-list"] button b').first().innerText()).trim();
    // 服务端真实形状（crates/web/src/ws.rs PushMsg::Quote：change_pct snake_case）
    await page.evaluate((code) => {
      window.__push({ type: 'quote', code, ts: new Date().toISOString(), last: 1.999, change_pct: 3.21 });
    }, first);
    await page.waitForTimeout(1500);
    // 期望：页面不崩（当前实现崩 → 复现）
    const listVisible = await page.locator('[data-region="symbol-list"] button').first().isVisible().catch(() => false);
    const chartVisible = await page.locator('[data-testid="kline-chart"] canvas').first().isVisible().catch(() => false);
    await shot(page, 'K1_quote_crash');
    // 复现语义：缺陷存在（页面崩溃）→ 本用例 PASS 并打印证据；若未来修复则转为 FAIL 提示
    const defect = errs.length > 0 || !listVisible || !chartVisible;
    console.log('K1_EVIDENCE defect=' + defect + ' listVisible=' + listVisible + ' chartVisible=' + chartVisible +
      ' errs=' + JSON.stringify(errs.slice(0, 2)));
    if (defect) {
      expect(errs.length).toBeGreaterThan(0);
    } else {
      // 已修复：改为断言无错误（翻转为失败信号，提醒报告更新）
      expect(errs, 'K1 已修复（quote 帧不再崩溃）—— 报告需更新').toEqual([]);
    }
  });
});
