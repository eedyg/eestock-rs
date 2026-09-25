/**
 * ADR-028 §2.4b（D4.1）「买卖点醒目化 + L2 跳转 focus/精确到笔高亮/曲线竖线」——**tester 独立复验规格**（闸门 3）。
 *
 * 与实现方规格 `adr028-fill-focus-highlight.e2e.ts` 的区别（独立性）：
 *  1. **不引用实现方的截图/结论**：全部断言在自建视口/自建截图/自绘像素上重算；
 *  2. **像素级证据采用两个互相独立的口径**：
 *     ① 页面侧读 canvas `getImageData`（多 canvas 合成 → 白簇连通分量 + 标签 ink run）；
 *     ② `page.screenshot({clip})` 落盘 PNG，离线 PIL 复算（`raw/pixel_analyze.py`）。
 *  3. **判据比实现方更严**：focus 判据同时要求 K 线容器整体落在**视口**内（不只是滚动容器内）；
 *     高亮判据要求「白簇**恰 1 个**且质心落在被点那一笔的**堆叠位置**（±3px）」——
 *     按 bar 粗定位（M1 变异）或高亮 overlay 被静默丢弃（M2 变异）都会红；
 *  4. 三态提示用 `page.route` **注入数据面**（不改生产代码）构造 unmatched / unrecorded / loading。
 *  5. **2026-09-20（T4 flaky 取证后加固）**：`openRunSettled` 不再用 `waitForTimeout(2500)`「等落定」，改为
 *     **显式就绪判据**（图表 K 线 `dataList` 非空 + `data-marker-overlays` == 已加载成交笔数）；T4 另要求
 *     **写窗真身回执**（`wb-window-probe` rev 到位）后才读几何（见 `settleJump(page,{requireReceipt:true})`）。
 *     取证：`tester/evidence/20260920_t4_flaky_rootcause/report.md`。
 *
 * 真身（**2026-09-23 重锚**）：本波被测对象 = **当前工作树构建**（D6/D7 的上下分层 + 默认卡高 520）。
 *  实测事实：主机 `:8081` 的静态根 `web/dist` 是 **D6/D7 之前**的构建（`index-DhVqizDl.js`，Sep-22 14:28；
 *  产物中 `wb-kline-view`/`wb-detail-pane`/`eestock.result.cardHeights.v1` **命中 0**）⇒ 对 `:8081` 跑本规格
 *  读到的是**旧 UI**，无法作为新契约判据。故本波真身 = **沙箱构建 + preview**（不写 `web/dist`，遵守用户纪律）：
 *    cd web && npx vite build --outDir /tmp/reanchor-dist
 *    VITE_PROXY_TARGET=http://localhost:8081 npx vite preview --outDir /tmp/reanchor-dist --port 4188 --strictPort &
 *    E2E_BASE_URL=http://127.0.0.1:4188 ADR028V_DIST=/tmp/reanchor-dist \
 *      npx playwright test e2e/adr028-features-verify.e2e.ts --reporter=list --retries=0 --workers=1
 *  （API 仍由主机 `:8081` 代理——活库事实源不变；只有**前端产物**换成本次构建。）
 * 产物：`ADR028V_OUT`（默认 = **未跟踪**的 `tester/evidence/20260924_d9_spec_reanchor/raw/verify`）。
 *
 * ── 2026-09-24 **再重锚（ADR-028 §2.9 D9「三视图拆分」）**；按契约推导，禁按实现输出倒推 ──
 * 事实源：`ADR-028 §2.8/§2.9/§4 第 11·12 条/§5` + `design/17-…/08-plan-three-view-split.md`（D9-1..13）。
 * | 项 | 旧（D6/D7） | 新（D9） | 依据 |
 * |---|---|---|---|
 * | **T0 契约标记** | `wb-kline-view`/`wb-detail-pane`/`eestock.result.layout.v1`/`wb-indicator-menu`/`eestock.result.cardHeights.v1` | D9 命名：`wb-kline-view`/`wb-indicator-view`/`wb-detail-view`/`wb-detail-pane`/`wb-detail-tabs`/`wb-indicator-menu`/`eestock.result.layout.v2` + 模板前缀 `wb-splitter-`/`wb-restore-`（D9 之前不存在 ⇒ 有鉴别力）；并**新增反向锚**（被删的卡高机制标记 `wb-kline-preset`/`wb-card-resize-kline` **不得**出现） | §2.9-1/3/11 + D9-5（断言缺失） |
 * | **T3 滚动作用域** | 「**上栏容器**内滚回 K 线」（前置：把锚点滚出上栏可视区） | **作用域收敛到 K 线视图容器**：K 线视图**不滚**（scrollTop 恒 0 ∧ `scrollHeight ≤ clientHeight+1`）⇒ 旧前置**不可满足**、已删除；改为断言「页面 scrollY 不变 ∧ 明细与指标视图 scrollTop 不变（D9-10）∧ K 线常驻可见 ∧ 写窗回执 ok」 | §2.9-3（D9-4）+ §2.9-10（D9-10）+ §2.7-5（focus 作用域收敛） |
 * | **T3/T7 前置** | 「把窗口条在上栏容器内滚入视口」 | 删除：窗口条在 K 线视图**顶部且视图不滚** ⇒ **常驻可见**，改为直接断言其在 K 线视图可视区内 | D9-4 + §2.9-2（K 线视图常驻） |
 * | **T1/T4 阈值** | 阈值按「默认卡高 520 ⇒ 主图 371px」的像素映射校准 | 按 **D9-8① 恒等式**（`主图 = 内层 − 26 − 1×副图数 − Σ副图`）**运行时复算**（规格本来就用运行时 `yRaw` 作期望值 ⇒ 判据不变），并**新增 D9-8② 硬不变量断言**（`主图 ≥160 ∧ 副图 ≥30`）与恒等式读数落盘 | §2.9-6（D9-8①②） |
 * | **证据出口** | `tester/evidence/20260920_adr028_features_verify/raw`（**99 个已跟踪文件**） | **规格相对的未跟踪目录**（`ADR028V_OUT` / `E2E_EVIDENCE_DIR` 可覆盖） | AGENTS.md 2026-09-23 纪律 + 派工第 7 条 |
 */
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertResolvedByIdFresh,
  resolveRun,
  type ResolvedRun,
  type RunFetchPort,
  type RunFill,
  type RunListItem,
  type RunRoundTrip,
} from './adr028RunResolve';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT =
  process.env.ADR028V_OUT ??
  resolve(process.env.E2E_EVIDENCE_DIR ?? resolve(REPO, 'tester/evidence/20260924_d9_spec_reanchor/raw'), 'verify');

/** run A：rt_seq=1 的 44 笔中第 42/43 笔**同 bar**（bar_index=423，ts=1789660800）。 */
/** ── T0 真身锚点（2026-09-23 重锚；ADR-023 §6.2 契约推导）───────────────────────────────────────
 *  **旧契约**：硬编码 `EXPECT_BUNDLE_NAME/SHA256`（人工维护）⇒ 每次合法重构建都要人工改常量，否则红；
 *  且常量一旦过期，T0 的失败与它的**唯一目的**（「服务端跑的是不是本次被测的构建」）脱钩。
 *  **新契约**：目的不变，判据去掉人工常量，改为**两条互补**断言：
 *   ① **逐字节相等并记录**：`GET /` 的 index.html 引用的 `assets/index-*.js`（被服务产物）sha256
 *      == **被测静态根**（`ADR028V_DIST`，默认 `web/dist`）内同名文件 sha256，并把该值**落盘**（供跨波比对）。
 *   ② **契约命名标记在位**：被服务产物必须含 ADR-028 D6/D7 契约**命名**的标记
 *      （`wb-kline-view`/`wb-detail-pane`/`wb-tab-trades`/`wb-indicator-menu`/`eestock.result.cardHeights.v1`；
 *      事实源 = ADR-028 §2.6 第 3/5 项、§2.7 第 1/2 项 + `design/17-…/07-plan §3` 新增节点与 key 清单）。
 *      必要性：①**单独成立是同义反复**（任何构建都与自身相等）——2026-09-23 实测 `:8081` 静态根正是
 *      「无任何 D6/D7 标记的旧产物」，只留①则**服务端跑旧产物也会绿**；②把「服务端 == 被测构建」恢复成
 *      **可失败**判据（这本是旧常量锚点的职责）。
 *  说明：只有在静态根与被测构建**同一份**时 ① 才可能成立；换构建（或静态根被别的产物覆盖）⇒ ① 或 ② 变红，
 *  且失败信息自带两组 sha256/组件标记读数，无需人工维护常量。 */
const DIST_DIR = process.env.ADR028V_DIST ?? resolve(REPO, 'web/dist');
/** 被服务产物必须含有的**契约命名**标记（testid / 存储 key；不放实现内部符号名）。 */
const CONTRACT_MARKERS = [
  'wb-kline-view', // D9-1：K 线视图（常驻、不可收起；x 域锚）
  'wb-indicator-view', // D9-1：指标视图（**仅**四张曲线卡）
  'wb-detail-view', // D9-1：明细视图（4 tab）
  'wb-detail-pane', // D9-1：明细容器
  'wb-detail-tabs', // D9-1/D7-2：明细分段控件
  // 说明：两条分隔条与恢复条由**模板字面量**拼接（`wb-splitter-${boundary}` / `wb-restore-${view}`）
  // ⇒ 产物中只有前缀；且这两个前缀在 D9 **之前**不存在（旧为 `wb-pane-splitter` / `wb-detail-expand`）⇒ 有鉴别力。
  'wb-splitter-', // D9-1/D9-6：两条视图分隔条
  'wb-restore-', // D9-3：视图级恢复条（指标 / 明细）
  'wb-indicator-menu', // D6-5（D9 保留）：指标勾选收进浮层
  'eestock.result.layout.v2', // D9-11：三段比例 + 两个收起态独立 key
] as const;
/** **反向锚（D9-5 断言缺失）**：被删的卡高机制标记**不得**出现在被服务产物中。 */
const REMOVED_MARKERS = ['wb-kline-preset', 'wb-card-resize-kline'] as const;

/**
 * 目标 run：**一律谓词解析**（ADR-028 §2.10.1 裁决 3），**禁硬编码 run id**。
 * 动因（独立复验 §7.1）：硬编码的旧 run 会被新 run 顶出历史列表首屏 ⇒ 「运行不在历史列表内」假红。
 * 本族需要的**结构性前提**（已编进谓词 `pair`，不再是「某个具体 run」）：
 *  - rt_seq=1 有足够多笔；**数据末根 bar 上恰有一 Buy 一 Sell**（末根双笔场景）；
 *  - 存在**中段**成交（距末根 ≥{@link MID_GAP_BARS} 根）作对照样本（标签向**右**绘制、有右侧空间）。
 * ⇒ 只有一个目标 run；下标（末根双笔 / 中段成交）由**实测数据**推出，禁写死 42/43/1。
 */
let RUN_A = '';
let RT_A = 1;
/** 末根 bar 上的 Buy / Sell 下标（T1/T4/T5/T6/T7 的目标笔）。 */
let FILL_A = -1;
let FILL_B = -1;
/** 中段成交下标（距末根 ≥MID_GAP_BARS；T5 的「竖线随下一次跳转更新」目标）。 */
let FILL_C = -1;
/** 中段对照笔与数据末根的最小间距（根）：保证标签有右侧绘制空间 + 远离右缘。 */
const MID_GAP_BARS = 40;
/** 目标 run 的解析结果（含谓词原文与扫描证据；落盘供复核）。 */
let RUN_RESOLUTION: ResolvedRun | null = null;

/** 高亮存活时长（与 `KlineChart.HIGHLIGHT_DURATION_MS` 同口径）。 */
const HL_MS = 3000;
/** 堆叠间距（与 `KlineChart.FILL_DOT_DY_PX` 同口径；判据处不直接引用实现方常量，独立取 12）。 */
const STACK_DY = 12;
/** 白簇最小计重（< 该值视为恒定背景噪声，实测为 y 轴小簇 size 4/1）。 */
const CLUSTER_MIN = 30;
/**
 * 标签 ink run 阈值（D11 重锚，ADR-028 **§2.11.1** 新口径）。
 * 旧值 15 是**旧长标签**（`B 1.188×843.9619`，17 字符）下的校准；D11 决策 3 把标签缩短为 `方向×数量`
 * （如 `B×843.9619`，10 字符）⇒ **阈值随文本缩短而失真**。
 * 新口径：以**列覆盖率 ≥0.6** 为主判据（对文本长度不敏感），ink run 只作**辅判据**且按新短标签重标为 8
 * （= 最短实测短标签 `S×37764.7619` 的墨缝量级下限；旧口径 15 在短标签下会把「真的画了标签」判红）。
 * 依据：ADR-028 §2.11.1（“主判据与阈值无关”）+ 复验 §7.1 第 3 行（“按新短标签重标 / 改用列覆盖率为主判据”）。
 */
const INK_RUN_MIN = 8;
/** 列覆盖率主判据阀值（§7.1 第 3 行建议值）。 */
const INK_COVER_MIN = 0.6;
/** 标签 span 内绝对墨量下限（px）：旧值 120 是 17 字符长标签口径（实测 234）；
 *  短标签（10 字符）按同墨密度换算 ≈ 70 ⇒ 取 **60**（并一字保留对照区比较判据）。 */
const INK_MIN_PX = 60;
/** D9-8② 硬不变量（取代旧「默认卡高 520 ⇒ 主图 ≥320」的口径；D9-5 已删卡高机制）。 */
const MAIN_MIN_PX = 160;
const SUB_PANE_MIN_PX = 30;

const PAGE_CAPTURE = `
  (() => {
    const w = window;
    w.__wbCharts = [];
    w.__wbTexts = {};
    const orig = Map.prototype.set;
    Map.prototype.set = function (k, v) {
      try {
        if (v && typeof v === 'object' && typeof v.convertToPixel === 'function' && typeof v.getDataList === 'function') {
          w.__wbCharts.push(v);
        }
      } catch {}
      return orig.call(this, k, v);
    };
    // T2 仪表：记录渲染器自己的 fillText 锚点（按文本去重，后写覆盖）⇒ 标签锚点判据的目标专属依据。
    try {
      const proto = CanvasRenderingContext2D.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'font');
      if (d && d.get && d.set) {
        Object.defineProperty(proto, 'font', {
          configurable: true,
          get() { return d.get.call(this); },
          set(v) { try { this.__wbFont = v; } catch {} return d.set.call(this, v); },
        });
      }
      const ft = proto.fillText;
      proto.fillText = function (text, x, y) {
        try {
          const t = String(text);
          if (t.length > 0 && t.length <= 64) {
            const m = w.__wbTexts;
            m[t] = { text: t, font: this.__wbFont || '', align: this.textAlign, x: x, y: y, n: (m[t] ? m[t].n : 0) + 1 };
          }
        } catch {}
        return ft.apply(this, arguments);
      };
    } catch {}
  })();
`;

