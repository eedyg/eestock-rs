import { useEffect, useMemo, useState } from 'react';
import type {
  ExposureGuardSpec,
  ExposureOnSignalBreak,
  ExposureRamp,
  ExposureSellPolicy,
  ExposureTarget,
  StrategyCatalogEntry,
  StrategyParamDef,
  SymbolSnapshot,
  WorkbenchAvailableRange,
  WorkbenchPinnedSlot,
  WorkbenchPolicy,
  WorkbenchPresetConfigInput,
  WorkbenchPresetRow,
  WorkbenchRunConfig,
  WorkbenchStop,
  WorkbenchSubmitReq,
} from '@/api/types';
// ADR-024 P0 §5.1：周期下拉由单一事实源（前端镜像常量）生成，不得手写第二份。
import { SUPPORTED_BACKTEST_PERIODS } from '@/features/backtest/periods';
import { fmtMoney, fmtPct } from '@/features/backtest/format';

/** 表单内 slot 状态（数值字段以文本持有，提交时统一 parse/校验——与 TestRunPanel 同模式）。 */
interface SlotForm {
  versionId: string;
  strategyId: string;
  label: string; // 「策略名 vN」
  schema: StrategyParamDef[];
  weight: string;
  paramText: Record<string, string>;
}

const INPUT =
  'mt-0.5 h-7 w-full rounded-lg border border-line bg-panel2 px-2 text-txt text-xs';
const LABEL = 'block text-xs text-dim';

function dayToIso(day: string): string {
  return `${day}T00:00:00Z`;
}

const noop = (): void => {};

function todayPlus(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** RFC3339 → `input[type=date]` 的 `yyyy-mm-dd`（null/非法 → undefined；ADR-024 P5 §5.2）。 */
function isoToDay(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined;
}

/** catalog 版本 → 新 slot（schema 默认值预填）。 */
function slotFromCatalog(e: StrategyCatalogEntry): SlotForm {
  return {
    versionId: e.version.id,
    strategyId: e.strategy.id,
    label: `${e.strategy.name} v${e.version.version}`,
    schema: e.version.params_schema,
    weight: '1',
    paramText: Object.fromEntries(e.version.params_schema.map((p) => [p.key, String(p.default)])),
  };
}

/** 钉住 slot（预设/历史 config）→ slot 表单：schema 优先取 catalog 同版本；
 *  catalog 缺失（版本后被归档等）→ 以钉住 params 键合成通用数值参数，保证预设可复现提交。 */
function slotFromPinned(p: WorkbenchPinnedSlot, catalog: StrategyCatalogEntry[] | null): SlotForm {
  const hit = (catalog ?? []).find((e) => e.version.id === p.version_id);
  const schema: StrategyParamDef[] =
    hit?.version.params_schema ??
    Object.keys(p.params).map((k) => ({ key: k, type: 'float' as const, default: p.params[k]! }));
  const paramText: Record<string, string> = {};
  for (const def of schema) paramText[def.key] = String(p.params[def.key] ?? def.default);
  return {
    versionId: p.version_id,
    strategyId: p.strategy_id,
    label: hit ? `${hit.strategy.name} v${p.version}` : `${p.strategy_id} v${p.version}`,
    schema,
    weight: String(p.weight),
    paramText,
  };
}

interface ParsedSlot {
  version_id: string;
  params: Record<string, number>;
  weight: number;
}

/** slots 数上限（与后端 §1.8 submit_run 校验同口径：1..=10）。 */
export const MAX_SLOTS = 10;

/** ADR-029 D4：`ramp` 到达方式维的 Step 1 基元（`Immediate` = 当 bar 到目标；`RateCap` = 每 bar 限速）。 */
export type ExposureRampKind = 'Immediate' | 'RateCap';
/** ADR-029 D3：`exposure.target` 目标维的 Step 1 基元。 */
export type ExposureTargetKind = 'Fixed' | 'ScoreMapped';

/**
 * ADR-029 Step 1 保守默认值（派工给定）：`ScoreMapped 20%→50%` + `RateCap 5%/bar` +
 * `guard.max_pct 90% / deadzone 0.5%`。理由：
 *  - 分数映射两端点不冒进（阈值处 20%、满分 50%），避免“分数一高即满仓”；
 *  - 默认走 `RateCap` 而非 `Immediate` —— 分数曲线是阶跃型信号源，无速率限制时易整仓跳变；
 *  - `max_pct=0.9` 留出现金缓冲（D8 安全不变式）；`deadzone=0.5%` 做防抖；
 *  - `Fixed.pct=0.3` 仅为切到 Fixed 时的起手值（固定目标下用户必填）。
 *  **前端显式落值**，不依赖后端缺省（后端对 Exposure 字段无缺省）。
 */
export const EXPOSURE_DEFAULTS = {
  fixedPct: '0.3',
  atThresholdPct: '0.2',
  atFullPct: '0.5',
  sell: 'Flat',
  pctPerBar: '0.05',
  /** ADR-029 Step 1.5 D12（**用户裁定** 2026-09-29）：**新配置**默认 `Continue` 且**显式写入** JSON
   *  （显式值 ⇒ 可复现；不必依赖后端缺省 `Pause`）。
   *  **回填纪律**：预设/历史 run **未带**该字段时**不得**新增（`''` = 未声明态，round-trip 逐字节保真）。 */
  onSignalBreak: 'Continue',
  maxPct: '0.9',
  minPct: '0',
  deadzonePct: '0.005',
  /** `down_pct_per_bar`（下行速率）与 `deadzone_min_notional`（死区金额门槛）默认**留空 = 省略**：
   *  二者的缺省即现行语义（对称 / 纯比例口径），给新配置凭空写值会引入不必要的行为位移。 */
  downPctPerBar: '',
  deadzoneMinNotional: '',
  ramp: 'RateCap',
} as const;

/** ADR-029 R1/R5/D12 **量纲**说明（多个量纲不同名同心，必须在表单处显式区分）。 */
export const EXPOSURE_DIM_NOTE =
  '量纲：at_threshold_pct / at_full_pct / max_pct / min_pct = 净值占比（0..1）；' +
  'pct_per_bar / down_pct_per_bar = 每 bar 允许变动金额 / 净值（前者上行、后者下行）；' +
  'deadzone_pct = 暴露比例差（与 position_ratio 同量纲）；deadzone_min_notional = **元**（死区金额门槛）。';

/** D14：`min_fee` 主导的**最小再平衡规模**倍数（建议值 `deadzone_min_notional = 20 × min_fee`）。 */
export const MIN_REBALANCE_FEE_MULTIPLE = 20;

/** 预设 config 规范化序列化（脏检测比较用；钉住/未钉住形态先归一为未钉住）。 */
function canonicalConfig(cfg: WorkbenchPresetConfigInput): string {
  return JSON.stringify({
    slots: cfg.slots.map((s) => ({ version_id: s.version_id, params: s.params ?? {}, weight: s.weight })),
    buy_threshold: cfg.buy_threshold ?? 60,
    sell_threshold: cfg.sell_threshold ?? 40,
    policy: cfg.policy,
    stop: cfg.stop ?? null,
    initial_capital: cfg.initial_capital ?? 100_000,
    fee: cfg.fee,
  });
}

/** 应用预设返回的 config（钉住形态）→ 未钉住输入形态（脏检测基线）。 */
function pinnedToInput(cfg: WorkbenchRunConfig): WorkbenchPresetConfigInput {
  return {
    slots: cfg.slots.map((s) => ({ version_id: s.version_id, params: s.params, weight: s.weight })),
    buy_threshold: cfg.buy_threshold,
    sell_threshold: cfg.sell_threshold,
    policy: cfg.policy,
    stop: cfg.stop,
    initial_capital: cfg.initial_capital,
    fee: cfg.fee,
  };
}

/** slot 表单校验 + 解析（weight>0；params 按 schema 数值/整数/范围校验——与后端 validate_slot 同口径）。 */
function parseSlots(slots: SlotForm[]): { ok: ParsedSlot[] } | { err: string } {
  const out: ParsedSlot[] = [];
  for (const s of slots) {
    const weight = Number(s.weight);
    if (!Number.isFinite(weight) || weight <= 0) {
      return { err: `策略 ${s.label} 权重须 > 0` };
    }
    const params: Record<string, number> = {};
    for (const p of s.schema) {
      const raw = (s.paramText[p.key] ?? String(p.default)).trim();
      const v = Number(raw);
      if (raw === '' || Number.isNaN(v)) return { err: `参数 ${p.key} 须为数值` };
      if (p.type === 'int' && !Number.isInteger(v)) return { err: `参数 ${p.key} 须为整数` };
      if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) {
        return { err: `参数 ${p.key} 超出范围 [${p.min ?? '-∞'}, ${p.max ?? '+∞'}]` };
      }
      params[p.key] = v;
    }
    out.push({ version_id: s.versionId, params, weight });
  }
  return { ok: out };
}

