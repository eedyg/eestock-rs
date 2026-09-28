import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ADR-028 §2.10.1 **裁决 3｜规格耐久**：真渲染 e2e 的目标 run **必须按谓词解析**，**禁止硬编码**具体 run id。
 *
 * 动因（实测）：本机真实库有 **93 个 run**（每跑一次验收就新增若干），而历史列表首屏只渲染一页 ⇒
 * 硬编码的 run 会被新 run **顶出首屏**（前序车道已实测；见 `coder/report/030_…` §8-3），
 * 且目标 run 一旦被清理，规格会以「缺读数」的形式**假红**。
 *
 * 本模块的两条纪律（对应裁决 3 的原文「解析失败必须显式红 / 不得静默换用别的 run / 不得回退为跳过」）：
 *  1. {@link resolveRun} 只接受**谓词命中**的 run：按 `created_at` **倒序**（最新优先）逐个核对
 *     **结构性事实**（回合的 L2 笔数 / 成交所在 bar 与数据末端的距离 …），**第一个命中者**即结果；
 *     全都不命中 ⇒ **抛错**（携带扫描证据：扫了几个、各自为何被拒），**不返回**任何兜底值。
 *  2. {@link assertResolvedByIdFresh} 是**反硬编码护栏**：规格实际使用的 id 必须等于**现场重解析**的结果
 *     ——把 run id 改回字面量（硬编码）后，只要该字面量不是谓词命中的最新匹配 ⇒ 护栏立即变红。
 *
 * 依赖面刻意做成**端口**（{@link RunFetchPort}）而不是 Playwright `Page`：
 * 这样谓词/解析/护栏三件事都能在 vitest 里用固定 fixture 单测（`adr028RunResolve.test.ts`，先红后绿），
 * 真渲染侧只提供一个 3 行的 `page.request` 适配器。
 */

/** run 列表行（`GET /api/workbench/runs`；只取本模块需要的字段）。 */
export interface RunListItem {
  id: string;
  period?: string;
  status?: string;
  created_at?: string;
  /** 标的（`/runs` 实测携带；可选声明——谓词用它钉住「同一标的」的基线口径）。 */
  symbol?: string;
}

/** 回合行（`GET …/round-trips`）。 */
export interface RunRoundTrip {
  rt_seq: number;
  l2_count?: number;
  open_bar?: number;
  close_bar?: number;
  open_ts?: number;
  close_ts?: number;
  /** ADR-026 §2.3：清仓那一笔的来源（`Option<String>`）；**历史 run 缺字段/为 null** ⇒ UI 来源列显「未记录」。
   *  可选声明（真实 `GET /round-trips` 携带；仅 `legacy` 谓词读取）。 */
  reason?: string | null;
}

/** 成交行（`GET …/round-trips/{rt}/fills`）。 */
export interface RunFill {
  bar_index: number;
  ts: number;
  side: string;
  rt_seq: number;
}

/** 解析所需的**只读取数面**（真渲染侧由 `page.request` 实现；单测由 fixture 实现）。 */
export interface RunFetchPort {
  listRuns(): Promise<RunListItem[]>;
  totalBars(runId: string): Promise<number>;
  roundTrips(runId: string): Promise<RunRoundTrip[]>;
  fills(runId: string, rtSeq: number): Promise<RunFill[]>;
}

/** 谓词标签（= 用例族所需的**结构性**前提，不是「某个具体 run」）。 */
export type RunLabel = 'd1' | 'center' | 'excl' | 'm5' | 'pair' | 'klineHistory' | 'audit' | 'legacy';

/** 解析结果（含**可复核证据**：谓词原文 / 扫描数 / 逐候选拒绝原因）。 */
export interface ResolvedRun {
  id: string;
  label: RunLabel;
  predicate: string;
  totalBars: number;
  rtSeq: number | null;
  l2Count: number | null;
  evidence: {
    scanned: number;
    rejected: Array<{ id: string; why: string }>;
    detail: Record<string, unknown>;
    /** 本次解析使用的**有界并发度**（可复核；1 = 串行）。 */
    concurrency?: number;
    /** 落盘缓存的处置（`disabled`/`miss`/`hit`/`invalidated`）；命中必有 `validated: true`。 */
    cache?: ResolveCacheInfo;
  };
}

/** 落盘缓存处置（**命中仍须校验**，故单列 `validated` 与失效 `reason`）。 */
export interface ResolveCacheInfo {
  status: 'disabled' | 'miss' | 'hit' | 'invalidated';
  key?: string;
  path?: string;
  /** 失效原因（`invalidated` 时必有 ⇒ 禁静默换 run）。 */
  reason?: string;
  /** 命中后是否已重新校验「run 仍存在 ∧ 仍满足谓词」。 */
  validated?: boolean;
}