function writeJson(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

async function readAttrs(page: Page, testId: string): Promise<Record<string, string>> {
  return page.getByTestId(testId).evaluate((e) =>
    Object.fromEntries(Array.from(e.attributes).map((a) => [a.name, a.value])),
  );
}

/** 页面上屏的图表真身状态（就绪判据读点）。 */
async function chartReadyState(page: Page): Promise<{ maxDataLen: number; markers: string; fillsNote: string }> {
  const dataLens = await page.evaluate(() => {
    const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    return (w.__wbCharts ?? []).map((c) => {
      try {
        return (((c['getDataList'] as () => unknown[])() ?? []) as unknown[]).length;
      } catch {
        return -1;
      }
    });
  });
  const markers = (await page.getByTestId('kline-chart').getAttribute('data-marker-overlays')) ?? '';
  const fillsNote = (await page.getByTestId('wb-fills-note').textContent()) ?? '';
  return { maxDataLen: dataLens.reduce((a, b) => Math.max(a, b), 0), markers, fillsNote };
}

/** 由 `wb-fills-note` 文案导出**期望已建标记数**（= 已加载成交笔数）。
 *  与 K 线标记的事实源同源：`成交合计 N 笔（精确源 /fills，已加载 L / 共 N）` ⇒ 期望 L（每笔一个 fillDot）。
 *  `加载中…` / `未记录…` ⇒ 期望 0（与 T6b/T6c 的显式判据同口径）。
 *  文案无法解析 ⇒ **显式抛错**（就绪判据失去依据时必须变红，禁止静默放宽）。 */
function expectedMarkerCount(fillsNote: string): number {
  if (fillsNote.includes('加载中')) return 0;
  if (fillsNote.includes('未记录')) return 0;
  const m = /已加载\s*(\d+)\s*\/\s*共\s*\d+/.exec(fillsNote);
  if (!m) throw new Error(`wb-fills-note 文案无法解析（就绪判据失效，须更新规格）：${fillsNote}`);
  return Number(m[1]);
}

/** 打开工作台 + 选中 run + 等初始装载落定（结果页可见、窗口事实源来自 kline、成交明细到位）。
 *
 *  **2026-09-20（T4 flaky 取证）**：本条原先以 `waitForTimeout(2500)`「等落定」——固定 sleep 不能保证任何
 *  前置条件成立（数据慢于 2.5s ⇒ 断言跑在未就绪状态上；数据快于 2.5s ⇒ 白白等待）。现改为**显式就绪判据**：
 *  ① 图表 K 线数据到位（`dataList` 非空 ⇒ 窗口事实源/几何定位可用）；
 *  ② 成交明细到位且**每笔成交一个 `fillDot`**（`data-marker-overlays` == 已加载成交数，读页面自身上屏口径）。
 *  就绪判据超时 ⇒ 显式红（附实际/期望计数），不再随机停在后续断言上。
 *  取证与残留在产品侧的竞态见 `tester/evidence/20260920_t4_flaky_rootcause/report.md`。 */
async function openRunSettled(page: Page, runId: string): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const sel = page.getByTestId(`wb-run-select-${runId}`);
  await expect(page.locator('[data-testid^="wb-run-select-"]').first()).toBeVisible();
  // **历史列表分页**（§7.1 第 2 行）：库已 90+ run，目标 run 会被顶出首屏 ⇒ 必顶“加载更多”
  // 直到目标出现（无翻页就会在「run 打开处」假红，且与本批语义无关）。
  for (let i = 0; i < 30 && (await sel.count()) === 0; i++) {
    const more = page.getByTestId('wb-runs-more');
    if ((await more.count()) > 0) {
      await more.scrollIntoViewIfNeeded().catch(() => {});
      await more.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(300);
  }
  await expect(sel, `运行 ${runId} 必须在历史列表内（已翻页查找）`).toBeVisible();
  await sel.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-window-bar')).toBeVisible();
  await expect(page.getByTestId('wb-fills-note')).toBeVisible();
  // ① 图表 K 线数据就绪（窗口事实源来自 kline；dataList 为空则「定位/画标记」无从谈起）
  await expect
    .poll(async () => (await chartReadyState(page)).maxDataLen, {
      timeout: 15_000,
      intervals: [100],
      message: '图表 K 线数据必须到位（真图表实例 dataList 非空）',
    })
    .toBeGreaterThan(0);
  // ② 成交明细就绪 + 每笔成交一个标记（读页面上屏计数，与 T1/T4 判据同源）
  await expect
    .poll(
      async () => {
        const { markers, fillsNote } = await chartReadyState(page);
        const want = expectedMarkerCount(fillsNote);
        return markers === String(want) ? 'OK' : `MISMATCH data-marker-overlays=${markers} want=${want} note=${fillsNote}`;
      },
      {
        timeout: 15_000,
        intervals: [100],
        message: '成交明细到位后每笔成交必须已建成 fillDot 标记（data-marker-overlays == 已加载成交笔数）',
      },
    )
    .toBe('OK');
}

/** 真图表 store：`fillDot`（常态标记）/`fillDotHighlight`（跳转高亮）逐条读回。 */
type StoreDump = {
  ok: boolean;
  names: string[];
  fillDot: Array<{ key: string; stack: number; label: string; color: string; ts: number; price: number; zLevel: number }>;
  highlight: Array<{ key: string; stack: number; label: string; color: string; ts: number; price: number; zLevel: number; pulse: number }>;
};

async function storeDump(page: Page): Promise<StoreDump> {
  return page.evaluate(() => {
    const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    const cands = (w.__wbCharts ?? []).filter((c) => {
      try {
        return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
      } catch {
        return false;
      }
    });
    if (cands.length === 0) return { ok: false, names: [], fillDot: [], highlight: [] } as unknown as never;
    const chart = cands[0]!;
    const all = (chart['getOverlays'] as () => Array<Record<string, unknown>>)();
    const pick = (o: Record<string, unknown>) => {
      const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
      const pts = (o['points'] ?? []) as Array<{ timestamp?: number; value?: number }>;
      return {
        key: String(ext['fillKey'] ?? ''),
        stack: Number(ext['stackIndex'] ?? 0),
        label: String(ext['label'] ?? ''),
        color: String(ext['color'] ?? ''),
        pulse: Number(ext['pulse'] ?? 0),
        zLevel: Number(o['zLevel'] ?? 0),
        ts: Number(pts[0]?.timestamp ?? 0),
        price: Number(pts[0]?.value ?? 0),
      };
    };
    return {
      ok: true,
      names: all.map((o) => String(o['name'])),
      fillDot: all.filter((o) => o['name'] === 'fillDot').map(pick),
      highlight: all.filter((o) => o['name'] === 'fillDotHighlight').map(pick),
    } as unknown as never;
  }) as Promise<StoreDump>;
}


/** 几何（**键方案无关**）：按 (ts, price) 定位目标笔的渲染位置——供变异态（键被粗化）下仍能测到位置。 */
async function geomByFill(
  page: Page,
  targets: Array<{ ts: number; price: number }>,
): Promise<Record<string, { x: number; yRaw: number; y: number; stack: number; label: string; color: string; fillKey: string }>> {
  return page.evaluate((want) => {
    const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    const cands = (w.__wbCharts ?? []).filter((c) => {
      try {
        return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
      } catch {
        return false;
      }
    });
    if (cands.length === 0) return {};
    const chart = cands[0]!;
    const out: Record<string, unknown> = {};
    const all = (chart['getOverlays'] as (f?: unknown) => Array<Record<string, unknown>>)({ name: 'fillDot' });
    for (const o of all) {
      const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
      const pts = (o['points'] ?? []) as Array<{ timestamp: number; value: number }>;
      const hit = want.find((t) => Math.abs(pts[0]!.timestamp - t.ts * 1000) < 1000 && Math.abs(pts[0]!.value - t.price) < 1e-9);
      if (!hit) continue;
      const p = (chart['convertToPixel'] as (a: unknown, b: unknown) => { x?: number; y?: number })(
        { timestamp: pts[0]!.timestamp, value: pts[0]!.value },
        { paneId: 'candle_pane' },
      );
      const stack = Number(ext['stackIndex'] ?? 0);
      out[`${hit.ts}:${hit.price}`] = {
        x: Number(p.x ?? NaN),
        yRaw: Number(p.y ?? NaN),
        y: Number(p.y ?? NaN) + stack * 12,
        stack,
        label: String(ext['label'] ?? ''),
        color: String(ext['color'] ?? ''),
        fillKey: String(ext['fillKey'] ?? ''),
      };
    }
    return out as never;
  }, targets) as Promise<Record<string, { x: number; yRaw: number; y: number; stack: number; label: string; color: string; fillKey: string }>>;
}

/** 几何：目标 `fillKey` 的**渲染位置**（kline 容器相对坐标，**含堆叠偏移**）与锚点价/ts。 */
type Geom = Record<string, { x: number; yRaw: number; y: number; stack: number; label: string; labelDetail?: string; color: string; ts: number; price: number }>;
async function geomOf(page: Page, keys: string[]): Promise<Geom> {
  return page.evaluate((want) => {
    const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    const cands = (w.__wbCharts ?? []).filter((c) => {
      try {
        return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
      } catch {
        return false;
      }
    });
    if (cands.length === 0) return {};
    const chart = cands[0]!;
    const out: Record<string, unknown> = {};
    const all = (chart['getOverlays'] as (f?: unknown) => Array<Record<string, unknown>>)({ name: 'fillDot' });
    for (const o of all) {
      const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
      const key = String(ext['fillKey'] ?? '');
      if (!want.includes(key)) continue;
      const pts = (o['points'] ?? []) as Array<{ timestamp: number; value: number }>;
      const p = (chart['convertToPixel'] as (a: unknown, b: unknown) => { x?: number; y?: number })(
        { timestamp: pts[0]!.timestamp, value: pts[0]!.value },
        { paneId: 'candle_pane' },
      );
      const stack = Number(ext['stackIndex'] ?? 0);
      out[key] = {
        x: Number(p.x ?? NaN),
        yRaw: Number(p.y ?? NaN),
        y: Number(p.y ?? NaN) + stack * 12,
        stack,
        label: String(ext['label'] ?? ''),
        labelDetail: String(ext['labelDetail'] ?? ''),
        color: String(ext['color'] ?? ''),
        ts: Number(pts[0]!.timestamp),
        price: pts[0]!.value,
      };
    }
    return out as never;
  }, keys) as Promise<Geom>;
}

/** 绘图区宽度（CSS px）：K 线容器内最宽 canvas 的宽（DPR=1；与 `inkRun` 的列坐标同尺度）。 */
async function paneWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const kl = document.querySelector('[data-testid="kline-chart"]');
    if (!kl) return 0;
    const ws = Array.from(kl.querySelectorAll('canvas')).map((c) => c.width);
    return ws.length > 0 ? Math.max(...ws) : 0;
  });
}

/**
 * 选「中部且右侧留完整标签盒空间」的标记（T2 的**静止态**目标）。
 * 规则（可复核）：`x ∈ [40, paneW − 161]`；取最接近 pane 中点者；无候选 ⇒ 返回 null（调用方**显式红**）。
 */
function pickMidMarker(keys: string[], geom: Geom, paneW: number): string | null {
  const cands = keys.filter((k) => {
    const g = geom[k];
    if (!g || !Number.isFinite(g.x)) return false;
    return g.x >= 40 && g.x <= paneW - 161;
  });
  if (cands.length === 0) return null;
  const mid = paneW / 2;
  return cands.slice().sort((a, b) => Math.abs(geom[a]!.x - mid) - Math.abs(geom[b]!.x - mid))[0]!;
}

type TextRec = { text: string; font: string; align: string; x: number; y: number; n: number };
/** 渲染器自报的 `fillText` 记录（按文本；T2 的锚点判据依据）。 */
async function textRec(page: Page, text: string): Promise<TextRec | null> {
  return page.evaluate((t) => {
    const m = (window as unknown as { __wbTexts?: Record<string, TextRec> }).__wbTexts ?? {};
    return (m[t] ?? null) as never;
  }, text) as Promise<TextRec | null>;
}
async function clearTextRecs(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __wbTexts?: Record<string, unknown> }).__wbTexts = {};
  });
}

type Cluster = { size: number; cx: number; cy: number; x0: number; x1: number; y0: number; y1: number };
type WhiteScan = { pane: { w: number; h: number }; canvases: number; whiteTotal: number; clusters: Cluster[]; readErrors: string[] };

/** 页面侧读全部 canvas → 合成「近白像素」位图 → 连通分量（4 邻接）。 */
async function scanWhite(page: Page): Promise<WhiteScan> {
  return page.evaluate(() => {
    const kl = document.querySelector('[data-testid="kline-chart"]')!;
    const kr = kl.getBoundingClientRect();
    const W = Math.round(kr.width);
    const H = Math.round(kr.height);
    const grid = new Uint8Array(W * H);
    const cs = Array.from(kl.querySelectorAll('canvas'));
    const readErrors: string[] = [];
    let count = 0;
    for (const c of cs) {
      const cr = c.getBoundingClientRect();
      const ox = Math.round(cr.x - kr.x);
      const oy = Math.round(cr.y - kr.y);
      let data: Uint8ClampedArray;
      try {
        data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      } catch (e) {
        readErrors.push(String(e));
        continue;
      }
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (data[i + 3]! < 200) continue;
          if (data[i]! >= 240 && data[i + 1]! >= 240 && data[i + 2]! >= 240) {
            const gx = x + ox;
            const gy = y + oy;
            if (gx >= 0 && gx < W && gy >= 0 && gy < H && grid[gy * W + gx] === 0) {
              grid[gy * W + gx] = 1;
              count += 1;
            }
          }
        }
      }
    }
    const seen = new Uint8Array(W * H);
    const clusters: Cluster[] = [];
    for (let i = 0; i < W * H; i++) {
      if (grid[i] !== 1 || seen[i] === 1) continue;
      const stack = [i];
      seen[i] = 1;
      let n = 0, sx = 0, sy = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
      while (stack.length) {
        const p = stack.pop()!;
        const px = p % W;
        const py = (p - px) / W;
        n += 1; sx += px; sy += py;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (grid[q] === 1 && seen[q] === 0) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
      clusters.push({ size: n, cx: sx / n, cy: sy / n, x0, x1, y0, y1 });
    }
    clusters.sort((a, b) => b.size - a.size);
    return { pane: { w: W, h: H }, canvases: cs.length, whiteTotal: count, clusters: clusters.slice(0, 8), readErrors };
  });
}

