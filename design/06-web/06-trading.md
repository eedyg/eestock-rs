# 06-web / 06 — 交易面板（页面⑥，Wave 4）

> Grill P6 定稿（2026-09-02）。券商通道**双路线**（用户拍板）；其余按推荐。

## 1. 布局（三层法表达，规范见 00-shell.md；样板 01-dashboard.md §1）

### L1 ASCII 线框

默认视图：

```
┌────────────────────────────────────────────────────────────────────┐
│ 顶部状态条 H=44px（shell 级，见 00-shell）                           │
├────────┬───────────────────────────────────────────────────────────┤
│ 导航栏  │ account-card H=96px                                      │
│ W=208px│ 总资产/可用资金/冻结/当日盈亏 + [手动刷新]（不自动轮询）   │
│ (shell)├───────────────────────────────────────┬───────────────────┤
│        │ position-table（flex-1）               │ order-form W=320  │
│        │ code/名称/持股/可用/成本/现价/市值/浮盈 │ code/方向/价格/数量│
│        │ （现价=本系统行情源，数量成本查券商）   │ 快捷比例 ¼⅓½全仓  │
│        │                                       │ [下单]            │
│        ├───────────────────────────────────────┴───────────────────┤
│        │ order-list H=30%（当日委托：已报/部成/已成/已撤/废单       │
│        │          +可撤状态撤单按钮）                               │
│        ├───────────────────────────────────────────────────────────┤
│        │ trade-list H=30%（当日成交）                              │
└────────┴───────────────────────────────────────────────────────────┘
min-width: 1280px（桌面优先，不响应式）
```

确认弹窗视图（下单唯一防误触闸，遮罩居中）：

```
┌──── 遮罩（半透明，点击不关闭）─────────────────────────────────┐
│   ┌─ confirm-dialog W=420 ──────────────────────────────┐     │
│   │ 订单摘要：标的/方向/价格/数量/预估金额                │     │
│   │ [取消]                        [确认下单]             │     │
│   │ （未确认不出单）                                     │     │
│   └──────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────┘
```

### L1.5 可视化样机（静态 HTML，tangle 生成，浏览器直接打开看效果）

