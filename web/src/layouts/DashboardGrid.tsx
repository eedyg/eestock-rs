// ~/~ begin <<design/06-web/01-dashboard.md#web/src/layouts/DashboardGrid.tsx>>[init]
// 由 design/06-web/01-dashboard.md L3 代码块 tangle 生成，禁止手改
// 骨架职责：Props 契约 + 区域→组件映射 + 数据源/三态内联注释 + 定稿默认值；视觉样式与数据获取实现在组件内手写

/** 已定稿默认值（定稿 1b/1c/1d，勿改常量改文档） */
export const DASHBOARD_DEFAULTS = {
  period: '15m',                    // 周期：1m/5m/15m/1h/1d，默认 15m
  indicators: { ma: true, macd: false, kdj: false, boll: false },
  maWindows: [5, 10, 20],
  view: 'single',                   // 'single' | 'grid2x2' | 'grid2x3'
  chartTab: 'kline',                // 'kline' | '分时'(timeshare，1m bar 客户端计算)
  initialRange: 'today+prevTradingDay',
} as const;

export type Period = '1m' | '5m' | '15m' | '1h' | '1d';
export type GridMode = 'single' | 'grid2x2' | 'grid2x3';

/** 标快照（GET /api/symbols 含 latest 字段 + WS {type:"quote"} 增量）
 *  D2：enabled=false 渲染「已停用」；last=null（启用但尚未采到数据）渲染「无数据」，不伪造 0.000。 */
export interface SymbolSnapshot {
  code: string;
  name: string;
  enabled: boolean;
  last: number | null; // 无最新数据（latest=null）→ null；有数据为最新价
  changePct: number;
}

/** 页面 Props 契约 */
export interface DashboardGridProps {
  symbols: SymbolSnapshot[];
  selected: string;
  onSelectSymbol(code: string): void;
  period: Period;                   onPeriodChange(p: Period): void;
  gridMode: GridMode;               onGridModeChange(m: GridMode): void;
  followLatest: boolean;            onBackToLatest(): void;   // 手动缩放后 false，「回到最新」置 true
  onLoadBefore(ts: string): void;   // 向前翻页：GET /api/kline?before=<ts>&limit=
}

export function DashboardGrid(props: DashboardGridProps) {
  return (
    <div data-region="dashboard" className="flex min-w-[1280px] flex-1">

      {/* symbol-list：GET /api/symbols + WS quote；三态=骨架行/「去标的管理」引导链/错误条+重试 */}
      <aside data-region="symbol-list" className="w-60 border-r">
        {/* <SymbolSearchBox/> H=32 模糊过滤 code/名称 */}
        {/* <SymbolList symbols selected onSelect/> */}
      </aside>

      <main data-region="main-area" className="flex min-h-0 flex-1 flex-col">

        {/* toolbar：静态控件无三态；周期/Tab/指标勾选/宫格/回到最新 */}
        <div data-region="toolbar" className="h-9 shrink-0 border-b">
          {/* <PeriodSwitch/> <ChartTab/> <IndicatorToggles/> <GridSwitch/> <BackToLatest/> */}
        </div>

        {props.gridMode === 'single' ? (
          <>
            {/* main-chart：GET /api/kline（merge 视图，1m 读 raw、高周期读 cagg）+ WS {type:"bar"}；
                三态=骨架图/「该时段无数据」占位/错误占位+重试；手动缩放后不强拉。
                klinecharts 单实例（candle + VOL 副图分 pane）容器取 h-full 填满本区域，
                故本区域用 relative min-h-0 flex-1 承接整段图表区（含底部副图），
                sub-chart 作为 region 锚点以绝对定位占位（region 契约不变，见 §1 L1/L2）。 */}
            <div data-region="main-chart" className="relative min-h-0 flex-1">
              {/* <KlineChart/> 或 <TimeshareChart/>（chartTab 切换；经 RegionPortal 挂入本锚点） */}
              {/* sub-chart：成交量副图（klinecharts volume pane 经主图容器 h-full 在底部呈现），
                  随主图数据/三态，无独立交互；绝对定位仅作锚点占位，不占主图布局 */}
              <div data-region="sub-chart" className="pointer-events-none absolute inset-x-0 bottom-0 h-1/5 border-t">
                {/* <VolumeChart/> */}
              </div>
            </div>
          </>
        ) : (
          /* grid-view：2×2/2×3，每格独立订阅独立三态；点格→onSelectSymbol+回单图
             R1：显式 grid-rows（均分网格高度），避免 auto 行按内容分高导致 chart 容器 flex-1
             在 auto 行下解析为 0 高（末行坍缩）；grid-view 自身 min-h-0，保证作为 flex 子项
             可收缩到可用高度（否则 min-height:auto 会按内容 3×322px 撑高，2×3 纵向溢出 1042>720） */
          <div
            data-region="grid-view"
            className={`grid min-h-0 flex-1 grid-cols-2 ${props.gridMode === 'grid2x3' ? 'grid-rows-3' : 'grid-rows-2'}`}
          >
            {/* <GridCell/> ×4 或 ×6（grid2x3 时 grid-rows-3） */}
          </div>
        )}
      </main>
    </div>
  );
}
// ~/~ end