/** 标签 ink：在给定 band 内，统计「含墨列」的最长连续列数（墨 = 与该标记同色的红字像素）。 */
type Ink = { maxRun: number; cols: Array<[number, number]>; total: number };
async function inkRun(page: Page, box: { x0: number; x1: number; y0: number; y1: number }): Promise<Ink> {
  return page.evaluate((b) => {
    const kl = document.querySelector('[data-testid="kline-chart"]')!;
    const kr = kl.getBoundingClientRect();
    const W = Math.round(kr.width);
    const cs = Array.from(kl.querySelectorAll('canvas'));
    const cols = new Map<number, number>();
    let total = 0;
    for (const c of cs) {
      const cr = c.getBoundingClientRect();
      const ox = Math.round(cr.x - kr.x);
      const oy = Math.round(cr.y - kr.y);
      let data: Uint8ClampedArray;
      try {
        data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      } catch {
        continue;
      }
      for (let x = Math.max(0, b.x0 - ox); x < Math.min(c.width, b.x1 - ox); x++) {
        for (let y = Math.max(0, b.y0 - oy); y < Math.min(c.height, b.y1 - oy); y++) {
          const i = (y * c.width + x) * 4;
          const r = data[i]!, g = data[i + 1]!, bl = data[i + 2]!;
          if (data[i + 3]! < 200) continue;
          if (r > 80 && r - g > 40 && r - bl > 25 && !(r >= 240 && g >= 240 && bl >= 240)) {
            const gx = x + ox;
            cols.set(gx, (cols.get(gx) ?? 0) + 1);
            total += 1;
          }
        }
      }
    }
    let best = 0;
    let cur = 0;
    const arr: Array<[number, number]> = [];
    for (let x = b.x0; x < b.x1; x++) {
      const n = cols.get(x) ?? 0;
      arr.push([x, n]);
      if (n >= 1) {
        cur += 1;
        if (cur > best) best = cur;
      } else {
        cur = 0;
      }
    }
    void W;
    return { maxRun: best, cols: arr.filter(([, n]) => n > 0), total };
  }, box);
}

/** 结果页几何读数（**2026-09-23 重锚**）：滚动容器由 `wb-result`（页级；§2.7 第 1 项已移除）收敛为
 *  **上栏** `wb-kline-view`（自身滚动），并读**下栏** `wb-detail-pane` 与页面级滚动事实（D7-4①②）。
 *  另加「蜡烛主图在上栏可视区内的可见比例」（§2.7 第 6 项弱档②的量化口径；K 线卡内首个 pane 子节点）。 */
type Rects = {
  viewport: { w: number; h: number };
  pageScrollY: number;
  pageScrollHeight: number;
  pageClientHeight: number;
  result: { x: number; y: number; w: number; h: number } | null;
  resultScrollTop: number;
  pane: { x: number; y: number; w: number; h: number } | null;
  scrollTop: number;
  paneClientH: number;
  paneScrollH: number;
  detail: { x: number; y: number; w: number; h: number } | null;
  detailScrollTop: number;
  /** D9：指标视图（自身滚动；D9-4/D9-10 要求跳转不得改其 scrollTop）。 */
  indicator: { x: number; y: number; w: number; h: number } | null;
  indicatorScrollTop: number;
  /** D9 观测性 + 几何（视图高/三段/夹取）。 */
  views: { kline: number; indicators: number; detail: number; available: number; clamped: string | null };
  paneMetrics: { candlePx: number | null; subPanes: Array<{ id: string; px: number | null }>; subPaneTotalPx: number | null } | null;
  headerPx: number | null;
  /** K 线内层容器（klinecharts 挂载点）高（D9-8① 恒等式输入）。 */
  inner2H: number;
  anchor: { x: number; y: number; w: number; h: number } | null;
  host: { x: number; y: number; w: number; h: number } | null;
  candle: { top: number; h: number; visiblePx: number; visibleRatio: number } | null;
  cardFullyInPane: boolean | null;
  cardTopAligned: boolean | null;
  overlapDetailPx: number | null;
};

async function rects(page: Page): Promise<Rects> {
  return page.evaluate(() => {
    const g = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const paneEl = document.querySelector('[data-testid="wb-kline-view"]') as HTMLElement | null;
    const detailEl = document.querySelector('[data-testid="wb-detail-pane"]') as HTMLElement | null;
    const se = document.scrollingElement as HTMLElement | null;
    const card = document.querySelector('[data-testid="wb-kline-chart"]')?.getBoundingClientRect() ?? null;
    const pane = paneEl?.getBoundingClientRect() ?? null;
    const detail = detailEl?.getBoundingClientRect() ?? null;
    const inner = document.querySelector('[data-testid="kline-chart"]');
    const kids = inner?.firstElementChild ? Array.from(inner.firstElementChild.children) : [];
    const cEl = kids.length > 0 ? kids[0]!.getBoundingClientRect() : null;
    const cVis = cEl && pane ? Math.max(0, Math.min(cEl.bottom, pane.bottom) - Math.max(cEl.top, pane.top)) : null;
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      pageScrollY: window.scrollY,
      pageScrollHeight: se?.scrollHeight ?? -1,
      pageClientHeight: se?.clientHeight ?? -1,
      result: g('[data-testid="wb-result"]'),
      resultScrollTop: (document.querySelector('[data-testid="wb-result"]') as HTMLElement | null)?.scrollTop ?? -1,
      pane: g('[data-testid="wb-kline-view"]'),
      scrollTop: paneEl?.scrollTop ?? -1,
      paneClientH: paneEl?.clientHeight ?? -1,
      paneScrollH: paneEl?.scrollHeight ?? -1,
      detail: g('[data-testid="wb-detail-pane"]'),
      detailScrollTop: detailEl?.scrollTop ?? -1,
      indicator: g('[data-testid="wb-indicator-view"]'),
      indicatorScrollTop:
        (document.querySelector('[data-testid="wb-indicator-view"]') as HTMLElement | null)?.scrollTop ?? -1,
      views: {
        kline: Number(document.querySelector('[data-testid="wb-result"]')?.getAttribute('data-view-height-kline')),
        indicators: Number(
          document.querySelector('[data-testid="wb-result"]')?.getAttribute('data-view-height-indicators'),
        ),
        detail: Number(document.querySelector('[data-testid="wb-result"]')?.getAttribute('data-view-height-detail')),
        available: Number(document.querySelector('[data-testid="wb-result"]')?.getAttribute('data-view-available')),
        clamped: document.querySelector('[data-testid="wb-result"]')?.getAttribute('data-view-clamped') ?? null,
      },
      paneMetrics: (() => {
        try {
          const raw = document.querySelector('[data-testid="kline-chart"]')?.getAttribute('data-pane-metrics');
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      })(),
      headerPx: (() => {
        const h = document.querySelector('[data-testid="wb-kline-card-header"]');
        return h ? Math.round(h.getBoundingClientRect().height) : null;
      })(),
      inner2H: (() => {
        const el = document.querySelector('[data-testid="kline-chart"]');
        return el ? Math.round(el.getBoundingClientRect().height) : -1;
      })(),
      anchor: g('[data-testid="wb-kline-focus-anchor"]'),
      host: g('[data-testid="wb-kline-chart"]'),
      candle: cEl
        ? {
            top: cEl.top,
            h: cEl.height,
            visiblePx: cVis ?? 0,
            visibleRatio: cEl.height > 0 ? (cVis ?? 0) / cEl.height : 0,
          }
        : null,
      cardFullyInPane: card && pane ? card.top >= pane.top - 1 && card.bottom <= pane.bottom + 1 : null,
      cardTopAligned: card && pane ? Math.abs(card.top - pane.top) <= 2 : null,
      overlapDetailPx:
        card && pane && detail
          ? Math.max(0, Math.min(card.bottom, pane.bottom, detail.bottom) - Math.max(card.top, pane.top, detail.top))
          : null,
    };
  });
}

/** 轻量读数：卡头高 / 内层高 / 真身 pane metrics（用于「高亮回常态后」的复核）。 */
function probePaneOnly() {
  const el = document.querySelector('[data-testid="kline-chart"]');
  const h = document.querySelector('[data-testid="wb-kline-card-header"]');
  let pm: unknown = null;
  try {
    const raw = el?.getAttribute('data-pane-metrics');
    pm = raw ? JSON.parse(raw) : null;
  } catch {
    pm = null;
  }
  return {
    headerPx: h ? Math.round(h.getBoundingClientRect().height) : null,
    inner2H: el ? Math.round(el.getBoundingClientRect().height) : -1,
    paneMetrics: pm as { candlePx: number | null } | null,
    candlePx: (pm as { candlePx: number | null } | null)?.candlePx ?? null,
  };
}

/**
 * 「K 线回到可见」的 **D9 形式**（**分档已取消**）：
 * D9-2/D9-4 规定 **K 线视图常驻且不滚** ⇒ K 线卡**恒**完整落在 K 线视图可视区内
 * （由 D9-8① `卡高 = K 线视图高 − 60` 保证）⇒ 判据收敛为「卡完整落在 K 线视图内」这**一条**。
 * 旧 D7 分档（强档=整卡在上栏内 / 弱档=卡顶对齐 + 主图可见 ≥80%，阈值实测 1065）随「上栏自身滚动」一并作废。
 */
function klineVisibleOk(r: Pick<Rects, 'cardFullyInPane'>): boolean {
  return r.cardFullyInPane === true;
}

/** 跳转后等「平滑滚动落定 + 高亮生效」（高亮只活 3s ⇒ 判据用 scrollTop 连续两次采样不变，最快 ~1.2s）。
 *
 *  `requireReceipt`（默认 false）：额外要求**写窗真身回执**到位（`wb-window-probe` 的
 *  `data-ok=true` 且 `data-rev == data-cmd-rev`，即最近一次命令已被 K 线实例读回确认）。
 *  几何/像素判据（T4）用它把「跳转是否真的落到图上」变成显式前置条件——F18「静默吞掉写窗」不再能用
 *  「滚动到了」蒙混（回执口径见 ADR-028 §3.4）。 */
async function settleJump(
  page: Page,
  opts: { maxMs?: number; requireReceipt?: boolean } = {},
): Promise<{ waitedMs: number }> {
  const maxMs = opts.maxMs ?? 3000;
  const t0 = Date.now();
  let prev = Number.NaN;
  let last = '{}';
  try {
  await expect
    .poll(
      async () => {
        const r = await rects(page);
        const active = await page.getByTestId('kline-chart').getAttribute('data-highlight-active');
        last = JSON.stringify({
          active,
          paneScrollTop: r.scrollTop,
          pane: r.pane,
          anchor: r.anchor,
          cardFullyInPane: r.cardFullyInPane,
          cardTopAligned: r.cardTopAligned,
          candle: r.candle,
          overlapDetailPx: r.overlapDetailPx,
          pageScrollY: r.pageScrollY,
          detailScrollTop: r.detailScrollTop,
          klineVisibleOk: klineVisibleOk(r),
        });
        if (active !== 'true' || !r.host || !r.pane) return false;
        // 「K 线回到可见」= D9 形式：K 线卡完整落在 K 线视图内（K 线视图常驻不滚 ⇒ 恒成立，
        //   但去掉身份恒等式/视图高度约束即会红，故仍具鉴别力）。
        if (!klineVisibleOk(r)) return false;
        // K 线视图（D9-4：不得滚动）与明细视图（D7-4②：跳转不得顶走明细）双双落定
        const stable =
          Number.isFinite(prev) &&
          Math.abs(r.scrollTop - prev) <= 1 &&
          r.scrollTop === 0;
        prev = r.scrollTop;
        if (!stable) return false;
        if (!opts.requireReceipt) return true;
        const p = await page.getByTestId('wb-window-probe').evaluate((e) => ({
          ok: e.getAttribute('data-ok'),
          rev: e.getAttribute('data-rev'),
          cmd: e.getAttribute('data-cmd-rev'),
        }));
        return p.ok === 'true' && p.rev !== '' && p.rev === p.cmd;
      },
      {
        timeout: maxMs,
        intervals: [120],
        message: opts.requireReceipt
          ? 'K 线视图静止（不滚）+ K 线可见 + 高亮生效 + 写窗真身回执 rev 到位'
          : 'K 线视图静止（不滚）+ K 线可见 + 高亮生效',
      },
    )
    .toBe(true);
  } catch (e) {
    // 失败自带状态画像（超时不得只剩一句「谓词为假」）
    writeJson('settleJump_fail', { last, waitedMs: Date.now() - t0 });
    throw e;
  }
  return { waitedMs: Date.now() - t0 };
}

/** K 线裁切截图（每次重测几何，视口内钳位）。 */
async function shotKline(page: Page, name: string) {
  const r = await rects(page);
  const vp = r.viewport;
  const x = Math.max(0, Math.round(r.host!.x));
  const y = Math.max(0, Math.round(r.host!.y));
  const width = Math.max(1, Math.min(Math.round(r.host!.w), vp.w - x));
  const height = Math.max(1, Math.min(Math.round(r.host!.h), vp.h - y));
  await page.screenshot({ path: resolve(OUT, name), clip: { x, y, width, height } });
  return { name, clip: { x, y, width, height } };
}

test.beforeEach(async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.addInitScript(PAGE_CAPTURE);
});

/**
 * `APIRequestContext` → {@link RunFetchPort} 适配器（只读；口径与 D10/D11 规格一致）。
 * 用 `beforeAll({request})`（不占 page）⇒ 解析先于任何用例完成，解析失败就**整体显式红**。
 */
function requestPort(request: APIRequestContext): RunFetchPort {
  return {
    listRuns: async () => {
      const resp = await request.get('/api/workbench/runs?limit=500');
      expect(resp.ok(), 'GET /api/workbench/runs').toBeTruthy();
      return (await resp.json()) as RunListItem[];
    },
    totalBars: async (id) => {
      const resp = await request.get(`/api/workbench/runs/${id}/bars?kind=per_bar&offset=0&limit=1`);
      expect(resp.ok(), `GET /bars per_bar ${id}`).toBeTruthy();
      const total = ((await resp.json()) as { total?: number }).total;
      expect(typeof total, '/bars per_bar 必须回 total').toBe('number');
      return total!;
    },
    roundTrips: async (id) => {
      const resp = await request.get(`/api/workbench/runs/${id}/round-trips?limit=5000`);
      expect(resp.ok(), `GET /round-trips ${id}`).toBeTruthy();
      return ((await resp.json()) as { round_trips?: RunRoundTrip[] }).round_trips ?? [];
    },
    fills: async (id, rt) => {
      const resp = await request.get(`/api/workbench/runs/${id}/round-trips/${rt}/fills?limit=500`);
      expect(resp.ok(), `GET /fills ${id}/${rt}`).toBeTruthy();
      return ((await resp.json()) as { fills?: RunFill[] }).fills ?? [];
    },
  };
}

const RESOLVE_SOURCE = process.env.E2E_BASE_URL ?? 'http://localhost:8081';

