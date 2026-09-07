// ~/~ begin <<design/06-web/10-simlive.md#web/src/layouts/SimLiveGrid.tsx>>[init]
// 由 design/06-web/10-simlive.md L3 代码块 tangle 生成，禁止手改
// 骨架职责：Props 契约 + 区域→组件映射 + 数据源/三态内联注释 + Tab；视觉样式与数据获取实现在组件内手写

export type SimLiveTab = 'current' | 'history';

/** 会话账户读模型（后端线格式 snake_case 直通；camel 由前端展示层映射）。 */
export interface SimLiveStateDto {
  active: boolean;
  session: {
    id: string; name: string; status: 'running' | 'ended'; source: string;
    cash_init: number; strategy_set: string[]; stock_set: string[]; period: string;
  } | null;
  account: { session_id: string; cash: number; equity: number; market_value: number;
    realized_pnl: number; unrealized_pnl: number; total_fee: number } | null;
  positions: Array<{ code: string; qty: number; avg_cost: number; latest: number;
    market_value: number; unrealized_pnl: number }>;
  pnl: { realized_pnl: number; unrealized_pnl: number; total_fee: number; net_profit: number } | null;
  trading_enabled: boolean;
  mcp_enabled: boolean;
}

/** 策略评估（`/api/sim-live/strategies`）。 */
export interface SimLiveStrategiesDto {
  session_id: string;
  strategies: Array<{ strategy_id: string; name: string;
    strongest: { code: string; score: number; signal: string } | null }>;
  stocks: Array<{ code: string; ts: number; latest_price: number;
    per_strategy_scores: Array<{ strategy_id: string; score: number; signal: string }>;
    aggregate_score: number; signal: string }>;
}

/** 页面 Props 契约。 */
export interface SimLiveGridProps {
  activeTab: SimLiveTab;
  onTabChange(tab: SimLiveTab): void;                      // Tab 切换（当前会话/历史回顾，历史不影响当前会话）
  state: SimLiveStateDto;                                  // GET /api/sim-live/state（session-control/position-table）
  strategies: SimLiveStrategiesDto | null;                 // GET /api/sim-live/strategies（strategy-panel/stock-scoring）
  orders: Array<{ id: string; code: string; side: string; qty: number; status: string;
    limit_price: number | null; filled_price: number | null; ts: number; source: string }>; // GET /api/sim-live/orders（order-trade-list）
  sessions: Array<{ session: unknown; metrics: unknown }>; // GET /api/sim-live/sessions（session-history）
  loading: boolean;                                        // 任一区域拉取中
  error: string | null;                                    // 拉取错误（sticky 顶部错误条 + 各 region 错误占位）
  onRetry(): void;                                         // 错误重试（重新拉取 state/strategies）
  onStartSession(params: { name: string; period: string; cash_init?: number }): void; // POST /api/sim-live/start-session
  onStopSession(id?: string): void;                        // POST /api/sim-live/stop-session
  onToggleTrading(enabled: boolean): void;                 // POST /api/sim-live/trading{enabled}
  onToggleMcp(enabled: boolean): void;                     // POST /api/sim-live/mcp-toggle{enabled}
  onPlaceOrder(params: { code: string; side: string; qty: number; price: number; limit_price?: number }): void; // POST place-order
  onCancelOrder(orderId: string): void;                    // POST /api/sim-live/cancel-order
  onBacktestCompare(sessionId: string): void;              // POST /api/sim-live/sessions/{id}/backtest-compare
  onSelectSession(sessionId: string): void;                // 会话回看（GET /api/sim-live/sessions/{id}）
}

export function SimLiveGrid(props: SimLiveGridProps) {
  return (
    <div data-region="sim-live" className="flex min-w-[1280px] flex-1 flex-col">

      {/* Tab 切换（当前会话 / 历史回顾；历史不影响当前会话） */}
      <div className="flex gap-1 border-b px-3 py-2">
        <button
          type="button"
          data-tab="current"
          className={props.activeTab === 'current' ? 'tab-on' : ''}
          onClick={() => props.onTabChange('current')}
        >当前会话</button>
        <button
          type="button"
          data-tab="history"
          className={props.activeTab === 'history' ? 'tab-on' : ''}
          onClick={() => props.onTabChange('history')}
        >历史回顾</button>
      </div>

      {props.activeTab === 'current' && (
        <div className="flex flex-1 flex-col">

          {/* session-control：GET /api/sim-live/state；会话状态+账户+统一交易开关+MCP 状态/停用按钮+停止会话；
              三态=骨架数值/未运行（active=false）/错误占位+重试 */}
          <section data-region="session-control" className="border-b px-4 py-3">
            {/* <SessionControl/>（状态 pill / 总资产/可用/已实现/未实现 / 统一开关 / MCP 开关） */}
          </section>

          {/* position-table：state.positions；三态=骨架行/「无持仓」/错误占位+重试 */}
          <section data-region="position-table" className="border-b px-4">
            {/* <PositionTable positions/>（现价=本系统行情，数量/成本=模拟账户） */}
          </section>

          {/* strategy-panel：GET /api/sim-live/strategies.strategies（3 策略独立评估）；
              三态=骨架卡/「未启动会话」/错误占位+重试 */}
          <section data-region="strategy-panel" className="border-b px-4 py-3">
            {/* <StrategyPanel strategies/>（每策略当前最强标的/分） */}
          </section>

          {/* stock-scoring：strategies.stocks（每 stock 聚合+各策略独立分+信号）；
              三态=骨架行/「未评估」/错误占位+重试 */}
          <section data-region="stock-scoring" className="border-b px-4">
            {/* <StockScoringTable stocks/>（聚合分决策+独立分展示） */}
          </section>

          {/* order-trade-list：GET /api/sim-live/orders + state.trades；三态=骨架行/「无委托」/错误占位+重试 */}
          <section data-region="order-trade-list" className="px-4">
            {/* <OrderTradeList onCancelOrder/>（source: strategy|manual） */}
          </section>
        </div>
      )}

      {props.activeTab === 'history' && (
        /* session-history：GET /api/sim-live/sessions + 详情 + 「回测一下」对比；
           三态=骨架行/「无历史会话」/错误占位+重试；独立 Tab，不影响当前会话 */
        <div data-region="session-history" className="flex-1 px-4 py-3">
          {/* <SessionHistory onSelectSession onBacktestCompare/> */}
        </div>
      )}
    </div>
  );
}
// ~/~ end
