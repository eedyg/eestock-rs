/**
 * ADR-024 §3.1.1（P5 整改 N1）—— **前端按 `code` 分支**的错误展示。
 *
 * 契约：400 响应体 `{error:{code,message,detail}}`，`code` 为**稳定**标识（后端
 * `application::error::codes` 同源）。前端据此给**中文提示**；**未知码必须回退到服务端
 * `message`**（可读、不吞信息），不得只显示「未知错误」。
 *
 * 消费点：工作台提交（`WorkbenchStore.submit`）、在线试算（`TestRunPanel`）等 `ApiError` 展示。
 * ⚠️ 防漂移：本文件的码集合由 `crates/web/tests/adr024_structured_errors.rs` 的
 * parity 用例与后端 `application::error::codes::ALL` 对比（新增码未覆盖 ⇒ 该用例红）。
 */
import type { ApiErrorDetail } from './types';

/** 已知错误码 → 中文提示（可读 `detail`）。 */
const CODE_HINTS: Record<string, (d: ApiErrorDetail) => string> = {
  // ── 区间/周期（§3.1.1 列举）──
  range_empty: (d) =>
    d.available_from && d.available_to
      ? `该标的该周期无数据（可用区间：${d.available_from} ~ ${d.available_to}）`
      : '该标的该周期无数据',
  resource_guard: (d) =>
    `区间过大：预估 ${d.requested_bars ?? '?'} 根 bar（约 ${d.estimated_secs ?? '?'} 秒）` +
    (d.confirmable === false ? '，已超硬上界不可放行' : '，可二次确认后重提'),
  period_invalid: () => '不支持的周期',
  from_after_to: () => '开始时间必须早于结束时间',
  timestamp_invalid: () => '时间格式非法（须 RFC3339）',
  // ── 标的/槽位/参数 ──
  symbol_required: () => '标的必填',
  symbol_unregistered: () => '该标的未注册',
  slots_invalid: () => '策略槽位非法（须 1~10 个且版本有效）',
  weight_invalid: () => '策略权重须大于 0',
  params_invalid: () => '策略参数不符合其参数表（schema）要求',
  threshold_invalid: () => '买入阈值须严格大于卖出阈值（且买入 > 50 > 卖出）',
  policy_invalid: () => '执行策略（policy）非法',
  stop_invalid: () => '止损配置非法（value 须为正有限值）',
  fee_invalid: () => '费用配置非法（rate_pct/min_fee/slippage_bp）',
  capital_invalid: () => '初始资金须为正有限值',
  version_not_runnable: () => '该策略版本未发布（draft 不可运行，请先发布）',
  source_invalid: () => '策略来源非法（代码与版本须且仅须提供一个）',
  mode_invalid: () => '试算模式非法（pure_score / sim_position）',
  code_invalid: () => '策略代码未通过冒烟门禁（缺少 on_bar 或语法错误）',
  // ── 其余 400 ──
  name_required: () => '名称必填',
  code_required: () => '代码必填',
  ids_required: () => '请选择要对比的运行',
  status_invalid: () => '运行状态过滤值非法',
  kind_invalid: () => '序列类型非法（per_bar / net_value / drawdown）',
  level_invalid: () => '审批等级非法',
  config_invalid: () => '配置结构非法',
  request_invalid: () => '请求参数非法',
};

/**
 * `ApiError`（或同形对象）→ 展示文案。
 * - 已知 `code` ⇒ 「中文提示（服务端原文）」；
 * - **未知 `code` ⇒ 回退服务端 `message`**（前端可读，不吞信息）；
 * - 无 `code`（旧形状/网络错误）⇒ `message`。
 */
export function errorDisplayText(err: {
  code?: string;
  message?: string;
  detail?: ApiErrorDetail;
}): string {
  const message = (err.message ?? '').trim() || '请求失败';
  const code = err.code;
  if (!code) return message;
  const hint = CODE_HINTS[code];
  if (!hint) return message; // 未知码：回退 message（防「只显示未知错误」）
  const text = hint(err.detail ?? {});
  return text === message ? text : `${text}（${message}）`;
}

/** 已知码判定（用于测试/调试；未知码 = false）。 */
export function isKnownErrorCode(code: string | undefined): boolean {
  return code !== undefined && Object.prototype.hasOwnProperty.call(CODE_HINTS, code);
}

/** 已知码集合（只读；parity 用例经 Rust 侧读取源码文本比对）。 */
export const KNOWN_ERROR_CODES: readonly string[] = Object.keys(CODE_HINTS);
