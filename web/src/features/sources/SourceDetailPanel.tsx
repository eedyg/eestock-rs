import type { DetailState } from './store';

/**
 * 详情区（D1 降级）：后端 metrics/events/divergence/rate-limits 端点为 Wave 2+ 上线
 * （ADR-014：Phase A 不建后端），前端不再发这 4 条请求，仅渲染占位提示。
 * 保留：源卡健康显示、手动复位按钮、缺口摘要、告警预览（SourcesPage 组件）；
 * 移除 4 个「加载失败/404」错误态。
 */
export function SourceDetailPanel({ detail }: { detail: DetailState }) {
  if (!detail.detailUnavailable) {
    // 理论上不可达（后端端点落地前恒为 unavailable）；防御式占位
    return <div className="flex h-full items-center justify-center text-xs text-dim">暂无详情数据</div>;
  }
  return (
    <div className="flex h-full items-center justify-center px-4 text-center">
      <p className="max-w-md text-xs leading-relaxed text-dim">
        详情数据将在后续版本提供（后端端点 Wave 2+ 上线）
      </p>
    </div>
  );
}