``` {.html file=design/06-web/preview/06-trading.html}
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>页面⑥ 交易面板 — 布局样机</title>
<style>
  :root {
    --bg:#0b0e17; --panel:#121627; --panel2:#171c33; --line:rgba(255,255,255,.07);
    --txt:#e5e9f2; --dim:#8b93b0; --up:#ff5c6c; --down:#00e0a4;
    --acc1:#38bdf8; --acc2:#a78bfa; --warn:#fbbf24;
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px; background:radial-gradient(1200px 600px at 70% -10%, #1a2040 0%, var(--bg) 55%);
         font:14px/1.6 "Inter","PingFang SC",sans-serif; color:var(--txt); }
  .frame { min-width:1280px; margin:0 auto 28px; background:rgba(18,22,39,.75); border:1px solid var(--line);
           border-radius:16px; overflow:hidden; backdrop-filter:blur(6px); box-shadow:0 12px 40px rgba(0,0,0,.45); }
  .frame h2 { margin:0; padding:12px 18px; font-size:13px; font-weight:600; letter-spacing:.08em; color:var(--dim);
              background:rgba(255,255,255,.03); border-bottom:1px solid var(--line); }
  .region { position:relative; }
  .tag { position:absolute; top:6px; left:10px; font-size:11px; color:var(--dim); opacity:.85; z-index:2; }
  .num { font-variant-numeric:tabular-nums; font-family:"JetBrains Mono",monospace; }
  .topbar { height:44px; display:flex; align-items:center; gap:14px; padding:0 18px; border-bottom:1px solid var(--line); }
  .pill { display:flex; align-items:center; gap:7px; padding:4px 12px; border-radius:999px;
          background:rgba(255,255,255,.04); border:1px solid var(--line); font-size:12px; }
  .dot { width:8px; height:8px; border-radius:50%; }
  .live { background:#00e0a4; box-shadow:0 0 8px #00e0a4aa; animation:pulse 2s infinite; }
  @keyframes pulse { 50% { opacity:.45; } }
  .body { display:flex; }
  .nav { width:208px; padding:14px 10px; border-right:1px solid var(--line); }
  .nav div { padding:9px 14px; margin:2px 0; border-radius:10px; color:var(--dim); font-size:13px; }
  .nav .on { color:#fff; background:linear-gradient(90deg, rgba(56,189,248,.18), rgba(167,139,250,.14));
             border-left:3px solid var(--acc1); }
  .nav .off { opacity:.4; }
  .page { flex:1; display:flex; flex-direction:column; }
  .btn { padding:4px 12px; border-radius:8px; font-size:12px; color:var(--dim); border:1px solid transparent; }
  .btn.on { color:#fff; background:linear-gradient(135deg, var(--acc1), var(--acc2)); box-shadow:0 2px 10px rgba(56,189,248,.35); }
  .btn.ghost { border-color:var(--line); }
  .btn.buy { color:#fff; background:linear-gradient(135deg, #ff5c6c, #ff8a5c); }
  .btn.sell { color:#fff; background:linear-gradient(135deg, #00b489, #00e0a4); }
  .btn.danger { color:var(--up); border:1px solid rgba(255,92,108,.4); }
  .up { color:var(--up); } .down { color:var(--down); } .warn { color:var(--warn); }
  /* account-card */
  .acct { height:96px; display:flex; align-items:center; gap:28px; padding:0 18px; border-bottom:1px solid var(--line); }
  .acct .it small { display:block; color:var(--dim); font-size:11px; }
  .acct .it b { font-size:17px; }
  /* position-table */
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th { text-align:left; padding:8px 12px; color:var(--dim); font-weight:500; font-size:11px; border-bottom:1px solid var(--line); }
  td { padding:7px 12px; border-bottom:1px solid var(--line); }
  tr:hover td { background:rgba(255,255,255,.03); }
  /* order-form */
  .oform { width:320px; border-left:1px solid var(--line); padding:16px; font-size:12px; }
  .fld { margin-bottom:10px; }
  .fld label { display:block; color:var(--dim); margin-bottom:4px; }
  .fld .inp { height:32px; border-radius:8px; background:var(--panel2); border:1px solid var(--line);
              color:var(--txt); display:flex; align-items:center; padding:0 12px; }
  .ratios { display:flex; gap:6px; }
  .ratios span { flex:1; text-align:center; padding:4px 0; border-radius:8px; background:var(--panel2);
                 border:1px solid var(--line); color:var(--dim); font-size:11px; }
  .lst { padding:20px 14px 8px; }
  /* confirm-dialog */
  .mask { flex:1; background:rgba(4,6,12,.6); display:flex; align-items:center; justify-content:center; }
  .dlg { width:420px; background:var(--panel); border:1px solid var(--line); border-radius:16px;
         box-shadow:0 20px 60px rgba(0,0,0,.6); padding:20px 22px; position:relative; font-size:13px; }
  .dlg h3 { margin:0 0 12px; font-size:15px; }
  .dlg .row { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--line); }
  .note { max-width:1280px; margin:0 auto; color:var(--dim); font-size:12px; }
</style>
</head>
<body>

<div class="frame">
  <h2>默认视图 · min-width 1280 · Wave 4 仅手工交易</h2>
  <div class="topbar region" data-region="topbar">
    <span class="pill"><span class="dot live"></span>交易中 10:23</span>
    <span class="pill"><span class="dot live"></span>采集正常</span>
    <span class="pill">券商通道 <b>东财 CDP</b> <span class="dot live"></span></span>
  </div>
  <div class="body" style="height:640px">
    <div class="nav region" data-region="nav">
      <div>① 行情看板</div><div>② 数据源诊断</div><div>③ 标的管理</div>
      <div>④ 数据质量</div><div>⑤ 回测工作台</div>
      <div class="on">⑥ 交易面板</div><div>⑦ 告警中心</div><div>⑧ 设置</div>
    </div>
    <div class="page">
      <!-- account-card：GET /api/broker/account（每次调用=实时查券商） -->
      <div class="acct region" data-region="account-card">
        <span class="tag">account-card · 进页查一次 + 手动刷新（不自动轮询，防券商风控）</span>
        <div class="it"><small>总资产</small><b class="num">512,430.55</b></div>
        <div class="it"><small>可用资金</small><b class="num">201,880.12</b></div>
        <div class="it"><small>冻结</small><b class="num">24,310.00</b></div>
        <div class="it"><small>当日盈亏</small><b class="num up">+3,215.40 (+0.63%)</b></div>
        <span style="flex:1"></span>
        <span class="btn ghost">⟳ 手动刷新</span>
      </div>
      <div style="display:flex;flex:1">
        <!-- position-table：GET /api/broker/positions + 现价=本系统行情快照 -->
        <div class="region" data-region="position-table" style="flex:1">
          <span class="tag">position-table · 现价用本系统行情源 · 数量成本查券商</span>
          <table>
            <tr><th>code</th><th>名称</th><th>持股/可用</th><th>成本价</th><th>现价</th><th>市值</th><th>浮动盈亏</th></tr>
            <tr><td class="num">518880</td><td>黄金ETF</td><td class="num">100,000 / 60,000</td><td class="num">2.318</td><td class="num">2.431</td><td class="num">243,100</td><td class="num up">+11,300 (+4.87%)</td></tr>
            <tr><td class="num">513310</td><td>纳指ETF</td><td class="num">30,000 / 30,000</td><td class="num">1.612</td><td class="num">1.587</td><td class="num">47,610</td><td class="num down">−750 (−1.55%)</td></tr>
          </table>
        </div>
        <!-- order-form：POST /api/broker/orders（经 confirm-dialog） -->
        <div class="oform region" data-region="order-form">
          <span class="tag">order-form W=320</span>
          <div class="fld" style="margin-top:14px"><label>code（行情看板/持仓行可带入）</label><div class="inp num">518880 黄金ETF</div></div>
          <div class="fld"><label>方向</label><span class="btn buy">买入</span> <span class="btn ghost">卖出</span></div>
          <div class="fld"><label>价格（限价 / 市价五档）</label><div class="inp num">2.431</div></div>
          <div class="fld"><label>数量（快捷比例）</label><div class="inp num">10,000</div>
            <div class="ratios" style="margin-top:6px"><span>1/4</span><span>1/3</span><span>1/2</span><span>全仓</span></div></div>
          <span class="btn on" style="display:block;text-align:center;margin-top:14px">下单（先弹确认）</span>
          <p style="color:var(--warn);font-size:11px;margin-top:10px">⚠️ 免认证环境，确认弹窗是唯一防误触闸；不设交易口令（定稿）</p>
        </div>
      </div>
      <!-- order-list：GET /api/broker/orders?today=1；撤单 POST /{id}/cancel -->
      <div class="lst region" data-region="order-list" style="height:30%;border-top:1px solid var(--line)">
        <span class="tag">order-list · 当日委托 · 可撤状态附撤单按钮 · 轮询至终态（5s×N）即停</span>
        <table>
          <tr><th>时刻</th><th>code</th><th>方向</th><th>价/量</th><th>状态</th><th>操作</th></tr>
          <tr><td class="num">10:21:33</td><td class="num">518880</td><td class="up">买入</td><td class="num">2.430 × 10,000</td><td><span class="pill">已报</span></td><td><span class="btn danger">撤单</span></td></tr>
          <tr><td class="num">09:52:10</td><td class="num">513310</td><td class="down">卖出</td><td class="num">1.590 × 5,000</td><td><span class="pill">已成</span></td><td>—</td></tr>
        </table>
      </div>
      <!-- trade-list：GET /api/broker/trades?today=1 -->
      <div class="lst region" data-region="trade-list" style="height:30%;border-top:1px solid var(--line)">
        <span class="tag">trade-list · 当日成交</span>
        <table>
          <tr><th>时刻</th><th>code</th><th>方向</th><th>成交价/量</th></tr>
          <tr><td class="num">09:52:11</td><td class="num">513310</td><td class="down">卖出</td><td class="num">1.590 × 5,000</td></tr>
        </table>
      </div>
    </div>
  </div>
</div>

<div class="frame">
  <h2>确认弹窗视图 · 未确认不出单（验收项）</h2>
  <div class="body" style="height:360px">
    <div class="nav region"><div class="on">⑥ 交易面板</div></div>
    <div class="mask region" data-region="confirm-dialog">
      <div class="dlg">
        <span class="tag" style="top:8px;left:12px">confirm-dialog · 遮罩点击不关闭</span>
        <h3>确认下单</h3>
        <div class="row"><span style="color:var(--dim)">标的</span><b class="num">518880 黄金ETF</b></div>
        <div class="row"><span style="color:var(--dim)">方向</span><b class="up">买入</b></div>
        <div class="row"><span style="color:var(--dim)">价格</span><b class="num">限价 2.431</b></div>
        <div class="row"><span style="color:var(--dim)">数量</span><b class="num">10,000</b></div>
        <div class="row"><span style="color:var(--dim)">预估金额</span><b class="num">24,310.00</b></div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
          <span class="btn ghost">取消</span><span class="btn buy">确认下单</span>
        </div>
      </div>
    </div>
  </div>
</div>

<p class="note">样机仅表达布局/区域/尺寸与风格基调（深色交易终端风，同 01-dashboard 基线；红涨绿跌 = 买入红/卖出绿），非最终视觉设计稿。三态与交互契约见 L2 表。</p>
</body>
</html>
```

