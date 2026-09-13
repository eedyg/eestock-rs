import { expect, test, type Page } from '@playwright/test';
import { gotoPage } from './helpers/pages';

/**
 * **红测试（当前必红）**：K 线看板「K线 与 VOL 之间多出一条分割线」（用户问题①）——期望的 pane/分隔线形态。
 *
 * 本文件位置（self-location）：`web/e2e/dashboard-pane-separator.e2e.ts`
 * 口径来源：`design/14-dcap-indicator/02-spec.md` §6（图表契约 C：DCAP = 独立副图 pane）、
 *           `design/06-web/01-dashboard.md` L2（`sub-chart` 区域契约「绝对定位仅作锚点占位」）。
 * 诊断/取证（本用例由该诊断产出）：`tester/test/047_issue1_stray_separator_diagnosis_execution.md`
 * 测试设计：`tester/design/014_issue1_pane_separator_red_test_design.md`
 * 证据：`tester/evidence/047/`
 *
 * ## 期望形态（用户可见口径）
 * 1. 单图看板 `[data-region="main-chart"]` 内的**全宽水平分割线只允许来自 klinecharts 的 pane 分隔元素**
 *    （klinecharts `SeparatorPane`：1px `#DDDDDD` 底 + 内嵌 `cursor:ns-resize` 拖拽层）；条数恒为
 *    「内容 pane 数 − 1」（K线+VOL ⇒ 1 条；再开 DCAP ⇒ 2 条）。
 * 2. `[data-region="sub-chart"]` 是**不可见占位锚点**（region 契约要求其存在），**不得**再画一条线。
 *    当前实现该 div 带 `border-t` ⇒ Tailwind preflight 默认边框色 `#e5e7eb` ⇒ 在主图区恒画一条静态浅灰线
 *    （0.8×main-chart 高，不随 pane 拖动移动）——这就是用户看到的那条多出来的线。**故本用例当前必红。**
 * 3. 用户场景：把第一条分隔线（K线|VOL 边界）往上拖 → klinecharts 分隔线随 pane 边界上移；不得存在
 *    「不随 pane 移动」的残留线。
 * 4. DCAP 开/关（独立副图）：pane 分隔线 1 ↔ 2 可逆（无空 pane 残留），且期间始终无残留线。
 *
 * ## 运行前置
 * `eestock-app` 在 `E2E_BASE_URL`（默认 `http://localhost:8081`）服务**本仓库当前构建**的 SPA + 后端（真实数据）：
 *   `cd web && E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/dashboard-pane-separator.e2e.ts`
 * 为什么必须是真实渲染：那条多余的线是 **DOM/CSS 计算样式 + 几何** 事实（jsdom 无 Tailwind CSS，计算样式恒 0
 * ⇒ 打桩测试对该缺陷「假绿」）；klinecharts pane 分隔元素也只有真实渲染才存在。
 * 安全性：用例只发 GET（非 GET 请求一律 abort 并在末尾断言 0 条）→ 不改线上状态；DCAP 勾选是**前端本地状态**
 * （不写 `/api/config/*`）。
 */

interface LineRec {
  tag: string;
  kind: string;
  topInMain: number;
  h: number;
  w: number;
}

interface PaneSeparatorProbe {
  error?: string;
  mainChart?: { h: number; w: number };
  anchor?: {
    classes: string;
    topInMain: number;
    h: number;
    borderTopWidth: string;
    borderTopStyle: string;
    borderTopColor: string;
    background: string;
  };
  separators?: LineRec[];
  strayLines?: LineRec[];
  allLines?: LineRec[];
}