/** 解析选项（全部可选；**默认值即生产口径**）。 */
export interface ResolveRunOptions {
  /** 有界并发度（默认 {@link DEFAULT_CONCURRENCY}；1 = 串行，用于对拍）。 */
  concurrency?: number;
  /** 缓存出口目录（**未跟踪**目录）；`null` = 完全关闭缓存。默认 {@link DEFAULT_RESOLVE_CACHE_DIR}。 */
  cacheDir?: string | null;
  /** 库/后端身份（如 base URL）——进缓存键，防跨后端复用同一条目。 */
  sourceKey?: string;
}

/** E1/E2/E4/D10L/M1 的结构性前提：回合 1 至少 16 笔，且「第 16 笔落在数据末根、第 8 笔不在末根」。 */
export const L2_MIN_FILLS = 16;
/** 中段目标行下标（E2：距末端 31 根，span=120 ⇒ 物理上无法居中）。 */
export const L2_MID_IDX = 7;
/** 末端目标行下标（E2：必须是数据末根上的成交）。 */
export const L2_END_FILL_IDX = 15;
/** E3/M2 要求目标两侧各 ≥ 该根数（真居中可行）。 */
export const CENTER_MARGIN_BARS = 60;
/** D10E 要求 run 全根数 ≥ 该值（可达根数 ≪ 全根数 ⇒ 两源错位判别力最大）。 */
export const EXCL_MIN_BARS = 3000;

/* ── `audit` 谓词的冻结基线事实（ADR-026 §2.2/§2.4；数值逐字取自
 *    `coder/evidence/20260919_adr026_redeploy/raw/12_audit_resp.json`，**不得**改写成别的 run 的读数）── */
/** 冻结基线标的（`11_run_row.txt`：symbol=518880 / D1）。 */
export const AUDIT_SYMBOL = '518880';
/** 成交合计（`/fills` 全口径）= 42 Buy(Policy) + 1 Sell(ForceClose)。 */
export const AUDIT_FILL_TOTAL = 43;
/** 买入成交笔数（= 审计 `batches_done`）。 */
export const AUDIT_BUY_FILLS = 42;
/** 期末强平卖出笔数（`round_trips_force_closed`）。 */
export const AUDIT_SELL_FILLS = 1;
/** 回合 1 的 `l2_count`（= 逐笔源 L2 全口径笔数 = {@link AUDIT_FILL_TOTAL}）。 */
export const AUDIT_L2_COUNT = 43;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

/**
 * 解析的**有界并发度**默认值（§7.2 修法 ② 实测：`d1` 串行 **48.8s** → 8 路 **7.4s**，6.6×）。
 * 为什么必须有界：`page.request` 单次 150–300ms，无限并发会把后端与本机拖进排队区；
 * 8 路在上述实测里既能吃满收益又不触发排队（库 93 run / 75 候选时仍 < 8s）。
 */
export const DEFAULT_CONCURRENCY = 8;
/**
 * 解析结果的**落盘缓存出口**（§7.2 修法 ③）。默认落**未跟踪**目录 `coder/evidence/…`
 * （`AGENTS.md`「代理产物与提交纪律」：`coder/evidence/` 已 gitignore）——禁把缓存写进
 * 已跟踪路径。可用 `ADR028_RESOLVE_CACHE=off` 或传 `cacheDir: null` 关闭。
 */
export const DEFAULT_RESOLVE_CACHE_DIR: string | null =
  process.env.ADR028_RESOLVE_CACHE === 'off' || process.env.ADR028_RESOLVE_CACHE === ''
    ? null
    : (process.env.ADR028_RESOLVE_CACHE ?? resolve(REPO, 'coder/evidence/adr028_resolve_cache'));

/** 缓存条目（键 = 后端身份 + 谓词 + **库指纹**）。 */
interface CacheEntry {
  version: 1;
  key: string;
  label: RunLabel;
  resolvedAt: string;
  resolved: ResolvedRun;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function cacheFile(dir: string, key: string): string {
  return resolve(dir, `${sha256(key).slice(0, 32)}.json`);
}

function readEntry(path: string, key: string, label: RunLabel): CacheEntry | null {
  try {
    const e = JSON.parse(readFileSync(path, 'utf8')) as CacheEntry;
    if (e?.version !== 1 || e.key !== key || e.label !== label) return null;
    if (typeof e.resolved?.id !== 'string') return null;
    return e;
  } catch {
    return null;
  }
}

function writeEntry(dir: string, key: string, label: RunLabel, resolved: ResolvedRun): string {
  const path = cacheFile(dir, key);
  mkdirSync(dir, { recursive: true });
  const entry: CacheEntry = { version: 1, key, label, resolvedAt: new Date().toISOString(), resolved };
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2), 'utf8');
  renameSync(tmp, path); // 原子替换：并发写者不会读到半个文件
  return path;
}

