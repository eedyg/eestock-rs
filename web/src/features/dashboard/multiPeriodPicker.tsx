import { useEffect, useMemo, useState } from 'react';
import type { Period } from '@/api/types';
import { Button } from '@/components/ui/button';

/**
 * 两步周期选择器（`design/15-multi-period/02-spec.md` §1/§2/§2.1/§6/§7；ADR-022 §2.5）。
 *
 * 本文件位置：`web/src/features/dashboard/multiPeriodPicker.tsx`
 *
 * 交互口径（用户裁决 + ADR-022 §2.5）：
 *  - **步骤 1** 选 K 线（基准）周期 P0：全集 = 全部周期 \ {`1mo`}；
 *  - **步骤 2** 选指标（卫星）周期 {Pi}：候选 = 全集 ∩ {P ≥ P0}（**允许相等**）\ {`1mo`}；含 `1w` 时要求 P0 ≥ `1d`
 *    （P0 < `1d` 时 `1w` **出现但禁用并给出原因** —— 不得静默隐藏）；最多 3 个（总周期 ≤4）。
 *
 * 护栏（02-spec §7）：非法组合（周期数 >4 / 卫星 < 基准 / 含 `1mo` / 含 `1w` 且基准 <`1d` / 总 pane >12）
 * **就地拒绝并明确报错**（不静默截断）；总 pane 计数基于**去重后**的 `indicators` 集合（§7.4）。
 *
 * 本组件为**受控/无副作用**视图：只把选择结果经 `onConfirm` 交给页面；持久化（PUT / 乐观更新 / 失败回滚）
 * 与 `state.period` 同步由 `DashboardPage` 负责（见 `02-spec.md` §2.1 硬要求：同时写 `periods[0]` 与 `state.period`）。
 * `onConfirm` 返回 Promise ⇒ 本组件 await；**reject ⇒ 显示可见报错并保持打开（可重试）**。
 */

/** 周期秩升序全集（**不含 `1mo`**；ADR-022 §2.5 用户裁决：`1mo` 不提供）。 */
export const MULTI_PERIOD_PICKER_PERIODS: Period[] = ['1m', '5m', '15m', '1h', '1d', '1w'];

/** 指标（卫星）周期上限 ⇒ 总周期 ≤4（ADR-022 口径 2）。 */
export const MAX_INDICATOR_PERIODS = 3;
/** 总周期上限（基准 1 + 卫星 ≤3）。 */
export const MULTI_PERIOD_MAX_PERIODS = 4;
/** 总 pane 预算上限（02-spec §7.4）。 */
export const MULTI_PERIOD_PANE_BUDGET = 12;
/** 新增基准 pane 的默认请求高度 px（02-spec §6）。 */
export const PICKER_DEFAULT_BASE_HEIGHT = 420;
/** 新增卫星 pane 的默认请求高度 px（02-spec §6）。 */
export const PICKER_DEFAULT_SATELLITE_HEIGHT = 180;

/** 周期秩（未知 / `1mo` ⇒ -1）。 */
function periodRank(period: string): number {
  return MULTI_PERIOD_PICKER_PERIODS.indexOf(period as Period);
}

/** 步骤 2 候选（含禁用项与原因；顺序 = 周期秩升序）。 */
export interface IndicatorPeriodOption {
  period: Period;
  enabled: boolean;
  reason: string | null;
}

/**
 * 步骤 2 候选：`{P ∈ 全集 | rank(P) ≥ rank(base)}`。
 * `1w` 在 `base < 1d` 时**出现但 `enabled=false` 且 `reason` 非空**（用户须能看到原因，不得静默消失）；
 * `base ≥ 1d` 时 `enabled=true`。未知 base ⇒ 空候选。
 */
export function indicatorPeriodOptions(base: string): IndicatorPeriodOption[] {
  const baseRank = periodRank(base);
  if (baseRank < 0) return [];
  return MULTI_PERIOD_PICKER_PERIODS.filter((p) => periodRank(p) >= baseRank).map((p) => {
    if (p === '1w' && baseRank < periodRank('1d')) {
      return { period: p, enabled: false, reason: '1w 需基准 ≥ 1d（避免恒退化）' };
    }
    return { period: p, enabled: true, reason: null };
  });
}