### L2 区域规格表

| 区域 id | 内容 | 数据源 | loading/空/错误态 | 交互 |
|---|---|---|---|---|
| `account-card` | 总资产/可用资金/冻结/当日盈亏；手动刷新按钮 | `GET /api/broker/account`（每次调用=实时查券商） | 骨架数值 / 不可能空（券商通道在线即返回账户字段；通道异常=错误态）/ 错误占位+重试（含券商通道探活失败提示） | 进页面查一次 + 手动刷新；不自动轮询（券商查询重，防券商端风控） |
| `position-table` | 持仓表：code/名称/持股数量/可用数量/成本价/现价/市值/浮动盈亏(+%)；**现价用本系统行情源**，数量成本查券商 | `GET /api/broker/positions` + 现价取本系统行情快照（`GET /api/symbols` latest / WS `{type:"quote"}`；⚠️ §7 API 依赖节未列行情快照端点，见「待裁决」） | 骨架行 / 「无持仓」占位 / 错误占位+重试 | 点行带 code 入 order-form；手动刷新随 account-card |
| `order-form` | 下单表单：code（行情看板/持仓行可带入）、买卖方向、价格（限价/市价五档）、数量（1/4、1/3、1/2、全仓快捷比例） | 本地状态；提交经 confirm-dialog → `POST /api/broker/orders` | 不可能空（静态控件）/ — / 提交失败错误提示（表单保留不重置） | 填毕点「下单」→ confirm-dialog；快捷比例按可用资金/可卖数量换算 |
| `confirm-dialog` | 订单摘要：标的/方向/价格/数量/预估金额 → 「确认下单」才发出（免认证环境唯一防误触闸；不设交易口令，定稿） | `POST /api/broker/orders` | 提交中按钮禁用 / 不可能空（必有表单上下文）/ 下单失败错误提示+可重试 | 遮罩点击不关闭；取消返回表单；未确认不出单（验收项） |
| `order-list` | 当日委托列表（已报/部成/已成/已撤/废单）+ 可撤状态下撤单按钮 | `GET /api/broker/orders?today=1`；撤单 `POST /api/broker/orders/{id}/cancel`；下单后轮询至终态（5s×N 次）即停，不常驻轮询 | 骨架行 / 「当日无委托」/ 错误占位+重试 | 撤单按钮（仅可撤状态可见）；状态轮询至终态自动停 |
| `trade-list` | 当日成交列表 | `GET /api/broker/trades?today=1` | 骨架行 / 「当日无成交」/ 错误占位+重试 | 只读 |