/** 采集主图区的「全宽水平线」：klinecharts pane 分隔元素 vs 其他（= 残留线）。 */
function probePaneSeparators(page: Page): Promise<PaneSeparatorProbe> {
  return page.evaluate((): PaneSeparatorProbe => {
    const main = document.querySelector('[data-region="main-chart"]');
    const anchor = document.querySelector('[data-region="sub-chart"]');
    const host = document.querySelector('[k-line-chart-id]');
    const kc = host ? host.firstElementChild : null;
    if (!main || !anchor || !kc) {
      return { error: 'main-chart / sub-chart / [k-line-chart-id] 未渲染（页面未就绪）' };
    }
    const mr = main.getBoundingClientRect();
    const rel = (el: Element): { topInMain: number; h: number; w: number } => {
      const r = el.getBoundingClientRect();
      return { topInMain: +(r.top - mr.top).toFixed(2), h: +r.height.toFixed(2), w: +r.width.toFixed(2) };
    };
    const isKcSeparator = (el: Element): boolean => {
      const widget = el.firstElementChild as HTMLElement | null;
      return !!widget && widget.style.cursor === 'ns-resize';
    };

    const separators: LineRec[] = [];
    for (const el of Array.from(kc.children)) {
      if (!isKcSeparator(el)) continue;
      const cs = getComputedStyle(el);
      separators.push({
        tag: 'DIV[klinecharts-separator]',
        kind: `bg ${cs.backgroundColor}`,
        ...rel(el),
      });
    }

    const allLines: LineRec[] = [];
    for (const el of Array.from(main.querySelectorAll('*'))) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const borderTop = parseFloat(cs.borderTopWidth || '0');
      const opaqueBg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
      const thinOpaqueBg = r.height <= 3 && opaqueBg;
      const fullWidthBorder =
        borderTop > 0 && cs.borderTopStyle !== 'none' && r.width >= 0.9 * mr.width;
      if (!fullWidthBorder && !thinOpaqueBg && !isKcSeparator(el)) continue;
      const region = (el as HTMLElement).dataset.region;
      allLines.push({
        tag: el.tagName + (region ? `[data-region=${region}]` : '') + (isKcSeparator(el) ? '[klinecharts-separator]' : ''),
        kind: isKcSeparator(el)
          ? 'klinecharts-separator'
          : borderTop > 0
            ? `border-top ${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`
            : `bg ${cs.backgroundColor}`,
        ...rel(el),
      });
    }
    const acs = getComputedStyle(anchor);
    return {
      mainChart: { h: +mr.height.toFixed(2), w: +mr.width.toFixed(2) },
      anchor: {
        classes: anchor.className,
        ...rel(anchor),
        borderTopWidth: acs.borderTopWidth,
        borderTopStyle: acs.borderTopStyle,
        borderTopColor: acs.borderTopColor,
        background: acs.backgroundColor,
      },
      separators,
      strayLines: allLines.filter((l) => !l.tag.includes('klinecharts-separator')),
      allLines,
    };
  });
}

/** 失败诊断：把实测的线清单拼进断言消息（红的时候一眼看到「多了哪条线」）。 */
function diag(label: string, p: PaneSeparatorProbe): string {
  if (p.error) return `[${label}] ${p.error}`;
  return (
    `[${label}] main-chart h=${p.mainChart?.h}\n` +
    `  klinecharts 分隔线: ${JSON.stringify(p.separators)}\n` +
    `  残留线(应为空):     ${JSON.stringify(p.strayLines)}\n` +
    `  sub-chart 锚点:     ${JSON.stringify(p.anchor)}`
  );
}

