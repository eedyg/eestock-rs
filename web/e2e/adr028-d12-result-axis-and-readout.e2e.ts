/**
 * **ADR-028 D12（Y 轴刻度）/ D13（时刻取值）真渲染独立复验**（09-plan §2/§3；契约 SSOT = 09-plan）。
 *
 * 与既有规格的关系（读之前必读）：
 *  - `adr028-axis-align-probe.e2e.ts` 是 **tester 冻结基线**（跨仓契约：判据不得放宽、文件不得改）；
 *    本文件**不**触碰它，也**不**重复它的 Δ 配对口径 —— 本文件专问「刻度是否真标注了既有值域」与
 *    「读数是否就是序列原值（**禁插值**）」这两件 09-plan 新裁的事。
 *  - `curveReadout.test.tsx` / `resultAxisReadout.test.tsx` 是 jsdom 组件测试（无真布局）⇒ 本文件补
 *    **真浏览器布局**下的两条 jsdom 无法回答的事实：① 文字宽度不随卡片宽度变化（非等比拉伸下不变形）；
 *    ② 横线集在真身 DOM 里唯一（净值/持仓卡原有的 3 条固定分数装饰线已被替换）。
 *
 * ## 判据鉴别力（**逐条注明「旧实现/回退实现下哪条必红」**）
 *  - `A1` 刻度条数/值集合：旧实现（无刻度带）⇒ `wb-axis-tick-*` 计数为 0 ⇒ 计数断言**必红**。
 *  - `A1` 净值/持仓刻度**落在数据域内**：若实现改成「nice 外扩值域」或「padding 后标注」（09-plan §1.2-2 禁），
 *    则会出现落在兜底域外的刻度 ⇒ 域内断言**必红**（不是「未反向」式断言：域由 `/curve` 原始点独立算得）。
 *  - `A1` 横线集唯一：旧实现（净值/持仓卡的 3 条固定分数装饰线，位于卡高 0.25/0.5/0.75）⇒
 *    存在 `y1≈55/110/165`（H=220）且**不对应任何刻度**的水平线 ⇒ 唯一性断言**必红**。
 *  - `A3` 文字不拉伸：若把刻度文本画进 `preserveAspectRatio="none"` 的 svg（旧实现没有刻度，但
 *    「画进 svg」是最自然的错误实现）⇒ 同一标签的 `getBoundingClientRect().width` 随卡宽线性变化
 *    （实测 Δ ≈ 5px ≫ 1px）⇒ `|Δtext| ≤ 1px` **必红**，且 `closest('svg[preserveAspectRatio=none]')`
 *    **必红**。
 *  - `A2` 读数 == 序列原值：旧实现（无读数）⇒ `wb-readout-*` 缺失 ⇒ **必红**；若实现改为「按鼠标位置
 *    在两点间线性插值」⇒ 在两根锚点之间的 40% 处读数会等于插值结果（≠ 端点的原值）⇒
 *    「读数 == 端点原值」与「≠ 插值结果」两条**必红**。
 *  - `A2` 锁定/解除/键盘：旧实现无 `tabIndex`、无 `wb-readout-locked` ⇒ **必红**。
 *  - `A1` 末尾的**反证**（把 `wb-axis-ticks-aggregate` 从 DOM 移除后重数）：证明计数断言对 DOM 存在性
 *    **敏感**（不是恒真/`locator.count()` 假绿）。
 *  - `A4`（**逐卡**交互链）：四卡各自独立跑「悬停原值 / 锁定 / Esc / ←→ / 可聚焦」。逐条鉴别力：
 *    ① 命中读数数 == 0（该卡未把 `series`/`frame` 接线）⇒ **必红**；② 读数 ts ∉ 该卡原始点 ts 集合
 *    （插值/自造 ts 或错卡取数）⇒ **必红**；③ 扫描覆盖 < 3 根不同 bar（读数与鼠标位置脱钩、恒值）⇒ **必红**；
 *    ④ 读数各行 ≠ 接口原值逐字符（错 bar / 错列 / 插值）⇒ **必红**；⑤ 读数行数 ≠ 可见系列数 ⇒ **必红**；
 *    ⑥ 点击后 `wb-readout-locked`/`data-readout-locked` 不出现 ⇒ **必红**（该卡未接点击锁定）；
 *    ⑦ `tabindex` ≠ 0 ⇒ **必红**（该卡未接键盘可达）；⑧ `→` 后 ts 在该卡序列上**未前进**（或落在非原始点）
 *    ⇒ **必红**；`←` 未回到原点 ⇒ **必红**。
 *  - `A5`（slot 图例耦合）：读数行必须**跟随图例可见性**。鉴别力：若读数接的是**未过滤**的 slot 列表
 *    （典型「未接线」缺陷）⇒ 隐藏后仍出行 ⇒ 「隐藏后行数 == 可见线数」**必红**；恢复可见后 ts/文本与基线
 *    不一致（耦合被实现成一次性丢弃）⇒ **必红**。
 *  - **登记（环境限制，非产品缺陷）**：活库**无** `succeeded ∧ slots ≥ 2` 的 run（118 个 run 全扫，见
 *    `a5_slot_legend_coupling.json::multiSlotRuns`）⇒ 「隐藏一条后与**剩余**可见线比对」的多线变体**不可执行**；
 *    A5 按「隐藏后可见线 = 0 ⇒ 读数整体消失（0 行）」判定，并把该环境事实落盘。
 *
 * ## run 靶（**不硬编码**：库会增长，硬编码会被顶出首屏或随清理假红）
 * 本文件就地按**结构谓词**解析：`period=D1 ∧ status=succeeded ∧ symbol=518880 ∧ per_bar 根数 ≥ 200`，
 * `created_at` 倒序取**第一个命中者**；全不命中 ⇒ 显式抛错（禁静默换 run / 禁跳过）。
 * 解析结果（含扫描证据）落盘证据目录，供复核「解析到什么、为什么」。
 *
 * 证据落盘：`tester/evidence/20260925_d4b_render_verify/raw/`（**未跟踪**目录；可用 `D4B_OUT` 覆盖）——
 * 禁写入已跟踪的 `coder/evidence/20260920_*` / `tester/evidence/20260920_*`（AGENTS.md 2026-09-23 事故登记）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
/** 证据目录（**未跟踪**）：`tester/evidence/20260925_d4b_render_verify/raw`。 */
const OUT = process.env.D4B_OUT ?? resolve(REPO, 'tester/evidence/20260925_d4b_render_verify/raw');

/** 四张手写 SVG 曲线卡（09-plan §1 的适用范围；K 线卡不在本批）。 */
const CARDS = ['aggregate', 'slot', 'equity', 'position'] as const;
type Card = (typeof CARDS)[number];

/** 曲线绘图区高度（user units；与各卡源码的 `H` 一致 —— 只用于核对「装饰线 y = 0.25/0.5/0.75 × H」）。 */
const CARD_H: Record<Card, number> = { aggregate: 160, slot: 160, equity: 220, position: 220 };

function writeJson(name: string, data: unknown): string {
  mkdirSync(OUT, { recursive: true });
  const p = resolve(OUT, `${name}.json`);
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}

// ───────────────────────────────────── 靶 run 解析（谓词，本地实现） ─────────────────────────────────────

interface RunRow {
  id: string;
  period?: string;
  status?: string;
  symbol?: string;
  created_at?: string;
}

interface AxisTarget {
  id: string;
  totalBars: number;
  predicate: string;
  scanned: number;
  rejected: Array<{ id: string; why: string }>;
}