/**
 * 总 pane 数 = 1（基准）+ 卫星数 × |**去重后** indicators|（02-spec §7.4）。
 * 去重口径与后端 `normalize_multi_period_indicators` / mock 同源（`['dcap']×n` 恒计 1）。
 */
export function multiPeriodPaneCount(
  periods: readonly string[],
  indicators: readonly string[],
): number {
  const satellites = Math.max(0, periods.length - 1);
  const uniqueIndicators = new Set(indicators).size;
  return 1 + satellites * uniqueIndicators;
}

/** 选择器校验问题（`dimension` 为被拒维度名；02-spec §7.4 要求错误可定位）。 */
export interface PickerIssue {
  dimension: 'periods' | 'heights' | 'indicators' | 'pane';
  message: string;
}

/** 选择器内校验输入。 */
export interface PickerSelectionInput {
  base: string;
  indicatorPeriods: readonly string[];
  indicators: readonly string[];
}

/**
 * 选择器内校验（纯函数，与后端 `validate_multi_period_config` 同口径；02-spec §7）：
 * 周期数（≤4 / ≤3 指标）、卫星 ≥ 基准、不含 `1mo`、含 `1w` 须基准 ≥`1d`、指标周期不重复、
 * 总 pane ≤12（**去重后**计数）。`ok=false` ⇒ `issues` 至少一条含被拒维度名，且文案非空。
 *
 * 注：**指标周期允许与基准相等**（ADR-022 §2.5「允许相等」）⇒ 提交前由页面去重（`heights` 键与 `periods` 一一对应）。
 */
export function validatePickerSelection(input: PickerSelectionInput): {
  ok: boolean;
  issues: PickerIssue[];
} {
  const issues: PickerIssue[] = [];
  const baseRank = periodRank(input.base);
  if (baseRank < 0) {
    issues.push({ dimension: 'periods', message: `基准周期非法或不受支持：${input.base}` });
  }

  const uniquePeriods = new Set<string>([input.base]);
  const seenIndicator = new Set<string>();
  for (const p of input.indicatorPeriods) {
    const r = periodRank(p);
    if (r < 0) {
      issues.push({ dimension: 'periods', message: `指标周期非法或不受支持（含 1mo）：${p}` });
      continue;
    }
    if (baseRank >= 0 && r < baseRank) {
      issues.push({ dimension: 'periods', message: `卫星周期 ${p} 须 ≥ 基准 ${input.base}` });
    }
    if (p === '1w' && baseRank >= 0 && baseRank < periodRank('1d')) {
      issues.push({ dimension: 'periods', message: `含 1w 时基准须 ≥ 1d，收到基准 ${input.base}` });
    }
    if (seenIndicator.has(p)) {
      issues.push({ dimension: 'periods', message: `指标周期重复：${p}` });
    }
    seenIndicator.add(p);
    uniquePeriods.add(p);
  }

  if (input.indicatorPeriods.length > MAX_INDICATOR_PERIODS) {
    issues.push({
      dimension: 'periods',
      message: `指标周期最多 ${MAX_INDICATOR_PERIODS} 个（总周期 ≤ ${MULTI_PERIOD_MAX_PERIODS}），收到 ${input.indicatorPeriods.length}`,
    });
  }
  if (uniquePeriods.size > MULTI_PERIOD_MAX_PERIODS) {
    issues.push({
      dimension: 'periods',
      message: `总周期最多 ${MULTI_PERIOD_MAX_PERIODS} 个，收到 ${uniquePeriods.size}`,
    });
  }

  const panes = multiPeriodPaneCount([input.base, ...input.indicatorPeriods], input.indicators);
  if (panes > MULTI_PERIOD_PANE_BUDGET) {
    issues.push({
      dimension: 'pane',
      message: `indicators 去重后总 pane 数 ${panes} 超上限 ${MULTI_PERIOD_PANE_BUDGET}（拒绝保存，不静默截断）`,
    });
  }

  return { ok: issues.length === 0, issues };
}

