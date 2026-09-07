# 06-web / 10 — 模拟实盘（sim-live）页面（11-sim-live / L3b）

> 2026-09-07 定稿。本文档是 sim-live 页面布局/区域/视觉契约（tangle 事实源），
> 与 design/11-sim-live/01-adr.md §7（双通道 web）一致；data-region 锚点与 RegionPortal
> 骨架组合模式（09-frontend.md §3）复用。实现组件在 `web/src/features/simlive/` 手写。

## 1. 定位与范围

- **页面 ⑨ 模拟实盘**：`web/src/features/simlive/SimLivePage.tsx` + 路由 `/sim-live` + 左侧导航「⑨ 模拟实盘」。
- **数据**：全部来自 `/api/sim-live/*`（§1.6 后端 REST），与 MCP `sim_*` 工具共享同一 `SimLiveService` 实例（一致性）。
- **只读/纸面**：模拟实盘，**永不触真实券商**。
- **风格**：深色终端风（同 01-dashboard 基线 CSS 变量）；三态（骨架/空态/错误+重试）。

## 2. 区域布局（Tab：当前会话 / 历史回顾）

Tab 切换互不影响；**历史回顾独立于当前运行会话**。

### Tab1 当前会话
| region | 内容 | 数据源 | 三态 |
|---|---|---|---|
| `session-control` | 会话状态 + 总资产/可用/已实现/未实现盈亏 + 统一交易开关 + MCP sim_* 状态/停用按钮 + 停止会话 | `GET /api/sim-live/state` + `POST .../trading` + `POST .../mcp-toggle` + `POST .../stop-session` | 骨架/未运行/错误+重试 |
| `position-table` | 持仓（数量/成本来自模拟账户，现价=本系统行情） | `GET /api/sim-live/positions`（state 已含） | 骨架/「无持仓」/错误 |
| `strategy-panel` | 3 策略独立评估（当前最强标的/分） | `GET /api/sim-live/strategies` | 骨架/「未启动会话」/错误 |
| `stock-scoring` | 每 stock 聚合评分 + 各策略独立分 + 信号 | 同上 | 骨架/「未评估」/错误 |
| `order-trade-list` | 模拟委托/成交（source: strategy\|manual） | `GET /api/sim-live/orders`（state 已含 trades） | 骨架/「无委托」/错误 |

### Tab2 历史回顾
| region | 内容 | 数据源 | 三态 |
|---|---|---|---|
| `session-history` | 会话列表 + 详情 + 「回测一下」对比 | `GET /api/sim-live/sessions` + `GET .../sessions/{id}` + `POST .../sessions/{id}/backtest-compare` | 骨架/「无历史会话」/错误 |

## 3. Props 契约（SimLiveGridProps）

骨架零改动；页面状态机（store）向其对齐。视觉/数据获取在组件内手写。

``` {.tsx file=web/src/layouts/SimLiveGrid.tsx}
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
```