async function resolveAxisTarget(page: Page): Promise<AxisTarget> {
  const predicate =
    "period=D1 ∧ status=succeeded ∧ symbol=518880 ∧ /bars?kind=per_bar total ≥ 200（created_at 倒序取第一个命中者）";
  const resp = await page.request.get('/api/workbench/runs?limit=500');
  expect(resp.ok(), `/runs 必须可取（status=${resp.status()}）`).toBeTruthy();
  const rows = (await resp.json()) as RunRow[];
  const cands = rows
    .filter((r) => r.period === 'D1' && r.status === 'succeeded' && r.symbol === '518880')
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  const rejected: Array<{ id: string; why: string }> = [];
  let scanned = 0;
  for (const c of cands) {
    scanned += 1;
    const b = await page.request.get(`/api/workbench/runs/${c.id}/bars?kind=per_bar&offset=0&limit=1`);
    if (!b.ok()) {
      rejected.push({ id: c.id, why: `bars ${b.status()}` });
      continue;
    }
    const j = (await b.json()) as { total?: number };
    const total = j.total ?? 0;
    if (total < 200) {
      rejected.push({ id: c.id, why: `per_bar total=${total} < 200` });
      continue;
    }
    return { id: c.id, totalBars: total, predicate, scanned, rejected: rejected.slice(-25) };
  }
  throw new Error(
    `[D4b] 靶 run 解析失败：${predicate}；已扫 ${scanned} 个 D1/succeeded/518880 候选，无一命中 ⇒ 显式红。` +
      `拒绝原因：${JSON.stringify(rejected.slice(-25))}`,
  );
}

// ───────────────────────────────────── 打开 run / 取数 ─────────────────────────────────────

async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const sel = page.getByTestId(`wb-run-select-${runId}`);
  for (let i = 0; i < 30 && (await sel.count()) === 0; i++) {
    const more = page.getByTestId('wb-runs-more');
    if ((await more.count()) > 0) {
      await more.scrollIntoViewIfNeeded().catch(() => {});
      await more.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(300);
  }
  await sel.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  // 四卡渲染完成（刻度带 = D12 产物；出现即曲线已绘）
  await expect(page.getByTestId('wb-axis-ticks-aggregate')).toBeVisible();
  await expect(page.getByTestId('wb-readout-frame-equity')).toBeVisible();
  await page.waitForTimeout(1200); // 窗口/曲线 settle
}

/** `/curve?kind=…` 原始点（判据的**独立**取数面；不复用 UI 内部派生量）。
 *  ⚠️ 响应形状按 kind 不同：`net_value` / `drawdown` 是 `[ts, value]` **数组**对，
 *  `per_bar` / `position` 是**对象**行（本文件两种都吃下，避免把「形状差异」误判成产品缺陷）。 */
type CurvePoint = Record<string, number> | [number, number];

async function curvePoints(page: Page, runId: string, kind: string): Promise<CurvePoint[]> {
  const r = await page.request.get(`/api/workbench/runs/${runId}/curve?kind=${kind}&k=2000`);
  expect(r.ok(), `/curve?kind=${kind}（status=${r.status()}）`).toBeTruthy();
  const j = (await r.json()) as { points?: CurvePoint[] };
  return j.points ?? [];
}

/** `[ts,value]` 点对（两种形状统一）。 */
function pairs(points: CurvePoint[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const p of points) {
    if (Array.isArray(p)) {
      if (typeof p[0] === 'number' && typeof p[1] === 'number') out.push([p[0], p[1]]);
      continue;
    }
    if (typeof p['ts'] === 'number' && typeof p['value'] === 'number') out.push([p['ts'], p['value']]);
  }
  return out;
}

// ───────────────────────────────────── A1：刻度 ─────────────────────────────────────

interface TickReading {
  index: number;
  text: string;
  tickValue: string | null;
  zero: string | null;
  width: number;
  pct: string;
  insideStretchedSvg: boolean;
  /** 真身相对父 framebox 的左边界（含 `left-1` 偏移，只作读数记录）。 */
  cardWidth: number;
  frameWidth: number;
}

async function readTicks(page: Page, card: Card): Promise<TickReading[]> {
  return (await page.evaluate(
    ({ c }: { c: string }) => {
      const cardEl = document.querySelector(`[data-testid="wb-${c}-chart"]`);
      const frame = document.querySelector(`[data-testid="wb-readout-frame-${c}"]`);
      const labels = Array.from(document.querySelectorAll(`[data-testid^="wb-axis-tick-${c}-"]`));
      const cardW = cardEl?.getBoundingClientRect().width ?? -1;
      const frameW = frame?.getBoundingClientRect().width ?? -1;
      return labels.map((el, i) => {
        const r = el.getBoundingClientRect();
        return {
          index: i,
          text: (el.textContent ?? '').trim(),
          tickValue: el.getAttribute('data-tick-value'),
          zero: el.getAttribute('data-zero'),
          width: r.width,
          pct: (el as HTMLElement).style.top,
          insideStretchedSvg: el.closest('svg[preserveAspectRatio="none"]') !== null,
          cardWidth: cardW,
          frameWidth: frameW,
        };
      });
    },
    { c: card },
  )) as TickReading[];
}

/** 卡内**水平线**（`y1 === y2`）读数：testid / y1 / 是否语义阈值线。 */
interface HLine {
  testid: string | null;
  y1: number;
  gridTickValue: string | null;
  isThreshold: boolean;
}

async function readHLines(page: Page, card: Card): Promise<HLine[]> {
  return (await page.evaluate(
    ({ c }: { c: string }) => {
      const cardEl = document.querySelector(`[data-testid="wb-${c}-chart"]`);
      if (!cardEl) return [];
      return Array.from(cardEl.querySelectorAll('line'))
        .map((l) => ({
          testid: l.getAttribute('data-testid'),
          y1: Number(l.getAttribute('y1')),
          y2: Number(l.getAttribute('y2')),
          gridTickValue: l.getAttribute('data-tick-value'),
        }))
        .filter((l) => Number.isFinite(l.y1) && Number.isFinite(l.y2) && Math.abs(l.y1 - l.y2) < 1e-6)
        .map((l) => ({
          testid: l.testid,
          y1: l.y1,
          gridTickValue: l.gridTickValue,
          isThreshold: (l.testid ?? '').startsWith('threshold-'),
        }));
    },
    { c: card },
  )) as HLine[];
}

/** 网格线 y 值（`wb-axis-grid-{card}-i` 的 y1/y2），用于「横线集唯一」比对。 */
async function readGridYs(page: Page, card: Card): Promise<number[]> {
  return (await page.evaluate(
    ({ c }: { c: string }) => {
      const cardEl = document.querySelector(`[data-testid="wb-${c}-chart"]`);
      if (!cardEl) return [];
      return Array.from(cardEl.querySelectorAll(`[data-testid^="wb-axis-grid-${c}-"]`)).map((l) =>
        Number(l.getAttribute('y1')),
      );
    },
    { c: card },
  )) as number[];
}