/**
 * **目标 run 解析（谓词 `pair`）** + 反硬编码护栏（现场重解析，**不走落盘缓存**）。
 * 下标 FILL_A/FILL_B/FILL_B1/FILL_C **全部由实测 `fills` 推出**（禁写死 42/43/1）：
 *   `FILL_A` = 末根 bar 上的 Buy、`FILL_B` = 末根 bar 上的 Sell（同 bar 双笔场景）；
 *   `FILL_B1` = 首个「距末根 ≥{@link MID_GAP_BARS} 根」的成交（中段对照）；
 *   `FILL_C` = 与 FILL_A 不同 ts 的另一中段成交（竖线更新用例）。
 * 前提不满足 ⇒ **显式抛错**（不得静默换 run / 换笔）。
 */
test.beforeAll(async ({ request }) => {
  const port = requestPort(request);
  const run = await resolveRun(port, 'pair', { sourceKey: RESOLVE_SOURCE });
  const fresh = await resolveRun(port, 'pair', { cacheDir: null, sourceKey: RESOLVE_SOURCE });
  assertResolvedByIdFresh(run.id, fresh, 'pair');
  RUN_RESOLUTION = run;

  const fills = await port.fills(run.id, 1);
  if (fills.length < 3) throw new Error(`谓词 pair 命中 run 的 rt1 成交仅 ${fills.length} 笔，前提不成立（显式红）`);
  const lastBar = Math.max(...fills.map((f) => f.bar_index));
  const buyIdx = fills.findIndex((f) => f.bar_index === lastBar && f.side === 'Buy');
  const sellIdx = fills.findIndex((f) => f.bar_index === lastBar && f.side === 'Sell');
  if (buyIdx < 0 || sellIdx < 0) {
    throw new Error(`谓词 pair 命中 run 的末根 bar(${lastBar}) 上必须有一 Buy 一 Sell（实得 buy=${buyIdx} sell=${sellIdx}）`);
  }
  const midIdx = fills.findIndex((f) => lastBar - f.bar_index >= MID_GAP_BARS && f.ts !== fills[buyIdx]!.ts);
  if (midIdx < 0) throw new Error(`谓词 pair 命中 run 无「距末根 ≥${MID_GAP_BARS} 根且 ts 异于末根双笔」的中段成交（竖线更新用例前提）`);

  RUN_A = run.id;
  RT_A = 1;
  FILL_A = buyIdx;
  FILL_B = sellIdx;
  FILL_C = midIdx;
  writeJson('run_resolution', {
    id: run.id,
    predicate: run.predicate,
    totalBars: run.totalBars,
    rtSeq: run.rtSeq,
    l2Count: run.l2Count,
    evidence: run.evidence,
    derived: { lastBar, buyIdx, sellIdx, midIdx, fills: fills.length, midGapBars: MID_GAP_BARS },
  });
});

/**
 * **D11 重锚**（ADR-028 §2.11）：标签**默认不显** ⇒ 凡断言「标签文本/墨迹」的用例必须**先开结果页开关**
 * （走产品自身的持久化配置 key，不是测试钩子）。开关失效 ⇒ 后续断言**显式红**（非空转）。
 */
async function enableMarkerLabels(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('eestock.wb.result.chartConfig.v1', JSON.stringify({ markerLabels: true }));
    } catch {
      /* 隐私模式：留给断言显式红 */
    }
  });
}

/**
 * **写窗回执判据（ADR-028 §2.10 决策 3 + §2.10.2 措辞修正）**——D10 之后的正确形式：
 *  ① 写窗**回执**必须成功：`data-applied-ok == 'true'`（一次性，证明 `setBarSpace`/定位未被静默吞掉）；
 *  ② **活体一致性**：`data-ok == 'true'`（当前一致）**或** `data-ok == 'false'` **且 `data-live-reasons` 非空**
 *     —— §2.10.2 明确：分页态与 `min=1` 夹取态**不要求**端点恒等，**以「必披露」为准（禁静默）**。
 *  反假绿：`ok=false` 且 reasons 为空（静默不一致）= **必红**；回执失败 = **必红**。
 *  实读（本机 pair run）：跳转态 ok=true；全览态/未记录成交态 `ok=false` + `domain-drift: 真身可见域 … ≠ 写回窗口域 …`
 *  （≥10s 稳定披露，非瞬态 ⇒ 旧写法 `data-ok == 'true'` 会在这两态恒红，属**判据过期**而非产品缺陷）。
 */
async function assertReceiptOrDisclosed(page: Page, ctx: string): Promise<Record<string, string>> {
  const p = await readAttrs(page, 'wb-window-probe');
  expect(p['data-applied-ok'], `${ctx}：写窗真身回执（一次性）必须成功`).toBe('true');
  if (p['data-ok'] !== 'true') {
    const reasons = p['data-live-reasons'] ?? '';
    expect(
      reasons.length,
      `${ctx}：活体不一致**必须披露**（ok=${p['data-ok']} 而 reasons 为空 = 静默不一致，禁）`,
    ).toBeGreaterThan(0);
    expect(reasons, `${ctx}：披露必须含具体量（domain-drift / bar-space-rewritten）`).toMatch(/domain-drift|bar-space-rewritten/);
  }
  return p;
}

