// ~/~ begin <<design/06-web/02-sources.md#web/src/layouts/SourcesGrid.tsx>>[init]
// 由 design/06-web/02-sources.md L3 代码块 tangle 生成，禁止手改
// 骨架职责：Props 契约 + 区域→组件映射 + 数据源/三态内联注释 + 定稿默认值；视觉样式与数据获取实现在组件内手写

/** 已定稿默认值（定稿 P2，勿改常量改文档） */
export const SOURCES_DEFAULTS = {
  successRateWindow: '1h',        // 卡片成功率统计窗口：近 1h
  detailRange: '1h',              // 详情曲线默认范围：'1h' | 'today' | '3d'
  eventLimit: 50,                 // 事件流水条数
  alertPreviewLimit: 10,          // 告警预览条数（只读）
  gapRangeDays: 7,                // 缺口摘要窗口：近 7 个自然日（单标的，方案 A）
  divergenceThresholdPct: 0.5,    // 与腾讯锚分歧 >0.5% 记 DIVERGE
} as const;

export type DetailRange = '1h' | 'today' | '3d';

/** 页面 Props 契约 */
export interface SourcesGridProps {
  selectedSource: string | null;                 // 当前展开详情的源 id，null=折叠
  onSelectSource(id: string | null): void;       // 点卡展开/折叠 detail-panel
  detailRange: DetailRange;
  onDetailRangeChange(r: DetailRange): void;     // 详情曲线范围切换
  onResetCircuit(id: string): void;              // 熔断源手动复位：POST /api/sources/{id}/reset
}

export function SourcesGrid(props: SourcesGridProps) {
  return (
    <div data-region="sources" className="flex min-w-[1280px] flex-1 flex-col">

      {/* summary-bar：GET /api/sources/health + WS source_health；交易时段客户端计算；
          三态=骨架条/不可能空（服务在线即有计数）/错误条+重试；只读 */}
      <div data-region="summary-bar" className="h-14 border-b">
        {/* <SourcesSummaryBar/> */}
      </div>

      {/* source-cards：同 summary-bar 数据源；每源一卡，熔断卡附 <CircuitResetButton onResetCircuit/>；
          WS 状态变化卡片闪烁+迁移动画；三态=骨架卡/「无数据源配置」占位/错误占位+重试 */}
      <div data-region="source-cards" className="flex flex-wrap gap-2 border-b p-2">
        {/* <SourceCard/> ×N（选中卡高亮描边） */}
      </div>

      {props.selectedSource && (
        /* detail-panel：GET /api/sources/{id}/metrics?range= + events?limit=50 + divergence?range=；
            三态=骨架图+骨架行/「该范围无事件」占位/错误占位+重试 */
        <div data-region="detail-panel" className="flex h-80 border-b">
          {/* <MetricsChart range/>（flex-1） <DivergenceRow/> <RateLimitCounters/> */}
          {/* <EventStream limit=50/> W=40%（Trace ID 点击可复制） */}
        </div>
      )}

      {/* gap-cards（单标的缺口摘要）：GET /api/quality/gaps?code=&from=&to=（单 code，方案 A 裁决）；
          标的选择器复用 symbols 列表默认首个；三态=骨架行/「该范围无缺口」/错误占位+重试；只读 */}
      <div data-region="gap-cards" className="border-b p-2">
        {/* <GapCards symbols selectedCode slice onSelectCode onRetry/>（复用页面④ GapReportList 形态） */}
      </div>

      {/* alert-preview：GET /api/alerts?limit=10（复用页面⑦接口）只读；
          三态=骨架行/「暂无告警」/错误占位+重试 */}
      <div data-region="alert-preview" className="h-40">
        {/* <AlertPreviewList/> */}
      </div>
    </div>
  );
}
// ~/~ end
