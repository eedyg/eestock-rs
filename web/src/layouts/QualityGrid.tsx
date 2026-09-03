// ~/~ begin <<design/06-web/04-quality.md#web/src/layouts/QualityGrid.tsx>>[init]
// 由 design/06-web/04-quality.md L3 代码块 tangle 生成，禁止手改
// 骨架职责：Props 契约 + 区域→组件映射 + 数据源/三态内联注释 + 定稿默认值；视觉样式与数据获取实现在组件内手写

/** 已定稿默认值（定稿 P4，勿改常量改文档） */
export const QUALITY_DEFAULTS = {
  view: 'table',                  // 默认主视图：'table'(分歧表) | 'overlay'(叠加图)
  sort: 'deviation-desc',         // 分歧表默认按偏差降序
  consistencyThresholdPct: 0.5,   // 一致率口径：偏差 ≤0.5% 计一致
  readOnly: true,                 // 页面纪律：纯只读+同步触发，无修改数据入口（ADR-003）
} as const;

export type QualityView = 'table' | 'overlay';

/** 页面 Props 契约 */
export interface QualityGridProps {
  code: string | null;                       // 标的筛选
  range: { from: string; to: string };       // 日期范围
  view: QualityView;
  onFilterChange(code: string | null, range: { from: string; to: string }): void;  // 变更即重查
  onViewChange(v: QualityView): void;
  onJumpToKline(code: string, ts: string): void;  // 分歧表点行→行情看板对应标的对应时刻
  onTriggerSync(codes: string[], from: string, to: string): void;  // POST /api/tushare/sync（异步）
  syncRunning: boolean;                      // 同步中禁用触发按钮
}

export function QualityGrid(props: QualityGridProps) {
  return (
    <div data-region="quality" className="flex min-w-[1280px] flex-1 flex-col">

      {/* filter-bar：静态控件无三态；标的+日期范围+视图切换，变更即重查 */}
      <div data-region="filter-bar" className="flex h-12 items-center gap-2 border-b px-4">
        {/* <SymbolFilter/> <DateRangeFilter/> <ViewSwitch/> */}
      </div>

      {/* 主视图：分歧表（默认）或叠加图，二选一 */}
      {props.view === 'table' ? (
        /* divergence-table：GET /api/quality/divergence?code=&from=&to=；默认偏差降序+汇总行；
            三态=骨架行/「该范围无比对数据」+补拉引导/错误条+重试 */
        <div data-region="divergence-table" className="flex-1">
          {/* <DivergenceTable onJumpToKline/> + <SummaryRow/> */}
        </div>
      ) : (
        /* overlay-chart：同 divergence 数据客户端渲染；三态随分歧表；缩放 */
        <div data-region="overlay-chart" className="flex-1">
          {/* <OverlayChart/>（raw vs accurate 收盘双线） */}
        </div>
      )}

      {/* accuracy-cards：GET /api/quality/source-accuracy?from=&to=；
          三态=骨架卡/「该窗口无比对样本」/错误占位+重试；只读 */}
      <div data-region="accuracy-cards" className="flex h-28 gap-2 border-b p-2">
        {/* <SourceAccuracyCard/> ×源数（TencentIfzq/SinaJsonp） */}
      </div>

      <div className="flex">
        {/* sync-panel：GET /api/tushare/status + POST /api/tushare/sync；剩余积分醒目；
            三态=骨架区/「从未同步」/错误占位+重试；同步中按钮禁用 */}
        <div data-region="sync-panel" className="w-1/2 border-r p-3">
          {/* <TushareStatus/> + <SyncTriggerForm onTriggerSync syncRunning/> */}
        </div>
        {/* gap-report：GET /api/quality/gaps?code=&from=&to=；
            三态=骨架行/「该范围无缺口」/错误占位+重试；只读 */}
        <div data-region="gap-report" className="w-1/2 p-3">
          {/* <GapReportList/>（缺口日期+分钟段+缺 bar 数） */}
        </div>
      </div>
    </div>
  );
}
// ~/~ end