test.describe('问题① 期望的 pane/分隔线形态（当前必红）', () => {
  test('单图看板：K线 与 VOL 之间只应有 klinecharts 自带的 pane 分隔线（无骨架残留线）', async ({ page }) => {
    // 0) 安全网：本用例只读——拦截并 abort 任何非 GET；末尾断言从未发生
    const nonGet: string[] = [];
    await page.route('**/*', async (route, req) => {
      if (req.method() !== 'GET') {
        nonGet.push(`${req.method()} ${req.url()}`);
        await route.abort();
        return;
      }
      await route.continue();
    });

    await gotoPage(page, '/');
    const chart = page.locator('[data-testid="kline-chart"]');
    await expect(chart, 'KlineChart 未渲染：看板需处于「单图 + K线」态且有数据').toBeVisible({ timeout: 30_000 });
    await expect(chart.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500); // 等 klinecharts layout（异步 Promise.then）落定

    // 1) 默认态（MA 开、VOL 常开、DCAP 关）：K线|VOL 之间**恰好 1 条** klinecharts 分隔线
    const s0 = await probePaneSeparators(page);
    expect(s0.error, diag('默认态', s0)).toBeUndefined();
    expect(s0.separators, diag('默认态', s0)).toHaveLength(1);
    // ★ 红点：除 klinecharts 分隔线外**不得**存在任何全宽水平线
    //   当前实现 `[data-region="sub-chart"]` 的 `border-t` ⇒ 恒有一条 rgb(229,231,235) 静态线
    //   （位于 0.8×main-chart 高，正是「K线 与 VOL 之间多出来的那条」）
    expect(s0.strayLines, `主图区内出现了非 klinecharts 的水平分割线\n${diag('默认态', s0)}`).toEqual([]);
    // ★ 红点：region 锚点必须是不画线的占位（Tailwind preflight ⇒ border-width:0 ⇒ 计算值 0px）
    expect(s0.anchor?.borderTopWidth, `sub-chart 锚点仍在画线：${diag('默认态', s0)}`).toBe('0px');

    // 2) 用户场景：把第一条分隔线（K线|VOL）往上拖 120px → 分隔线随 pane 上移、且仍无残留线
    const before = s0.separators![0]!;
    const handle = await page.evaluate(() => {
      const kc = document.querySelector('[k-line-chart-id]')?.firstElementChild;
      if (!kc) return null;
      const sep = Array.from(kc.children).find((el) => {
        const w = el.firstElementChild as HTMLElement | null;
        return !!w && w.style.cursor === 'ns-resize';
      });
      const widget = sep?.firstElementChild as HTMLElement | null;
      if (!widget) return null;
      const r = widget.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    expect(handle, diag('拖拽前', s0)).not.toBeNull();
    await page.mouse.move(handle!.x, handle!.y);
    await page.mouse.down();
    await page.mouse.move(handle!.x, handle!.y - 120, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    const s1 = await probePaneSeparators(page);
    expect(s1.separators!.length, diag('拖高 VOL 后', s1)).toBe(1);
    expect(s1.separators![0]!.topInMain, `拖拽未生效（分隔线未随 pane 移动）\n${diag('拖高 VOL 后', s1)}`).toBeLessThan(
      before.topInMain - 50,
    );
    expect(
      s1.strayLines,
      `拖高 VOL 后残留线仍然存在（用户报告的「一直存在」）\n${diag('拖高 VOL 后', s1)}`,
    ).toEqual([]);

    // 3) DCAP 开/关（独立副图）：分隔线 1 → 2 → 1 可逆，且全程无残留线
    // exact: 工具栏另有「DCAP 配置」按钮（同为 button）——必须精确匹配 DCAP 开关本身
    const dcap = page.getByRole('button', { name: 'DCAP', exact: true });
    await expect(dcap).toBeVisible();
    await dcap.click();
    await page.waitForTimeout(1200);
    const s2 = await probePaneSeparators(page);
    expect(s2.separators, `DCAP 开启后应多出 VOL|DCAP 的一条分隔线（内容 pane 3 ⇒ 2 条）\n${diag('DCAP 开', s2)}`).toHaveLength(2);
    expect(s2.strayLines, `DCAP 开后出现残留线\n${diag('DCAP 开', s2)}`).toEqual([]);

    await dcap.click();
    await page.waitForTimeout(1200);
    const s3 = await probePaneSeparators(page);
    expect(s3.separators, `DCAP 关闭后应回到 1 条（不得残留空 pane/多余分隔线）\n${diag('DCAP 关', s3)}`).toHaveLength(1);
    expect(s3.strayLines, `DCAP 关后出现残留线\n${diag('DCAP 关', s3)}`).toEqual([]);

    // 4) 只读保证：全程未发任何非 GET 请求
    expect(nonGet, '本用例不得改动线上状态（只允许 GET）').toEqual([]);
  });
});