/** 谓词命中（内部）。 */
interface PredicateHit {
  hit: true;
  totalBars: number;
  rtSeq: number | null;
  l2Count: number | null;
  detail: Record<string, unknown>;
}

interface Predicate {
  label: RunLabel;
  /** 人读谓词（写进证据 JSON，便于复核「解析到什么、为什么」）。 */
  text: string;
  period: string;
  /** 核对候选的结构性事实；返回字符串 = 拒绝原因，返回 hit = 命中。 */
  inspect(port: RunFetchPort, run: RunListItem): Promise<PredicateHit | string>;
}

async function inspectD1(port: RunFetchPort, run: RunListItem): Promise<PredicateHit | string> {
  const total = await port.totalBars(run.id);
  const rts = await port.roundTrips(run.id);
  const rt = rts.find((t) => t.rt_seq === 1);
  if (!rt) return '无 rt_seq=1 的回合';
  if ((rt.l2_count ?? 0) < L2_MIN_FILLS) return `rt1 l2_count=${rt.l2_count ?? 0} < ${L2_MIN_FILLS}`;
  const fl = await port.fills(run.id, 1);
  if (fl.length < L2_MIN_FILLS) return `rt1 fills=${fl.length} < ${L2_MIN_FILLS}`;
  const endBar = fl[L2_END_FILL_IDX]!.bar_index;
  const midBar = fl[L2_MID_IDX]!.bar_index;
  if (endBar !== total - 1) return `fills[${L2_END_FILL_IDX}].bar_index=${endBar} ≠ 数据末根 ${total - 1}（E2 需贴末端）`;
  if (midBar >= total - 1) return `fills[${L2_MID_IDX}].bar_index=${midBar} 贴数据末根（E2 需中段目标）`;
  return {
    hit: true,
    totalBars: total,
    rtSeq: 1,
    l2Count: rt.l2_count ?? fl.length,
    detail: { endBar, midBar, fills: fl.length, totalBars: total },
  };
}

async function inspectCenter(port: RunFetchPort, run: RunListItem): Promise<PredicateHit | string> {
  const total = await port.totalBars(run.id);
  const rts = await port.roundTrips(run.id);
  const rt = rts.find((t) => t.rt_seq === 3);
  if (!rt) return '无 rt_seq=3 的回合';
  if ((rt.l2_count ?? 0) < 2) return `rt3 l2_count=${rt.l2_count ?? 0} < 2`;
  const fl = await port.fills(run.id, 3);
  if (fl.length < 2) return `rt3 fills=${fl.length} < 2`;
  const target = fl[1]!.bar_index;
  const margin = Math.min(target, total - 1 - target);
  if (margin < CENTER_MARGIN_BARS) return `rt3 第 2 笔 bar=${target} 距两侧最小 ${margin} 根 < ${CENTER_MARGIN_BARS}（真居中不可行）`;
  if (fl[0]!.bar_index === target) return 'rt3 两笔在同一根 bar ⇒ 无法判别「窗口是否移动」（M2 失去鉴别力）';
  return {
    hit: true,
    totalBars: total,
    rtSeq: 3,
    l2Count: rt.l2_count ?? fl.length,
    detail: { targetBar: target, firstBar: fl[0]!.bar_index, margin, totalBars: total },
  };
}

async function inspectExcl(port: RunFetchPort, run: RunListItem): Promise<PredicateHit | string> {
  const total = await port.totalBars(run.id);
  if (total < EXCL_MIN_BARS) return `per_bar total=${total} < ${EXCL_MIN_BARS}`;
  const rts = await port.roundTrips(run.id);
  const withL2 = rts.filter((t) => (t.l2_count ?? 0) >= 2);
  if (withL2.length === 0) return '无 l2_count ≥ 2 的回合（剔除判据需目标两侧都有数据）';
  const pick = withL2.slice().sort((a, b) => (b.l2_count ?? 0) - (a.l2_count ?? 0))[0]!;
  return {
    hit: true,
    totalBars: total,
    rtSeq: pick.rt_seq,
    l2Count: pick.l2_count ?? null,
    detail: { totalBars: total, rtSeq: pick.rt_seq, l2Count: pick.l2_count ?? null, roundTrips: rts.length },
  };
}

export const PAIR_MID_GAP_BARS = 40;
/** `pair` 前提：回合 1 至少这么多笔（至少要够「末根双笔 + 一个中段对照」）。 */
export const PAIR_MIN_FILLS = 3;