/** 断言标签开关**真的**生效（前置自检：否则「无标签」态会让标签判据空转/假红）。 */
async function assertLabelGateOn(page: Page): Promise<void> {
  await expect(page.getByTestId('wb-marker-labels-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-marker-labels', 'on');
}

// ───────────────────────────────── T0 真身锚定 ─────────────────────────────────
test('T0 真身锚定：被服务产物 == 被测静态根产物（sha256 相等并记录）+ 契约标记在位', async ({ page }) => {
  const html = await (await page.request.get('/')).text();
  const m = /src="(\/assets\/index-[^"]+\.js)"/.exec(html);
  expect(m, 'index.html 必须引用打包产物').toBeTruthy();
  const url = m![1]!;
  const body = await (await page.request.get(url)).body();
  const servedSha = createHash('sha256').update(body).digest('hex');
  const localPath = resolve(DIST_DIR, url.replace(/^\//, ''));
  const local = readFileSync(localPath);
  const localSha = createHash('sha256').update(local).digest('hex');
  const localHtml = readFileSync(resolve(DIST_DIR, 'index.html'), 'utf8');
  const localRef = /src="(\/assets\/index-[^"]+\.js)"/.exec(localHtml)?.[1] ?? null;
  // 契约标记在**被服务产物字节**上核（鉴别力所在）
  const js = body.toString('utf8');
  const markers = Object.fromEntries(CONTRACT_MARKERS.map((k) => [k, js.includes(k)]));
  // 对照样本（**非断言**，供跨波比对）：主机 :8081 的静态根 `web/dist`（本波实测为 D6/D7 之前的构建）
  const hostSample = (() => {
    try {
      const hh = readFileSync(resolve(REPO, 'web/dist/index.html'), 'utf8');
      const hr = /src="(\/assets\/index-[^"]+\.js)"/.exec(hh)?.[1];
      if (!hr) return null;
      const hb = readFileSync(resolve(REPO, 'web/dist', hr.replace(/^\//, '')));
      return { ref: hr, sha256: createHash('sha256').update(hb).digest('hex'), bytes: hb.length };
    } catch {
      return null;
    }
  })();
  writeJson('t0_bundle', {
    baseURL: process.env.E2E_BASE_URL ?? '(playwright config)',
    url,
    servedSha256: servedSha,
    bytes: body.length,
    distDir: DIST_DIR,
    localPath,
    localSha256: localSha,
    localRef,
    contractMarkers: CONTRACT_MARKERS,
    markers,
    hostStaticRootSample: hostSample,
  });
  expect(localRef, '被测静态根 index.html 必须引用同一 bundle').toBe(url);
  expect(servedSha, `被服务产物必须与被测静态根（${DIST_DIR}）内同名文件逐字节一致`).toBe(localSha);
  const missing = Object.entries(markers).filter(([, v]) => !v).map(([k]) => k);
  expect(
    missing,
    `被服务产物必须含本波契约命名标记（缺 ⇒ 服务端跑的不是含 D9 三视图的构建）；实读 ${JSON.stringify(markers)}`,
  ).toEqual([]);
  // **反向锚（D9-5）**：被删的卡高机制标记不得复活（复活的唯一路径 = 卡高机制回到界面上）
  const resurrected = REMOVED_MARKERS.filter((m) => js.includes(m));
  const resurrectedHost = (() => {
    try {
      const hh = readFileSync(resolve(REPO, 'web/dist/index.html'), 'utf8');
      const hr = /src="(\/assets\/index-[^"]+\.js)"/.exec(hh)?.[1];
      if (!hr) return null;
      const hb = readFileSync(resolve(REPO, 'web/dist', hr.replace(/^\//, '')), 'utf8');
      return REMOVED_MARKERS.filter((m) => hb.includes(m));
    } catch {
      return null;
    }
  })();
  writeJson('t0_removed_markers', { resurrected, resurrectedHost, markers: [...REMOVED_MARKERS] });
  expect(
    resurrected,
    `D9-5 被删的卡高机制标记不得复活（实读 ${JSON.stringify(resurrected)}；复活即说明卡高机制回来了）`,
  ).toEqual([]);
});

// ───────────────────────────────── T1 醒目化结构（store） ─────────────────────────────────
test('T1 醒目化：真图表 store 中每笔成交一个 fillDot（含 `方向×数量` 标签/明细/堆叠序），同 bar 多笔可分辨，且无连线类 overlay', async ({ page }) => {
  // D11 重锚：标签**默认不显** ⇒ 本用例断言 store 里的 label 文本，必须先开开关（否则 store.label 为空字符串）
  await enableMarkerLabels(page);
  const fillsResp = await page.request.get(`/api/workbench/runs/${RUN_A}/round-trips/${RT_A}/fills?limit=500`);
  const fills = ((await fillsResp.json()) as { fills: Array<Record<string, number | string>> }).fills;
  const fA = fills[FILL_A]!;
  const fB = fills[FILL_B]!;
  expect(fA['bar_index'], `第 ${FILL_A}/${FILL_B} 笔必须同 bar（同 bar 多笔场景；谓词 pair 已保证末根双笔）`).toBe(fB['bar_index']);
  expect(fA['ts']).toBe(fB['ts']);

  await openRunSettled(page, RUN_A);
  await assertLabelGateOn(page);
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  await settleJump(page);

  const store = await storeDump(page);
  const geom = await geomOf(page, [`${RT_A}:${FILL_A}`, `${RT_A}:${FILL_B}`]);
  const attrs = await readAttrs(page, 'kline-chart');
  const gA = geom[`${RT_A}:${FILL_A}`]!;
  const gB = geom[`${RT_A}:${FILL_B}`]!;

  // **D11 决策 3 重锚**（旧值 `B <price>×<qty>` ⇒ 新值 `方向×数量`；全文进 `labelDetail`）：
  //  事实源 = `KlineResultChart.buildFillOverlays`：`label = \`${text}×${fmtNum(qty,'qty')}\``，
  //  `labelDetail = \`${text} ${fmtNum(price,'price')}×${qty}\``。
  const qtyA = Number(fA['qty']).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
  const qtyB = Number(fB['qty']).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
  const shortLabelA = `B×${qtyA}`;
  const shortLabelB = `S×${qtyB}`;
  const detailLabelA = `B ${Number(fA['price']).toFixed(3)}×${qtyA}`;
  const detailLabelB = `S ${Number(fB['price']).toFixed(3)}×${qtyB}`;

  writeJson('t1_marker_store', { store, geom, attrs, shortLabelA, shortLabelB, detailLabelA, detailLabelB, fA, fB });

  expect(store.ok, '必须捕获到真图表实例并读到 overlay store').toBe(true);
  expect(store.fillDot.length, 'fillDot overlay 数 == /fills 笔数（每笔一个标记）').toBe(fills.length);
  expect(store.names.filter((n) => n !== 'fillDot' && n !== 'fillDotHighlight'), '除标记/高亮外不得有其它 overlay（禁连线/区间覆盖）').toEqual([]);
  expect(attrs['data-marker-overlays']).toBe(String(fills.length));

  expect(gA.label, `第 ${FILL_A} 笔标签 == \`方向×数量\`（D11 决策 3：价格移入 labelDetail）`).toBe(shortLabelA);
  expect(gB.label, `第 ${FILL_B} 笔标签 == \`方向×数量\``).toBe(shortLabelB);
  expect(gA.labelDetail, 'labelDetail 必须是全文（方向 价格×数量）').toBe(detailLabelA);
  expect(gB.labelDetail, 'labelDetail 必须是全文').toBe(detailLabelB);
  expect(gA.label, '短标签必须与全文不同（否则「缩短」未生效）').not.toBe(gA.labelDetail);
  expect(gA.label).not.toBe(gB.label);
  expect(gA.color).toBe('#ff5c6c');
  expect(gB.color).toBe('#00e0a4');
  expect(gA.stack, '同 bar 第 1 笔堆叠序').toBe(0);
  expect(gB.stack, '同 bar 第 2 笔堆叠序').toBe(1);
  expect(gA.ts, '两点必须锚同一 bar').toBe(gB.ts);
  // **重锚（2026-09-23，契约推导）**：旧阈值「±2px」是在**旧主图 67px**（D6 之前）下校准的近似；
  //  ADR-028 §2.6 第 4 项/§4 第 8 条要求默认卡高 520 下**蜡烛主图 ≥320px**（实测 371px）⇒ 同一价格差
  //  映射的像素差 ×5.5（实测两笔锚点原始 y 差 = 4px）。判据本意 = 「两笔锚点**原始**位置几乎重合 ⇒
  //  可分辨性必须由**堆叠**提供」⇒ 改为与堆叠间距同量纲比较（绝对值一并落盘）。
  const dRaw = Math.abs(gB.yRaw - gA.yRaw);
  expect(
    dRaw,
    `同 bar 两笔锚点原始 y 差必须 < 堆叠间距 ${STACK_DY}px（否则可分辨性来自价格差而非堆叠；实测 ${dRaw}px，主图高 ${(await readAttrs(page, 'kline-chart'))['data-kline-pane-height'] ?? '?'}px）`,
  ).toBeLessThan(STACK_DY - 2);
  // **重锚（同上，2026-09-23）**：渲染模型 `y = yRaw + stack×STACK_DY` ⇒ Δy 期望 = ΔyRaw + STACK_DY（±2）。
  //  旧判据 12±2 隐含「两笔 yRaw 相同」——旧主图 67px 下成立、新主图 371px 下 ΔyRaw 实测 -4px ⇒ 硬钉必红。
  //  另保留**不可遮盖**判据（渲染 y 拉开到圆点直径 6.4px 以上），它才是本条断言的真实目的。
  const dY = gB.y - gA.y;
  const dRawY = gB.yRaw - gA.yRaw;
  writeJson('t1_stack_model', { dY, dRawY, yRawA: gA.yRaw, yRawB: gB.yRaw, expectDy: dRawY + STACK_DY, candlePx: attrs['data-pane-metrics'] });
  expect(
    Math.abs(dY - (dRawY + STACK_DY)),
    `同 bar 两笔渲染 y 差必须 ≈ ΔyRaw(${dRawY.toFixed(1)}) + 堆叠间距 ${STACK_DY}（实测 Δy=${dY}）`,
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(dY),
    `同 bar 两笔渲染 y 必须拉开到圆点直径 6.4px 以上（否则互相遮盖；实测 ${Math.abs(dY)}px，ΔyRaw=${dRawY}）`,
  ).toBeGreaterThan(6.4);
});

// ───────────────────────────────── T2 标签像素（ink run，[@mut]） ─────────────────────────────────
test('T2 醒目化像素 [@mut]：门控开 ⇒ `方向×数量` 标签真的落到 canvas（渲染器自报锚点 = 圆点 + 6.2px；列覆盖率为主判据）', async ({ page }) => {
  const fillsResp = await page.request.get(`/api/workbench/runs/${RUN_A}/round-trips/${RT_A}/fills?limit=500`);
  const fills = ((await fillsResp.json()) as { fills: Array<Record<string, number | string>> }).fills;

  // **静止态**选目标（不跳转）：跳转会触发取数窗口变更（前向分页/写回），使“圆点+标签”的像素邻域不可复现。
  await openRunSettled(page, RUN_A);
  const paneW = await paneWidth(page);
  const store = await storeDump(page);
  const keys = store.fillDot.map((m) => m.key);
  const geom = await geomOf(page, keys);
  // 目标 = 落在 pane 中部、且右侧留出完整标签盒空间的可见标记（`x + 6.2 + LW ≤ paneW − 1`）
  const midKey = pickMidMarker(keys, geom, paneW);
  expect(midKey, '必须能选到「右侧有完整标签空间」的中部标记（否则本用例前提不成立，显式红）').not.toBeNull();
  const key = midKey!;
  const idx = Number(key.split(':')[1]);
  const f = fills[idx]!;
  const qty = Number(f['qty']).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
  const expectedLabel = `B×${qty}`;
  const expectedDetail = `B ${Number(f['price']).toFixed(3)}×${qty}`;
  // `LW` 常量取**实现口径**（`FILL_LABEL_CW_PX=5.5` / `FILL_LABEL_PAD_PX=5`；旧 4.4+6 是本批已否定的低估式）；
  // 锚点偏移取实现口径 `x + r(3.2) + gap(3) = x + 6.2`（旧规格写 `x + 12`）。
  const LW = Math.round(5.5 * expectedLabel.length + 5);
  const g0 = geom[key]!;
  const box = { x0: Math.round(g0.x + 6.2), x1: Math.round(g0.x + 6.2 + LW), y0: Math.round(g0.y - 5), y1: Math.round(g0.y + 6) };

  // ① 默认态（门控关）的基线墨迹：同一 box 内**不含任何标签墨迹**（标签默认不画）
  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-marker-labels', 'off');
  const inkOff = await inkRun(page, box);

  // ② 开开关（产品自身的开关，走 UI）⇒ 同一 box 内应出现标签墨迹；并核对渲染器自报的 fillText 记录
  await clearTextRecs(page);
  const toggle = page.getByTestId('wb-marker-labels-toggle');
  await expect(toggle, 'D11 决策 4：结果页必须有标记标签开关').toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-marker-labels', 'on');
  await page.waitForTimeout(400); // 等 React 状态 → overlay 重建 → 重绘落定
  const geomOn = await geomOf(page, [key]);
  const g = geomOn[key] ?? g0;
  expect(Math.abs(g.x - g0.x), '开开关不得改变标记位置（否则差分口径失效）').toBeLessThanOrEqual(1);
  const inkOn = await inkRun(page, box);
  const rec = await textRec(page, expectedLabel);
  const coverageOn = inkOn.cols.length / LW;
  const coverageOff = inkOff.cols.length / LW;
  const shots = { on: await shotKline(page, 't2_label_on.png') };
  const attrs = await readAttrs(page, 'kline-chart');
  writeJson('t2_label_ink', {
    key, paneW, geom: g, box, LW, expectedLabel, expectedDetail,
    inkOff, inkOn, coverageOff, coverageOn, rec, attrs, shots,
    delta: inkOn.total - inkOff.total,
  });

  // ① **渲染器自报锚点**（目标专属、免疫密集态粘连）：渲染器必须真的 `fillText` 过该短标签，
  //    且锚点 = 圆点 + 6.2px（±2）、纵向落在圆点附近（±6）。锚点写错（如旧 x+12）⇒ 必红。
  expect(rec, `渲染器必须真的 fillText 过标签 ${JSON.stringify(expectedLabel)}（像素口径的“真身”依据）`).not.toBeNull();
  // 两层锚点都要对齐（**实现口径**，两组都由真身读数命中）：
  //   ① 标签**盒**左缘 = 圆点 + `r(3.2) + FILL_LABEL_GAP_PX(3)` = **+6.2**（旧规格写 +12 ⇒ 必红）；
  //   ② `fillText` 的**笔**位 = 盒左缘 + 模板 `paddingLeft(2)` = **+8.2**（klinecharts 按 textRect 绘制）。
  expect(box.x0, `标签盒左缘必须 = round(圆点 x + 6.2)（实测 ${box.x0} vs ${Math.round(g.x + 6.2)}）`).toBe(Math.round(g.x + 6.2));
  expect(
    Math.abs(rec!.x - (g.x + 8.2)),
    `fillText 笔位必须 = 圆点 x + 8.2（盒 +6.2 再加盒内 paddingLeft 2；实测 ${rec!.x} vs ${(g.x + 8.2).toFixed(1)}）`,
  ).toBeLessThanOrEqual(2);
  expect(Math.abs(rec!.y - g.y), `标签锚点 y 必须落在圆点附近（实测 ${rec!.y} vs ${g.y}）`).toBeLessThanOrEqual(6);

  // ② 像素口径（**独立于 store**）：门控开后同一 box 内出现标签墨迹，且**列覆盖率为主判据**
  //   （与文本长度无关，见 ADR-028 §2.11.1）；墨列 run 为**重标后**的辅判据（绝对 + 相对 LW）。
  expect(inkOn.total, `标签 span 内墨量必须 > 默认态基线（实测 on=${inkOn.total} vs off=${inkOff.total}）`).toBeGreaterThan(inkOff.total);
  expect(coverageOn, `标签文本覆盖率 ≥ ${INK_COVER_MIN}（实测 ${coverageOn.toFixed(3)}；短标签 ${expectedLabel}，LW=${LW}）`).toBeGreaterThanOrEqual(INK_COVER_MIN);
  expect(inkOn.total, `标签 span 内墨量 ≥ ${INK_MIN_PX}（实测 ${inkOn.total}；默认态基线 ${inkOff.total}）`).toBeGreaterThanOrEqual(INK_MIN_PX);
  expect(inkOn.maxRun, `墨列 run ≥ ${INK_RUN_MIN}（实测 ${inkOn.maxRun}；旧阈值 15 是 17 字符长标签口径，短标签下过紧）`).toBeGreaterThanOrEqual(INK_RUN_MIN);
  // 注：**不**设「maxRun ≥ 比例×LW」——门控开时相邻标签的背景盒会覆盖前一个标签的墨迹
  // （实测 maxRun=25 而 LW=55）⇒ maxRun 不是长度的线性量；长度相对口径由**覆盖率**承担（主判据）。
  // ③ **同 box 的反向对照（本用例内自证非恒真）**：默认态同 box 覆盖率必须 < 主判据阈值
  //   （门控失效 = 默认也画标签 ⇒ 该断言必红；标签不画 ⇒ ② 必红）。
  expect(
    coverageOff,
    `默认态（门控关）同 box 覆盖率必须 < ${INK_COVER_MIN}（实测 ${coverageOff.toFixed(3)}）——否则说明「默认态也在画标签」`,
  ).toBeLessThan(INK_COVER_MIN);
  // ④ store 口径（短标签 + 全文明细，与 /fills 事实源逐字对齐）
  expect(g.label, 'store 标签必须 = 方向×数量').toBe(expectedLabel);
  expect(g.labelDetail, 'store labelDetail 必须 = 方向 价格×数量 全文').toBe(expectedDetail);
});

// ───────────────────────────────── T3 focus 滚动（D9 重锚：作用域收敛到 K 线视图容器） ─────────────────────────────────
test('T3 focus [@mut]：L2 [跳转] 后作用域收敛到 **K 线视图容器**（K 线视图不滚 / 页面不滚 / 明细与指标 scrollTop 均不变 / K 线常驻可见 / 写窗回执 ok）', async ({
  page,
}) => {
  await openRunSettled(page, RUN_A);
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();

  // ── 前置（**D9 重锚**）──
  //  ① 旧前置「把 K 线锚点滚出**上栏**可视区」在 D9 下**不可满足**（K 线视图不滚，D9-4）⇒ 删除
  //     （保留它就会变成「恒真/恒假」的假判据）。
  //  ② 新前置 = **明细视图**与**指标视图**的 scrollTop 均 > 0 —— 使「跳转不动它们」（D9-10/D7-4②）
  //     具备鉴别力；并核验 K 线视图 scrollTop 恒 0（作用域容器无内部滚动）。
  //  注意：明细视图的 scrollTop 必须**只由本前置**设定——若跳转按钮不在明细视图可视区内，
  //  playwright `click()` 的 actionability 检查会自动 `scrollIntoViewIfNeeded` 而改变 scrollTop，
  //  从而把「跳转是否动了下栏」这条判据污染成「点击助手是否滚了」的假红。
  //  ⇒ 前置把**跳转按钮**摆到明细视图垂直中部（按钮在视口内 ⇒ 后续 click 不会自动滚动），
  //    再断言「明细 scrollTop > 0 ∧ 目标行仍在明细视口内」。
  await page.evaluate(
    ({ jumpId }) => {
      const pane = document.querySelector('[data-testid="wb-detail-pane"]') as HTMLElement | null;
      const btn = document.querySelector(`[data-testid="${jumpId}"]`) as HTMLElement | null;
      if (pane && btn) {
        const pr = pane.getBoundingClientRect();
        const br = btn.getBoundingClientRect();
        pane.scrollTop = pane.scrollTop + (br.top - pr.top) - Math.round(pane.clientHeight / 2);
      }
      const iv = document.querySelector('[data-testid="wb-indicator-view"]') as HTMLElement | null;
      if (iv) iv.scrollTop = Math.min(200, Math.max(1, iv.scrollHeight - iv.clientHeight));
    },
    { jumpId: `wb-l2-jump-${RT_A}-${FILL_A}` },
  );
  await page.waitForTimeout(300);
  const before = await rects(page);
  const detailBefore = before.detailScrollTop;
  const indicatorBefore = before.indicatorScrollTop;
  writeJson('t3_before_jump', before);

  expect(before.scrollTop, '前置：K 线视图 scrollTop 必须恒为 0（D9-4：K 线视图不滚）').toBe(0);
  expect(detailBefore, '前置：明细视图必须已滚动（否则「不变」无鉴别力）').toBeGreaterThan(0);
  expect(indicatorBefore, '前置：指标视图必须已滚动（否则「不变」无鉴别力）').toBeGreaterThan(0);
  const rowVisBefore = await page.evaluate(
    ({ rowId }) => {
      const pane = document.querySelector('[data-testid="wb-detail-pane"]') as HTMLElement | null;
      const r = document.querySelector(`[data-testid="${rowId}"]`) as HTMLElement | null;
      if (!pane || !r) return { found: false, visible: false };
      const p = pane.getBoundingClientRect();
      const rr = r.getBoundingClientRect();
      return { found: true, visible: rr.top >= p.top - 1 && rr.bottom <= p.bottom + 1, rowTop: Math.round(rr.top), paneTop: Math.round(p.top), paneBottom: Math.round(p.bottom) };
    },
    { rowId: `wb-l2-row-${RT_A}-${FILL_A}` },
  );
  writeJson('t3_row_visibility_before', rowVisBefore);
  expect(rowVisBefore.visible, '前置：目标行必须原本就在明细视图视口内（否则 D7-4③ 无鉴别力）').toBe(true);
  expect(
    before.cardFullyInPane,
    '前置：K 线卡必须完整落在 K 线视图内（D9-8① 恒等式的直接后果）',
  ).toBe(true);
  const shotBefore = await page.screenshot({ path: resolve(OUT, 't3_before_jump.png') }).then(() => 't3_before_jump.png');

  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  const settle = await settleJump(page, { requireReceipt: true });
  const after = await rects(page);
  const shotAfter = await page.screenshot({ path: resolve(OUT, 't3_after_jump.png') }).then(() => 't3_after_jump.png');
  const attrsAfter = await readAttrs(page, 'kline-chart');
  const viewAttrs = await readAttrs(page, 'wb-kline-view');
  writeJson('t3_focus_scope', {
    before,
    after,
    settle,
    detailBefore,
    indicatorBefore,
    attrsAfter,
    focusScrollRev: viewAttrs['data-focus-scroll'] ?? null,
    shotBefore,
    shotAfter,
  });

  // ── ① **作用域收敛**：K 线视图**不得**有内部滚动（旧实现是页级 `scrollIntoView`，其反证见下）──
  expect(after.scrollTop, 'D9-4 K 线视图 scrollTop 必须恒为 0（focus 作用域容器无内部滚动）').toBe(0);
  expect(
    after.paneScrollH,
    `D9-4 K 线视图不得有内部滚动（scrollHeight ${after.paneScrollH} ≤ clientHeight ${after.paneClientH} + 1）`,
  ).toBeLessThanOrEqual(after.paneClientH + 1);
  expect(after.pageScrollY, 'D7-1 页面级滚动必须为 0（focus 不得把页面滚走）').toBe(0);
  expect(after.pageScrollY, 'D7-4① 跳转前后 window.scrollY 不变').toBe(before.pageScrollY);
  expect(
    after.pageScrollHeight,
    'D7-1 页面不得可滚（scrollingElement.scrollHeight ≤ 视口高 + 1）',
  ).toBeLessThanOrEqual(after.viewport.h + 1);
  // ── ② **跳转纪律（D9-10 / D7-4②）**：明细与指标视图的滚动位置**均**不得改变 ──
  expect(after.detailScrollTop, 'D7-4② 跳转不得改变明细视图 scrollTop').toBe(detailBefore);
  expect(after.indicatorScrollTop, 'D9-10 跳转不得改变**指标视图** scrollTop（对齐 D7-4②）').toBe(indicatorBefore);
  // ── ③ **K 线常驻可见**（D9-2/D9-4）+ 主图硬不变量（D9-8②）+ 卡高恒等式（D9-8①）──
  expect(klineVisibleOk(after), 'D9-2/D9-4 跳转后 K 线卡必须完整落在 K 线视图内（常驻可见）').toBe(true);
  const pm = after.paneMetrics;
  const nSub = pm?.subPanes.length ?? 0;
  const subFloor = SUB_PANE_MIN_PX * nSub;
  /** D9-8① 恒等式右端 = 容器几何上**可达的主图上限**（副图已压到下限时）。
   *  **契约口径（D9-8② 与 §4 边界联立）**：`主图 ≥ 160` 与「副图优先被压」在容器不足时**不可同时满足**
   *  ⇒ 判据取 `主图 ≥ min(160, 内层 − 26 − 1×n − 30×n)`（= 要么满足硬下限，要么已把副图压到下限）。 */
  const attainable = after.inner2H - 26 - 1 * nSub - subFloor;
  const headerOver = Math.max(0, (after.headerPx ?? 20) - 20);
  expect(
    pm?.candlePx ?? 0,
    `D9-8② 主图 ≥ min(${MAIN_MIN_PX}, 可达上限 ${attainable})（实测 ${pm?.candlePx ?? 'n/a'}；卡头实测 ${after.headerPx}）`,
  ).toBeGreaterThanOrEqual(Math.min(MAIN_MIN_PX, attainable) - 2);
  // **显式登记（不静默）**：跳转高亮提示使卡头换行（恒 20 → 实测值）时，主图让位量不得超过卡头超出量。
  const mainShortfall = Math.max(0, MAIN_MIN_PX - (pm?.candlePx ?? 0));
  writeJson('t3_main_shortfall', {
    candlePx: pm?.candlePx ?? null,
    attainable,
    subFloor,
    nSub,
    headerPx: after.headerPx,
    headerOver,
    mainShortfall,
    inner2H: after.inner2H,
  });
  expect(
    mainShortfall,
    `D9-8② 主图让位量不得超过卡头超出量（卡头 ${after.headerPx} ⇒ 允许 ${headerOver}px；实读让位 ${mainShortfall}px）`,
  ).toBeLessThanOrEqual(headerOver);
  if (pm?.candlePx != null && pm.subPaneTotalPx != null) {
    expect(
      Math.abs(pm.candlePx - (after.inner2H - 26 - 1 * nSub - pm.subPaneTotalPx)),
      `D9-8① 主图 == 内层 − 26 − 1×副图数 − Σ副图（主图 ${pm.candlePx} / 内层 ${after.inner2H} / Σ副图 ${pm.subPaneTotalPx}）`,
    ).toBeLessThanOrEqual(2);
    for (const sp of pm.subPanes) {
      expect(sp.px ?? 0, `D9-8② 副图 ≥ ${SUB_PANE_MIN_PX}`).toBeGreaterThanOrEqual(SUB_PANE_MIN_PX);
    }
  }
  // ── ⑤ 让位的**归因与可恢复性**（不静默）──
  //  实测事实（本规格取证，见 `t3_main_shortfall.json`）：跳转后高亮提示文案**常驻于卡头**
  //  （直到「全览」或下一次跳转才被清除）⇒ 卡头由 恒 20 涨到 **38**、内层 −18、引擎把副图压到下限 30，
  //  主图停在 **156**（= 容器可达上限 `内层 − 26 − 1×n − 30×n`），**4px 低于 D9-8② 的 160**。
  //  ⇒ 本条**不静默放宽**：①断言让位量 ≤ 卡头超出量；②断言让位是**稳态**（3s 回常态后仍为同一读数，
  //     排除了「脉冲抖动」解释）；③断言「全览」清除提示后卡头回单行时 **主图必须回到 ≥160**（干净态硬下限）。
  await expect
    .poll(async () => (await readAttrs(page, 'kline-chart'))['data-highlight-active'], { timeout: 6000, intervals: [400] })
    .toBe('false');
  const afterHl = await page.evaluate(probePaneOnly);
  writeJson('t3_after_highlight_end', afterHl);
  const shortfall2 = Math.max(0, MAIN_MIN_PX - (afterHl.candlePx ?? 0));
  expect(
    shortfall2,
    `D9-8②（提示常驻态）主图让位量不得超过卡头超出量（卡头 ${afterHl.headerPx} ⇒ 允许 ${Math.max(0, (afterHl.headerPx ?? 20) - 20)}px；实读让位 ${shortfall2}px）`,
  ).toBeLessThanOrEqual(Math.max(0, (afterHl.headerPx ?? 20) - 20));
  expect(
    afterHl.candlePx,
    '让位是**稳态**（回常态后与提示激活期读数一致 ⇒ 非脉冲抖动）',
  ).toBe(pm?.candlePx ?? null);
  expect(
    (afterHl.paneMetrics as { clamped?: boolean } | null)?.clamped,
    '引擎已把副图压到下限并回报 clamped=true（让位已尽力，非静默丢弃）',
  ).toBe(true);

  // 干净态（「全览」清除提示 ⇒ 卡头回单行）⇒ **D9-8② 硬下限必须成立**
  await page.getByTestId('wb-window-reset').click();
  await page.waitForTimeout(900);
  const clean = await page.evaluate(probePaneOnly);
  writeJson('t3_after_reset_clean', clean);
  expect(clean.headerPx ?? 99, `「全览」后卡头必须回单行（实测 ${clean.headerPx}）`).toBeLessThanOrEqual(24);
  expect(
    clean.candlePx ?? 0,
    `D9-8② 干净态（无提示换行）主图硬下限 ≥ ${MAIN_MIN_PX}（实测 ${clean.candlePx}）`,
  ).toBeGreaterThanOrEqual(MAIN_MIN_PX);
  // ── ④ **写窗真身回执 + 活体一致性**（ADR-028 §2.10 决策 3 + **§2.10.2 措辞修正**）──
  //  旧写法 `data-ok == 'true'` 是在「窗口态 = 真身镜像」的旧语义下的判据；D10 之后 `ok` 是**活体一致性**，
  //  而**「全览 ⇒ 写回窗口域 ≠ 真身可见域」的分页/`min=1` 夹取态**由 §2.10.2 明确**不要求**端点恒等
  //  （原文：「该态以『必披露』为准（`data-ok=false` + `domain-drift`，**禁静默**），**不再要求**端点恒等」）。
  //  故重锚为**两条并列**（保持鉴别力：**静默不一致必红**）：
  //   ① 写窗**回执**必须成功（`data-applied-ok == 'true'`）；
  //   ② 活体要么一致（`data-ok == 'true'`），要么**不一致但已披露**（`data-ok == 'false'` ∧ reasons 非空）。
  //  实读（本机 pair run 全览态）：applied-ok=true；ok=false；reasons=`domain-drift: 真身可见域
  //  [1763481600, 1790006400] ≠ 写回窗口域 [1767542400, 1790006400]`（≥10s 稳定披露，非瞬态）。
  const probeAttrs = await assertReceiptOrDisclosed(page, 'T3 「全览」态');
  writeJson('t3_receipt_after_reset', { appliedOk: probeAttrs['data-applied-ok'], ok: probeAttrs['data-ok'], reasons: probeAttrs['data-live-reasons'], probe: probeAttrs });
  // ── ⑤ 高亮仍生效（D4.1）──
  expect(attrsAfter['data-highlight-active'], 'D4.1 跳转后高亮必须激活').toBe('true');
  expect(attrsAfter['data-highlight-key'], 'D4.1 高亮键必须精确到笔').toBe(`${RT_A}:${FILL_A}`);
  // ── ⑥ 三段视图分配不得被跳转改变（D9-6④ + §4-12⑥）──
  expect(after.views, 'D9-10 跳转不得改变三段视图高度分配').toEqual(before.views);
  expect(settle.waitedMs, '滚动/回执落定耗时（观测）').toBeGreaterThan(0);
});

// ───────────────────────────────── T4 精确到笔高亮 + 3 秒回常态（[@mut]） ─────────────────────────────────
test('T4 只高亮被点击那一笔 [@mut]：白描边簇恰 1 个且质心落在该笔堆叠位置；3 秒后回落为 0', async ({ page }) => {
  // D11 重锚：高亮 overlay **恒带标签**（决策 2），而 `fillDot` 的 label 受门控（决策 1）
  // ⇒ 若不开开关，`storeOn.highlight[0].label`（短标签）与 `gA.label`（空串）**必然不等** ⇒ 假红。
  // 门控开后两侧同为 `方向×数量`，本用例的真实判据（白簇**恰 1 个**且质心落在该笔堆叠位置）不变。
  await enableMarkerLabels(page);
  await openRunSettled(page, RUN_A);
  await assertLabelGateOn(page);
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const keyA = `${RT_A}:${FILL_A}`;
  const keyB = `${RT_A}:${FILL_B}`;
  const rowA = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(rowA).toBeVisible();
  // `scrollIntoViewIfNeeded`（默认 behavior:'auto' ⇒ 瞬时）返回即已就位；本条原先再 `waitForTimeout(250)`
  // 属无判据依据的固定等待（跳转前无任何断言依赖滚动位置）⇒ 删除（禁止用 sleep 充当时序护栏）。
  await rowA.scrollIntoViewIfNeeded();

  const gtFills = ((await (await page.request.get(`/api/workbench/runs/${RUN_A}/round-trips/${RT_A}/fills?limit=500`)).json()) as {
    fills: Array<{ ts: number; price: number }>;
  }).fills;
  const fA = gtFills[FILL_A]!;
  const fB = gtFills[FILL_B]!;

  // ── 点击第 42 笔 ──
  const tClick = Date.now();
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  const settle = await settleJump(page, { requireReceipt: true });
  // 几何必须在**跳转后**读（跳转前窗口为全览 174 根，目标 bar 的 x 完全不同；跳转后窗口收敛到目标），
  // 且按 (ts, price) 定位（**键方案无关**）⇒ 变异把键粗化后仍能测到目标位置。
  const geomCells = await geomByFill(page, [{ ts: fA.ts, price: fA.price }, { ts: fB.ts, price: fB.price }]);
  const gA = geomCells[`${fA.ts}:${fA.price}`];
  const gB = geomCells[`${fB.ts}:${fB.price}`];
  // 失败时留痕（几何步的任何残留异常都自带状态画像，不再只剩一句「不可测」）
  writeJson('t4_geom_state', {
    geomKeys: Object.keys(geomCells),
    geomCells,
    chartState: await chartReadyState(page),
    windowProbe: await readAttrs(page, 'wb-window-probe'),
  });
  expect(gA != null && gB != null, '跳转后目标笔几何必须可测（按 ts+价格定位）').toBe(true);
  const attrsOn = await readAttrs(page, 'kline-chart');
  const noteOn = await readAttrs(page, 'wb-jump-highlight-note');
  const storeOn = await storeDump(page);
  const scanOn = await scanWhite(page);
  const shotOn = await shotKline(page, 't4_kline_hl42_a.png');
  await page.waitForTimeout(170);
  const attrsP2 = await readAttrs(page, 'kline-chart');
  const scanP2 = await scanWhite(page);
  const shotP2 = await shotKline(page, 't4_kline_hl42_b.png');
  await page.screenshot({ path: resolve(OUT, 't4_page_hl42.png') });

  // 页面侧时间序列（150ms 采样 ~4.2s）：脉冲期白像素 → 3 秒后回落。
  // 采样窗 = 覆盖两枚叠点的紧邻区域（子矩形 getImageData，避免整幅拷贝）。
  const sampleBox = {
    x0: Math.round(Math.min(gA.x, gB.x) - 24),
    x1: Math.round(Math.max(gA.x, gB.x) + 24),
    y0: Math.round(Math.min(gA.y, gB.y) - 24),
    y1: Math.round(Math.max(gA.y, gB.y) + 24),
  };
  const series = await page.evaluate(
    async (arg) => {
      const b = arg.box;
      const out: Array<{ t: number; sinceClick: number; pulse: string | null; active: string | null; white: number }> = [];
      const t0 = Date.now();
      const kl = document.querySelector('[data-testid="kline-chart"]')!;
      const kr = kl.getBoundingClientRect();
      const cs = Array.from(kl.querySelectorAll('canvas'));
      while (Date.now() - t0 < 4200) {
        let white = 0;
        for (const c of cs) {
          const cr = c.getBoundingClientRect();
          const ox = Math.round(cr.x - kr.x);
          const oy = Math.round(cr.y - kr.y);
          const x = Math.max(0, b.x0 - ox);
          const y = Math.max(0, b.y0 - oy);
          const w = Math.min(c.width, b.x1 - ox) - x;
          const h = Math.min(c.height, b.y1 - oy) - y;
          if (w <= 0 || h <= 0) continue;
          const data = c.getContext('2d')!.getImageData(x, y, w, h).data;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3]! < 200) continue;
            if (data[i]! >= 240 && data[i + 1]! >= 240 && data[i + 2]! >= 240) white += 1;
          }
        }
        out.push({
          t: Date.now() - t0,
          sinceClick: Date.now() - arg.tClick,
          pulse: document.querySelector('[data-testid="kline-chart"]')!.getAttribute('data-highlight-pulse'),
          active: document.querySelector('[data-testid="kline-chart"]')!.getAttribute('data-highlight-active'),
          white,
        });
        await new Promise((r) => setTimeout(r, 150));
      }
      return out;
    },
    { box: sampleBox, tClick },
  );

  // ── 3 秒后（跳转后 ≥3.6s） ──
  expect(Date.now() - tClick, '采样窗口已越过高亮时长（时序证据）').toBeGreaterThan(HL_MS);
  const attrsAfter = await readAttrs(page, 'kline-chart');
  const storeAfter = await storeDump(page);
  const scanAfter = await scanWhite(page);
  const shotAfter = await shotKline(page, 't4_kline_after3s.png');
  await page.screenshot({ path: resolve(OUT, 't4_page_after3s.png') });

  // ── 再点第 43 笔（同 bar 另一笔） ──
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_B}`).click();
  const settleB = await settleJump(page);
  const attrsOnB = await readAttrs(page, 'kline-chart');
  const storeOnB = await storeDump(page);
  const scanOnB = await scanWhite(page);
  const shotOnB = await shotKline(page, 't4_kline_hl43.png');
  await page.waitForTimeout(HL_MS + 800);
  const scanAfterB = await scanWhite(page);
  const attrsAfterB = await readAttrs(page, 'kline-chart');

  writeJson('t4_highlight_pixels', {
    run: RUN_A, rt: RT_A, fillA: FILL_A, fillB: FILL_B,
    geom: { gA, gB, geomCells },
    settle, settleB,
    attrsOn, noteOn, storeOn, scanOn, shotOn,
    attrsP2, scanP2, shotP2,
    series,
    attrsAfter, storeAfter, scanAfter, shotAfter,
    attrsOnB, storeOnB, scanOnB, shotOnB, attrsAfterB, scanAfterB,
  });

  const bigOn = scanOn.clusters.filter((c) => c.size >= CLUSTER_MIN);
  const bigP2 = scanP2.clusters.filter((c) => c.size >= CLUSTER_MIN);
  const bigAfter = scanAfter.clusters.filter((c) => c.size >= CLUSTER_MIN);
  const bigOnB = scanOnB.clusters.filter((c) => c.size >= CLUSTER_MIN);
  const bigAfterB = scanAfterB.clusters.filter((c) => c.size >= CLUSTER_MIN);

  // ① 高亮存在 + 只高亮被点那一笔
  expect(attrsOn['data-highlight-key'], '高亮键必须精确到笔').toBe(keyA);
  expect(attrsOn['data-highlight-active']).toBe('true');
  expect(noteOn['data-state'], '高亮提示状态').toBe('ok');
  expect(storeOn.highlight.length, '真图表 store 中高亮 overlay 恰 1 条（只高亮被点那一笔）').toBe(1);
  expect(storeOn.highlight[0]!.key).toBe(keyA);
  expect(storeOn.highlight[0]!.stack, '高亮必须复用该笔堆叠序').toBe(gA.stack);
  expect(storeOn.highlight[0]!.label).toBe(gA.label);
  expect(bigOn.length, 'K 线区白描边簇恰 1 个（同 bar 另一笔不得同时高亮）').toBe(1);
  // x 容差 6px：目标 bar 为 run 末根时圆环被 candle pane 右边界裁掉右侧（质心左偏 ~4px，见离线 PNG 复算）
  expect(Math.abs(bigOn[0]!.cx - gA.x), '白簇质心 x == 该笔渲染位置（±6，末根 bar 受 pane 边界裁切）').toBeLessThanOrEqual(6);
  expect(Math.abs(bigOn[0]!.cy - gA.y), '白簇质心 y == 该笔渲染位置（含堆叠偏移，±3）').toBeLessThanOrEqual(3);
  expect(bigOn[0]!.y1 - bigOn[0]!.y0, '白簇高度 ≤ 24px（单枚圆环；两枚粘连会显著变高）').toBeLessThanOrEqual(24);
  expect(scanOn.canvases, '已扫描 canvas 数').toBeGreaterThan(1);
  expect(scanOn.readErrors, 'canvas 像素可读（无跨域污染）').toEqual([]);

  // ② 脉冲（定时器驱动重绘）：相位递增 + 白像素量随相位变化
  expect(Number(attrsP2['data-highlight-pulse']), '相位 B 必须 > 相位 A').toBeGreaterThan(Number(attrsOn['data-highlight-pulse']));
  expect(bigP2.length).toBe(1);
  const pulseSizes = new Set([bigOn[0]!.size, bigP2[0]!.size]);
  const seriesSizes = new Set(series.filter((s) => s.white > CLUSTER_MIN).map((s) => s.white));
  expect(seriesSizes.size, '脉冲期白像素量随时间变化（放大+描边脉冲）').toBeGreaterThan(1);
  writeJson('t4_pulse_stats', { pulseSizes: [...pulseSizes], seriesWhiteDistinct: seriesSizes.size });

  // ③ 3 秒后回常态（无永久选中态、无残留高亮 overlay）
  expect(attrsAfter['data-highlight-active'], '3 秒后必须回常态').toBe('false');
  expect(attrsAfter['data-highlight-pulse']).toBe('0');
  expect(storeAfter.highlight.length, '3 秒后高亮 overlay 必须清空').toBe(0);
  expect(bigAfter.length, '3 秒后白簇必须归零（描边消失）').toBe(0);
  expect(attrsAfter['data-highlight-key'], '键仍指向目标笔（仅高亮态结束；不得残留选中态样式）').toBe(keyA);
  const firstOff = series.find((s) => s.active === 'false');
  expect(firstOff, '时间序列必须出现回常态样本').toBeTruthy();
  expect(firstOff!.sinceClick, '回落时刻 ≈ 高亮时长 3s（自点击起算）').toBeGreaterThanOrEqual(2900);
  expect(firstOff!.sinceClick, '回落时刻不得显著超过 3s').toBeLessThanOrEqual(3600);
  expect(series.filter((s) => s.active === 'true').length, '时间序列必须覆盖脉冲期（若样本起步晚于 3s 则该断言会红，属时序护栏）').toBeGreaterThan(0);
  expect(series.filter((s) => s.active === 'false' && s.white > CLUSTER_MIN).length, '回常态后序列样本白像素必须为 0').toBe(0);

  // ④ 同 bar 另一笔：仍恰 1 个白簇，且质心下移一个堆叠间距（互斥 + 精确到笔）
  expect(attrsOnB['data-highlight-key']).toBe(keyB);
  expect(storeOnB.highlight.length, '点第 43 笔后高亮 overlay 仍恰 1 条').toBe(1);
  expect(storeOnB.highlight[0]!.key).toBe(keyB);
  expect(storeOnB.highlight[0]!.stack).toBe(gB.stack);
  expect(bigOnB.length, '同 bar 另一笔：白簇仍恰 1 个（不是两笔同时高亮）').toBe(1);
  expect(Math.abs(bigOnB[0]!.cx - gB.x)).toBeLessThanOrEqual(6);
  expect(Math.abs(bigOnB[0]!.cy - gB.y), '白簇质心 y == 第 43 笔渲染位置').toBeLessThanOrEqual(3);
  // **重锚（2026-09-23，契约推导）**：渲染模型 = `stacked y = yRaw + stack×STACK_DY`（stack_A=0 / stack_B=1）
  //  ⇒ 期望 Δcy = ΔyRaw + STACK_DY。旧判据把 Δcy 硬钉在 12±3，隐含「两笔锚点原始 y 相同」——该前提只在
  //  **旧主图 67px** 下近似成立；D6-3 要求默认 520 卡高下主图 ≥320px（实测 371px）⇒ ΔyRaw 实测 -4px
  //  ⇒ 硬钉 12±3 必红，且**与「堆叠是否生效」无关**（属度量口径错，非缺陷）。改按页面实测 ΔyRaw 作期望值；
  //  若堆叠失效 ⇒ Δcy ≈ ΔyRaw ⇒ 与期望差 = STACK_DY = 12 > 3 ⇒ 仍红（鉴别力保留）。
  const dRawY = gB.yRaw - gA.yRaw;
  const dCy = bigOnB[0]!.cy - bigOn[0]!.cy;
  writeJson('t4_stack_model', { dRawY, dCy, expectDcy: dRawY + STACK_DY, stackA: gA.stack, stackB: gB.stack, yRawA: gA.yRaw, yRawB: gB.yRaw });
  expect(
    Math.abs(dCy - (dRawY + STACK_DY)),
    `两次点击的白簇质心差必须 ≈ ΔyRaw(${dRawY.toFixed(1)}) + 堆叠间距 ${STACK_DY}（实测 Δcy=${dCy.toFixed(2)}；堆叠失效则偏差 = ${STACK_DY}）`,
  ).toBeLessThanOrEqual(3);
  expect(Math.abs(dCy), '两次点击的白簇质心必须像素上可分辨（≥ 圆点半径级）').toBeGreaterThanOrEqual(4);
  expect(bigAfterB.length, '第 43 笔高亮 3 秒后同样归零').toBe(0);
  expect(attrsAfterB['data-highlight-active']).toBe('false');

  // ⑤ 白簇离线复算（截图 → PIL）由 raw/pixel_analyze.py 独立重算，见执行报告
  expect(shotOn.clip.width).toBeGreaterThan(100);
});

// ───────────────────────────────── T5 曲线竖线 ─────────────────────────────────
test('T5 曲线竖线：四视图同一时点画竖线，跨 3 秒保留、下一次跳转更新、全览清除', async ({ page }) => {
  const fillsResp = await page.request.get(`/api/workbench/runs/${RUN_A}/round-trips/${RT_A}/fills?limit=500`);
  const fills = ((await fillsResp.json()) as { fills: Array<Record<string, number | string>> }).fills;
  const tsA = Number(fills[FILL_A]!['ts']);
  const tsC = Number(fills[FILL_C]!['ts']);
  expect(tsA).not.toBe(tsC);

  await openRunSettled(page, RUN_A);
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const before = await page.locator('[data-testid="wb-vline"]').count();

  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  await settleJump(page);
  const read = async () =>
    page.locator('[data-testid="wb-vline"]').evaluateAll((els) =>
      els.map((e) => ({ view: e.getAttribute('data-view'), ts: e.getAttribute('data-vline-ts') })),
    );
  const vOn = await read();
  await page.waitForTimeout(HL_MS + 900);
  const vAfter3s = await read();

  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_C}`).click();
  await settleJump(page);
  const vSecond = await read();

  // 「全览」的手势点击在 L2 跳转后会被 K 线画布溢出遮挡（见 T7 红），此处用 DOM click 事件驱动状态机，
  // 并记录当前遮挡事实（elementFromPoint）。
  const obstruction = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="wb-window-reset"]')!;
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    return { elementAtCenter: el ? el.tagName.toLowerCase() : null, blocked: el !== btn && !btn.contains(el) };
  });
  await page.getByTestId('wb-window-reset').dispatchEvent('click');
  await page.waitForTimeout(400);
  const vReset = await read();
  const attrsReset = await readAttrs(page, 'kline-chart');
  writeJson('t5_vlines', { tsA, tsC, before, vOn, vAfter3s, vSecond, vReset, attrsReset, obstruction });

  expect(before, '跳转前不应有竖线').toBe(0);
  expect(vOn.length, '四曲线视图各一条竖线').toBeGreaterThanOrEqual(4);
  expect(new Set(vOn.map((v) => v.ts)).size, '竖线时点必须唯一（同一时点）').toBe(1);
  expect(Number(vOn[0]!.ts), '竖线时点 == 目标笔成交 ts').toBe(tsA);
  expect(vAfter3s.length, '高亮回常态后竖线仍保留（保留到下一次跳转或全览）').toBe(vOn.length);
  expect(vSecond.length).toBeGreaterThanOrEqual(4);
  expect(new Set(vSecond.map((v) => v.ts)).size, '第二次跳转后时点仍唯一').toBe(1);
  expect(Number(vSecond[0]!.ts), '竖线随下一次跳转更新为新目标 ts').toBe(tsC);
  expect(vReset.length, '全览必须清除竖线').toBe(0);
  expect(attrsReset['data-highlight-key'], '全览必须清除高亮键').toBe('');
  expect(attrsReset['data-highlight-active']).toBe('false');
});

