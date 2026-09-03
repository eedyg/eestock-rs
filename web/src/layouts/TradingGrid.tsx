// ~/~ begin <<design/06-web/06-trading.md#web/src/layouts/TradingGrid.tsx>>[init]
// 由 design/06-web/06-trading.md L3 代码块 tangle 生成，禁止手改
// 骨架职责：Props 契约 + 区域→组件映射 + 数据源/三态内联注释 + 定稿默认值；视觉样式与数据获取实现在组件内手写

/** 已定稿默认值（定稿 P6，勿改常量改文档） */
export const TRADING_DEFAULTS = {
  manualOnly: true,               // Wave 4 范围边界：只做手工交易，策略自动下单不在 Wave 4
  noTradePassword: true,          // 不设交易口令（与全站免认证一致）；确认弹窗=唯一防误触闸
  autoRefresh: false,             // 持仓/账户不自动轮询（券商查询重，防券商端风控）
  pollIntervalMs: 5000,           // 委托状态轮询 5s×N 至终态即停，不常驻
  qtyRatios: [0.25, 1 / 3, 0.5, 1] as readonly number[],  // 数量快捷比例 1/4、1/3、1/2、全仓
} as const;

export type OrderSide = 'buy' | 'sell';
export type PriceType = 'limit' | 'market5';   // 限价 / 市价五档

/** 页面 Props 契约 */
export interface TradingGridProps {
  prefillCode: string | null;                  // 行情看板/持仓行带入的 code
  onRefreshAccount(): void;                    // 手动刷新：GET /api/broker/account + positions
  onPickPosition(code: string): void;          // 持仓行点选带入 order-form
  onSubmitOrder(draft: OrderDraft): void;      // order-form「下单」→ 打开 confirm-dialog
  onConfirmOrder(draft: OrderDraft): void;     // confirm-dialog「确认下单」→ POST /api/broker/orders
  onCancelDraft(): void;
  onCancelOrder(id: string): void;             // 撤单：POST /api/broker/orders/{id}/cancel
  confirmOpen: boolean;
}

/** 订单草稿（confirm-dialog 摘要内容） */
export interface OrderDraft {
  code: string; side: OrderSide; priceType: PriceType;
  price: number | null;                        // 市价五档时 null
  qty: number;
  estAmount: number | null;                    // 预估金额（摘要展示）
}

export function TradingGrid(props: TradingGridProps) {
  return (
    <div data-region="trading" className="flex min-w-[1280px] flex-1 flex-col">

      {/* account-card：GET /api/broker/account（实时查券商）；进页一次+手动刷新不轮询；
          三态=骨架数值/不可能空（通道在线即有字段）/错误占位+重试（含通道探活失败） */}
      <div data-region="account-card" className="flex h-24 items-center border-b px-4">
        {/* <AccountCard onRefreshAccount/>（总资产/可用/冻结/当日盈亏） */}
      </div>

      <div className="flex flex-1">
        {/* position-table：GET /api/broker/positions + 现价=本系统行情快照；
            三态=骨架行/「无持仓」/错误占位+重试；点行→onPickPosition */}
        <div data-region="position-table" className="flex-1">
          {/* <PositionTable onPickPosition/>（数量成本查券商，现价本地行情源） */}
        </div>
        {/* order-form：静态控件无三态；提交失败错误提示表单保留；
            「下单」不直发，先 onSubmitOrder 打开确认弹窗 */}
        <div data-region="order-form" className="w-80 border-l p-4">
          {/* <OrderForm prefillCode qtyRatios onSubmitOrder/> */}
        </div>
      </div>

      {/* order-list：GET /api/broker/orders?today=1；轮询至终态(5s×N)即停；
          三态=骨架行/「当日无委托」/错误占位+重试；可撤状态附撤单按钮 */}
      <div data-region="order-list" className="h-1/3 border-t">
        {/* <OrderList onCancelOrder/>（已报/部成/已成/已撤/废单） */}
      </div>

      {/* trade-list：GET /api/broker/trades?today=1；
          三态=骨架行/「当日无成交」/错误占位+重试；只读 */}
      <div data-region="trade-list" className="h-1/3 border-t">
        {/* <TradeList/>（当日成交） */}
      </div>

      {props.confirmOpen && (
        /* confirm-dialog：POST /api/broker/orders；免认证唯一防误触闸，未确认不出单；
            三态=提交中禁用/不可能空（必有表单上下文）/下单失败错误提示+可重试；遮罩点击不关闭 */
        <div data-region="confirm-dialog" className="fixed inset-0 flex items-center justify-center">
          {/* <OrderConfirmDialog draft onConfirmOrder onCancelDraft/> W=420 */}
        </div>
      )}
    </div>
  );
}
// ~/~ end