/**
 * `pair` 谓词（`adr028-features-verify*` 族的结构性前提：**末根 bar 双笔 + 中段对照**）。
 * 编码的不变量（均对**数据**而非某个具体 run）：
 *  ① rt_seq=1 成交 ≥ {@link PAIR_MIN_FILLS}；
 *  ② **数据末根 bar 上恰有一 Buy 一 Sell**（T1/T4/T5/V1 的「同 bar 双笔 + 买红卖绿」场景）；
 *  ③ 存在**中段**成交（距末根 ≥ {@link PAIR_MID_GAP_BARS} 根）⇒ 对照样本的标签有右侧绘制空间。
 */
async function inspectPair(port: RunFetchPort, run: RunListItem): Promise<PredicateHit | string> {
  const total = await port.totalBars(run.id);
  const rts = await port.roundTrips(run.id);
  const rt = rts.find((t) => t.rt_seq === 1);
  if (!rt) return '无 rt_seq=1 的回合';
  const fl = await port.fills(run.id, 1);
  if (fl.length < PAIR_MIN_FILLS) return `rt1 fills=${fl.length} < ${PAIR_MIN_FILLS}`;
  const lastBar = Math.max(...fl.map((f) => f.bar_index));
  const onLast = fl.filter((f) => f.bar_index === lastBar);
  const buyIdx = fl.findIndex((f) => f.bar_index === lastBar && f.side === 'Buy');
  const sellIdx = fl.findIndex((f) => f.bar_index === lastBar && f.side === 'Sell');
  if (buyIdx < 0 || sellIdx < 0) {
    return `末根 bar(${lastBar}) 上必须一 Buy 一 Sell（实得 Buy=${buyIdx} Sell=${sellIdx}，onLast=${onLast.length}）`;
  }
  const midIdx = fl.findIndex((f) => lastBar - f.bar_index >= PAIR_MID_GAP_BARS);
  if (midIdx < 0) return `无「距末根 ≥ ${PAIR_MID_GAP_BARS} 根」的中段成交（对照样本缺失）`;
  return {
    hit: true,
    totalBars: total,
    rtSeq: 1,
    l2Count: rt.l2_count ?? fl.length,
    detail: { lastBar, onLast: onLast.length, buyIdx, sellIdx, midIdx, fills: fl.length, totalBars: total },
  };
}

/**
 * `audit` 谓词（`adr026-audit.e2e.ts` 的**冻结审计基线**结构事实）。
 *
 * 动因（ADR-028 §2.10.1 裁决 3）：该规格原以硬编码 `sr_1789738328788_000005` 取靶，该 run 已**行删除**
 * （`GET /runs/{id}` → 404，且不在 `/runs?limit=500` 列表内），规格因而 7/7 红。
 * 本谓词把该规格**与「具体某个 run id」解耦**，只钉住它真正依赖的**结构事实**：
 *  ① `symbol=518880`（冻结基线的名义投入比例只对实测标成立）∧ `period=D1` ∧ `status=succeeded`；
 *  ② **恰 1 个回合**（冻结基线「回合 1 条 / 其中强平合成 1 条」）；
 *  ③ 该回合 `l2_count == ` {@link AUDIT_FILL_TOTAL}（= 成交合计 43 笔）且 `fills` 逐笔核对为
 *     {@link AUDIT_BUY_FILLS} 笔 Buy + {@link AUDIT_SELL_FILLS} 笔 Sell；
 *     （`/fills` 全口径 = 42 Buy(Policy) + 1 Sell(ForceClose) = 43，ADR-026 §2.4-1）
 * 不核对根数（本规格不涉 K 线域）。
 *
 * **已知残差（登记）**：谓词只看得到 `RunFetchPort` 的成交面，看不到 `/audit` 自身字段
 * （`planned_tranches` / `reachable_batches` / `deployed_pct` …）⇒「最新命中者」仍可能在这些字段上与
 * 冻结基线不等（如未来新增一笔结构同形的 run）——此时由**规格自身的基线断言**变红（显式，不静默）。
 */
