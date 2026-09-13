/**
 * 反向证据变体（验收 问题②）：「去掉 zero figure」的 /tmp 副本。
 * 仅存在于 /tmp 沙箱；通过临时 vite resolve.alias 生效（@/features/indicators/dcapIndicator → 本文件）。
 * 除 `figures` 去掉 `zero` 外，其余（含 calc：still { ...values, zero: 0 }）与真实模块逐字一致。
 */
import { registerIndicator } from 'klinecharts';
import * as real from '/home/eestock/workspace/git/eestock/eestock-rs/web/src/features/indicators/dcapIndicator';

export * from '/home/eestock/workspace/git/eestock/eestock-rs/web/src/features/indicators/dcapIndicator';

/** 变体：figures 仅 3 条数据线（无 0 参考线）。 */
export const DCAP_INDICATOR_TEMPLATE = {
  ...real.DCAP_INDICATOR_TEMPLATE,
  figures: (real.DCAP_INDICATOR_TEMPLATE.figures ?? []).filter((f) => f.key !== 'zero'),
};

let reg = false;
export function ensureDcapIndicatorRegistered(): void {
  if (reg) return;
  if (typeof registerIndicator !== 'function') return;
  registerIndicator(DCAP_INDICATOR_TEMPLATE);
  reg = true;
}
