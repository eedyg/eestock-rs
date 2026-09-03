// ~/~ begin <<design/06-web/05-backtest.md#web/src/layouts/BacktestGrid.tsx>>[init]
// 由 design/06-web/05-backtest.md L3 代码块 tangle 生成，禁止手改
// 骨架职责：Props 契约 + 区域→组件映射 + 数据源/三态内联注释 + 定稿默认值；视觉样式与数据获取实现在组件内手写

/** 已定稿默认值（定稿 P5，勿改常量改文档） */
export const BACKTEST_DEFAULTS = {
  builtinStrategyCount: 7,        // Wave 3 首批 7 个内置经典策略（编译期注册，非页面配置）
  periods: ['1m', '5m', '15m', '1d'],  // 回测周期可选集（数据=merge 视图，准确层优先 ADR-003）
  compareMin: 2,                  // 对比至少 2 次
  heatmapGranularity: 'month',    // 周期分析默认按月：'month' | 'week'
  // ⚠️ 手续费/滑点默认值「与旧系统口径一致」（定稿 §5）但具体数值本文档未给出 —— 见「待裁决」，勿自行编常量
} as const;

export type BacktestPeriod = '1m' | '5m' | '15m' | '1d';
export type ResultView = 'single' | 'compare' | 'grid-rank';

/** 页面 Props 契约 */
export interface BacktestGridProps {
  resultView: ResultView;
  selectedRunId: string | null;              // 当前载入结果区的任务
  compareIds: string[];                      // task-list 勾选的 2-N 次
  onSelectRun(id: string): void;             // 点已完成任务载入结果
  onToggleCompare(id: string): void;         // 勾选进 compare-view
  onSubmit(params: BacktestSubmitParams): void;   // POST /api/backtest/runs（含网格展开）
  onJumpToKline(code: string, from: string, to: string): void;  // trade-table 点行跳 K 线对应区间
}

/** 提交参数（策略 schema 由 GET /api/backtest/strategies 驱动渲染） */
export interface BacktestSubmitParams {
  strategyId: string;
  params: Record<string, number | string>;   // 数值参数支持「起:止:步长」→ 网格任务组
  code: string;
  period: BacktestPeriod;
  fee: { ratePct: number; minFee: number; slippageBp: number };
}

export function BacktestGrid(props: BacktestGridProps) {
  return (
    <div data-region="backtest" className="flex min-w-[1280px] flex-1">

      {/* strategy-form：GET /api/backtest/strategies + POST /api/backtest/runs；
          三态=骨架表单/不可能空（7 款编译期注册）/错误占位+重试；提交错误内联 */}
      <aside data-region="strategy-form" className="w-80 border-r p-4">
        {/* <StrategySelect/> <ParamForm schema驱动/> <FeeSlippageFields/> <GridExpandField/> <SubmitButton/> */}
      </aside>

      <main className="flex flex-1 flex-col">

        {/* task-list：GET /api/backtest/runs + WS 进度推送；异步任务制多任务并行；
            三态=骨架行/「暂无回测任务，从左侧提交」/错误条+重试 */}
        <div data-region="task-list" className="h-36 border-b">
          {/* <BacktestTaskList onSelectRun onToggleCompare/>（状态/进度%/当前回测日期） */}
        </div>

        {props.resultView === 'compare' ? (
          /* compare-view：GET /api/backtest/compare?ids=；≥2 次已完成；
              三态=骨架图/「至少勾选 2 次已完成回测」/错误占位+重试 */
          <div data-region="compare-view" className="flex-1">
            {/* <CompareEquityChart/> + <CompareMetricTable/> */}
          </div>
        ) : (
          <>
            {/* result-overview：GET /api/backtest/runs/{id}；净值+回撤双图联动回撤着色；
                三态=骨架图/「选择已完成任务查看结果」/错误占位+重试 */}
            <div data-region="result-overview" className="h-2/5 border-b">
              {/* <EquityDrawdownChart/>（TradingView Overview 式） */}
            </div>
            {/* metric-cards：同 runs/{id} 指标（口径 design/08-backtest 单测锁定）；
                三态=骨架卡/随 result-overview/错误占位+重试；只读 */}
            <div data-region="metric-cards" className="flex h-22 gap-2 border-b p-2">
              {/* <MetricCard/> ×8：NetProfit/MaxDD/Sharpe/胜率/盈亏比/年化/总交易数/平均持仓 */}
            </div>
            {props.resultView === 'grid-rank' ? (
              /* grid-rank：GET /api/backtest/runs（网格任务组）；按总收益/夏普排序；
                  三态=骨架行/「无网格任务组」/错误条+重试；点行进单次详情 */
              <div data-region="grid-rank" className="flex-1">
                {/* <GridRankTable/> */}
              </div>
            ) : (
              <>
                {/* trade-table：同 runs/{id} 交易序列；排序筛选；
                    三态=骨架行/「本次回测无交易」/错误占位+重试；点行→onJumpToKline */}
                <div data-region="trade-table" className="flex-1">
                  {/* <TradeTable onJumpToKline/>（Trades analysis 式） */}
                </div>
                {/* period-heatmap：runs/{id} 净值客户端聚合；月/周切换；
                    三态=随 result-overview/「数据不足一月」/随 result-overview */}
                <div data-region="period-heatmap" className="h-44 border-t">
                  {/* <PeriodHeatmap granularity/>（Freqtrade UI 式） */}
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
// ~/~ end
