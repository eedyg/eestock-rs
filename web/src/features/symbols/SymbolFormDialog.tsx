import type { FormState } from './store';
import { cn } from '@/lib/utils';

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-xs text-dim">
        {label}
        {children}
      </label>
      {error ? (
        <div className="mt-1 text-[11px] text-up">{error}</div>
      ) : hint ? (
        <div className="mt-1 text-[11px] text-[#f5c451]">{hint}</div>
      ) : null}
    </div>
  );
}

const inputCls =
  'mt-1 flex h-[34px] w-full items-center rounded-lg border border-line bg-panel2 px-3 text-[13px] text-txt outline-none focus:border-acc1/50';

/**
 * 注册/编辑共用模态 W=480（03-symbols §3）：
 * - 遮罩点击不关闭（防误触，定稿）——遮罩无 onClick，仅 取消/保存 控制
 * - code 主键编辑态只读（改 code = 停用旧 + 注册新）
 * - settlement 变更需二次确认（⚠️ 回测/交易撮合规则输入，改错污染回测结论）
 * - 校验错误字段内联；提交错误顶部提示；提交中禁用+spinner
 */
export function SymbolFormDialog({
  form,
  onChange,
  onConfirmSettlement,
  onSubmit,
  onClose,
}: {
  form: FormState;
  onChange(patch: Partial<FormState['values']>): void;
  onConfirmSettlement(v: boolean): void;
  onSubmit(): void;
  onClose(): void;
}) {
  const { mode, values, errors, submitting, submitError, originalSettlement } = form;
  const settlementChanged =
    mode === 'edit' && originalSettlement !== null && values.settlement !== originalSettlement;
  return (
    <div className="w-[480px] rounded-2xl border border-line bg-panel p-5 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
      <h3 className="mb-3.5 text-[15px]">{mode === 'register' ? '注册标的' : '编辑标的'}</h3>
      {submitError && (
        <div className="mb-3 rounded-lg border border-up/40 bg-up/10 px-3 py-2 text-xs text-up">
          {submitError}
        </div>
      )}
      <Field
        label="code（6 位数字；5/6/9→沪，0/1/2/3→深；北交所 4/8/920 拒绝）"
        error={errors.code}
      >
        <input
          value={values.code}
          readOnly={mode === 'edit'}
          onChange={(e) => onChange({ code: e.target.value.trim() })}
          className={cn(inputCls, 'num', mode === 'edit' && 'opacity-55')}
          placeholder="600519"
        />
      </Field>
      <Field label="抓取间隔（秒，默认 60，下限 60；保存后下一周期热生效）" error={errors.intervalSec}>
        <input
          type="number"
          min={60}
          value={Number.isNaN(values.intervalSec) ? '' : values.intervalSec}
          onChange={(e) => onChange({ intervalSec: parseInt(e.target.value, 10) })}
          className={cn(inputCls, 'num')}
        />
      </Field>
      <Field label="交收规则（按分类预填：跨境/债券/商品/货币→T0，股票型→T1；修改需二次确认）" error={errors.settlement}>
        <select
          value={values.settlement}
          onChange={(e) => onChange({ settlement: e.target.value as 'T0' | 'T1' })}
          className={inputCls}
        >
          <option value="T0">T+0（跨境/债券/商品/货币）</option>
          <option value="T1">T+1（股票型）</option>
        </select>
      </Field>
      {settlementChanged && (
        <div className="mb-3 rounded-lg border border-[#f5c451]/40 bg-[#f5c451]/10 px-3 py-2 text-xs text-[#f5c451]">
          ⚠️ 修改交收规则将影响回测撮合（T+1 当日买不可当日卖，T+0 可日内回转）
          <label className="mt-1 flex items-center gap-2 text-dim">
            <input
              type="checkbox"
              checked={form.settlementConfirmed}
              onChange={(e) => onConfirmSettlement(e.target.checked)}
            />
            确认修改交收规则
          </label>
        </div>
      )}
      <Field label="启用（默认开）">
        <span className="mt-1 flex items-center gap-2 text-[13px] text-dim">
          <input
            type="checkbox"
            aria-label="启用开关"
            checked={values.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          {values.enabled ? '开' : '关'}
        </span>
      </Field>
      <Field
        label="名称（ADR-017：服务端不经行情源反查，留空可手工填写）"
        error={errors.name}
      >
        <input
          value={values.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className={inputCls}
          placeholder="留空可后续编辑补录"
        />
      </Field>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-lg border border-line px-3 py-1 text-xs text-dim hover:text-txt disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className="rounded-lg bg-gradient-to-br from-acc1 to-acc2 px-3 py-1 text-xs text-white disabled:opacity-50"
        >
          {submitting ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}
