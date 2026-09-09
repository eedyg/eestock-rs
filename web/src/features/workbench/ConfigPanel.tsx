import { useMemo, useState } from 'react';
import type {
  StrategyCatalogEntry,
  StrategyParamDef,
  SymbolSnapshot,
  WorkbenchPinnedSlot,
  WorkbenchPolicy,
  WorkbenchPresetConfigInput,
  WorkbenchPresetRow,
  WorkbenchRunConfig,
  WorkbenchStop,
  WorkbenchSubmitReq,
} from '@/api/types';

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

function todayPlus(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
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
 * 聚合阈值（默认 60/40）/ ExecutionPolicy（LumpSum | DCA）/ 硬止损（可选）/ 初始资金 / 费用 /
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
  onSubmit,
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
  onSubmit: (req: WorkbenchSubmitReq) => void;
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
  const [policyKind, setPolicyKind] = useState<'LumpSum' | 'Dca'>('LumpSum');
  const [positionPct, setPositionPct] = useState('1');
  const [dcaTranches, setDcaTranches] = useState('3');
  const [dcaMode, setDcaMode] = useState<'Equal' | 'FixedAmount'>('Equal');
  const [dcaAmount, setDcaAmount] = useState('');
  const [dcaInterval, setDcaInterval] = useState('1');
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
    } else {
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
      } else {
        setPolicyKind('Dca');
        setDcaTranches(String(cfg.policy.Dca.tranches));
        setDcaMode(cfg.policy.Dca.mode);
        setDcaAmount(cfg.policy.Dca.amount != null ? String(cfg.policy.Dca.amount) : '');
        setDcaInterval(String(cfg.policy.Dca.interval));
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
            <option value="M1">M1</option>
            <option value="M5">M5</option>
            <option value="M15">M15</option>
            <option value="D1">D1</option>
          </select>
        </label>
        <label className={LABEL}>
          初始资金
          <input type="number" className={INPUT} value={initialCapital} onChange={(e) => setInitialCapital(e.target.value)} data-testid="wb-initial-capital" />
        </label>
        <label className={LABEL}>
          起始
          <input type="date" className={INPUT} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} data-testid="wb-date-from" />
        </label>
        <label className={LABEL}>
          截止
          <input type="date" className={INPUT} value={dateTo} onChange={(e) => setDateTo(e.target.value)} data-testid="wb-date-to" />
        </label>
      </div>

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

      {/* ExecutionPolicy */}
      <div className="rounded-lg border border-line bg-panel2 p-2">
        <label className={LABEL}>
          执行策略（ExecutionPolicy）
          <select className={INPUT} value={policyKind} onChange={(e) => setPolicyKind(e.target.value as 'LumpSum' | 'Dca')} data-testid="wb-policy-kind">
            <option value="LumpSum">LumpSum 一次性</option>
            <option value="Dca">DCA 分批</option>
          </select>
        </label>
        {policyKind === 'LumpSum' ? (
          <label className={`${LABEL} mt-1`}>
            仓位比例 (0,1]
            <input type="number" className={INPUT} value={positionPct} min={0} max={1} step="any" onChange={(e) => setPositionPct(e.target.value)} data-testid="wb-position-pct" />
          </label>
        ) : (
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