/**
 * heights 键随周期增删（02-spec §6）：输出键 = 去重后的 `[base, ...indicatorPeriods]`；
 * 保留既有键值（`prevHeights[p]` 为有限正数时），新增基准 ⇒ 420、新增卫星 ⇒ 180；
 * 移除周期 ⇒ 键删除（**零残键**，保证与 `periods` 一一对应）。
 */
export function heightsForSelection(
  sel: { base: Period; indicatorPeriods: readonly Period[] },
  prevHeights: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const seen = new Set<string>();
  for (const p of [sel.base, ...sel.indicatorPeriods]) {
    if (seen.has(p)) continue;
    seen.add(p);
    const prev = prevHeights?.[p];
    const usable = typeof prev === 'number' && Number.isFinite(prev) && prev > 0;
    out[p] = usable ? (prev as number) : p === sel.base ? PICKER_DEFAULT_BASE_HEIGHT : PICKER_DEFAULT_SATELLITE_HEIGHT;
  }
  return out;
}

/** 规范序：去重 + 秩升序（确认载荷与 `periods` 规范形态）。 */
function normalizeSelection(periods: readonly Period[]): Period[] {
  const seen = new Set<string>();
  return [...periods]
    .filter((p) => (seen.has(p) ? false : (seen.add(p), true)))
    .sort((a, b) => periodRank(a) - periodRank(b));
}

/** 初值净化：丢弃对当前基准非法/不可选的已选指标周期（步骤 1 变化 ⇒ 候选收窄，不得保留非法已选项）。 */
function sanitizeSelection(base: Period, initial: readonly Period[]): Period[] {
  const allowed = new Set(indicatorPeriodOptions(base).filter((o) => o.enabled).map((o) => o.period));
  return normalizeSelection(initial.filter((p) => allowed.has(p)));
}

function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim() !== '') return m;
  }
  return '保存多周期配置失败（未知错误）';
}

/** 确认载荷（页面负责持久化 + 写 `state.period`）。 */
export interface MultiPeriodPickerSelection {
  basePeriod: Period;
  indicatorPeriods: Period[];
}

export interface MultiPeriodPeriodPickerProps {
  /** 步骤 1 初值（= 当前 K 线周期）。 */
  basePeriod: Period;
  /** 步骤 2 初值（= 配置 `periods[1..]`）。 */
  indicatorPeriods?: Period[];
  /** 卫星指标集合（首版 `['dcap']`；用于 pane 预算提示与校验）。 */
  indicators?: string[];
  /** 确认（页面持久化；返回 Promise ⇒ 组件 await，reject ⇒ 可见报错并保持打开）。 */
  onConfirm(sel: MultiPeriodPickerSelection): void | Promise<void>;
  /** 取消（可选）。 */
  onCancel?(): void;
}

/**
 * 两步周期选择器面板（DOM 契约见设计报告 `283_p5.5_period_picker_red_design.md` §2.3）：
 *  - 根 `[data-testid="mp-picker"]`；
 *  - 步骤 1 选项 `button[data-mp-base-period="<P>"]`（选中 ⇒ `aria-pressed="true"`）；
 *  - 步骤 2 选项 `button[data-mp-indicator-period="<P>"]`（不可选 ⇒ `disabled`）；
 *  - 禁用原因 `[data-mp-indicator-reason="<P>"]`（非空文本）；
 *  - 确认 `button[data-testid="mp-picker-confirm"]`；
 *  - 报错 `[data-testid="mp-picker-error"]`（非空文案）。
 */
