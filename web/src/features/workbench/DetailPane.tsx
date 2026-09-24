import type { ReactNode } from 'react';

/**
 * ADR-028 §2.9（**D9｜明细视图**）—— 下栏容器 + `wb-detail-tabs`。
 *
 * 结构契约（D9-1/D9-3/D9-4）：
 *  - 明细视图 = **独立滚动容器**（`overflow:auto`；K 线不滚、指标与明细各自滚、整页不滚）；
 *  - 四个 tab：**回合与逐笔**（默认）/ 8 项绩效 / 逐 bar 明细 / 事件日志（D9-1 不拆）；
 *  - **收起入口统一到视图级**（D9-3）：收起的**状态与恢复条**由 `ResultView` 持有/渲染，
 *    本组件只把 tab 条上的按钮接给调用方（`data-collapse-view="detail"` 标记「视图级」语义），
 *    **tab 语义与懒挂载不变**（数据契约仍由 `ResultView` 以 `content` 注入）。
 */
export type DetailTabKey = 'trades' | 'metrics' | 'perbar' | 'events';

export const DETAIL_TABS: ReadonlyArray<{ key: DetailTabKey; label: string }> = [
  { key: 'trades', label: '回合与逐笔' },
  { key: 'metrics', label: '8项绩效' },
  { key: 'perbar', label: '逐 bar 明细' },
  { key: 'events', label: '事件日志' },
];

export function DetailPane({
  tab,
  onTabChange,
  heightPx,
  content,
  onCollapse,
}: {
  tab: DetailTabKey;
  onTabChange(key: DetailTabKey): void;
  /** 明细视图高度（未布局/jsdom 下可为 0 ⇒ 用 flex 自适应）。 */
  heightPx: number;
  content: Record<DetailTabKey, ReactNode>;
  /** 视图级收起（恢复条由 `ResultView` 渲染）。 */
  onCollapse(): void;
}) {
  return (
    <div
      data-testid="wb-detail-pane"
      data-detail-pane-height={Math.round(heightPx)}
      data-view-collapse-entry="detail"
      style={heightPx > 0 ? { height: `${Math.round(heightPx)}px` } : undefined}
      className="flex h-full min-h-0 shrink-0 flex-col overflow-auto rounded-lg border border-line bg-panel2"
    >
      <div
        data-testid="wb-detail-tabs"
        role="tablist"
        aria-label="明细分段控件"
        // 明细自身滚动 ⇒ tab 条必须 sticky，切 tab 前后位置稳定
        className="sticky top-0 z-10 flex shrink-0 items-center gap-1 border-b border-line bg-panel2 px-2 pt-1"
      >
        {DETAIL_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            tabIndex={tab === t.key ? 0 : -1}
            className={`rounded-t px-3 py-1 text-xs ${tab === t.key ? 'bg-panel text-txt' : 'text-dim hover:text-txt'}`}
            onClick={() => onTabChange(t.key)}
            data-testid={`wb-tab-${t.key}`}
          >
            {t.label}
          </button>
        ))}
        <span className="flex-1" />
        {/* 明细**视图**的收起入口（D9-3）；恢复条由 ResultView 渲染（`wb-restore-detail`） */}
        <button
          type="button"
          onClick={onCollapse}
          data-testid="wb-detail-collapse"
          data-collapse-view="detail"
          aria-label="收起明细视图（其余视图按原比例分享其空间）"
          title="收起明细视图"
          className="rounded border border-line px-2 py-0.5 text-[10px] text-dim hover:text-txt"
        >
          明细 收起 ▾
        </button>
      </div>
      <div className="p-2">{content[tab]}</div>
    </div>
  );
}