### L3 布局骨架（tangle 生成；结构+锚点+尺寸类，视觉样式手写）

``` {.tsx file=web/src/layouts/TradingGrid.tsx}
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
```

## 2. 券商通道双路线（BrokerGateway 抽象，design/09-trading 细化）

| 路线 | 通道 | 技术形态 | 风险 |
|---|---|---|---|
| **A. 东方财富** | CDP 网页自动化（继承旧 webauto 思路）| Rust chromiumoxide 驱动浏览器 | chromiumoxide 成熟度弱于 go-rod → **Wave 3 spike 必验**（登录态保持/持仓查询/下单三关） |
| **B. 银河证券** | 量化 API（QMT/xtquant 系）| xtquant 为 Python SDK → **Python sidecar 进程**，Rust 经 IPC（HTTP/gRPC）调用 | sidecar 进程编排；QMT 终端需常驻 Windows 环境的部署约束 |

- domain 定义 `BrokerGateway` trait（持仓/账户/委托/成交/撤单/下单），两路线各自实现
- **运行时二选一配置切换**（主用哪个券商账户由配置决定）；诊断面板接入券商通道健康度（两路线各自探活）
- spike 结论若 A 失败 → B 升主用；若 B 环境不可得 → A 独撑；双失败 → 回用户重新决策（ADR-012）