async function inspectAudit(port: RunFetchPort, run: RunListItem): Promise<PredicateHit | string> {
  if (run.symbol == null) return '列表行未提供 symbol ⇒ 无法核对基线标的 518880（禁猜）';
  if (run.symbol !== AUDIT_SYMBOL) return `symbol=${run.symbol} ≠ ${AUDIT_SYMBOL}（冻结基线只对实测标成立）`;
  const rts = await port.roundTrips(run.id);
  if (rts.length !== 1) return `回合数 ${rts.length} ≠ 1（冻结基线是单回合 run）`;
  const rt = rts[0]!;
  if (rt.rt_seq !== 1) return `唯一回合的 rt_seq=${rt.rt_seq} ≠ 1（禁取其它序号）`;
  if ((rt.l2_count ?? -1) !== AUDIT_L2_COUNT) return `rt1 l2_count=${rt.l2_count ?? -1} ≠ ${AUDIT_L2_COUNT}`;
  const fl = await port.fills(run.id, 1);
  const buy = fl.filter((f) => f.side === 'Buy').length;
  const sell = fl.filter((f) => f.side === 'Sell').length;
  if (fl.length !== AUDIT_FILL_TOTAL) return `rt1 fills=${fl.length} ≠ ${AUDIT_FILL_TOTAL}`;
  if (buy !== AUDIT_BUY_FILLS) return `rt1 Buy 笔数=${buy} ≠ ${AUDIT_BUY_FILLS}`;
  if (sell !== AUDIT_SELL_FILLS) return `rt1 Sell 笔数=${sell} ≠ ${AUDIT_SELL_FILLS}（冻结基线含 1 笔期末强平卖出）`;
  return {
    hit: true,
    totalBars: await port.totalBars(run.id),
    rtSeq: 1,
    l2Count: rt.l2_count ?? fl.length,
    detail: { symbol: run.symbol, roundTrips: rts.length, fillTotal: fl.length, buyFills: buy, sellFills: sell },
  };
}

/**
 * `legacy` 谓词（`adr026-audit.e2e.ts` **用例 12** 的结构性前提）。
 *
 * 用例 12 的判据是「历史 run（`trades[*].reason` 缺字段）的**来源列全部「未记录」**」——
 * 其存活前提 = 库里确实存在一个**回合全缺 `reason`** 的 run（ADR-026 §2.3 之前的 run 形态）。
 * 本谓词只编码该结构事实（**根数不参与**，行数由规格按解析结果读）：
 *  ① `period=D1` ∧ `status=succeeded`（基础过滤）；
 *  ② 回合数 ≥ 1（空 run 会让「全部行未记录」退化为空集成真 ⇒ 必须拒）；
 *  ③ **每个**回合的 `reason` 缺字段/为 null（含 `Open` 回合——它在 UI 上同样落「未记录」）。
 */
async function inspectLegacy(port: RunFetchPort, run: RunListItem): Promise<PredicateHit | string> {
  const rts = await port.roundTrips(run.id);
  if (rts.length === 0) return '回合数 0（来源列清单为空 ⇒ 「全部未记录」退化为空集成真）';
  const reasonless = rts.filter((t) => t.reason == null).length;
  if (reasonless !== rts.length) {
    return `回合 ${rts.length} 个中有 ${rts.length - reasonless} 个带 reason ⇒ 来源列不会是「未记录」`;
  }
  return {
    hit: true,
    totalBars: await port.totalBars(run.id),
    rtSeq: null,
    l2Count: null,
    detail: { roundTrips: rts.length, reasonless },
  };
}

/** M5 轴对齐（ADR-027 E 段）前提：M5 ∧ 根数足够（含周末/隔夜/午休缺口的长区间）。 */
async function inspectM5(port: RunFetchPort, run: RunListItem): Promise<PredicateHit | string> {
  const total = await port.totalBars(run.id);
  if (total < 1000) return `per_bar total=${total} < 1000`;
  return { hit: true, totalBars: total, rtSeq: null, l2Count: null, detail: { totalBars: total } };
}

/**
 * 服务端 `/api/kline` **单页上限**（契约常量：`crates/web/src/dto.rs: MAX_LIMIT = 1000`）——
 * 谓词据此推「这段区间一次能不能拉回」。
 */
export const SERVER_KLINE_PAGE_CAP = 1000;
/**
 * `klineHistory` 前提的最小根数（= 3 × 单页上限）。
 *
 * 为什么必须 ≥ 3 页：本族的 K1/K3 判据要求「**初始装载之外仍有历史可拉**」与
 * 「**数据域覆盖 run 起点**」 —— 若根数 ≤ 单页上限，一次请求就够 ⇒ 两条判据**退化为恒真**
 * （修复前后都会绿）。取 3 页而非刚好 1 页，是给「初始向前分页 ≤ {@link MAX_INITIAL_PAGES} 次」
 * 与「K3 向左到底再拉一页」两侧都留出真实余量。
 * ADR-028 §2.10.1 裁决 3 给出的原文示例即「最新 M15 且根数 ≥3000 的 succeeded run」。
 */
export const KLINE_HISTORY_MIN_BARS = 3 * SERVER_KLINE_PAGE_CAP;