test.describe('D12｜Y 轴刻度（真渲染）', () => {
  test('A1：四卡刻度 3–5 条 + 值集合（固定域 0–100 / 净值·持仓落在数据域内）+ 横线集唯一', async ({ page }) => {
    test.setTimeout(180_000);
    mkdirSync(OUT, { recursive: true });
    const target = await resolveAxisTarget(page);
    const evid: Record<string, unknown> = { target, cards: {} };
    writeJson('a1_target', target);

    await openRun(page, target.id);

    // 独立取数面（域由接口原始点算得，**不**复用 UI 派生量）
    const netPts = pairs(await curvePoints(page, target.id, 'net_value'));
    const posPts = (await curvePoints(page, target.id, 'position'))
      .filter((p): p is Record<string, number> => !Array.isArray(p))
      .filter((p) => typeof p['position_ratio'] === 'number');
    const perBar = (await curvePoints(page, target.id, 'per_bar'))
      .filter((p): p is Record<string, number> => !Array.isArray(p))
      .filter((p) => typeof p['aggregate'] === 'number');
    const netMin = Math.min(...netPts.map((p) => p[1]));
    const netMax = Math.max(...netPts.map((p) => p[1]));
    const posVals = posPts.map((p) => p['position_ratio'] as number);
    const posMin = Math.min(0, ...posVals);
    const posMax = Math.max(1, ...posVals);
    evid['domains'] = {
      net: { min: netMin, max: netMax, n: netPts.length },
      position: { min: posMin, max: posMax, n: posVals.length },
      perBarN: perBar.length,
    };

    const perCard: Record<string, unknown> = {};
    for (const card of CARDS) {
      const ticks = await readTicks(page, card);
      const gridYs = await readGridYs(page, card);
      const hlines = await readHLines(page, card);
      perCard[card] = {
        ticks,
        tickCount: ticks.length,
        gridYs,
        hLines: hlines,
        cardWidth: ticks[0]?.cardWidth ?? null,
        frameWidth: ticks[0]?.frameWidth ?? null,
      };

      // ① 条数 3–5（契约 §2 表格）
      expect(
        ticks.length,
        `${card}：刻度条数必须 ∈ [3,5]（实得 ${ticks.length}；texts=${JSON.stringify(ticks.map((t) => t.text))}）`,
      ).toBeGreaterThanOrEqual(3);
      expect(ticks.length, `${card}：刻度条数上限 5`).toBeLessThanOrEqual(5);

      // ② 刻度值（`data-tick-value` = 真值；文本 = 该卡格式）
      const values = ticks.map((t) => Number(t.tickValue));
      expect(
        values.every((v) => Number.isFinite(v)),
        `${card}：每个刻度必须带可解析的 data-tick-value（实得 ${JSON.stringify(ticks.map((t) => t.tickValue))}）`,
      ).toBe(true);
      // 刻度升序且互不相同（不得重复标注同一条线）
      expect([...values].sort((a, b) => a - b), `${card}：刻度值必须升序且互不相同`).toEqual(values);
      expect(new Set(values).size, `${card}：刻度值不得重复`).toBe(values.length);

      if (card === 'aggregate' || card === 'slot') {
        // 固定 0–100 域 ⇒ 契约要求 5 条 0/25/50/75/100（含 2.5×10^k 档才会得到）
        expect(values, `${card}：0–100 固定域的刻度集合必须 == {0,25,50,75,100}`).toEqual([0, 25, 50, 75, 100]);
        expect(ticks.map((t) => t.text), `${card}：整数刻度文本`).toEqual(['0', '25', '50', '75', '100']);
        expect(ticks[0]!.zero, `${card}：0 刻度必须带 data-zero=true（视觉区别）`).toBe('true');
      }
      if (card === 'equity') {
        const eps = 1e-6;
        expect(
          values.every((v) => v >= netMin - eps && v <= netMax + eps),
          `${card}：刻度必须落在该卡数据域内（域由 /curve?kind=net_value 原始点算得 [${netMin}, ${netMax}]；` +
            `实得 ${JSON.stringify(values)}）—— 外扩/padding 值域会让本断言变红`,
        ).toBe(true);
        expect(
          ticks.map((t) => t.text).every((t) => /^-?\d+\.\d{2}$/.test(t)),
          `${card}：净值刻度格式 = 金额两位小数（与同卡 wb-last-equity 同口径，无千分位）：${JSON.stringify(ticks.map((t) => t.text))}`,
        ).toBe(true);
      }
      if (card === 'position') {
        const eps = 1e-6;
        expect(
          values.every((v) => v >= posMin - eps && v <= posMax + eps),
          `${card}：刻度必须落在 extentOf(ratios ∪ {0,1}) = [${posMin}, ${posMax}] 内（实得 ${JSON.stringify(values)}）`,
        ).toBe(true);
        expect(
          ticks.map((t) => t.text).every((t) => /^-?\d+\.\d{2}%$/.test(t)),
          `${card}：持仓刻度格式 = 百分比两位（fmtPct）：${JSON.stringify(ticks.map((t) => t.text))}`,
        ).toBe(true);
      }

      // ③ 刻度文本**不在**被非等比拉伸的 svg 内（09-plan §1.2-1）
      expect(
        ticks.every((t) => !t.insideStretchedSvg),
        `${card}：刻度标签不得位于 preserveAspectRatio="none" 的 <svg> 内（实得 ${JSON.stringify(ticks.map((t) => t.insideStretchedSvg))}）`,
      ).toBe(true);

      // ④ 横线集唯一：网格线 == 刻度（同一 y），且**非阈值**水平线全部是网格线
      expect(
        gridYs.length,
        `${card}：网格线条数必须 == 刻度数（grid=${gridYs.length} ticks=${ticks.length}）`,
      ).toBe(ticks.length);
      const nonThresholdYs = hlines.filter((l) => !l.isThreshold).map((l) => l.y1);
      expect(
        nonThresholdYs.length,
        `${card}：非阈值水平线必须**全部**是刻度网格线（实得 ${nonThresholdYs.length} 条，刻度 ${ticks.length} 条）—— ` +
          `净值/持仓卡若残留旧的 3 条固定分数装饰线（0.25/0.5/0.75 卡高）本条必红`,
      ).toBe(ticks.length);
      const gridSet = [...new Set(gridYs.map((y) => Math.round(y * 1000) / 1000))].sort((a, b) => a - b);
      const lineSet = [...new Set(nonThresholdYs.map((y) => Math.round(y * 1000) / 1000))].sort((a, b) => a - b);
      expect(lineSet, `${card}：非阈值水平线的 y 集合必须 == 网格线 y 集合`).toEqual(gridSet);
      // 0 刻度必须是网格线之一（若该卡含 0 刻度）
      for (const t of ticks) {
        if (t.zero === 'true') {
          const y0 = gridYs[ticks.indexOf(t)];
          expect(Number.isFinite(y0), `${card}：0 刻度必须有对应网格线`).toBe(true);
        }
      }
      // 旧的固定分数装饰线（0.25/0.5/0.75 × H）不得存在（除非恰好等于某条刻度线的 y）
      const H = CARD_H[card];
      const legacyYs = [0.25 * H, 0.5 * H, 0.75 * H];
      const legacyLeft = hlines
        .filter((l) => legacyYs.some((ly) => Math.abs(l.y1 - ly) < 0.5))
        .filter((l) => !gridYs.some((gy) => Math.abs(gy - l.y1) < 0.5));
      expect(
        legacyLeft.map((l) => `${l.testid}@${l.y1}`),
        `${card}：不得残留固定在卡高 0.25/0.5/0.75 的装饰线（${JSON.stringify(legacyYs)}）`,
      ).toEqual([]);
    }
    evid['cards'] = perCard;

    // ── 反证（**证明断言不是恒真**）：把刻度带从 DOM 移除后再数 ⇒ 必须为 0 ──
    const before = (await readTicks(page, 'aggregate')).length;
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="wb-axis-ticks-aggregate"]');
      el?.parentElement?.removeChild(el);
    });
    const after = (await readTicks(page, 'aggregate')).length;
    evid['removalCounterProof'] = { aggregateTicksBefore: before, aggregateTicksAfterRemovingBand: after };
    expect(before, '反证前基数必须 > 0').toBeGreaterThan(0);
    expect(
      after,
      '反证：移除刻度带后计数必须归零 ⇒ A1 的计数断言对 DOM 存在性敏感（非恒真）',
    ).toBe(0);

    writeJson('a1_axis_ticks', evid);
  });
});

// ───────────────────────────────────── A2：时刻取值（读数 == 序列原值） ─────────────────────────────────────

interface HoverSample {
  mouseX: number;
  ts: number | null;
  xPct: number | null;
  v0: string | null;
  v1: string | null;
  readout: string | null;
}

async function probeHover(page: Page, x: number, y: number): Promise<HoverSample> {
  await page.mouse.move(x, y);
  return (await page.evaluate((mx: number) => {
    const read = document.querySelector('[data-testid="wb-readout-equity"]');
    const cross = document.querySelector('[data-testid="wb-crosshair-equity"]') as HTMLElement | null;
    const v0 = document.querySelector('[data-testid="wb-readout-value-equity-0"]');
    const v1 = document.querySelector('[data-testid="wb-readout-value-equity-1"]');
    const pct = cross?.style.left ?? null;
    return {
      mouseX: mx,
      ts: read?.getAttribute('data-readout-ts') ? Number(read.getAttribute('data-readout-ts')) : null,
      xPct: pct == null ? null : Number(pct.replace('%', '')),
      v0: v0?.textContent?.trim() ?? null,
      v1: v1?.textContent?.trim() ?? null,
      readout: read?.textContent?.trim() ?? null,
    };
  }, x)) as HoverSample;
}