export function MultiPeriodPeriodPicker({
  basePeriod,
  indicatorPeriods = [],
  indicators = ['dcap'],
  onConfirm,
  onCancel,
}: MultiPeriodPeriodPickerProps) {
  const [base, setBase] = useState<Period>(basePeriod);
  const [selected, setSelected] = useState<Period[]>(() => sanitizeSelection(basePeriod, indicatorPeriods));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(() => indicatorPeriodOptions(base), [base]);

  // 步骤 1 变化 ⇒ 步骤 2 候选**立即**收窄（丢弃不再合法的已选项；不得保留非法已选项，02-spec §2.3）。
  useEffect(() => {
    setSelected((prev) => {
      const allowed = new Set(options.filter((o) => o.enabled).map((o) => o.period));
      const next = prev.filter((p) => allowed.has(p));
      return next.length === prev.length ? prev : next;
    });
  }, [options]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const atMax = selected.length >= MAX_INDICATOR_PERIODS;
  const paneCount = multiPeriodPaneCount([base, ...selected], indicators);
  const paneBudgetLeft = MULTI_PERIOD_PANE_BUDGET - paneCount;

  /** 选项的禁用原因（`null` ⇒ 可选且未触上限）。 */
  const reasonFor = (o: IndicatorPeriodOption): string | null => {
    if (!o.enabled) return o.reason ?? '不可选';
    if (atMax && !selectedSet.has(o.period))
      return `已达上限 ${MAX_INDICATOR_PERIODS} 个指标周期（总周期 ≤ ${MULTI_PERIOD_MAX_PERIODS}）`;
    return null;
  };

  const toggle = (p: Period) => {
    setError(null);
    setSelected((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : normalizeSelection([...prev, p])));
  };

  const handleConfirm = async () => {
    setError(null);
    const sel: MultiPeriodPickerSelection = {
      basePeriod: base,
      indicatorPeriods: normalizeSelection(selected),
    };
    const verdict = validatePickerSelection({
      base: sel.basePeriod,
      indicatorPeriods: sel.indicatorPeriods,
      indicators,
    });
    if (!verdict.ok) {
      // 非法组合 ⇒ **就地拒绝并明确报错**（不静默截断、不发请求）。
      setError(verdict.issues.map((i) => i.message).join('；'));
      return;
    }
    setPending(true);
    try {
      await onConfirm(sel);
    } catch (e) {
      // 服务端 400 / PUT 失败 ⇒ 可见报错且保持打开（可重试），不静默关闭。
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      data-testid="mp-picker"
      data-mp-picker
      role="group"
      aria-label="两步周期选择器"
      className="flex w-[22rem] flex-col gap-2 rounded-lg border border-line bg-panel p-2.5 shadow-lg"
    >
      <div className="text-xs text-dim">步骤 1：K 线（基准）周期</div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="K 线周期">
        {MULTI_PERIOD_PICKER_PERIODS.map((p) => (
          <Button
            key={p}
            data-mp-base-period={p}
            aria-pressed={base === p}
            variant={base === p ? 'primary' : 'ghost'}
            onClick={() => setBase(p)}
          >
            {p}
          </Button>
        ))}
      </div>

      <div className="text-xs text-dim">
        步骤 2：指标周期（≥ {base}；最多 {MAX_INDICATOR_PERIODS} 个）
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-1" role="group" aria-label="指标周期">
        {options.map((o) => {
          const reason = reasonFor(o);
          const active = selectedSet.has(o.period);
          const disabled = !o.enabled || (atMax && !active);
          return (
            <span key={o.period} className="flex items-center gap-1">
              <Button
                data-mp-indicator-period={o.period}
                aria-pressed={active}
                disabled={disabled}
                variant={active ? 'primary' : 'ghost'}
                onClick={() => toggle(o.period)}
              >
                {o.period}
              </Button>
              {reason && (
                <span data-mp-indicator-reason={o.period} className="text-[10px] text-dim">
                  {reason}
                </span>
              )}
            </span>
          );
        })}
      </div>

      <div data-mp-picker-hint className="text-[10px] text-dim">
        已选 {selected.length}/{MAX_INDICATOR_PERIODS}；总 pane {paneCount}/{MULTI_PERIOD_PANE_BUDGET}
        （剩余 {paneBudgetLeft}）；候选已按步骤 1 收窄为 ≥ {base}，`1mo` 不提供。
      </div>

      {error && (
        <div data-testid="mp-picker-error" data-mp-picker-error role="alert" className="text-[11px] text-down">
          {error}
        </div>
      )}

      <div className="mt-0.5 flex gap-1.5">
        <Button data-testid="mp-picker-confirm" variant="primary" disabled={pending} onClick={handleConfirm}>
          {pending ? '保存中…' : '确定'}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
        )}
      </div>
    </div>
  );
}
