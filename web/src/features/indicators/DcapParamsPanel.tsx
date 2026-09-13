/**
 * DCAP 参数面板（Toolbar 内联编辑，**形态照 MA windows**）—— 手写
 *
 * 本文件位置：`web/src/features/indicators/DcapParamsPanel.tsx`
 * 权威口径：`design/14-dcap-indicator/02-spec.md` §7（配置面：Toolbar 内联面板，形态同 MA windows）
 *  - 8 个显示参数（n_s/n_m/n_l/r_s/r_m/r_l/smooth/m）；**`th` 不在此面板**（只属策略参数，在策略编辑器里）；
 *  - 值域/跨字段校验（`n_s < n_m < n_l`）在前端只作**即时提示**（体验层，不作强制手段）；
 *    真正的服务端强校验在 `PUT /api/config/dcap`（非单调/越界 → 400）。
 *  - 保存经父级 `onSave`（乐观更新由父级负责：先同步 setState 再 await 接口，失败回滚）。
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DCAP_M_MAX,
  DCAP_M_MIN,
  DCAP_N_MAX,
  DCAP_N_MIN,
  DCAP_R_MAX,
  DCAP_R_MIN,
  validateDcapParams,
  type DcapParams,
} from './dcapIndicator';

type DraftKey = keyof DcapParams;
type Draft = Record<DraftKey, string>;

/** 显示参数（按钮摘要用 n 三元组，与 MA 的 `MA(5,10,20)` 同形态）。 */
export interface DcapParamsPanelProps {
  params: DcapParams;
  onSave(params: DcapParams): Promise<void>;
}

const N_FIELDS: Array<{ key: DraftKey; label: string }> = [
  { key: 'n_s', label: 'DCAP 短窗口 n_s' },
  { key: 'n_m', label: 'DCAP 中窗口 n_m' },
  { key: 'n_l', label: 'DCAP 长窗口 n_l' },
];

const R_FIELDS: Array<{ key: DraftKey; label: string }> = [
  { key: 'r_s', label: 'DCAP 短窗增长比 r_s' },
  { key: 'r_m', label: 'DCAP 中窗增长比 r_m' },
  { key: 'r_l', label: 'DCAP 长窗增长比 r_l' },
];

const RE_INT = /^[+-]?\d+$/;
const RE_FLOAT = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

function toDraft(p: DcapParams): Draft {
  return {
    n_s: String(p.n_s),
    n_m: String(p.n_m),
    n_l: String(p.n_l),
    r_s: String(p.r_s),
    r_m: String(p.r_m),
    r_l: String(p.r_l),
    smooth: String(p.smooth),
    m: String(p.m),
  };
}

/** 草稿 → 参数（非整数/空串 → NaN，交由 validateDcapParams 拒绝）；非法返回错误文案。 */
export function parseDcapDraft(draft: Draft): { params: DcapParams } | { error: string } {
  const int = (s: string): number => (RE_INT.test(s.trim()) ? Number(s.trim()) : NaN);
  const flt = (s: string): number => (RE_FLOAT.test(s.trim()) ? Number(s.trim()) : NaN);
  const params: DcapParams = {
    n_s: int(draft.n_s),
    n_m: int(draft.n_m),
    n_l: int(draft.n_l),
    r_s: flt(draft.r_s),
    r_m: flt(draft.r_m),
    r_l: flt(draft.r_l),
    smooth: int(draft.smooth),
    m: int(draft.m),
  };
  const err = validateDcapParams(params);
  return err ? { error: err } : { params };
}

export function DcapParamsPanel({ params, onSave }: DcapParamsPanelProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(params));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 配置由外部（统一配置源）驱动而变时，未打开的状态下同步草稿（同 MaConfigControl）
  useEffect(() => {
    if (!open) setDraft(toDraft(params));
  }, [params, open]);

  const updateDraft = (key: DraftKey, raw: string) => {
    setDraft((d) => ({ ...d, [key]: raw }));
  };

  const handleSave = async () => {
    setError(null);
    const parsed = parseDcapDraft(draft);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed.params);
      setOpen(false);
    } catch {
      setError('保存失败（服务端拒绝或网络异常），参数未落库');
    } finally {
      setSaving(false);
    }
  };

  const numInput = (key: DraftKey, label: string) => (
    <input
      key={key}
      data-testid={`dcap-input-${key}`}
      aria-label={label}
      value={draft[key]}
      onChange={(e) => updateDraft(key, e.target.value)}
      inputMode="decimal"
      className="h-7 w-full min-w-0 rounded border border-line bg-panel2 px-1.5 text-xs num"
    />
  );

  return (
    <div className="relative">
      <Button
        aria-pressed={false}
        aria-expanded={open}
        variant="ghost"
        aria-label="DCAP 配置"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) setError(null);
        }}
      >
        DCAP({params.n_s},{params.n_m},{params.n_l})
        <span className="ml-1 text-dim">▾</span>
      </Button>
      {open && (
        <div
          data-dcap-editor
          role="group"
          aria-label="DCAP 参数"
          className="absolute left-0 top-full z-20 mt-1 flex w-80 flex-col items-start gap-2 rounded-lg border border-line bg-panel p-2.5 shadow-lg"
        >
          <div className="text-xs text-dim">
            窗口 n（{DCAP_N_MIN}-{DCAP_N_MAX}，须 n_s&lt;n_m&lt;n_l）
          </div>
          <div className="flex w-full items-center gap-1.5">
            {N_FIELDS.map((f) => numInput(f.key, f.label))}
          </div>
          <div className="text-xs text-dim">
            金额增长比 r（{DCAP_R_MIN}-{DCAP_R_MAX}，1=等额定投）
          </div>
          <div className="flex w-full items-center gap-1.5">
            {R_FIELDS.map((f) => numInput(f.key, f.label))}
          </div>
          <div className="flex w-full items-center gap-2">
            <span className="text-xs text-dim">平滑 SMA</span>
            <select
              data-testid="dcap-input-smooth"
              aria-label="DCAP 平滑开关 smooth"
              value={draft.smooth}
              onChange={(e) => updateDraft('smooth', e.target.value)}
              className="h-7 rounded border border-line bg-panel2 px-1.5 text-xs"
            >
              <option value="1">开</option>
              <option value="0">关</option>
            </select>
            <span className="text-xs text-dim">m（{DCAP_M_MIN}-{DCAP_M_MAX}）</span>
            {numInput('m', 'DCAP 平滑周期 m')}
          </div>
          {error && (
            <div role="alert" className="text-xs text-down">
              {error}
            </div>
          )}
          <div className="mt-1 flex gap-1.5">
            <Button variant="primary" size="sm" disabled={saving} onClick={handleSave}>
              {saving ? '保存中…' : '保存'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              取消
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