/**
 * 页面⑪ 配置区（ADR §13.5 / 07-app-plane §1.8）：
 * 策略多选下拉（catalog published）→ slot 卡片（权重 + params_schema 参数表单）；
 * 聚合阈值（默认 60/40）/ ExecutionPolicy（LumpSum | DCA | Exposure[目标 × ramp × guard]，ADR-029）/ 硬止损（可选）/ 初始资金 / 费用 /
 * 标的+周期+区间；组合预设下拉（选中即回填）+ 保存为预设 + 重命名/删除。
 * 校验与后端 §1.8 400 口径同构（前端预校验，后端兜底）。
 */
export function ConfigPanel({
  catalog,
  catalogLoading,
  catalogError,
  onRetryCatalog,
  symbols,
  presets,
  submitting,
  submitError,
  clampNotice = null,
  guardPrompt = null,
  loadAvailableRange,
  onSubmit,
  onConfirmGuard = noop,
  onDismissGuard = noop,
  onApplyPreset,
  onCreatePreset,
  onUpdatePreset,
  onRenamePreset,
  onDeletePreset,
}: {
  catalog: StrategyCatalogEntry[] | null;
  catalogLoading: boolean;
  catalogError: string | null;
  onRetryCatalog: () => void;
  symbols: SymbolSnapshot[] | null;
  presets: WorkbenchPresetRow[] | null;
  submitting: boolean;
  submitError: string | null;
  /** ADR-024 P5 §5.2：提交响应 `clamped:true` ⇒ 显著提示条（不弹确认框）。 */
  clampNotice?: { requestedFrom: string; requestedTo: string; effectiveFrom: string; effectiveTo: string } | null;
  /** ADR-024 P5 §5.2：`resource_guard` 二次确认（展示预估 bar 数/耗时）。 */
  guardPrompt?: { bars: number; secs: number } | null;
  /** 可得区间加载器（日期控件 min/max 随「标的+周期」联动）；未注入 → 不拉取、不设边界。 */
  loadAvailableRange?: (symbol: string, period: string) => Promise<WorkbenchAvailableRange | null>;
  onSubmit: (req: WorkbenchSubmitReq) => void;
  onConfirmGuard?: () => void;
  onDismissGuard?: () => void;
  onApplyPreset: (id: string) => Promise<WorkbenchRunConfig>;
  onCreatePreset: (name: string, config: WorkbenchPresetConfigInput) => Promise<void>;
  /** MINOR-2：presetSel 非空且表单偏离预设时「保存」走 PUT 就地更新（当前表单 config）。 */
  onUpdatePreset: (id: string, name: string, config: WorkbenchPresetConfigInput) => Promise<void>;
  onRenamePreset: (id: string, name: string) => Promise<void>;
  onDeletePreset: (id: string) => Promise<void>;
}) {
  const enabledSymbols = useMemo(() => (symbols ?? []).filter((s) => s.enabled), [symbols]);
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('518880');
  const [period, setPeriod] = useState('D1');
  const [dateFrom, setDateFrom] = useState(() => todayPlus(-90));
  const [dateTo, setDateTo] = useState(() => todayPlus(0));
  const [slots, setSlots] = useState<SlotForm[]>([]);
  const [addSel, setAddSel] = useState('');
  const [buyThreshold, setBuyThreshold] = useState('60');
  const [sellThreshold, setSellThreshold] = useState('40');
  const [policyKind, setPolicyKind] = useState<'LumpSum' | 'Dca' | 'Exposure'>('LumpSum');
  const [positionPct, setPositionPct] = useState('1');
  const [dcaTranches, setDcaTranches] = useState('3');
  const [dcaMode, setDcaMode] = useState<'Equal' | 'FixedAmount'>('Equal');
  const [dcaAmount, setDcaAmount] = useState('');
  const [dcaInterval, setDcaInterval] = useState('1');
  // ADR-029 Step 1：`Exposure` = 目标（target） × 到达方式（ramp） × 硬边界（guard）
  const [exposureTarget, setExposureTarget] = useState<ExposureTargetKind>('Fixed');
  const [exposureFixedPct, setExposureFixedPct] = useState<string>(EXPOSURE_DEFAULTS.fixedPct);
  const [exposureAtThreshold, setExposureAtThreshold] = useState<string>(EXPOSURE_DEFAULTS.atThresholdPct);
  const [exposureAtFull, setExposureAtFull] = useState<string>(EXPOSURE_DEFAULTS.atFullPct);
  const [exposureSell, setExposureSell] = useState<ExposureSellPolicy>(EXPOSURE_DEFAULTS.sell);
  const [rampKind, setRampKind] = useState<ExposureRampKind>(EXPOSURE_DEFAULTS.ramp);
  const [pctPerBar, setPctPerBar] = useState<string>(EXPOSURE_DEFAULTS.pctPerBar);
  // ADR-029 Step 1.5 D12：`down_pct_per_bar`（下行速率；留空 = 省略 = 对称）——仅 `RateCap`。
  const [downPctPerBar, setDownPctPerBar] = useState<string>(EXPOSURE_DEFAULTS.downPctPerBar);
  /** ADR-029 Step 1.5 D12：`on_signal_break`（仅 `RateCap`）。三态：`'Pause' | 'Continue' | ''`
   *  —— `''` = **未声明**（运行期缺省 `Pause` = 现行语义），用于预设/历史 run 的**保真回填**。 */
  const [onSignalBreak, setOnSignalBreak] = useState<ExposureOnSignalBreak | ''>(EXPOSURE_DEFAULTS.onSignalBreak);
  const [guardMaxPct, setGuardMaxPct] = useState<string>(EXPOSURE_DEFAULTS.maxPct);
  const [guardMinPct, setGuardMinPct] = useState<string>(EXPOSURE_DEFAULTS.minPct);
  const [guardDeadzonePct, setGuardDeadzonePct] = useState<string>(EXPOSURE_DEFAULTS.deadzonePct);
  /** ADR-029 Step 1.5 D14：`deadzone_min_notional`（**元**；留空 = 省略 = 纯比例口径）。 */
  const [guardDeadzoneMinNotional, setGuardDeadzoneMinNotional] = useState<string>(EXPOSURE_DEFAULTS.deadzoneMinNotional);
  const [stopEnabled, setStopEnabled] = useState(false);
  const [stopKind, setStopKind] = useState<'FixedPct' | 'Trailing' | 'Atr'>('FixedPct');
  const [stopValue, setStopValue] = useState('0.08');
  const [stopTrigger, setStopTrigger] = useState<'Intrabar' | 'CloseBasis'>('Intrabar');
  const [initialCapital, setInitialCapital] = useState('100000');
  const [feeRate, setFeeRate] = useState('0.025');
  const [feeMin, setFeeMin] = useState('5');
  const [feeSlippage, setFeeSlippage] = useState('2');
  const [formError, setFormError] = useState<string | null>(null);
  const [presetSel, setPresetSel] = useState('');
  const [presetName, setPresetName] = useState('');
  const [presetMsg, setPresetMsg] = useState<string | null>(null);
  /** MINOR-2 脏检测基线：最近一次成功应用/就地更新的预设 config 规范化串（null = 无基线）。 */
  const [appliedJson, setAppliedJson] = useState<string | null>(null);
  /** ADR-024 P5 §5.2：可得区间（随「标的+周期」联动 → 日期控件 min/max）。 */
  const [availRange, setAvailRange] = useState<WorkbenchAvailableRange | null>(null);

  useEffect(() => {
    if (!loadAvailableRange) return;
    let alive = true;
    loadAvailableRange(symbol, period)
      .then((r) => {
        if (alive) setAvailRange(r);
      })
      .catch(() => {
        if (alive) setAvailRange(null); // 加载失败 → 不设边界（不阻断表单）
      });
    return () => {
      alive = false;
    };
  }, [symbol, period, loadAvailableRange]);

  const minDay = isoToDay(availRange?.available_from);
  const maxDay = isoToDay(availRange?.available_to);

  /**
   * ADR-029 Step 1.5 D14（F5 成本盲区）成本提示：**死区门槛**（元）= `deadzone_pct × 初始资金`；
   * 低于 `20 × min_fee` ⇒ 该规模下的再平衡佣金**由 `min_fee` 主导**（单笔实际费率远高于名义）。
   * 数值**全部取自面板输入**（`deadzone_pct` / `initial_capital` / `min_fee`），**不硬编码费用**；
   * 一键预填值 = `20 × min_fee`（D14 分层纪律：domain 不依赖费模型 ⇒ 金额门槛由配置给出、UI 推导建议值）。
   */
  const costHint = useMemo(() => {
    if (policyKind !== 'Exposure') return null;
    const dz = Number(guardDeadzonePct);
    const cap = Number(initialCapital);
    const minFee = Number(feeMin);
    if (![dz, cap, minFee].every((v) => Number.isFinite(v))) return null;
    if (!(cap > 0) || !(minFee > 0) || dz < 0) return null;
    const deadzoneNotional = dz * cap;
    const recommended = MIN_REBALANCE_FEE_MULTIPLE * minFee;
    if (!(deadzoneNotional < recommended)) return null;
    return {
      deadzoneNotional,
      recommended,
      /** 单笔佣金占比 = `min_fee / 死区门槛`；`deadzone_pct = 0`（无门槛）⇒ `null`（**不造数**）。 */
      perTradePct: dz > 0 ? minFee / deadzoneNotional : null,
    };
  }, [policyKind, guardDeadzonePct, initialCapital, feeMin]);

  const addable = (catalog ?? []).filter((e) => !slots.some((s) => s.versionId === e.version.id));

  const patchSlot = (versionId: string, f: (s: SlotForm) => SlotForm) =>
    setSlots((cur) => cur.map((s) => (s.versionId === versionId ? f(s) : s)));

  /** 表单 → 共享配置（submit 与预设保存共用）纯校验核心：不落 formError，供脏检测复用。 */
  const buildConfigCore = ():
    | { ok: { config: WorkbenchPresetConfigInput; slots: ParsedSlot[] } }
    | { err: string } => {
    if (slots.length === 0) {
      return { err: '至少添加 1 个策略' };
    }
    // NIT-1：slots 1..=10 预校验（提交前友好提示；后端同口径兜底）
    if (slots.length > MAX_SLOTS) {
      return { err: `策略数量须在 1..=${MAX_SLOTS}（当前 ${slots.length}）` };
    }
    const parsed = parseSlots(slots);
    if ('err' in parsed) {
      return { err: parsed.err };
    }
    const buy = Number(buyThreshold);
    const sell = Number(sellThreshold);
    if (!Number.isFinite(buy) || !Number.isFinite(sell) || buy <= 0 || sell <= 0) {
      return { err: '阈值须为正数' };
    }
    if (buy <= sell) {
      return { err: '买入阈值须大于卖出阈值（防倒挂）' };
    }
    let policy: WorkbenchPolicy;
    if (policyKind === 'LumpSum') {
      const pct = Number(positionPct);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 1) {
        return { err: 'LumpSum 仓位比例须在 (0,1]' };
      }
      policy = { LumpSum: { position_pct: pct } };
    } else if (policyKind === 'Dca') {
      const tranches = Number(dcaTranches);
      const interval = Number(dcaInterval);
      if (!Number.isInteger(tranches) || tranches < 1) {
        return { err: 'DCA 批次数须为 ≥1 整数' };
      }
      if (!Number.isInteger(interval) || interval < 1) {
        return { err: 'DCA 批间隔须为 ≥1 整数' };
      }
      let amount: number | null = null;
      if (dcaMode === 'FixedAmount') {
        amount = Number(dcaAmount);
        if (!Number.isFinite(amount) || amount <= 0) {
          return { err: 'FixedAmount 模式须填正数金额' };
        }
      }
      policy = { Dca: { tranches, mode: dcaMode, amount, interval } };
    } else {
      // ADR-029 Step 1：`Exposure` = target × ramp × guard。
      // 校验（E11 + R1/R5 量纲）在**表单层** fail loud（与后端 `ExecutionPolicy::validate` 同口径，不静默回退默认）。
      const maxPct = Number(guardMaxPct);
      const minPct = Number(guardMinPct);
      const dz = Number(guardDeadzonePct);
      if (!Number.isFinite(maxPct) || !Number.isFinite(minPct) || !Number.isFinite(dz)) {
        return { err: 'guard 参数须为数值（净值占比 / 暴露比例差）' };
      }
      if (minPct < 0 || maxPct > 1 || minPct > maxPct) {
        return {
          err: 'guard 须满足 0 ≤ min_pct ≤ max_pct ≤ 1（均为净值占比；min_pct 非零时仅约束持有态、不清仓）',
        };
      }
      if (dz < 0) {
        return { err: 'guard.deadzone_pct（暴露比例差，与 position_ratio 同量纲）须 ≥ 0' };
      }
      let ramp: ExposureRamp = { Immediate: null };
      if (rampKind === 'RateCap') {
        const per = Number(pctPerBar);
        if (!Number.isFinite(per) || per <= 0) {
          return { err: 'ramp.pct_per_bar（每 bar 允许变动金额 / 净值）须 > 0' };
        }
        const rcap: { pct_per_bar: number; down_pct_per_bar?: number; on_signal_break?: ExposureOnSignalBreak } = {
          pct_per_bar: per,
        };
        // ADR-029 Step 1.5 D12（E18）：下行速率预算。**留空 = 省略**（= 对称，与现行逐字节一致）；
        // `0` 合法且**必须显式写入**（0 = 下行不限速 ≠ 「缺省对称」）。
        if (downPctPerBar.trim() !== '') {
          const down = Number(downPctPerBar);
          if (!Number.isFinite(down) || down < 0) {
            return { err: 'ramp.down_pct_per_bar（每 bar 允许变动金额 / 净值；0 = 下行不限速）须 ≥ 0' };
          }
          rcap.down_pct_per_bar = down;
        }
        // ADR-029 Step 1.5 D12：`''` = 未声明（预设/历史 run 未带该字段）⇒ **不写键**（round-trip 保真）；
        // 新配置默认 `Continue` 并显式写入（用户裁定：显式值 ⇒ 可复现，不依赖后端缺省 `Pause`）。
        if (onSignalBreak !== '') rcap.on_signal_break = onSignalBreak;
        ramp = { RateCap: rcap };
      }
      let target: ExposureTarget;
      if (exposureTarget === 'Fixed') {
        const pct = Number(exposureFixedPct);
        if (!Number.isFinite(pct) || pct <= 0 || pct > 1) {
          return { err: 'exposure.Fixed.pct（净值占比）须在 (0,1]' };
        }
        // R2：`Fixed` 等价现行 `LumpSum` —— 卖侧目标恒为 0（清仓）⇒ **不携带** `sell` 字段。
        target = { Fixed: { pct } };
      } else {
        // E11：ScoreMapped 映射分母 `100 − buy_threshold` 与 `sell` 边界不得为 0（否则映射无定义）。
        if (!(buy < 100)) {
          return { err: 'ScoreMapped 须买入阈值 < 100（映射分母 100 − buy_threshold 不得为 0）' };
        }
        if (!(sell > 0)) {
          return { err: 'ScoreMapped 须卖出阈值 > 0（卖出边界不得为 0）' };
        }
        const at = Number(exposureAtThreshold);
        const full = Number(exposureAtFull);
        if (!Number.isFinite(at) || !Number.isFinite(full)) {
          return { err: 'exposure.ScoreMapped 端点须为数值（净值占比）' };
        }
        if (at < 0) {
          return { err: 'exposure.ScoreMapped.at_threshold_pct（净值占比）须 ≥ 0' };
        }
        if (full < at) {
          return { err: 'exposure.ScoreMapped.at_full_pct（净值占比）须 ≥ at_threshold_pct' };
        }
        if (full > maxPct) {
          return { err: 'exposure.ScoreMapped.at_full_pct（净值占比）须 ≤ guard.max_pct（分数不得要求超出硬边界）' };
        }
        target = { ScoreMapped: { at_threshold_pct: at, at_full_pct: full, sell: exposureSell } };
      }
      // ADR-029 Step 1.5 D14（E23）：死区**金额门槛**（元）。**留空 = 省略**（`None` = 纯比例口径，与现行逐字节一致）。
      const guard: ExposureGuardSpec = { max_pct: maxPct, min_pct: minPct, deadzone_pct: dz };
      if (guardDeadzoneMinNotional.trim() !== '') {
        const mn = Number(guardDeadzoneMinNotional);
        if (!Number.isFinite(mn) || mn < 0) {
          return {
            err: 'guard.deadzone_min_notional（元；死区阈值 = max(deadzone_pct × equity, deadzone_min_notional)）须 ≥ 0',
          };
        }
        guard.deadzone_min_notional = mn;
      }
      policy = { Exposure: { target, ramp, guard } };
    }
    let stop: WorkbenchStop | null = null;
    if (stopEnabled) {
      const v = Number(stopValue);
      if (!Number.isFinite(v) || v <= 0) {
        return { err: '止损 value 须为正数' };
      }
      stop = { kind: stopKind, value: v, trigger: stopTrigger };
    }
    const cap = Number(initialCapital);
    if (!Number.isFinite(cap) || cap <= 0) {
      return { err: '初始资金须为正数' };
    }
    const fee = { rate_pct: Number(feeRate), min_fee: Number(feeMin), slippage_bp: Number(feeSlippage) };
    if (!Number.isFinite(fee.rate_pct) || !Number.isFinite(fee.min_fee) || !Number.isFinite(fee.slippage_bp)) {
      return { err: '费用参数须为数值' };
    }
    return {
      ok: {
        slots: parsed.ok,
        config: {
          slots: parsed.ok,
          buy_threshold: buy,
          sell_threshold: sell,
          policy,
          stop,
          initial_capital: cap,
          fee,
        },
      },
    };
  };

  /** 表单 → 共享配置；null = 校验失败（formError 已落）。 */
  const buildConfig = (): { config: WorkbenchPresetConfigInput; slots: ParsedSlot[] } | null => {
    const r = buildConfigCore();
    if ('err' in r) {
      setFormError(r.err);
      return null;
    }
    setFormError(null);
    return r.ok;
  };

  /** MINOR-2 脏状态：presetSel 非空且当前表单偏离已应用预设（校验失败的表单视为偏离）。 */
  const cur = buildConfigCore();
  const presetDirty =
    presetSel !== '' && appliedJson !== null && ('err' in cur || canonicalConfig(cur.ok.config) !== appliedJson);

  const handleSubmit = () => {
    if (!symbol.trim()) {
      setFormError('标的代码必填');
      return;
    }
    if (!dateFrom || !dateTo || dateFrom >= dateTo) {
      setFormError('回测区间 from 须早于 to');
      return;
    }
    const built = buildConfig();
    if (!built) return;
    onSubmit({
      ...(name.trim() ? { name: name.trim() } : {}),
      symbol: symbol.trim(),
      period,
      from: dayToIso(dateFrom),
      to: dayToIso(dateTo),
      slots: built.slots,
      buy_threshold: built.config.buy_threshold,
      sell_threshold: built.config.sell_threshold,
      policy: built.config.policy,
      stop: built.config.stop ?? null,
      initial_capital: built.config.initial_capital,
      fee: built.config.fee,
    });
  };

  /** 预设选中即回填（config 为钉住形态；slots 经 catalog 恢复 schema 参数表单）。
   *  NIT-3：apply 成功后才落 presetSel（失败回退原选中态）；成功后落脏检测基线。 */
  const handleApplyPreset = async (id: string) => {
    if (!id) {
      setPresetSel('');
      setAppliedJson(null);
      setPresetMsg(null);
      return;
    }
    setPresetMsg(null);
    try {
      const cfg = await onApplyPreset(id);
      setSlots(cfg.slots.map((p) => slotFromPinned(p, catalog)));
      setBuyThreshold(String(cfg.buy_threshold));
      setSellThreshold(String(cfg.sell_threshold));
      if ('LumpSum' in cfg.policy) {
        setPolicyKind('LumpSum');
        setPositionPct(String(cfg.policy.LumpSum.position_pct));
      } else if ('Dca' in cfg.policy) {
        setPolicyKind('Dca');
        setDcaTranches(String(cfg.policy.Dca.tranches));
        setDcaMode(cfg.policy.Dca.mode);
        setDcaAmount(cfg.policy.Dca.amount != null ? String(cfg.policy.Dca.amount) : '');
        setDcaInterval(String(cfg.policy.Dca.interval));
      } else {
        // ADR-029：`Exposure` 预设逐字段回填（未改动即无脏标记 ⇒ round-trip 无字段丢失）。
        setPolicyKind('Exposure');
        const ex = cfg.policy.Exposure;
        if ('Fixed' in ex.target) {
          setExposureTarget('Fixed');
          setExposureFixedPct(String(ex.target.Fixed.pct));
        } else {
          setExposureTarget('ScoreMapped');
          setExposureAtThreshold(String(ex.target.ScoreMapped.at_threshold_pct));
          setExposureAtFull(String(ex.target.ScoreMapped.at_full_pct));
          setExposureSell(ex.target.ScoreMapped.sell);
        }
        if ('Immediate' in ex.ramp) {
          setRampKind('Immediate');
          // `Immediate` 无下行速率/信号中断语义（字段只属 `RateCap`）⇒ 两态置「未声明」
          setDownPctPerBar('');
          setOnSignalBreak('');
        } else {
          setRampKind('RateCap');
          setPctPerBar(String(ex.ramp.RateCap.pct_per_bar));
          // ADR-029 Step 1.5（默认值纪律）：**未带即不补** —— `undefined` ⇒ `''`（未声明）⇒ 提交时不写该键。
          const down = ex.ramp.RateCap.down_pct_per_bar;
          setDownPctPerBar(down === undefined || down === null ? '' : String(down));
          setOnSignalBreak(ex.ramp.RateCap.on_signal_break ?? '');
        }
        setGuardMaxPct(String(ex.guard.max_pct));
        setGuardMinPct(String(ex.guard.min_pct));
        setGuardDeadzonePct(String(ex.guard.deadzone_pct));
        const minNotional = ex.guard.deadzone_min_notional;
        setGuardDeadzoneMinNotional(minNotional === undefined || minNotional === null ? '' : String(minNotional));
      }
      if (cfg.stop) {
        setStopEnabled(true);
        setStopKind(cfg.stop.kind);
        setStopValue(String(cfg.stop.value));
        setStopTrigger(cfg.stop.trigger ?? 'Intrabar');
      } else {
        setStopEnabled(false);
      }
      setInitialCapital(String(cfg.initial_capital));
      setFeeRate(String(cfg.fee.rate_pct));
      setFeeMin(String(cfg.fee.min_fee));
      setFeeSlippage(String(cfg.fee.slippage_bp));
      const row = (presets ?? []).find((p) => p.id === id);
      if (row) setPresetName(row.name);
      setAppliedJson(canonicalConfig(pinnedToInput(cfg)));
      setPresetSel(id);
    } catch (e) {
      setPresetMsg(`预设应用失败：${(e as Error).message}`);
    }
  };

  /** 保存预设：presetSel 非空且表单偏离预设 → PUT 就地更新（MINOR-2）；否则 POST 新建。 */
  const handleSavePreset = async () => {
    const built = buildConfig();
    if (!built) return;
    if (!presetName.trim()) {
      setPresetMsg('预设名必填');
      return;
    }
    setPresetMsg(null);
    const json = canonicalConfig(built.config);
    try {
      if (presetSel && appliedJson !== null && json !== appliedJson) {
        await onUpdatePreset(presetSel, presetName.trim(), built.config);
        setAppliedJson(json);
        setPresetMsg('已更新预设');
      } else {
        await onCreatePreset(presetName.trim(), built.config);
        setPresetMsg('已保存预设');
      }
    } catch (e) {
      setPresetMsg(`保存失败：${(e as Error).message}`);
    }
  };

  const handleRename = async () => {
    if (!presetSel || !presetName.trim()) return;
    setPresetMsg(null);
    try {
      await onRenamePreset(presetSel, presetName.trim());
      setPresetMsg('已重命名');
    } catch (e) {
      setPresetMsg(`重命名失败：${(e as Error).message}`);
    }
  };

  const handleDelete = async () => {
    if (!presetSel) return;
    setPresetMsg(null);
    try {
      await onDeletePreset(presetSel);
      setPresetSel('');
      setAppliedJson(null);
      setPresetMsg('已删除预设');
    } catch (e) {
      setPresetMsg(`删除失败：${(e as Error).message}`);
    }
  };

  if (catalogError) {
    return (
      <div className="flex items-center gap-3 p-3 text-xs text-up" data-testid="wb-catalog-error">
        <span>策略目录加载失败：{catalogError}</span>
        <button type="button" onClick={onRetryCatalog} className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt">
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 overflow-auto p-3 text-xs" data-testid="wb-config">
      {/* 组合预设（ADR §13.5：选中即回填；保存/重命名/删除） */}
      <div className="rounded-lg border border-line bg-panel2 p-2">
        <div className="mb-1 flex items-center justify-between text-dim">
          <span>组合预设</span>
          {presetDirty && (
            <span className="text-acc1" data-testid="wb-preset-dirty">
              已修改（未保存回预设）
            </span>
          )}
        </div>
        <div className="flex gap-1">
          <select
            className={INPUT}
            value={presetSel}
            onChange={(e) => void handleApplyPreset(e.target.value)}
            data-testid="wb-preset-select"
          >
            <option value="">选择预设…</option>
            {(presets ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-1 flex gap-1">
          <input
            className={INPUT}
            placeholder="预设名"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            data-testid="wb-preset-name"
          />
          <button type="button" onClick={() => void handleSavePreset()} className="shrink-0 rounded-lg border border-line px-2 text-dim hover:text-txt" data-testid="wb-preset-save">
            {presetDirty ? '更新' : '保存'}
          </button>
          <button type="button" onClick={() => void handleRename()} disabled={!presetSel} className="shrink-0 rounded-lg border border-line px-2 text-dim hover:text-txt disabled:opacity-40" data-testid="wb-preset-rename">
            重命名
          </button>
          <button type="button" onClick={() => void handleDelete()} disabled={!presetSel} className="shrink-0 rounded-lg border border-line px-2 text-dim hover:text-txt disabled:opacity-40" data-testid="wb-preset-delete">
            删除
          </button>
        </div>
        {presetMsg && <div className="mt-1 text-dim" data-testid="wb-preset-msg">{presetMsg}</div>}
      </div>

      {/* 策略多选（catalog published）→ slot 卡片 */}
      <div className="rounded-lg border border-line bg-panel2 p-2">
        <div className="mb-1 text-dim">策略（多选，加权聚合）</div>
        <div className="flex gap-1">
          <select
            className={INPUT}
            value={addSel}
            onChange={(e) => setAddSel(e.target.value)}
            disabled={catalogLoading}
            data-testid="wb-add-strategy"
          >
            <option value="">{catalogLoading ? '加载中…' : '添加策略…'}</option>
            {addable.map((e) => (
              <option key={e.version.id} value={e.version.id}>
                {e.strategy.name} v{e.version.version}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="shrink-0 rounded-lg border border-line px-2 text-dim hover:text-txt disabled:opacity-40"
            disabled={!addSel}
            onClick={() => {
              const hit = (catalog ?? []).find((e) => e.version.id === addSel);
              if (!hit) return;
              setSlots((cur) => [...cur, slotFromCatalog(hit)]);
              setAddSel('');
            }}
            data-testid="wb-add-btn"
          >
            添加
          </button>
        </div>
        {slots.map((s) => (
          <div key={s.versionId} className="mt-2 rounded-lg border border-line/60 p-2" data-testid={`slot-card-${s.versionId}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-txt">{s.label}</span>
              <button
                type="button"
                className="text-dim hover:text-up"
                onClick={() => setSlots((cur) => cur.filter((x) => x.versionId !== s.versionId))}
                data-testid={`slot-remove-${s.versionId}`}
              >
                移除
              </button>
            </div>
            <label className={`${LABEL} mt-1`}>
              权重
              <input
                type="number"
                className={INPUT}
                value={s.weight}
                min={0}
                step="any"
                onChange={(e) => patchSlot(s.versionId, (x) => ({ ...x, weight: e.target.value }))}
                data-testid={`slot-weight-${s.versionId}`}
              />
            </label>
            {s.schema.length > 0 && (
              <div className="mt-1 grid grid-cols-2 gap-1">
                {s.schema.map((p) => (
                  <label key={p.key} className={LABEL}>
                    {p.key}
                    {p.description ? `（${p.description}）` : ''}
                    <input
                      type="number"
                      className={INPUT}
                      value={s.paramText[p.key] ?? String(p.default)}
                      min={p.min}
                      max={p.max}
                      step={p.type === 'int' ? 1 : 'any'}
                      onChange={(e) =>
                        patchSlot(s.versionId, (x) => ({
                          ...x,
                          paramText: { ...x.paramText, [p.key]: e.target.value },
                        }))
                      }
                      data-testid={`slot-param-${s.versionId}-${p.key}`}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 标的 + 周期 + 区间 */}
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-panel2 p-2">
        <label className={LABEL}>
          名称（可选）
          <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} data-testid="wb-name" />
        </label>
        <label className={LABEL}>
          标的
          <select className={INPUT} value={symbol} onChange={(e) => setSymbol(e.target.value)} data-testid="wb-symbol">
            {!enabledSymbols.some((s) => s.code === symbol) && <option value={symbol}>{symbol}</option>}
            {enabledSymbols.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code} {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          周期
          <select className={INPUT} value={period} onChange={(e) => setPeriod(e.target.value)} data-testid="wb-period">
            {SUPPORTED_BACKTEST_PERIODS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          初始资金
          <input type="number" className={INPUT} value={initialCapital} onChange={(e) => setInitialCapital(e.target.value)} data-testid="wb-initial-capital" />
        </label>
        <label className={LABEL}>
          起始
          <input type="date" className={INPUT} value={dateFrom} min={minDay} max={maxDay} onChange={(e) => setDateFrom(e.target.value)} data-testid="wb-date-from" />
        </label>
        <label className={LABEL}>
          截止
          <input type="date" className={INPUT} value={dateTo} min={minDay} max={maxDay} onChange={(e) => setDateTo(e.target.value)} data-testid="wb-date-to" />
        </label>
      </div>

      {/* ADR-024 P5 §5.2：可得区间（日期控件 min/max 随「标的+周期」联动） */}
      {minDay && maxDay && (
        <div className="text-[11px] text-dim" data-testid="wb-available-range">
          可用区间：{minDay} ~ {maxDay}
        </div>
      )}
      {/* ADR-024 P5：clamped:true ⇒ 显著提示条（不弹确认框） */}
      {clampNotice && (
        <div className="rounded-lg border border-up/40 bg-up/10 px-2 py-1 text-up" role="status" data-testid="wb-clamp-notice">
          已按实际数据范围收缩：{clampNotice.effectiveFrom.slice(0, 10)} ~ {clampNotice.effectiveTo.slice(0, 10)}（原因：数据可得范围）
        </div>
      )}
      {/* ADR-024 P5：resource_guard ⇒ 二次确认（展示预估 bar 数/耗时） */}
      {guardPrompt && (
        <div className="rounded-lg border border-up/40 bg-up/10 px-2 py-1 text-up" role="alert" data-testid="wb-guard-prompt">
          <div>预估 {guardPrompt.bars} 根 bar（约 {guardPrompt.secs.toFixed(1)} 秒），达到二次确认阈值。</div>
          <div className="mt-1 flex gap-2">
            <button type="button" className="h-7 rounded-lg bg-acc1 px-2 text-xs font-medium text-white" onClick={onConfirmGuard} data-testid="wb-guard-confirm">仍要提交</button>
            <button type="button" className="h-7 rounded-lg border border-line px-2 text-xs" onClick={onDismissGuard} data-testid="wb-guard-cancel">取消</button>
          </div>
        </div>
      )}

      {/* 聚合阈值 */}
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-panel2 p-2">
        <label className={LABEL}>
          买入阈值（≥ 买）
          <input type="number" className={INPUT} value={buyThreshold} onChange={(e) => setBuyThreshold(e.target.value)} data-testid="wb-buy-threshold" />
        </label>
        <label className={LABEL}>
          卖出阈值（≤ 卖）
          <input type="number" className={INPUT} value={sellThreshold} onChange={(e) => setSellThreshold(e.target.value)} data-testid="wb-sell-threshold" />
        </label>
      </div>

      {/* ExecutionPolicy（ADR-029：LumpSum/Dca = legacy 只读；Exposure = 目标 × ramp × guard） */}
      <div className="rounded-lg border border-line bg-panel2 p-2">
        <label className={LABEL}>
          执行策略（ExecutionPolicy）
          <select
            className={INPUT}
            value={policyKind}
            onChange={(e) => setPolicyKind(e.target.value as 'LumpSum' | 'Dca' | 'Exposure')}
            data-testid="wb-policy-kind"
          >
            <option value="LumpSum">LumpSum 一次性</option>
            <option value="Dca">DCA 分批</option>
            <option value="Exposure">Exposure 目标 × 到达方式 × 硬边界</option>
          </select>
        </label>
        {policyKind === 'LumpSum' ? (
          <label className={`${LABEL} mt-1`}>
            仓位比例 (0,1]
            <input type="number" className={INPUT} value={positionPct} min={0} max={1} step="any" onChange={(e) => setPositionPct(e.target.value)} data-testid="wb-position-pct" />
          </label>
        ) : policyKind === 'Dca' ? (
          <div className="mt-1 grid grid-cols-2 gap-2">
            <label className={LABEL}>
              批次数 N
              <input type="number" className={INPUT} value={dcaTranches} min={1} step={1} onChange={(e) => setDcaTranches(e.target.value)} data-testid="wb-dca-tranches" />
            </label>
            <label className={LABEL}>
              金额模式
              <select className={INPUT} value={dcaMode} onChange={(e) => setDcaMode(e.target.value as 'Equal' | 'FixedAmount')} data-testid="wb-dca-mode">
                <option value="Equal">等额</option>
                <option value="FixedAmount">固定金额</option>
              </select>
            </label>
            {dcaMode === 'FixedAmount' && (
              <label className={LABEL}>
                每批金额（元）
                <input type="number" className={INPUT} value={dcaAmount} min={0} step="any" onChange={(e) => setDcaAmount(e.target.value)} data-testid="wb-dca-amount" />
              </label>
            )}
            <label className={LABEL}>
              批间隔（bar）
              <input type="number" className={INPUT} value={dcaInterval} min={1} step={1} onChange={(e) => setDcaInterval(e.target.value)} data-testid="wb-dca-interval" />
            </label>
          </div>
        ) : (
          <div className="mt-1 flex flex-col gap-2" data-testid="wb-exposure-fields">
            {/* ① 目标维 target（ADR-029 D3；量纲 = 净值占比） */}
            <div className="grid grid-cols-2 gap-2">
              <label className={LABEL}>
                目标维 target
                <select
                  className={INPUT}
                  value={exposureTarget}
                  onChange={(e) => setExposureTarget(e.target.value as ExposureTargetKind)}
                  data-testid="wb-exposure-target"
                >
                  <option value="Fixed">Fixed 常数目标（= LumpSum 目标语义）</option>
                  <option value="ScoreMapped">ScoreMapped 随聚合分线性</option>
                </select>
              </label>
              {exposureTarget === 'Fixed' ? (
                <label className={LABEL}>
                  pct（净值占比，(0,1]）
                  <input type="number" className={INPUT} value={exposureFixedPct} min={0} max={1} step="any" onChange={(e) => setExposureFixedPct(e.target.value)} data-testid="wb-exposure-fixed-pct" />
                </label>
              ) : (
                <>
                  <label className={LABEL}>
                    at_threshold_pct（净值占比；score = 买入阈值 时的目标）
                    <input type="number" className={INPUT} value={exposureAtThreshold} min={0} max={1} step="any" onChange={(e) => setExposureAtThreshold(e.target.value)} data-testid="wb-exposure-at-threshold-pct" />
                  </label>
                  <label className={LABEL}>
                    at_full_pct（净值占比；score = 100 时的目标）
                    <input type="number" className={INPUT} value={exposureAtFull} min={0} max={1} step="any" onChange={(e) => setExposureAtFull(e.target.value)} data-testid="wb-exposure-at-full-pct" />
                  </label>
                  <label className={LABEL}>
                    卖出侧 sell（仅 ScoreMapped）
                    <select className={INPUT} value={exposureSell} onChange={(e) => setExposureSell(e.target.value as ExposureSellPolicy)} data-testid="wb-exposure-sell">
                      <option value="Flat">Flat — score ≤ 卖出阈值 ⇒ 直接清仓（目标 0）</option>
                      <option value="Scaled">Scaled — 对称降档（score=0 ⇒ 0；score=卖出阈值 ⇒ at_threshold_pct）</option>
                    </select>
                  </label>
                </>
              )}
            </div>
            {/* ② 到达方式维 ramp（ADR-029 D4） */}
            <div className="grid grid-cols-2 gap-2">
              <label className={LABEL}>
                到达方式 ramp
                <select className={INPUT} value={rampKind} onChange={(e) => setRampKind(e.target.value as ExposureRampKind)} data-testid="wb-ramp-kind">
                  <option value="Immediate">Immediate — 当 bar 目标即全额</option>
                  <option value="RateCap">RateCap — 每 bar 目标变动上限</option>
                </select>
              </label>
              {rampKind === 'RateCap' && (
                <label className={LABEL}>
                  {'pct_per_bar（每 bar 允许变动金额 / 净值，须 > 0）'}
                  <input type="number" className={INPUT} value={pctPerBar} min={0} step="any" onChange={(e) => setPctPerBar(e.target.value)} data-testid="wb-ramp-pct-per-bar" />
                </label>
              )}
              {rampKind === 'RateCap' && (
                <label className={LABEL}>
                  {'down_pct_per_bar（下行；每 bar 允许变动金额 / 净值；0 = 下行不限速；留空 = 对称）'}
                  <input type="number" className={INPUT} value={downPctPerBar} min={0} step="any" onChange={(e) => setDownPctPerBar(e.target.value)} data-testid="wb-exposure-down-pct-per-bar" />
                </label>
              )}
              {rampKind === 'RateCap' && (
                <label className={LABEL}>
                  on_signal_break（中立带：信号中断后未走完的路径如何处置）
                  <select
                    className={INPUT}
                    value={onSignalBreak}
                    onChange={(e) => setOnSignalBreak(e.target.value as ExposureOnSignalBreak | '')}
                    data-testid="wb-exposure-on-signal-break"
                  >
                    <option value="Continue">Continue — 中立带继续朝「意图」推进（新配置默认）</option>
                    <option value="Pause">Pause — 输出目标冻结在上一目标（停在中途）</option>
                    <option value="">未声明（运行期缺省 = Pause，现行语义；不写该字段）</option>
                  </select>
                </label>
              )}
            </div>
            {/* ③ 硬边界维 guard（ADR-029 D5/D8） */}
            <div className="grid grid-cols-3 gap-2">
              <label className={LABEL}>
                max_pct（净值占比，强制夹取）
                <input type="number" className={INPUT} value={guardMaxPct} min={0} max={1} step="any" onChange={(e) => setGuardMaxPct(e.target.value)} data-testid="wb-guard-max-pct" />
              </label>
              <label className={LABEL}>
                min_pct（净值占比；非零下限仅约束持有态、不清仓）
                <input type="number" className={INPUT} value={guardMinPct} min={0} max={1} step="any" onChange={(e) => setGuardMinPct(e.target.value)} data-testid="wb-guard-min-pct" />
              </label>
              <label className={LABEL}>
                deadzone_pct（暴露比例差）
                <input type="number" className={INPUT} value={guardDeadzonePct} min={0} step="any" onChange={(e) => setGuardDeadzonePct(e.target.value)} data-testid="wb-guard-deadzone-pct" />
              </label>
              <label className={LABEL}>
                deadzone_min_notional（**元**；留空 = 仅比例口径）
                <input
                  type="number"
                  className={INPUT}
                  value={guardDeadzoneMinNotional}
                  min={0}
                  step="any"
                  placeholder="省略 = 仅比例"
                  onChange={(e) => setGuardDeadzoneMinNotional(e.target.value)}
                  data-testid="wb-exposure-deadzone-min-notional"
                />
              </label>
            </div>
            {/* ④ D14/C：成本提示（`min_fee` 主导的小额再平衡）+ 一键预填（数值取自面板输入，不硬编码） */}
            {costHint && (
              <div
                className="flex flex-col gap-1 rounded-lg border border-amber-300/40 bg-amber-300/10 px-2 py-1 text-[11px] text-amber-200/90"
                data-testid="wb-exposure-cost-hint"
              >
                <div>
                  {`成本提示：最小再平衡规模 ≈ ${fmtMoney(costHint.deadzoneNotional)}（死区门槛 = deadzone_pct ${fmtPct(Number(guardDeadzonePct), 2)} × 初始资金 ${fmtMoney(Number(initialCapital))}）< ${MIN_REBALANCE_FEE_MULTIPLE} × min_fee ${fmtMoney(costHint.recommended)} ⇒ 该规模的再平衡佣金**由 min_fee 主导**：单笔佣金占比 ≈ ${
                    costHint.perTradePct === null ? '不可计算（deadzone_pct = 0）' : fmtPct(costHint.perTradePct, 1)
                  }（名义佣金率 ${fmtPct(Number(feeRate) / 100, 3)}）。`}
                </div>
                <div>
                  <button
                    type="button"
                    className="rounded-lg border border-line px-2 py-0.5 text-dim hover:text-txt"
                    onClick={() => setGuardDeadzoneMinNotional(String(Number(costHint.recommended.toFixed(6))))}
                    data-testid="wb-exposure-cost-prefill"
                  >
                    {`一键预填 deadzone_min_notional = ${MIN_REBALANCE_FEE_MULTIPLE} × min_fee = ${fmtMoney(costHint.recommended)}`}
                  </button>
                </div>
              </div>
            )}
            {/* ④ ADR-029 D7/R1/R5/R6 披露（配置处）：总分 ≠ 仓位 + 映射端点 + 两支卖出语义 + 量纲 */}
            <div className="flex flex-col gap-0.5 text-[11px] text-dim" data-testid="wb-exposure-disclosure">
              <div>
                总分曲线是诊断量、不等于仓位：聚合分只决定「目标」暴露；实际仓位由 ramp 限速、guard 夹取与次 bar 成交共同决定。
              </div>
              <div data-testid="wb-exposure-endpoints">
                {exposureTarget === 'Fixed'
                  ? `目标 Fixed：pct=${fmtPct(Number(exposureFixedPct))}（净值占比；score ≤ sell_threshold(${sellThreshold}) ⇒ 目标 0，等价 LumpSum）`
                  : `目标 ScoreMapped：score=${buyThreshold}（买阈值）→ at_threshold_pct=${fmtPct(Number(exposureAtThreshold))}；score=100 → at_full_pct=${fmtPct(Number(exposureAtFull))}；卖出侧 ${exposureSell}（${
                      exposureSell === 'Flat'
                        ? `Flat = 直接清仓（score ≤ ${sellThreshold} ⇒ 目标 0）`
                        : `Scaled = 对称降档（score=0 ⇒ 0；score=${sellThreshold} ⇒ at_threshold_pct=${fmtPct(Number(exposureAtThreshold))}）`
                    }）`}
                {'；'}路径 ramp={
                  rampKind === 'Immediate'
                    ? 'Immediate（当 bar 目标即全额；该变体**无** `on_signal_break`，恒取 Pause 语义）'
                    : `RateCap：上行 pct_per_bar=${fmtPct(Number(pctPerBar))}（净值）/ 下行 down_pct_per_bar=${
                        downPctPerBar.trim() === '' ? `${fmtPct(Number(pctPerBar))}（未声明 ⇒ 对称）` : fmtPct(Number(downPctPerBar))
                      }${
                        Number(downPctPerBar) === 0 && downPctPerBar.trim() !== '' ? '（0 = 下行不限速）' : ''
                      }；信号中断 on_signal_break=${
                        onSignalBreak === ''
                          ? '未声明（运行期缺省 = Pause = 现行语义）'
                          : `${onSignalBreak}（${
                              onSignalBreak === 'Pause' ? '中立带冻结在上一输出目标，路径停在中途' : '中立带继续朝意图推进'
                            }）`
                      }`
                }
                {'；'}硬边界 guard：{
                  `max_pct=${fmtPct(Number(guardMaxPct))}（强制夹取，策略无权覆盖）/ min_pct=${fmtPct(Number(guardMinPct))} / deadzone_pct=${fmtPct(Number(guardDeadzonePct), 2)}（|目标 − 当前暴露| < 死区 ⇒ 不下单）${
                    guardDeadzoneMinNotional.trim() === ''
                      ? ''
                      : ` / deadzone_min_notional=${fmtMoney(Number(guardDeadzoneMinNotional))}（元；阈值 = max(deadzone_pct × equity, 该值)）`
                  }。`
                }
              </div>
              {/* §2.5 注（量纲披露，不得当作缺陷）：死区是**意图 gap 门**，不是订单规模下限 */}
              <div data-testid="wb-exposure-deadzone-note" className="text-amber-300/80">
                死区是**意图 gap 门**、**不是订单规模下限**：它拦的是「意图与当前的水位差」，限速可把单笔订单切到死区之下
                （有意行为，非缺陷）；`deadzone_min_notional` 只抬高**门槛**，不改变这一点。死区阈值的金额口径 =
                max(deadzone_pct × equity, deadzone_min_notional)。
              </div>
              <div data-testid="wb-exposure-dim-note">{EXPOSURE_DIM_NOTE}</div>
              {/* E15/E16（契约补充）：非零 min_pct **不阻塞清仓** —— 避免「设了下限就不会空仓」的误读 */}
              <div data-testid="wb-exposure-guard-note" className="text-amber-300/80">
                guard.min_pct 非零时仅约束持有态目标（持仓不低于下限），不阻塞清仓：score ≤ 卖出阈值时目标仍为 0（清仓）。
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 硬止损（可选，ADR §13.3 第二层） */}
      <div className="rounded-lg border border-line bg-panel2 p-2">
        <label className="flex items-center gap-2 text-xs text-dim">
          <input type="checkbox" checked={stopEnabled} onChange={(e) => setStopEnabled(e.target.checked)} data-testid="wb-stop-enabled" />
          启用硬止损（触发即绕过评分平仓）
        </label>
        {stopEnabled && (
          <div className="mt-1 grid grid-cols-3 gap-2">
            <label className={LABEL}>
              类型
              <select className={INPUT} value={stopKind} onChange={(e) => setStopKind(e.target.value as typeof stopKind)} data-testid="wb-stop-kind">
                <option value="FixedPct">固定百分比</option>
                <option value="Trailing">移动止损</option>
                <option value="Atr">ATR 吊灯</option>
              </select>
            </label>
            <label className={LABEL}>
              值（比例/ATR 倍数）
              <input type="number" className={INPUT} value={stopValue} min={0} step="any" onChange={(e) => setStopValue(e.target.value)} data-testid="wb-stop-value" />
            </label>
            <label className={LABEL}>
              触发
              <select className={INPUT} value={stopTrigger} onChange={(e) => setStopTrigger(e.target.value as typeof stopTrigger)} data-testid="wb-stop-trigger">
                <option value="Intrabar">intrabar</option>
                <option value="CloseBasis">close_basis</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {/* 费用 */}
      <div className="grid grid-cols-3 gap-2 rounded-lg border border-line bg-panel2 p-2">
        <label className={LABEL}>
          佣金率%
          <input type="number" className={INPUT} value={feeRate} step="any" onChange={(e) => setFeeRate(e.target.value)} data-testid="wb-fee-rate" />
        </label>
        <label className={LABEL}>
          最低佣金
          <input type="number" className={INPUT} value={feeMin} step="any" onChange={(e) => setFeeMin(e.target.value)} data-testid="wb-fee-min" />
        </label>
        <label className={LABEL}>
          滑点 bp
          <input type="number" className={INPUT} value={feeSlippage} step="any" onChange={(e) => setFeeSlippage(e.target.value)} data-testid="wb-fee-slippage" />
        </label>
      </div>

      {formError && (
        <div className="rounded-lg border border-up/40 bg-up/10 px-2 py-1 text-up" role="alert" data-testid="wb-form-error">
          {formError}
        </div>
      )}
      {submitError && (
        <div className="rounded-lg border border-up/40 bg-up/10 px-2 py-1 text-up" role="alert" data-testid="wb-submit-error">
          提交失败：{submitError}
        </div>
      )}
      <button
        type="button"
        className="h-8 rounded-lg bg-acc1 text-xs font-medium text-white disabled:opacity-40"
        disabled={submitting}
        onClick={handleSubmit}
        data-testid="wb-submit"
      >
        {submitting ? '提交中…' : '提交回测'}
      </button>
    </div>
  );
}