// ───────────────────────────────── T6 三态显式提示 ─────────────────────────────────
test('T6a 三态提示 unmatched：目标笔不在 K 线标记集合内（序号跨源错配）⇒ 显式提示、不静默', async ({ page }) => {
  await page.route('**/api/workbench/runs/*/fills*', async (route) => {
    const resp = await route.fetch();
    const body = (await resp.json()) as { fills?: Array<Record<string, unknown>> };
    for (const f of body.fills ?? []) f['rt_seq'] = Number(f['rt_seq']) + 1000;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await openRunSettled(page, RUN_A);
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  await page.waitForTimeout(1200);

  const note = page.getByTestId('wb-jump-highlight-note');
  await expect(note, '未命中必须显式提示（不得静默）').toBeVisible();
  const attrs = await readAttrs(page, 'wb-jump-highlight-note');
  const text = (await note.textContent()) ?? '';
  const attrsOnK = await readAttrs(page, 'kline-chart');
  const store = await storeDump(page);
  const scan = await scanWhite(page);
  const probe = await readAttrs(page, 'wb-window-probe');
  writeJson('t6a_unmatched', { attrs, text, attrsOnK, markers: store.fillDot.length, highlight: store.highlight.length, bigClusters: scan.clusters.filter((c) => c.size >= CLUSTER_MIN).length, probe });

  expect(attrs['data-state'], '状态必须为 unmatched').toBe('unmatched');
  expect(text.length, '提示文案非空（显式）').toBeGreaterThan(10);
  expect(text, '文案须指明目标键与「只跳窗口、无高亮」').toContain(`${RT_A}:${FILL_A}`);
  expect(store.fillDot.length, '标记仍在（只是键不匹配）').toBeGreaterThan(0);
  expect(store.highlight.length, '未命中 ⇒ 不得画高亮').toBe(0);
  expect(attrsOnK['data-highlight-active']).toBe('false');
  // 窗口跳转仍须执行（提示的是「仅无高亮」）——判据形式见 {@link assertReceiptOrDisclosed}（§2.10.2）
  await assertReceiptOrDisclosed(page, 'T6a unmatched 态');
  expect(probe['data-cmd-from-ts'], '命令（跳转）必须真的发出（不能只靠「无高亮」判过）').not.toBeUndefined();
});

test('T6b 三态提示 unrecorded：recorded=false（未写成交明细）⇒ 显式提示、不静默', async ({ page }) => {
  await page.route('**/api/workbench/runs/*/fills*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ run_id: RUN_A, total: 0, recorded: false, offset: 0, limit: 500, has_more: false, next_offset: null, fills: [] }),
    });
  });
  await openRunSettled(page, RUN_A);
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row, 'L2 行来自 /round-trips 端点，不受 run 级 /fills 注入影响').toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  await page.waitForTimeout(1200);

  const note = page.getByTestId('wb-jump-highlight-note');
  await expect(note).toBeVisible();
  const attrs = await readAttrs(page, 'wb-jump-highlight-note');
  const text = (await note.textContent()) ?? '';
  const fillsNote = (await page.getByTestId('wb-fills-note').textContent()) ?? '';
  const store = await storeDump(page);
  const probe = await readAttrs(page, 'wb-window-probe');
  writeJson('t6b_unrecorded', { attrs, text, fillsNote, markers: store.fillDot.length, highlight: store.highlight.length, probe });

  expect(attrs['data-state'], '状态必须为 unrecorded').toBe('unrecorded');
  expect(text, '文案须显式说明 recorded=false 且窗口跳转仍执行').toContain('recorded=false');
  expect(fillsNote.length).toBeGreaterThan(0);
  expect(store.highlight.length).toBe(0);
  await assertReceiptOrDisclosed(page, 'T6b unrecorded 态');
});