const fmtMoney2 = (v: number) => v.toFixed(2);
const fmtPct2 = (v: number) => `${(v * 100).toFixed(2)}%`;

test.describe('D13｜时刻取值（真渲染）', () => {
  test('A2：读数 == 序列原值（禁插值）+ 锁定/解除/Esc/点卡外/←→', async ({ page }) => {
    test.setTimeout(180_000);
    mkdirSync(OUT, { recursive: true });
    const target = await resolveAxisTarget(page);
    const evid: Record<string, unknown> = { target };
    await openRun(page, target.id);

    // 序列原值（独立取数面）
    const netPts = pairs(await curvePoints(page, target.id, 'net_value'));
    const ddPts = pairs(await curvePoints(page, target.id, 'drawdown'));
    const netMap = new Map(netPts);
    const ddMap = new Map(ddPts);
    /** x 映射主路 = bar 索引空间（`data-x-mode=index`）；非 index 时插值反证口径不成立 ⇒ 必须显式记录。 */
    const xMode = await page.getByTestId('wb-equity-chart').getAttribute('data-x-mode');
    evid['equityXMode'] = xMode;
    /** ts → 该卡序列（net_value）中的下标；用于「相邻锚点」与键盘方向判据。 */
    const tsIndexByTs = new Map(netPts.map((p, i) => [p[0], i]));

    const frame = page.getByTestId('wb-readout-frame-equity');
    await frame.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const box = await frame.boundingBox();
    expect(box, '净值卡读数框必须可测').not.toBeNull();
    const rect = box!;
    const y = rect.y + rect.height / 2;

    // ① 横扫：记录鼠标 x → 读数（ts + 两序列值）；用于定位**相邻锚点对**与取证「只落在原始点」
    const N = 48;
    const sweep: HoverSample[] = [];
    for (let k = 0; k <= N; k++) {
      const x = rect.x + 3 + ((rect.width - 6) * k) / N;
      sweep.push(await probeHover(page, x, y));
    }
    evid['sweep'] = sweep;
    const hit = sweep.filter((s) => s.ts != null);
    expect(hit.length, '横扫必须命中读数（否则 wb-readout-equity 未实现 ⇒ 本断言即鉴别力所在）').toBeGreaterThan(3);
    // 每个被读到的 ts 必须是**接口原始点**的 ts（禁自造/禁插值 ts）
    const netTsSet = new Set(netPts.map((p) => p[0]));
    const bogus = hit.filter((s) => !netTsSet.has(s.ts!)).map((s) => s.ts);
    expect(bogus, '读数 ts 必须全部是 /curve?kind=net_value 的原始点 ts（禁插值/禁自造）').toEqual([]);
    // 读数文本 == 原值（逐字符）：每个采样点都对接口原值做一次比对
    const mismatch: Array<Record<string, unknown>> = [];
    for (const s of hit) {
      const expV0 = fmtMoney2(netMap.get(s.ts!)!);
      const dd = ddMap.get(s.ts!);
      const expV1 = dd == null ? null : fmtPct2(dd);
      if (s.v0 !== expV0 || (expV1 != null && s.v1 !== expV1)) {
        mismatch.push({ ts: s.ts, got: [s.v0, s.v1], want: [expV0, expV1] });
      }
    }
    expect(
      mismatch,
      `读数必须逐字符等于序列原值（净值 = /curve net_value 原值 toFixed(2)；回撤 = drawdown × 100 两位）。不符 ${mismatch.length}/${hit.length} 处`,
    ).toEqual([]);

    // ② 插值反证：**细扫**（≈3px 步长）找**真正相邻**的两个锚点（API 序列下标差 == 1），
    //    再在两者之间 40% 处悬停 ⇒ 必须仍 snap 到左端**原值**，且 ≠ 该处线性插值结果。
    //    方法学要点（第一版踩过的坑，登记在案）：粗扫的相邻**采样**并不等于相邻**锚点**
    //    （178 个锚点 vs 48 个采样 ⇒ 相邻采样之间通常隔着多个锚点）⇒ 必须细扫 + 用「下标差 == 1」证相邻。
    const stepPx = Math.max(2, Math.floor((rect.width - 6) / 400));
    const fine: HoverSample[] = [];
    for (let x = rect.x + 3; x <= rect.x + rect.width - 3; x += stepPx) {
      fine.push(await probeHover(page, x, y));
    }
    const idxOf = (ts: number | null) => (ts == null ? -1 : (tsIndexByTs.get(ts) ?? -1));
    const adjacent: Array<{ a: HoverSample; b: HoverSample; ia: number; ib: number }> = [];
    for (let i = 1; i < fine.length; i++) {
      const a = fine[i - 1]!;
      const b = fine[i]!;
      if (a.ts == null || b.ts == null || a.ts === b.ts) continue;
      if (a.xPct == null || b.xPct == null) continue;
      const ia = idxOf(a.ts);
      const ib = idxOf(b.ts);
      if (ib === ia + 1) adjacent.push({ a, b, ia, ib });
    }
    evid['fineSweep'] = { stepPx, samples: fine.length, adjacentPairs: adjacent.length };
    expect(
      adjacent.length,
      `细扫必须找到**真正相邻**的锚点对（下标差 1；samples=${fine.length} step=${stepPx}px）—— 否则插值反证不可执行（显式红，不静默跳过）`,
    ).toBeGreaterThan(0);
    const differing = adjacent.filter((p) => {
      const va = netMap.get(p.a.ts!);
      const vb = netMap.get(p.b.ts!);
      return va != null && vb != null && fmtMoney2(va) !== fmtMoney2(vb);
    });
    expect(
      differing.length,
      `相邻锚点对中必须存在两端读数**不同**者（否则插值反证退化为恒真；adjacent=${adjacent.length}）`,
    ).toBeGreaterThan(0);
    const pair = differing[0]!;
    const xA = rect.x + (pair.a.xPct! / 100) * rect.width;
    const xB = rect.x + (pair.b.xPct! / 100) * rect.width;
    const xMid = xA + 0.4 * (xB - xA);
    // 相邻性**二次取证**：在 (xA, xB) 内密采样，观察到的 ts 集合必须**只有** {tsA, tsB}
    const seenTs = new Set<number>();
    for (let x = xA; x <= xB; x += Math.max(0.5, (xB - xA) / 12)) {
      const s2 = await probeHover(page, x, y);
      if (s2.ts != null) seenTs.add(s2.ts);
    }
    const mid = await probeHover(page, xMid, y);
    const vA = netMap.get(pair.a.ts!)!;
    const vB = netMap.get(pair.b.ts!)!;
    const interpolated = vA + 0.4 * (vB - vA);
    evid['interpolationCounterProof'] = {
      xMode,
      anchorA: pair.a,
      anchorB: pair.b,
      apiIndexA: pair.ia,
      apiIndexB: pair.ib,
      xA,
      xB,
      anchorGapPx: xB - xA,
      xMid,
      tsObservedBetweenAnchors: [...seenTs],
      hovered: mid,
      vA,
      vB,
      fraction: 0.4,
      interpolated,
      interpolatedText: fmtMoney2(interpolated),
      expectedSnapText: fmtMoney2(vA),
    };
    expect(
      [...seenTs].sort((a, b) => a - b),
      `相邻性二次取证：(xA, xB) 内只应出现两个锚点的 ts（实得 ${JSON.stringify([...seenTs])}）`,
    ).toEqual([Math.min(pair.a.ts!, pair.b.ts!), Math.max(pair.a.ts!, pair.b.ts!)]);
    expect(
      mid.ts,
      `两根**相邻**锚点之间 40% 处必须 snap 到**左端原始点**（ts=${pair.a.ts}），实得 ts=${mid.ts}（插值实现会给出别的 ts/值）`,
    ).toBe(pair.a.ts);
    expect(
      mid.v0,
      `读数必须是左端**原值** ${fmtMoney2(vA)}（实得 ${mid.v0}）—— 插值实现会给出 ${fmtMoney2(interpolated)}`,
    ).toBe(fmtMoney2(vA));
    expect(
      fmtMoney2(interpolated),
      `鉴别力前提：该位置线性插值结果 ${fmtMoney2(interpolated)} 必须 ≠ 左端原值 ${fmtMoney2(vA)}`,
    ).not.toBe(fmtMoney2(vA));
    expect(mid.v0, `读数 ≠ 插值结果（${fmtMoney2(interpolated)}）`).not.toBe(fmtMoney2(interpolated));

    // ③ 点击锁定 / 再点同点解除 / Esc / 点卡外解除
    const xc = rect.x + rect.width / 2;
    await page.mouse.click(xc, y);
    await expect(page.getByTestId('wb-readout-locked'), '点击后必须出现锁定标记').toBeVisible();
    await expect(frame).toHaveAttribute('data-readout-locked', 'true');
    const lockedTs = await page.getByTestId('wb-readout-equity').getAttribute('data-readout-ts');
    expect(lockedTs, '锁定读数必须带 ts').not.toBeNull();

    await page.mouse.click(xc, y);
    await expect(frame, '再点同点必须解除锁定').toHaveAttribute('data-readout-locked', 'false');
    expect(await page.getByTestId('wb-readout-locked').count(), '解除后锁定标记必须消失').toBe(0);

    await page.mouse.click(xc, y);
    await expect(page.getByTestId('wb-readout-locked')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(frame, 'Esc 必须解除锁定').toHaveAttribute('data-readout-locked', 'false');

    await page.mouse.click(xc, y);
    await expect(page.getByTestId('wb-readout-locked')).toBeVisible();
    // 卡外 = **读数框之外的中性区域**（`wb-indicator-view-header` 的空白段：无点击处理器，不会改选中 run）
    await page.getByTestId('wb-indicator-view-header').click({ position: { x: 300, y: 8 } });
    await expect(frame, '点击卡外必须解除锁定').toHaveAttribute('data-readout-locked', 'false');

    // ④ 键盘 ←/→：读数变化，且对应 bar 索引（接口序列下标）按方向变化
    await page.keyboard.press('Escape');
    const hov = await probeHover(page, xc, y);
    expect(hov.ts, '键盘测试前须有悬停读数').not.toBeNull();
    await frame.focus();
    await expect(frame, '卡必须可聚焦（tabIndex=0）').toBeFocused();
    // 取出脏：**不得**再发 mousemove（未锁定时悬停会覆盖键盘态 ⇒ 必须直接读 DOM）
    const readTs = () =>
      page.evaluate(() => {
        const r = document.querySelector('[data-testid="wb-readout-equity"]');
        return r?.getAttribute('data-readout-ts') ?? null;
      });
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    const keyReadout = await readTs();
    evid['keyboard'] = { hoverTs: hov.ts, keyReadoutTs: keyReadout };
    expect(keyReadout, '按 → 后必须有读数').not.toBeNull();
    expect(keyReadout, '按 → 必须移动读数点（ts 变化）').not.toBe(hov.ts);
    expect(
      tsIndexByTs.get(Number(keyReadout))! > tsIndexByTs.get(hov.ts!)!,
      `按 → 必须移动到**更靠后**的原始点（期望 index > ${tsIndexByTs.get(hov.ts!)}，实得 ${tsIndexByTs.get(Number(keyReadout))}）`,
    ).toBe(true);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(150);
    const keyBack = await readTs();
    (evid['keyboard'] as Record<string, unknown>)['afterLeftTs'] = keyBack;
    expect(Number(keyBack), '按 ← 必须回到原读数点').toBe(hov.ts);

    writeJson('a2_readout', evid);
  });
});

// ───────────────────────────────────── A3：文字不被拉伸（真身两次实测） ─────────────────────────────────────

interface WidthMeasure {
  cardWidth: number;
  frameWidth: number;
  ticks: Array<{ index: number; text: string; tickValue: string | null; width: number; insideStretchedSvg: boolean }>;
}

async function measureWidths(page: Page, card: Card): Promise<WidthMeasure> {
  return (await page.evaluate(
    ({ c }: { c: string }) => {
      const cardEl = document.querySelector(`[data-testid="wb-${c}-chart"]`);
      const frame = document.querySelector(`[data-testid="wb-readout-frame-${c}"]`);
      const labels = Array.from(document.querySelectorAll(`[data-testid^="wb-axis-tick-${c}-"]`));
      return {
        cardWidth: cardEl?.getBoundingClientRect().width ?? -1,
        frameWidth: frame?.getBoundingClientRect().width ?? -1,
        ticks: labels.map((el, i) => ({
          index: i,
          text: (el.textContent ?? '').trim(),
          tickValue: el.getAttribute('data-tick-value'),
          width: el.getBoundingClientRect().width,
          insideStretchedSvg: el.closest('svg[preserveAspectRatio="none"]') !== null,
        })),
      };
    },
    { c: card },
  )) as WidthMeasure;
}

test.describe('D12｜文字不被非等比拉伸（真身实测两次）', () => {
  test('A3：卡宽显著变化而同一刻度标签文本宽度基本不变（|Δtext| ≤ 1px）', async ({ page }) => {
    test.setTimeout(240_000);
    mkdirSync(OUT, { recursive: true });
    const target = await resolveAxisTarget(page);
    const evid: Record<string, unknown> = { target };

    await page.setViewportSize({ width: 1280, height: 800 });
    await openRun(page, target.id);
    const narrow: Record<string, WidthMeasure> = {};
    for (const c of CARDS) narrow[c] = await measureWidths(page, c);

    // 卡宽显著变化（view 宽 380px 左栏固定 ⇒ 结果区增宽 ~440px）
    await page.setViewportSize({ width: 1720, height: 800 });
    await expect(page.getByTestId('wb-axis-ticks-aggregate')).toBeVisible();
    await page.waitForTimeout(2500); // 视口变化 → K 线可见区间/共享窗口 settle
    const wide: Record<string, WidthMeasure> = {};
    for (const c of CARDS) wide[c] = await measureWidths(page, c);

    const report: Record<string, unknown> = {};
    for (const c of CARDS) {
      const n = narrow[c]!;
      const w = wide[c]!;
      const dW = w.cardWidth - n.cardWidth;
      const dFrame = w.frameWidth - n.frameWidth;
      // 同一标签：优先按**文本相同**配对（真身「同一个刻度标签」）；文本随域变化时按值集合交集给出可比对数
      const byText = new Map(n.ticks.map((t) => [t.text, t]));
      const matched = w.ticks
        .map((t) => ({ wide: t, narrowEl: byText.get(t.text) }))
        .filter((p): p is { wide: typeof p.wide; narrowEl: NonNullable<typeof p.narrowEl> } => p.narrowEl != null)
        .map((p) => ({ text: p.wide.text, narrowW: p.narrowEl.width, wideW: p.wide.width, d: p.wide.width - p.narrowEl.width }));
      report[c] = {
        narrow: n,
        wide: w,
        deltaCardWidth: dW,
        deltaFrameWidth: dFrame,
        matchedByText: matched,
      };
      // 卡宽必须显著变化（否则 Δtext 无意义）
      expect(Math.abs(dW), `${c}：视口 1280→1720 必须让卡宽显著变化（实测 ΔW=${dW}）`).toBeGreaterThan(100);
      // 标签一律不在被拉伸的 svg 内（两态都应成立）
      expect(
        n.ticks.every((t) => !t.insideStretchedSvg) && w.ticks.every((t) => !t.insideStretchedSvg),
        `${c}：两态下刻度标签都不得位于 preserveAspectRatio="none" 的 svg 内`,
      ).toBe(true);
      // 关键判据：同一标签文本宽度基本不变
      expect(
        matched.length,
        `${c}：必须至少有一个**同文本**标签可在两态间配对（否则宽度比对不可执行；narrow=${JSON.stringify(
          n.ticks.map((t) => t.text),
        )} wide=${JSON.stringify(w.ticks.map((t) => t.text))}）`,
      ).toBeGreaterThan(0);
      for (const m of matched) {
        expect(
          Math.abs(m.d),
          `${c}：标签「${m.text}」文本宽度必须基本不变（窄 ${m.narrowW}px → 宽 ${m.wideW}px，Δ=${m.d}px）；` +
            `若文字画在 preserveAspectRatio="none" 的 svg 内，Δtext 会随 ΔW≈${dW}px 线性放大（本机实测同一文本 Δ≈5px）`,
        ).toBeLessThanOrEqual(1);
      }
      // 附加鉴别力读数：若标签被拉伸，Δtext/文本宽 ≈ ΔW/画布 user 宽
      report[c] = { ...(report[c] as object), stretchIfInsideSvg: dFrame / 984 };
    }
    evid['measurements'] = report;
    evid['deltaSummary'] = Object.fromEntries(
      CARDS.map((c) => [
        c,
        {
          deltaCardWidth: (report[c] as { deltaCardWidth: number }).deltaCardWidth,
          deltaText: (report[c] as { matchedByText: Array<{ text: string; d: number }> }).matchedByText.map((m) => ({
            text: m.text,
            deltaText: m.d,
          })),
        },
      ]),
    );
    writeJson('a3_text_not_stretched', evid);
  });
});

// ───────────────────────────── A4/A5：D13 交互链**逐卡**实测（补齐 equity-only 的覆盖缺口） ─────────────────────────────

/**
 * **逐卡**取数面（四卡各自的「原值」来源，与卡源码的 series 定义一一对应）：
 *  - `aggregate` → `/bars?kind=per_bar` 的 `aggregate`（格式 `fmtScore`）
 *  - `slot`      → `/bars?kind=per_bar` 的 `scores[slot_idx].score`（仅**图例可见**的 slot 各一行，按 slot_idx 升序）
 *  - `equity`    → `/curve?kind=net_value`（`toFixed(2)`）+ `/curve?kind=drawdown`（`×100%` 两位）
 *  - `position`  → `/curve?kind=position` 的 `position_ratio`（`×100%` 两位）
 */
interface BarRecord {
  ts: number;
  aggregate?: number;
  scores?: Array<{ score: number; slot_idx: number }>;
}

interface CardData {
  /** ts → 该卡读数各行期望文本（**独立**算自接口，不复用 UI 派生量）。 */
  expectedRows: (ts: number) => string[];
  /** 该卡锚点 ts 的**升序**全集（用于「←/→ 方向」判据与「ts 必属原始点」判据）。 */
  tsOrdered: number[];
  tsIndex: Map<number, number>;
  /** 该卡读数行数（按图例/系列定义算出）。 */
  rowCount: number;
}

const fmtScore = (v: number | undefined) => (v == null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(2));
const pct2 = (v: number | undefined) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);