## 3. 持仓/账户信息区（定稿 6a-A）

- 持仓表：code/名称/持股数量/可用数量/成本价/现价/市值/浮动盈亏(+%)；**现价用本系统行情源**，数量成本查券商
- 账户卡：总资产/可用资金/冻结/当日盈亏
- 刷新：进页面查一次 + 手动刷新按钮（券商查询重，不自动轮询，防券商端风控）

## 4. 下单区（定稿）

- 表单：code（行情看板/持仓行可带入）、买卖方向、价格（限价/市价五档）、数量（1/4、1/3、1/2、全仓快捷比例）
- **确认弹窗**：订单摘要（标的/方向/价格/数量/预估金额）→「确认下单」才发出——免认证环境唯一防误触闸
- **交易口令：不设**（按推荐 A，与全站免认证一致；⚠️ 真金白银风险已向你明示，你确认"其他按推荐"即视为接受；反悔随时说，加一个会话级口令成本很低）

## 5. 委托/成交区（定稿）

- 当日委托列表（已报/部成/已成/已撤/废单）+ 可撤状态下**撤单按钮**
- 当日成交列表
- 委托状态：下单后轮询至终态（5s×N 次）即停，不常驻轮询

## 6. Wave 4 范围边界（定稿 6d-A）

- **只做手工交易**：页面下单 + 持仓/账户查询 + 撤单
- 策略自动下单**不在 Wave 4**（信号链路/风控/熔断另开 Grill 系列与波次）

## 7. API 依赖

| 用途 | 接口 |
|---|---|
| 持仓/账户 | `GET /api/broker/positions` / `GET /api/broker/account`（每次调用=实时查券商） |
| 下单 | `POST /api/broker/orders` |
| 当日委托/成交 | `GET /api/broker/orders?today=1` / `GET /api/broker/trades?today=1` |
| 撤单 | `POST /api/broker/orders/{id}/cancel` |

## 8. 验收（Wave 4）

- [ ] spike 报告（Wave 3 产出）：两路线登录/查询/下单三关各自的证据结论
- [ ] 双路线 BrokerGateway 契约测试：同一 trait 两实现行为一致（mock 层锁定）
- [ ] 小额真实下单→撤单全流程走通（用户在场监督下验收）
- [ ] 确认弹窗拦截测试：未确认不出单