test('T6c 三态提示 loading：成交明细未到位期间必须显式披露；并核验「跳转高亮 loading 分支」在 UI 上是否可达', async ({ page }) => {
  // 先取真实载荷（APIRequestContext 不经 page.route），再注册「延迟 14s 放行」拦截。
  const realFills = await (await page.request.get(`/api/workbench/runs/${RUN_A}/fills?limit=5000`)).json();
  const hitUrls: string[] = [];
  await page.route('**/api/workbench/runs/*/fills*', async (route) => {
    hitUrls.push(route.request().url());
    await new Promise((r) => setTimeout(r, 14000));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(realFills) });
  });
  await openRunSettled(page, RUN_A);

  // ── 未到位期间：显式披露 + 无标记 + L2 表是否可用（可达性判据） ──
  const fillsNoteDuring = (await page.getByTestId('wb-fills-note').textContent()) ?? '';
  const markersDuring = await page.getByTestId('kline-chart').getAttribute('data-marker-overlays');
  let l2ReachableDuring = false;
  try {
    await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).waitFor({ state: 'visible', timeout: 2500 });
    l2ReachableDuring = true;
  } catch {
    l2ReachableDuring = false;
  }
  const shotLoading = await page.screenshot({ path: resolve(OUT, 't6c_loading_phase.png') }).then(() => 't6c_loading_phase.png');

  // ── 放行后：标记到位 + 正常跳转高亮应恢复可用 ──
  await expect
    .poll(async () => page.getByTestId('kline-chart').getAttribute('data-marker-overlays'), { timeout: 30000 })
    .toBe(String((realFills as { fills?: unknown[] }).fills?.length ?? 44));
  const fillsNoteAfter = (await page.getByTestId('wb-fills-note').textContent()) ?? '';
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  await settleJump(page);
  const noteAfter = await readAttrs(page, 'wb-jump-highlight-note');
  const attrsAfter = await readAttrs(page, 'kline-chart');
  const scanAfter = await scanWhite(page);
  writeJson('t6c_loading', {
    hitUrls,
    fillsNoteDuring,
    markersDuring,
    l2ReachableDuring,
    shotLoading,
    fillsNoteAfter,
    noteAfter,
    attrsAfter,
    bigClustersAfter: scanAfter.clusters.filter((c) => c.size >= CLUSTER_MIN).length,
  });

  expect(hitUrls.length, '注入拦截必须命中（否则本用例无区分力）').toBeGreaterThan(0);
  expect(fillsNoteDuring, '未到位期间必须显式披露加载中（不得静默）').toContain('加载中');
  expect(markersDuring, '未到位期间标记数必须为 0').toBe('0');
  expect(fillsNoteAfter, '放行后必须显式披露成交总量').toContain('成交合计');
  expect(noteAfter['data-state'], '放行后跳转高亮恢复正常').toBe('ok');
  expect(attrsAfter['data-highlight-active']).toBe('true');
  expect(scanAfter.clusters.filter((c) => c.size >= CLUSTER_MIN).length, '放行后高亮白簇恰 1 个').toBe(1);
});