async function loadCardData(page: Page, runId: string, visibleSlots: number[]): Promise<Record<Card, CardData>> {
  const barsJson = (await getBars(page, runId)) as { bars?: BarRecord[] };
  const bars = (barsJson.bars ?? []).slice().sort((a, b) => a.ts - b.ts);
  const barByTs = new Map(bars.map((b) => [b.ts, b]));
  const perBarTs = bars.map((b) => b.ts);

  const net = pairs(await curvePoints(page, runId, 'net_value'));
  const dd = new Map(pairs(await curvePoints(page, runId, 'drawdown')));
  const netMap = new Map(net);
  const netTs = net.map((p) => p[0]).sort((a, b) => a - b);

  const posRows = (await curvePoints(page, runId, 'position'))
    .filter((p): p is Record<string, number> => !Array.isArray(p))
    .filter((p) => typeof p['position_ratio'] === 'number')
    .sort((a, b) => (a['ts'] as number) - (b['ts'] as number));
  const posMap = new Map(posRows.map((p) => [p['ts'] as number, p['position_ratio'] as number]));
  const posTs = posRows.map((p) => p['ts'] as number);

  const mk = (tsOrdered: number[], rowCount: number, rows: (ts: number) => string[]): CardData => ({
    expectedRows: rows,
    tsOrdered,
    tsIndex: new Map(tsOrdered.map((t, i) => [t, i])),
    rowCount,
  });

  return {
    aggregate: mk(perBarTs, 1, (ts) => [fmtScore(barByTs.get(ts)?.aggregate)]),
    slot: mk(perBarTs, visibleSlots.length, (ts) => {
      const rec = barByTs.get(ts);
      return visibleSlots.map((si) => fmtScore(rec?.scores?.find((s) => s.slot_idx === si)?.score));
    }),
    equity: mk(netTs, 2, (ts) => [fmtMoney2(netMap.get(ts) ?? NaN), pct2(dd.get(ts))]),
    position: mk(posTs, 1, (ts) => [pct2(posMap.get(ts))]),
  };
}