/**
 * `klineHistory` 谓词（`adr028-kline-history.e2e.ts` 的结构性前提）。
 * 编码的不变量（均对**数据**而非某个具体 run）：
 *  ① `period='M15'`（规格的周期步长常量 = M15 = 900s，进网格对齐判据）；
 *  ② `per_bar` 根数 ≥ {@link KLINE_HISTORY_MIN_BARS}（> 单页上限 ⇒ 必须向前分页才有数据域覆盖）。
 * 不核对成交（本族判据不涉及回合/标记）。
 */
async function inspectKlineHistory(port: RunFetchPort, run: RunListItem): Promise<PredicateHit | string> {
  const total = await port.totalBars(run.id);
  if (total < KLINE_HISTORY_MIN_BARS) {
    return `per_bar total=${total} < ${KLINE_HISTORY_MIN_BARS}（单页 ${SERVER_KLINE_PAGE_CAP} 根就够 ⇒ 向前分页判据退化为恒真）`;
  }
  return {
    hit: true,
    totalBars: total,
    rtSeq: null,
    l2Count: null,
    detail: { totalBars: total, serverPageCap: SERVER_KLINE_PAGE_CAP, pages: Math.ceil(total / SERVER_KLINE_PAGE_CAP) },
  };
}

/** 六条谓词（新增用例族时**追加**一条，不要把具体 run id 写进来）。 */
export const PREDICATES: Record<RunLabel, Predicate> = {
  d1: {
    label: 'd1',
    text: `period=D1 ∧ status=succeeded ∧ 回合 1 的 l2_count ≥ ${L2_MIN_FILLS} ∧ fills[${L2_END_FILL_IDX}].bar_index == 数据末根 ∧ fills[${L2_MID_IDX}].bar_index < 数据末根`,
    period: 'D1',
    inspect: inspectD1,
  },
  center: {
    label: 'center',
    text: `period=D1 ∧ status=succeeded ∧ 回合 3 有 ≥2 笔 ∧ 第 2 笔距数据两侧各 ≥ ${CENTER_MARGIN_BARS} 根 ∧ 两笔不同 bar`,
    period: 'D1',
    inspect: inspectCenter,
  },
  excl: {
    label: 'excl',
    text: `period=M15 ∧ status=succeeded ∧ per_bar ≥ ${EXCL_MIN_BARS} ∧ 存在 l2_count ≥ 2 的回合`,
    period: 'M15',
    inspect: inspectExcl,
  },
  m5: {
    label: 'm5',
    text: 'period=M5 ∧ status=succeeded ∧ per_bar ≥ 1000',
    period: 'M5',
    inspect: inspectM5,
  },
  pair: {
    label: 'pair',
    text: `period=D1 ∧ status=succeeded ∧ 回合 1 成交 ≥ ${PAIR_MIN_FILLS} ∧ 数据末根 bar 上有一 Buy 一 Sell ∧ 存在距末根 ≥ ${PAIR_MID_GAP_BARS} 根的中段成交`,
    period: 'D1',
    inspect: inspectPair,
  },
  klineHistory: {
    label: 'klineHistory',
    text: `period=M15 ∧ status=succeeded ∧ per_bar ≥ ${KLINE_HISTORY_MIN_BARS}（= 3 × 单页上限 ${SERVER_KLINE_PAGE_CAP} 根 ⇒ 单页拉不回 ⇒ 初始向前分页与向左到底分页判据有前提）`,
    period: 'M15',
    inspect: inspectKlineHistory,
  },
  audit: {
    label: 'audit',
    text: `symbol=${AUDIT_SYMBOL} ∧ period=D1 ∧ status=succeeded ∧ 回合数 == 1 ∧ rt1 l2_count == ${AUDIT_L2_COUNT} ∧ rt1 fills == ${AUDIT_FILL_TOTAL}（${AUDIT_BUY_FILLS} Buy + ${AUDIT_SELL_FILLS} Sell）`,
    period: 'D1',
    inspect: inspectAudit,
  },
  legacy: {
    label: 'legacy',
    text: 'period=D1 ∧ status=succeeded ∧ 回合数 ≥ 1 ∧ **每个**回合的 reason 缺字段/null（历史 run 形态 ⇒ 来源列「未记录」）',
    period: 'D1',
    inspect: inspectLegacy,
  },
};

