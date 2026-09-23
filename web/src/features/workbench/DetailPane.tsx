import type { ReactNode } from 'react';

/**
 * ADR-028 §2.7（**D7｜明细独立视图**）—— 下栏容器 + `wb-detail-tabs`。
 *
 * 结构契约：
 *  - 下栏 = **独立滚动容器**（`overflow:auto`；D7-1），tab 条 `sticky top-0` 常驻可点；
 *  - 四个 tab：**回合与逐笔**（L1 回合表 + L2 逐笔，默认选中）/ 8 项绩效 / 逐 bar 明细 / 事件日志
 *    （ADR §2.7 第 2 项「①②③④ 全搬」；「8 项绩效」为既有内容，**保留**⇒ 禁静默有损，经 2026-09-23 裁决）；
 *  - **数据契约不变**：本组件只做容器与分段控件，`RoundTripsTable` / `PerBarTable` / `EventLog` 的数据源与
 *    分页语义由 `ResultView` 以 `content` 注入（本组件不感知 `useRunSeries` 状态形状）；
 *  - 折叠入口 `wb-detail-collapse`（键盘可达按钮）常驻；折叠态的恢复入口 `wb-detail-expand` 由调用方渲染。
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
  /** 下栏高度（未布局/jsdom 下可为 0 ⇒ 用 flex 自适应）。 */
  heightPx: number;
  content: Record<DetailTabKey, ReactNode>;
  onCollapse(): void;
}) {
  return (
    <div
      data-testid="wb-detail-pane"
      data-detail-pane-height={Math.round(heightPx)}
      style={heightPx > 0 ? { height: `${Math.round(heightPx)}px` } : undefined}
      className="flex min-h-0 shrink-0 flex-col overflow-auto rounded-lg border border-line bg-panel2"
    >
      <div
        data-testid="wb-detail-tabs"
        role="tablist"
        aria-label="明细分段控件"
        // 下栏自身滚动 ⇒ tab 条必须 sticky，切 tab 前后位置稳定
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
        <button
          type="button"
          onClick={onCollapse}
          data-testid="wb-detail-collapse"
          aria-label="收起明细面板（上栏占满）"
          title="收起明细面板"
          className="rounded border border-line px-2 py-0.5 text-[10px] text-dim hover:text-txt"
        >
          收起 ▼
        </button>
      </div>
      <div className="p-2">{content[tab]}</div>
    </div>
  );
}