async function getBars(page: Page, runId: string): Promise<unknown> {
  const r = await page.request.get(`/api/workbench/runs/${runId}/bars?kind=per_bar&offset=0&limit=5000`);
  expect(r.ok(), `/bars?kind=per_bar（status=${r.status()}）`).toBeTruthy();
  return r.json();
}

/** 图例可见性（真身读 checkbox 状态 ⇒ 「可见线」集合来自 DOM 而非硬编码）。 */
async function visibleSlotIdxs(page: Page): Promise<number[]> {
  return (await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[data-testid^="legend-slot-"]')) as HTMLInputElement[];
    return els
      .map((e, i) => ({ i, checked: e.checked }))
      .filter((x) => x.checked)
      .map((x) => x.i);
  })) as number[];
}

interface CardHover {
  x: number;
  ts: number | null;
  values: string[];
  readoutText: string | null;
  xPct: number | null;
}

/** 单次悬停读数（该卡）。React 提交与 CDP 事件之间存在单帧竞态 ⇒ `ts === null` 时**重试**（最多 3 次，
 *  **不**放宽任何值判据：只影响「是否有读数」的取样时机，不影响比对内容）。 */
async function probeCard(page: Page, card: Card, x: number, y: number): Promise<CardHover> {
  let out = await probeCardOnce(page, card, x, y);
  for (let i = 0; i < 2 && out.ts == null; i++) {
    await page.mouse.move(x + 1, y);
    await page.waitForTimeout(120);
    await page.mouse.move(x, y);
    await page.waitForTimeout(80);
    out = await probeCardOnce(page, card, x, y);
  }
  return out;
}

async function probeCardOnce(page: Page, card: Card, x: number, y: number): Promise<CardHover> {
  await page.mouse.move(x, y);
  return (await page.evaluate(
    ({ c, mx }: { c: string; mx: number }) => {
      const read = document.querySelector(`[data-testid="wb-readout-${c}"]`);
      const cross = document.querySelector(`[data-testid="wb-crosshair-${c}"]`) as HTMLElement | null;
      const valueEls = Array.from(document.querySelectorAll(`[data-testid^="wb-readout-value-${c}-"]`));
      const pct = cross?.style.left ?? null;
      return {
        x: mx,
        ts: read?.getAttribute('data-readout-ts') ? Number(read.getAttribute('data-readout-ts')) : null,
        values: valueEls.map((e) => (e.textContent ?? '').trim()),
        readoutText: read?.textContent?.trim() ?? null,
        xPct: pct == null ? null : Number(pct.replace('%', '')),
      };
    },
    { c: card, mx: x },
  )) as CardHover;
}

/**
 * **取样点有效性守卫**（A5 用）：Playwright 在 `click(legend)` 前会**自动滚动**目标元素 ⇒ 之前量得的
 * frame 盒子会**过期**，直接复用旧 `(x,y)` 会打在卡外 ⇒ 会产出「读数消失」的**假绿**。
 * 本函数**现场重新量盒**，把「锚点 xPct」换算成新的屏幕坐标，并回报该点是否真的落在 frame 内
 * （`elementFromPoint` 的祖先链含 frame）。A5 的每条读数结论都必须先过这道守卫。
 */