/** 新→旧排序（`created_at` 倒序；无 `created_at` 的候选排在最后，靠列表原序兜底）。 */
function newestFirst(runs: readonly RunListItem[]): RunListItem[] {
  return runs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ca = a.r.created_at ?? '';
      const cb = b.r.created_at ?? '';
      if (ca !== cb) return cb.localeCompare(ca);
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/** **位次证据**（新→旧全量列表中的下标 + 1，与复验读数「71/93」同口径）——不参与判定，只供复核。 */
function rankInfo(all: readonly RunListItem[], id: string): { rank: number; rankBasis: number } {
  const sorted = newestFirst(all);
  return { rank: sorted.findIndex((r) => r.id === id) + 1, rankBasis: sorted.length };
}

/**
 * **按谓词解析**目标 run（最新命中者优先），**有界并发**（{@link ResolveRunOptions.concurrency}），
 * 结果可**落盘缓存**（{@link ResolveRunOptions.cacheDir}；命中仍须校验 run 存在 ∧ 仍满足谓词）。
 * **全不命中 ⇒ 抛错**（附扫描证据），绝不返回兜底 run、绝不静默跳过（裁决 3）。
 *
 * 并发下仍保持「最新优先」：候选按 `created_at` 逆序切**批**，批内并行核对，
 * 命中时取**批内最靠前**（= 列表更靠前 = 更新）的那一个；批内更靠后的命中者记入
 * `evidence.detail.sameBatchHits`（可复核，不静默丢弃）。
 */
export async function resolveRun(
  port: RunFetchPort,
  label: RunLabel,
  opts: ResolveRunOptions = {},
): Promise<ResolvedRun> {
  const pred = PREDICATES[label];
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));
  const cacheDir = opts.cacheDir === undefined ? DEFAULT_RESOLVE_CACHE_DIR : opts.cacheDir;
  const sourceKey = opts.sourceKey ?? '';
  const all = await port.listRuns();
  const eligible = newestFirst(all).filter((r) => r.period === pred.period && r.status === 'succeeded');
  /** **库指纹**：候选集合（id + created_at + period + status）的规范序列化哈希。
   *  库增长/内容变动 ⇒ 指纹变 ⇒ 缓存失效重解析（缓存不得变成硬编码；§2.10.1 裁决 3）。 */
  const key = `${sourceKey}#${label}#${sha256(JSON.stringify(eligible.map((r) => [r.id, r.created_at ?? '', r.period ?? '', r.status ?? ''])))}`;
  const path = cacheDir ? cacheFile(cacheDir, key) : undefined;
  const cache: ResolveCacheInfo = { status: cacheDir ? 'miss' : 'disabled', key, path };

  // ① 缓存：命中**仍须校验**（run 仍在库中 ∧ 仍满足谓词）——校验通过才可用；否则记明失效原因后重解析。
  if (cacheDir && path && existsSync(path)) {
    const entry = readEntry(path, key, label);
    if (entry) {
      const target = eligible.find((r) => r.id === entry.resolved.id);
      if (!target) {
        cache.status = 'invalidated';
        cache.reason = `缓存 run ${entry.resolved.id} 已不在库中（不存在于当前 ${pred.period}/succeeded 候选集）`;
      } else {
        const out = await inspectSafe(pred, port, target);
        if (typeof out === 'string') {
          cache.status = 'invalidated';
          cache.reason = `缓存 run ${entry.resolved.id} 不再满足谓词：${out}`;
        } else {
          cache.status = 'hit';
          cache.validated = true;
          console.log(
            `[adr028RunResolve] 缓存命中（已校验）：${label} ⇒ ${target.id}（缓存键 ${key.slice(0, 46)}…）`,
          );
          return {
            id: target.id,
            label,
            predicate: pred.text,
            totalBars: out.totalBars,
            rtSeq: out.rtSeq,
            l2Count: out.l2Count,
            evidence: {
              scanned: 0,
              rejected: [],
              detail: { ...out.detail, ...rankInfo(all, target.id) },
              concurrency,
              cache,
            },
          };
        }
      }
    }
  }

  // ② 有界并发解析（批内并行，**批间有序**：保持「最新优先」）。
  const rejected: Array<{ id: string; why: string }> = [];
  let scanned = 0;
  for (let i = 0; i < eligible.length; i += concurrency) {
    const batch = eligible.slice(i, i + concurrency);
    const outs = await Promise.all(batch.map((run) => inspectSafe(pred, port, run)));
    scanned += batch.length;
    let hitIdx = -1;
    for (let k = 0; k < outs.length; k++) {
      const o = outs[k]!;
      if (typeof o === 'string') {
        rejected.push({ id: batch[k]!.id, why: o });
      } else if (hitIdx < 0) {
        hitIdx = k;
      }
    }
    if (hitIdx >= 0) {
      const run = batch[hitIdx]!;
      const hit = outs[hitIdx] as PredicateHit;
      /** 同一批里更靠后的命中者：已核对但**不采用**（证据保留，可复核并发不改变语义）。 */
      const sameBatchHits = batch.filter((_, k) => k > hitIdx && typeof outs[k] !== 'string').map((r) => r.id);
      const resolved: ResolvedRun = {
        id: run.id,
        label,
        predicate: pred.text,
        totalBars: hit.totalBars,
        rtSeq: hit.rtSeq,
        l2Count: hit.l2Count,
        evidence: {
          scanned,
          rejected: rejected.slice(-25),
          detail: { ...hit.detail, ...(sameBatchHits.length > 0 ? { sameBatchHits } : {}), ...rankInfo(all, run.id) },
          concurrency,
          cache,
        },
      };
      if (cacheDir) {
        cache.path = writeEntry(cacheDir, key, label, resolved);
      }
      return resolved;
    }
  }
  throw new Error(
    `[ADR-028 §2.10.1 裁决 3] 谓词解析失败（${label}）：${pred.text}；` +
      `已扫描 ${scanned} 个 ${pred.period}/succeeded 候选，无一命中 ⇒ 显式红（禁静默换用别的 run / 禁回退为跳过）。` +
      `拒绝原因（最后 25 条）：${JSON.stringify(rejected.slice(-25))}`,
  );
}

