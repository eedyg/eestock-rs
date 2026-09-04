import type { QualityGapsResponse, SymbolSnapshot } from '@/api/types';
import { GapReportList } from '@/features/quality/GapReportList';
import type { AsyncSlice } from './store';

/**
 * 采集质量区（02-sources §6 单标的摘要口径，方案 A 裁决 2026-09-04）：
 * 页②缺口区降级为「单标的缺口摘要」——标的级全量缺口归页面④（04-quality §5），
 * 本页只作该标的信息参考。数据源 GET /api/quality/gaps?code=&from=&to=（00-web-api §1.1）。
 * 三态=骨架行/「该范围无缺口」/错误占位+重试（复用页面④ GapReportList 形态，DRY）。
 */
export function GapCards({
  symbols,
  selectedCode,
  slice,
  onSelectCode,
  onRetry,
}: {
  symbols: SymbolSnapshot[];
  selectedCode: string | null;
  slice: AsyncSlice<QualityGapsResponse>;
  onSelectCode: (code: string) => void;
  onRetry: () => void;
}) {
  return (
    <div className="w-full p-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] text-dim">缺口摘要 · 标的</span>
        <select
          value={selectedCode ?? ''}
          onChange={(e) => onSelectCode(e.target.value)}
          disabled={symbols.length === 0}
          className="rounded-lg border border-line bg-panel2 px-2 py-0.5 text-xs text-txt disabled:opacity-40"
          data-testid="gap-symbol-select"
          aria-label="缺口摘要标的选择"
        >
          {symbols.map((s) => (
            <option key={s.code} value={s.code}>
              {s.code} {s.name}
            </option>
          ))}
        </select>
      </div>
      <GapReportList slice={slice} onRetry={onRetry} />
    </div>
  );
}