async function framePoint(
  page: Page,
  card: Card,
  xPct: number,
): Promise<{
  x: number;
  y: number;
  inside: boolean;
  box: { x: number; y: number; width: number; height: number };
  diag: Record<string, unknown>;
}> {
  const frame = page.getByTestId(`wb-readout-frame-${card}`);
  // 先滚入视口（Playwright 点图例时会自动滚动 ⇒ 取样前必须自己把 frame 摆好）
  await frame.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(80);
  const b = await frame.boundingBox();
  if (!b) throw new Error(`${card}：读数框不可测`);
  const x = b.x + (xPct / 100) * b.width;
  // 纵向候选：中心 → 3/4 → 1/4 → 顶部 +12px。**不锁死中心**：sticky 头/滚动容器可能遮住中心，
  // 取「真落在 frame 内」的第一个（读数锚点只由 x 决定 ⇒ 换 y 不改变取到的 bar）。
  const cands = [b.y + b.height / 2, b.y + (b.height * 3) / 4, b.y + b.height / 4, b.y + 12];
  const probe = async (y: number) =>
    (await page.evaluate(
      ({ c, px, py }: { c: string; px: number; py: number }) => {
        const el = document.elementFromPoint(px, py);
        const f = document.querySelector(`[data-testid="wb-readout-frame-${c}"]`);
        return {
          inside: !!(el && f && (f === el || f.contains(el))),
          at: el ? `${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? ''}]` : 'null',
        };
      },
      { c: card, px: x, py: y },
    )) as { inside: boolean; at: string };
  const trials: Array<Record<string, unknown>> = [];
  for (const y of cands) {
    const r = await probe(y);
    trials.push({ y, ...r });
    if (r.inside) {
      return { x, y, inside: true, box: b, diag: { xPct, viewport: page.viewportSize(), trials } };
    }
  }
  return { x, y: cands[0]!, inside: false, box: b, diag: { xPct, viewport: page.viewportSize(), trials } };
}

async function readReadoutTs(page: Page, card: Card): Promise<number | null> {
  return (await page.evaluate((c: string) => {
    const r = document.querySelector(`[data-testid="wb-readout-${c}"]`);
    const v = r?.getAttribute('data-readout-ts');
    return v == null ? null : Number(v);
  }, card)) as number | null;
}

