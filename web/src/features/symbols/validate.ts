import { SYMBOLS_DEFAULTS } from '@/layouts/SymbolsGrid';
import type { FormMode, Settlement, SymbolFormValues } from '@/api/types';

/**
 * 标的表单客户端校验（03-symbols §3；与后端 web/dto.rs 校验同口径双保险——
 * 客户端内联提示，服务端为最终裁决）。
 */

/** code 校验：6 位数字；5/6/9→沪、0/1/2/3→深；北交所 4/8/920 拒绝「暂不支持」 */
export function validateCode(code: string): string | null {
  if (!/^\d{6}$/.test(code)) return 'code 须为 6 位数字';
  if (/^(920|4|8)/.test(code)) return '北交所标的（4/8/920 前缀）暂不支持';
  if (!/^[0123569]/.test(code)) return '不支持的市场前缀';
  return null;
}

/** 市场判定（合法 code 前提；非法 → null） */
export function marketOf(code: string): '沪' | '深' | null {
  if (validateCode(code)) return null;
  return /^[569]/.test(code) ? '沪' : '深';
}

/** 抓取间隔：下限 60s（SYMBOLS_DEFAULTS.minIntervalSec / schema CHECK 同口径） */
export function validateInterval(secs: number): string | null {
  if (Number.isNaN(secs)) return '抓取间隔须为数字';
  if (secs < SYMBOLS_DEFAULTS.minIntervalSec) {
    return `抓取间隔下限 ${SYMBOLS_DEFAULTS.minIntervalSec} 秒`;
  }
  return null;
}

export function validateSettlement(s: Settlement): string | null {
  if (s !== 'T0' && s !== 'T1') return '交收规则须为 T0 或 T1';
  return null;
}

/**
 * 整表校验（注册/编辑共用）：
 * - 注册校验 code；编辑态 code 主键只读不校验
 * - 编辑态 settlement 变更且未二次确认 → settlement 错误（⚠️ 回测撮合规则输入）
 */
export function validateForm(
  mode: FormMode,
  values: SymbolFormValues,
  originalSettlement: Settlement | null,
  settlementConfirmed: boolean,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (mode === 'register') {
    const e = validateCode(values.code);
    if (e) errors.code = e;
  }
  const ei = validateInterval(values.intervalSec);
  if (ei) errors.intervalSec = ei;
  const es = validateSettlement(values.settlement);
  if (es) {
    errors.settlement = es;
  } else if (
    mode === 'edit' &&
    originalSettlement !== null &&
    values.settlement !== originalSettlement &&
    !settlementConfirmed
  ) {
    errors.settlement = '修改交收规则需二次确认（影响回测撮合）';
  }
  return errors;
}
