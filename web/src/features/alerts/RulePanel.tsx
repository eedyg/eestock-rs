import { useState } from 'react';
import type { AlertRuleItem, AlertRulePatchBody } from '@/api/types';
import type { AsyncSlice } from './store';
import { LEVEL_DOT } from './levelMeta';

/**
 * rule-panel W=360（07-alerts L2）：内置规则仅阈值/开关/静默时长可调（热生效）；
 * 交易类规则 Wave 4 预留置灰；三态=骨架卡/不可能空（内置预置）/错误占位+重试。
 */
export function RulePanel({
  rules,
  onUpdateRule,
  onRetry,
}: {
  rules: AsyncSlice<AlertRuleItem[]>;
  onUpdateRule: (id: string, patch: AlertRulePatchBody) => void;
  onRetry: () => void;
}) {
  if (rules.error) {
    return (
      <div className="p-3 text-xs text-up">
        <span>规则加载失败：{rules.error}</span>{' '}
        <button type="button" onClick={onRetry} className="underline">
          重试
        </button>
      </div>
    );
  }
  if (rules.loading || rules.data === null) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-panel2" />
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {rules.data.map((r) => (
        <RuleCard key={r.id} rule={r} onUpdateRule={onUpdateRule} />
      ))}
      {/* 交易类规则 Wave 4 预留（置灰不可调，07-alerts §2） */}
      <div className="rounded-lg border border-line bg-panel2 px-3 py-2.5 text-xs text-dim opacity-50">
        <b className="text-txt">委托异常/废单</b>
        <span className="ml-2 rounded-full border border-[#fbbf24]/35 bg-[#fbbf24]/12 px-2 py-0.5 text-[11px] text-[#fbbf24]">
          warning
        </span>
        <br />
        Wave 4 预留（交易类规则暂不可用）
      </div>
    </div>
  );
}

function RuleCard({
  rule,
  onUpdateRule,
}: {
  rule: AlertRuleItem;
  onUpdateRule: (id: string, patch: AlertRulePatchBody) => void;
}) {
  return (
    <div className={`rounded-lg border border-line bg-panel2 px-3 py-2.5 text-xs text-dim ${rule.enabled ? '' : 'opacity-60'}`}>
      <div className="flex items-center justify-between">
        <span>
          <b className="text-txt">{rule.name}</b>{' '}
          <span className={LEVEL_DOT[rule.level]}>●</span>
          <span className="ml-1 text-[11px]">{rule.level}</span>
        </span>
        <button
          type="button"
          aria-label={`${rule.name}开关`}
          aria-pressed={rule.enabled}
          onClick={() => onUpdateRule(rule.id, { enabled: !rule.enabled })}
          className={`relative h-4 w-8 rounded-full border ${
            rule.enabled ? 'border-down/50 bg-down/25' : 'border-line bg-white/5'
          }`}
        >
          <span
            className={`absolute top-[2px] h-2.5 w-2.5 rounded-full ${
              rule.enabled ? 'right-[2px] bg-down' : 'left-[2px] bg-dim'
            }`}
          />
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <NumberField
          label={`${rule.name}阈值`}
          value={rule.threshold}
          disabled={!rule.enabled}
          onCommit={(v) => onUpdateRule(rule.id, { threshold: v })}
        />
        <NumberField
          label={`${rule.name}静默时长`}
          value={rule.silence_minutes}
          min={1}
          disabled={!rule.enabled}
          onCommit={(v) => onUpdateRule(rule.id, { silence_minutes: v })}
        />
      </div>
    </div>
  );
}

/** 数值编辑：失焦提交（变更才 PATCH），Enter 提交 / Esc 还原 */
function NumberField({
  label,
  value,
  min,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const shown = editing ? text : String(value);
  const commit = () => {
    setEditing(false);
    const v = Number(text);
    if (!Number.isFinite(v) || (min !== undefined && v < min) || v === value) {
      setText(String(value));
      return;
    }
    onCommit(v);
  };
  return (
    <label className="flex items-center gap-1">
      <span className="text-[11px]">{label.includes('阈值') ? '阈值' : '静默(分)'}</span>
      <input
        aria-label={label}
        className="num w-16 rounded border border-line bg-panel px-1.5 py-0.5 text-xs text-txt outline-none disabled:opacity-40"
        value={shown}
        disabled={disabled}
        onFocus={() => {
          setText(String(value));
          setEditing(true);
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(String(value));
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}