/** 核对单候选，把异常折叠为「拒绝原因」字符串（不炸整体：failed run 的 404 只是拒绝）。 */
async function inspectSafe(pred: Predicate, port: RunFetchPort, run: RunListItem): Promise<PredicateHit | string> {
  try {
    return await pred.inspect(port, run);
  } catch (e) {
    return `取数失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * **显式覆盖校验**（`ADR028_KH_RUN` 类逃生门）：把某个**具体 run id** 交给谓词现场核对。
 *
 * 允许覆盖「不是最新命中者」（调试/复跑历史靶用），但**不允许**指向：
 *  - 不在库中的 run（`不在库中`）；
 *  - period/status 不符的 run（如 failed / 跨周期）；
 *  - 取数失败或结构上不满足谓词的 run。
 * 以上任一情形 ⇒ **抛错**（显式红），绝不返回兜底值、绝不静默换 run（§2.10.1 裁决 3）。
 * 本函数**不读不写**落盘缓存（否则覆盖路径可能被缓存逃逸谓词）。
 */
export async function assertRunMatchesPredicate(
  port: RunFetchPort,
  label: RunLabel,
  runId: string,
): Promise<ResolvedRun> {
  const pred = PREDICATES[label];
  const all = await port.listRuns();
  const target = all.find((r) => r.id === runId);
  const head = `[ADR-028 §2.10.1 裁决 3] 显式覆盖 run ${runId} 校验失败（谓词 ${label}）：`;
  if (!target) {
    throw new Error(
      `${head}不在库中（当前列表 ${all.length} 条）⇒ 显式红（禁静默换用别的 run / 禁回退为跳过）。`,
    );
  }
  if (target.period !== pred.period || target.status !== 'succeeded') {
    throw new Error(
      `${head}period=${target.period ?? '?'} status=${target.status ?? '?'} 不满足谓词基础前提 ` +
        `period=${pred.period} ∧ status=succeeded（谓词：${pred.text}）。`,
    );
  }
  const out = await inspectSafe(pred, port, target);
  if (typeof out === 'string') {
    throw new Error(`${head}${out} ⇒ 显式红（覆盖不得改变「判什么」，谓词：${pred.text}）。`);
  }
  return {
    id: target.id,
    label,
    predicate: pred.text,
    totalBars: out.totalBars,
    rtSeq: out.rtSeq,
    l2Count: out.l2Count,
    evidence: {
      scanned: 1,
      rejected: [],
      detail: { ...out.detail, ...rankInfo(all, target.id), explicitOverride: true },
      concurrency: 1,
      cache: { status: 'disabled' },
    },
  };
}

/**
 * **反硬编码护栏**（裁决 3）：规格实际使用的 run id 必须 == **现场重解析**结果。
 * 把 run id 改回字面量（硬编码）后，只要该字面量不是谓词命中的最新匹配 ⇒ 本函数抛错 ⇒ 规格必红。
 */
export function assertResolvedByIdFresh(usedId: string, fresh: ResolvedRun, label: RunLabel): void {
  if (usedId !== fresh.id) {
    throw new Error(
      `[ADR-028 §2.10.1 裁决 3] 反硬编码护栏：规格使用的 run ${usedId} ≠ 谓词(${label}) 现场解析结果 ${fresh.id}` +
        `（谓词：${fresh.predicate}）⇒ 禁止硬编码 run id`,
    );
  }
}

/** 便捷断言（Playwright 规格里直接 `expect` 报错更可读；这里只做纯函数判定）。 */
export function isResolvedByPredicate(usedId: string, fresh: ResolvedRun): boolean {
  return usedId === fresh.id;
}