test.describe('D13｜交互链逐卡实测（aggregate / slot / equity / position）', () => {
  test('A4：四卡各自 悬停原值 + 锁定 + Esc + ←→ + 可聚焦（逐卡独立取证）', async ({ page }) => {
    test.setTimeout(300_000);
    mkdirSync(OUT, { recursive: true });
    const target = await resolveAxisTarget(page);
    await openRun(page, target.id);
    const visibleSlots = await visibleSlotIdxs(page);
    expect(visibleSlots.length, 'slot 卡至少要有 1 条可见线（否则本用例前提不成立）').toBeGreaterThan(0);
    const data = await loadCardData(page, target.id, visibleSlots);

    const out: Record<string, unknown> = { target, visibleSlots, cards: {} };
    for (const card of CARDS) {
      const d = data[card];
      const frame = page.getByTestId(`wb-readout-frame-${card}`);
      await frame.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      const box = await frame.boundingBox();
      expect(box, `${card}：读数框必须可测`).not.toBeNull();
      const y = box!.y + box!.height / 2;

      // ── ① 扫描找锚点（14 个位置）；记录全部命中（供「ts 单调 + 覆盖多根 bar」判据）
      const scans: CardHover[] = [];
      for (let k = 1; k <= 14; k++) {
        scans.push(await probeCard(page, card, box!.x + (box!.width * k) / 15, y));
      }
      const hits = scans.filter((s) => s.ts != null);
      /**
       * 鉴别力：**未接线**（该卡没把 readoutSeries/ticks 接进 CurveReadoutFrame 或没渲染 frame）⇒ 命中数 0 ⇒ 必红。
       * 选「信息量最大」的一次命中（首行数值绝对值最大；恒定序列则退化为第一个命中）作为主样本。
       */
      expect(
        hits.length,
        `${card}：悬停 14 点必须命中读数（命中 ${hits.length}）—— 该卡未接线/未渲染读数时本条即红`,
      ).toBeGreaterThan(0);
      const score = (h: CardHover) => {
        const n = Number((h.values[0] ?? '').replace('%', ''));
        return Number.isFinite(n) ? Math.abs(n) : 0;
      };
      const main = hits.slice().sort((a, b) => score(b) - score(a))[0]!;

      // ② ts 必属该卡原始点集合，且扫描覆盖 ≥3 根不同 bar（读数确实由鼠标位置驱动，不是恒值）
      const bogusTs = hits.filter((h) => !d.tsIndex.has(h.ts!)).map((h) => h.ts);
      expect(bogusTs, `${card}：读数 ts 必须全部属于该卡原始点 ts 集合（插值/自造 ts ⇒ 本断言红）`).toEqual([]);
      const distinctTs = new Set(hits.map((h) => h.ts));
      expect(
        distinctTs.size,
        `${card}：扫描必须覆盖 ≥3 根不同 bar（实得 ${distinctTs.size}）—— 读数与鼠标位置脱钩时本条即红`,
      ).toBeGreaterThanOrEqual(3);

      // ③ 值逐字符 == 接口原值（该 ts 的该卡各行）
      const expRows = d.expectedRows(main.ts!);
      expect(
        main.values,
        `${card}：读数各行必须逐字符等于接口原值（ts=${main.ts}；期望 ${JSON.stringify(expRows)}，实得 ${JSON.stringify(main.values)}）`,
      ).toEqual(expRows);
      expect(main.values.length, `${card}：读数行数必须 == 该卡可见系列数`).toBe(d.rowCount);
      // 读数整段文本必须含该 ts 的格式化时刻（杜绝「有元素无内容」）
      expect(main.readoutText, `${card}：读数文本必须非空`).toBeTruthy();
      expect((main.readoutText ?? '').length, `${card}：读数文本长度`).toBeGreaterThan(0);

      // ④ 点击 ⇒ 锁定（`wb-readout-locked` 出现 + `data-readout-locked=true` + 读数 ts 不变）
      await page.mouse.click(main.x, y);
      await expect(page.getByTestId('wb-readout-locked'), `${card}：点击后必须出现锁定标记`).toBeVisible();
      await expect(frame, `${card}：点击后 data-readout-locked 必须为 true`).toHaveAttribute(
        'data-readout-locked',
        'true',
      );
      const lockedTs = await readReadoutTs(page, card);
      expect(lockedTs, `${card}：锁定不得改变读数点（悬停 ${main.ts} → 锁定 ${lockedTs}）`).toBe(main.ts);
      await expect(frame, `${card}：卡必须可聚焦（tabIndex=0）`).toHaveAttribute('tabindex', '0');

      // ⑤ Esc ⇒ 解除（锁定标记消失 + 属性 false）
      await page.keyboard.press('Escape');
      await expect(frame, `${card}：Esc 必须解除锁定`).toHaveAttribute('data-readout-locked', 'false');
      expect(await page.getByTestId('wb-readout-locked').count(), `${card}：解除后锁定标记必须消失`).toBe(0);

      // ⑥ 再锁定 ⇒ ←/→ 移动读数（ts 前后原值 + 该卡 ts 序列下标方向）
      await page.mouse.click(main.x, y);
      await expect(page.getByTestId('wb-readout-locked'), `${card}：再点必须重新锁定`).toBeVisible();
      await frame.focus();
      await expect(frame, `${card}：按键前必须已聚焦`).toBeFocused();
      const ts0 = await readReadoutTs(page, card);
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(120);
      const tsR = await readReadoutTs(page, card);
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(120);
      const tsL = await readReadoutTs(page, card);

      const i0 = d.tsIndex.get(ts0 ?? -1) ?? -1;
      const iR = d.tsIndex.get(tsR ?? -1) ?? -1;
      const iL = d.tsIndex.get(tsL ?? -1) ?? -1;
      expect(tsR, `${card}：按 → 必须移动读数点（ts 变化）`).not.toBe(ts0);
      expect(
        iR > i0,
        `${card}：按 → 必须前进到**更靠后**的原始点（ts0=${ts0}@${i0} → tsR=${tsR}@${iR}）—— ` +
          `读数未落在原始点（插值/自造 ts）时本条即红`,
      ).toBe(true);
      expect(tsL, `${card}：按 ← 必须回到原读数点（ts0=${ts0}，实得 ${tsL}）`).toBe(ts0);

      (out['cards'] as Record<string, unknown>)[card] = {
        rowCount: d.rowCount,
        fps: { y, frameBox: box },
        scanHits: hits.length,
        distinctTs: distinctTs.size,
        main,
        expectedRows: expRows,
        gotRows: main.values,
        lock: { lockedTs, frameTabIndex: await frame.getAttribute('tabindex') },
        keyboard: { ts0, index0: i0, afterRightTs: tsR, indexRight: iR, afterLeftTs: tsL, indexLeft: iL },
      };

      // 收尾：解除锁定，避免污染下一张卡（锁定态是会话内状态且跨卡独立）
      await page.keyboard.press('Escape');
      await expect(frame, `${card}：收尾必须为未锁定`).toHaveAttribute('data-readout-locked', 'false');
    }
    writeJson('a4_per_card_interaction', out);
  });

  test('A5：slot 卡「图例隐藏 ⇒ 读数与可见线一致」耦合', async ({ page }) => {
    test.setTimeout(240_000);
    mkdirSync(OUT, { recursive: true });
    const target = await resolveAxisTarget(page);
    await openRun(page, target.id);

    // 环境事实（**重要**）：活库是否存在 ≥2 slots 的 succeeded run？决定「剩余可见线」变体能否执行。
    const runs = (await page.request.get('/api/workbench/runs?limit=500')).ok()
      ? ((await (await page.request.get('/api/workbench/runs?limit=500')).json()) as Array<{
          id: string;
          status?: string;
          config?: { slots?: unknown[] };
        }>)
      : [];
    const multiSlot = runs.filter((r) => r.status === 'succeeded' && (r.config?.slots ?? []).length >= 2);
    const runConfig = runs.find((r) => r.id === target.id)?.config as { slots?: unknown[] } | undefined;

    const visible0 = await visibleSlotIdxs(page);
    const legendCount = await page.locator('[data-testid^="legend-slot-"]').count();
    const data = await loadCardData(page, target.id, visible0);
    const frame = page.getByTestId('wb-readout-frame-slot');
    await frame.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    const box = await frame.boundingBox();
    expect(box, 'slot 卡读数框必须可测').not.toBeNull();

    // ① 基线（图例全开）：命中一个锚点，读数行 == 可见线数、值逐字符 == 接口原值
    let base: CardHover | null = null;
    let baseInside = false;
    for (let k = 1; k <= 12 && base == null; k++) {
      const pt = await framePoint(page, 'slot', (100 * k) / 13);
      expect(pt.inside, `slot 卡：取样点必须真落在读数框内（k=${k}）`).toBe(true);
      const h = await probeCard(page, 'slot', pt.x, pt.y);
      if (h.ts != null) base = { ...h, x: pt.x };
      baseInside = pt.inside;
    }
    expect(base, 'slot 卡图例全开时必须能取到读数（未接线 ⇒ 本条红）').not.toBeNull();
    expect(base!.values, 'slot 卡：图例全开时读数行必须逐字符 == 接口原值').toEqual(
      data.slot.expectedRows(base!.ts!),
    );
    expect(base!.values.length, 'slot 卡：读数行数 == 可见线数').toBe(visible0.length);
    const polyBefore = await page.locator('[data-testid="wb-slot-chart"] svg polyline').count();

    // ② 隐藏第 1 条策略线（真身点击 checkbox），重新悬停
    const legend0 = page.getByTestId('legend-slot-0');
    await legend0.click();
    await expect(legend0, '图例 checkbox 必须被取消勾选').not.toBeChecked();
    const visible1 = await visibleSlotIdxs(page);
    expect(visible1.length, '隐藏后可见线数应减 1').toBe(visible0.length - 1);
    // ⚠️ 图例点击会让 Playwright 自动滚动 ⇒ **必须重新量盒**再用同一锚点 xPct 取样（否则假绿）
    const ptHide = await framePoint(page, 'slot', base!.xPct!);
    expect(
      ptHide.inside,
      `slot 卡：隐藏后的取样点必须真落在读数框内（否则「读数消失」可能是打偏而非耦合 ⇒ 假绿）；diag=${JSON.stringify(ptHide.diag)}`,
    ).toBe(true);
    const afterHide = await probeCard(page, 'slot', ptHide.x, ptHide.y);
    const polyAfter = await page.locator('[data-testid="wb-slot-chart"] svg polyline').count();

    /**
     * 鉴别力：读数行必须**跟随可见线**。
     *  - 若读数接的是**未过滤**的 slot 列表（典型「未接线」缺陷）⇒ 隐藏后仍出 1 行 ⇒ 本条必红；
     *  - 若读数行数与可见线数不一致 ⇒ 本条必红。
     * 本机活库**无 ≥2 slots 的 succeeded run**（见 evidence `multiSlotRuns`）⇒ 「剩余可见线」变体不可执行，
     * 隐藏后可见线数为 0 ⇒ **正确行为 = 读数整体消失（0 行）**，此处即按 0 行判定。
     */
    const hiddenRows = afterHide.ts == null ? 0 : afterHide.values.length;
    expect(
      hiddenRows,
      `slot 卡：隐藏全部策略线后读数必须消失/零行（可见线 ${visible1.length} 条；实得 ${hiddenRows} 行；` +
        `骨架 polyline 数 ${polyBefore} → ${polyAfter}）—— 读数未跟随可见线时本条红`,
    ).toBe(visible1.length);
    expect(afterHide.ts, 'slot 卡：无可见线时不得残留读数点').toBeNull();
    expect(polyAfter, 'slot 卡：隐藏后曲线骨架 polyline 必须消失').toBe(0);

    // ③ 恢复图例 ⇒ 读数回来且与基线**同一 ts、同一文本**（证明耦合是「可见性」而非「一次性丢弃」）
    await legend0.click();
    await expect(legend0, '图例 checkbox 必须恢复勾选').toBeChecked();
    const ptRestore = await framePoint(page, 'slot', base!.xPct!);
    expect(ptRestore.inside, 'slot 卡：恢复后的取样点必须真落在读数框内').toBe(true);
    const restored = await probeCard(page, 'slot', ptRestore.x, ptRestore.y);
    expect(restored.ts, 'slot 卡：恢复可见后必须回到同一 ts').toBe(base!.ts);
    expect(restored.values, 'slot 卡：恢复可见后读数必须与基线逐字符一致').toEqual(base!.values);
    const polyRestore = await page.locator('[data-testid="wb-slot-chart"] svg polyline').count();
    expect(polyRestore, 'slot 卡：恢复后曲线骨架必须回来').toBe(polyBefore);

    writeJson('a5_slot_legend_coupling', {
      target,
      runSlots: runConfig?.slots?.length ?? null,
      legendCount,
      visibleBaseline: visible0,
      visibleAfterHide: visible1,
      baseline: base,
      baselineInside: baseInside,
      probeGuards: {
        hide: ptHide.inside,
        restore: ptRestore.inside,
        hideDiag: ptHide.diag,
        restoreDiag: ptRestore.diag,
      },
      baselineExpected: data.slot.expectedRows(base!.ts!),
      afterHide,
      hiddenRows,
      polylineCounts: { before: polyBefore, afterHide: polyAfter, restore: polyRestore },
      restored,
      /** 环境事实：活库中 `succeeded ∧ slots ≥ 2` 的 run 数（0 ⇒ 「剩余可见线」变体不可执行，非产品缺陷）。 */
      multiSlotRuns: { count: multiSlot.length, ids: multiSlot.slice(0, 5).map((r) => r.id) },
    });
  });
});