// ───────────────────────── T7 回归：控制条可点击性（K 线画布溢出遮挡） ─────────────────────────
/**
 * **B1 复验口径（2026-09-20 复验解除冻结）**——比修复前版本更严：
 *  1. 触发条件必须**真实复现**：L2 跳转后高亮提示（长句，与图例同行 ⇒ 头部可能换行增高）必须存在；
 *  2. **两个按钮各取 3 个采样点**（中心 / 15% 高 / 85% 高）做 `elementFromPoint`，3/3 必须命中
 *     **按钮自身或其后代**（`selfOrChild`，不依赖具体标签名）；
 *  3. 两个按钮必须能被**真实 `click({timeout:3000})`** 点中且不超时——Playwright 自带命中测试，
 *     被 canvas 遮挡时会抛 `element intercepts pointer events` / TimeoutError；
 *     点击「全览」必须**真的生效**（高亮提示被清除）——证伪「点到了但没触发 handler」；
 *  4. 布局不变量：K 线容器不得溢出卡片、卡片底部不得越过控制条顶部、收缩后图表区仍须有可用高度。
 */
test('T7 回归 [@mut]：L2 跳转后「全览/回退」必须仍可点击（3 采样点自命中 + 真实 click 不超时）', async ({ page }) => {
  await openRunSettled(page, RUN_A);
  const beforeNote = await page.getByTestId('wb-jump-highlight-note').count();
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  await settleJump(page);

  // **前置重锚（2026-09-24，D9）**：D9 把窗口控制条放在 **K 线视图顶部**（K 线卡之上），且
  //  **K 线视图不滚**（D9-4）⇒ 控制条**常驻可见**，旧「在上栏容器内滚入视口」的做法已无对象
  //  （`pane.scrollTop = …` 在不滚动容器上恒无效，继续保留即变成「恒真前置」）⇒ 删除，
  //  改为直接断言「控制条完整落在 K 线视图可视区内」。B1 的触发条件（跳转高亮提示使卡头换行）仍须真实复现。
  expect(
    await page.evaluate(() => {
      const pane = document.querySelector('[data-testid="wb-kline-view"]') as HTMLElement | null;
      if (!pane) return false;
      pane.scrollTop = 999; // 反证：K 线视图不可滚（scrollTop 必须被忽略）
      return pane.scrollTop === 0;
    }),
    'D9-4 K 线视图必须不可滚（scrollTop 赋值被忽略 ⇒ 控制条常驻可见的物理前提）',
  ).toBe(true);
  await page.waitForTimeout(300);
  const barPre = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="wb-kline-view"]') as HTMLElement | null;
    const bar = document.querySelector('[data-testid="wb-window-bar"]') as HTMLElement | null;
    if (!pane || !bar) return null;
    const p = pane.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    return { paneTop: Math.round(p.top), paneBottom: Math.round(p.bottom), barTop: Math.round(b.top), barBottom: Math.round(b.bottom), inPane: b.top >= p.top - 1 && b.bottom <= p.bottom + 1 };
  });
  expect(barPre, '窗口控制条必须存在').toBeTruthy();
  expect(
    barPre!.inPane,
    `D9-2/D9-4 前置：控制条必须**常驻**落在 K 线视图可视区内（实读 ${JSON.stringify(barPre)}）`,
  ).toBe(true);

  /** 采样点分数（中心 / 15% / 85%）。 */
  const FRACS = [0.5, 0.15, 0.85];

  const probe = () =>
    page.evaluate((fracs: number[]) => {
      const sample = (id: string) => {
        const btn = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
        if (!btn) return { present: false as const };
        const br = btn.getBoundingClientRect();
        const samples = fracs.map((f) => {
          const px = Math.round(br.x + br.width / 2);
          const py = Math.round(br.y + br.height * f);
          const at = document.elementFromPoint(px, py) as HTMLElement | null;
          const owner = at?.closest('[data-testid]') as HTMLElement | null;
          return {
            f,
            px,
            py,
            tag: at ? at.tagName.toLowerCase() : null,
            testid: owner?.getAttribute('data-testid') ?? null,
            selfOrChild: at != null && (at === btn || btn.contains(at)),
          };
        });
        return {
          present: true as const,
          disabled: btn.hasAttribute('disabled'),
          rect: { x: br.x, y: br.y, w: br.width, h: br.height },
          samples,
          allSelf: samples.every((sp) => sp.selfOrChild),
        };
      };
      const host = document.querySelector('[data-testid="wb-kline-chart"]')!.getBoundingClientRect();
      const kl = document.querySelector('[data-testid="kline-chart"]')!.getBoundingClientRect();
      const bar = document.querySelector('[data-testid="wb-window-bar"]')!.getBoundingClientRect();
      const note = document.querySelector('[data-testid="wb-jump-highlight-note"]') as HTMLElement | null;
      const st = document.querySelector('[data-testid="wb-window-state"]')!;
      const paneEl = document.querySelector('[data-testid="wb-kline-view"]') as HTMLElement | null;
      const pr = paneEl?.getBoundingClientRect() ?? null;
      return {
        reset: sample('wb-window-reset'),
        back: sample('wb-window-back'),
        klineOverflowPx: Math.round(kl.bottom - host.bottom),
        hostTop: Math.round(host.top),
        hostBottom: Math.round(host.bottom),
        barTop: Math.round(bar.top),
        barBottom: Math.round(bar.bottom),
        pane: pr
          ? { top: Math.round(pr.top), bottom: Math.round(pr.bottom), h: Math.round(pr.height), scrollTop: paneEl!.scrollTop }
          : null,
        cardHeaderH: (() => {
          const h = document.querySelector('[data-testid="wb-kline-card-header"]');
          return h ? Math.round(h.getBoundingClientRect().height) : null;
        })(),
        paneMetrics: (() => {
          try {
            const raw = document.querySelector('[data-testid="kline-chart"]')?.getAttribute('data-pane-metrics');
            return raw ? JSON.parse(raw) : null;
          } catch {
            return null;
          }
        })(),
        chartAreaH: Math.round(kl.height),
        notePresent: note != null,
        noteState: note?.getAttribute('data-state') ?? '',
        noteText: note?.textContent?.slice(0, 80) ?? '',
        windowSource: st.getAttribute('data-source'),
        windowRev: st.getAttribute('data-rev'),
      };
    }, FRACS);

  const afterJump = await probe();
  await page.screenshot({ path: resolve(OUT, 't7_after_l2_jump.png') });

  // ── 真实点击 ①：「全览」（必须在**高亮提示仍在**时点，否则遮挡条件不成立） ──
  const guardNote = await page.getByTestId('wb-jump-highlight-note').count();
  let resetClickOk = false;
  let resetClickError = '';
  try {
    await page.getByTestId('wb-window-reset').click({ timeout: 3000 });
    resetClickOk = true;
  } catch (e) {
    resetClickError = String(e).slice(0, 400);
  }
  await page.waitForTimeout(700);
  const afterReset = await probe();

  // ── 真实点击 ②：「回退」（real click 前核验 enabled） ──
  let backClickOk = false;
  let backClickError = '';
  const backBefore = afterReset.back;
  if (backBefore.present && !backBefore.disabled) {
    try {
      await page.getByTestId('wb-window-back').click({ timeout: 3000 });
      backClickOk = true;
    } catch (e) {
      backClickError = String(e).slice(0, 400);
    }
  } else {
    backClickError = '「回退」在真实点击前不可用（disabled 或缺失）';
  }
  await page.waitForTimeout(700);
  const afterBack = await probe();

  writeJson('t7_bar_clickability', {
    beforeNote,
    afterJump,
    guardNote,
    resetClickOk,
    resetClickError,
    afterReset,
    backBefore,
    backClickOk,
    backClickError,
    afterBack,
  });

  // ── 判据：触发条件 ──
  expect(afterJump.notePresent, 'L2 跳转必须显示高亮提示（B1 遮挡条件须真实复现）').toBe(true);
  expect(afterJump.noteState, '提示态必须为 ok').toBe('ok');
  expect(afterJump.noteText, '提示文案必须为高亮成功长句').toContain('已高亮目标成交');
  expect(guardNote, '真实 click「全览」前提示必须仍在（保证遮挡条件成立）').toBe(1);

  // ── 判据：3 采样点自命中 ──
  expect(afterJump.reset.present && afterJump.back.present, '两个控制按钮必须存在').toBe(true);
  expect(afterJump.reset.samples.length, '「全览」采样点数必须 ≥ 3').toBe(3);
  expect(afterJump.back.samples.length, '「回退」采样点数必须 ≥ 3').toBe(3);
  expect(
    afterJump.reset.allSelf,
    `「全览」3 个采样点必须命中按钮自身或其子元素：${JSON.stringify(afterJump.reset.samples)}`,
  ).toBe(true);
  expect(
    afterJump.back.allSelf,
    `「回退」3 个采样点必须命中按钮自身或其子元素：${JSON.stringify(afterJump.back.samples)}`,
  ).toBe(true);

  // ── 判据：布局不变量 ──
  expect(afterJump.klineOverflowPx, 'K 线容器不得溢出卡片（溢出即盖住控制条）').toBeLessThanOrEqual(1);
  // **D9 布局不变量**：窗口条在 K 线视图**顶部**、卡片在其**之下** ⇒ 旧「卡片底部不得越过控制条顶部」几何反了；
  // 等价判据 = ①控制条完整落在 K 线视图可视区内 ②卡片与控制条**不重叠**（卡片顶 ≥ 控制条底）
  // ③卡片完整落在 K 线视图内 ④K 线视图 scrollTop 恒 0（不滚）
  expect(afterJump.pane, 'K 线视图必须存在').toBeTruthy();
  expect(afterJump.barTop, 'D9-4 控制条必须落在 K 线视图可视区内（顶边界）').toBeGreaterThanOrEqual(
    afterJump.pane!.top - 1,
  );
  expect(afterJump.barBottom, 'D9-4 控制条必须完整落在 K 线视图可视区内（底边界）').toBeLessThanOrEqual(
    afterJump.pane!.bottom + 1,
  );
  expect(afterJump.hostTop, 'D9 卡片顶不得高于控制条底（两者不得重叠）').toBeGreaterThanOrEqual(
    afterJump.barBottom - 1,
  );
  expect(afterJump.hostBottom, 'D9-2 卡片必须完整落在 K 线视图内').toBeLessThanOrEqual(afterJump.pane!.bottom + 1);
  expect(afterJump.pane!.scrollTop, 'D9-4 K 线视图 scrollTop 必须为 0').toBe(0);
  expect(afterJump.chartAreaH, 'D9 图表区（内层）收缩后仍须有可用高度（卡高 = 视图高 − 60）').toBeGreaterThan(100);
  // **D9-8① 恒等式**（含实测卡头）：主图 == 内层 − 26 − 1×副图数 − Σ副图；**D9-8②**：主图 ≥160（干净态时）
  const pm7 = afterJump.paneMetrics as
    | { candlePx: number | null; subPanes: Array<{ px: number | null }>; subPaneTotalPx: number | null }
    | null;
  expect(pm7?.candlePx ?? 0, `D9-8② 主图硬下限 ≥ ${MAIN_MIN_PX}（实测 ${pm7?.candlePx ?? 'n/a'}）`).toBeGreaterThanOrEqual(
    MAIN_MIN_PX - Math.max(0, (afterJump.cardHeaderH ?? 20) - 20),
  );
  if (pm7?.candlePx != null && pm7.subPaneTotalPx != null) {
    expect(
      Math.abs(pm7.candlePx - (afterJump.chartAreaH - 26 - 1 * pm7.subPanes.length - pm7.subPaneTotalPx)),
      `D9-8① 主图 == 内层 − 26 − 1×副图数 − Σ副图（主图 ${pm7.candlePx} / 内层 ${afterJump.chartAreaH} / Σ副图 ${pm7.subPaneTotalPx}）`,
    ).toBeLessThanOrEqual(2);
    for (const sp of pm7.subPanes) {
      expect(sp.px ?? 0, `D9-8② 副图 ≥ ${SUB_PANE_MIN_PX}`).toBeGreaterThanOrEqual(SUB_PANE_MIN_PX);
    }
  }

  // ── 判据：真实 click ──
  expect(resetClickOk, `「全览」真实 click 必须成功（不得被 canvas 拦截）：${resetClickError}`).toBe(true);
  expect(backClickOk, `「回退」真实 click 必须成功（不得被 canvas 拦截）：${backClickError}`).toBe(true);
  expect(afterReset.notePresent, '点「全览」后高亮提示必须被清除（证明点击真的触发了 handler）').toBe(false);
  expect(afterReset.reset.allSelf, '点「全览」后按钮仍须自命中').toBe(true);
});
