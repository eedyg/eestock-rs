# 06-web / 01 — 行情看板（页面①）

> Grill P1 定稿（2026-09-02）。实现时代码块由 coder 按本文档规格以 TDD 填充（文学式单向 tangle）。

## 1. 布局（定稿 1a-C；三层法表达，规范见 00-shell.md）

### L1 ASCII 线框

单图聚焦模式（默认）：

```
┌────────────────────────────────────────────────────────────────┐
│ 顶部状态条 H=40px（shell 级，见 00-shell）                       │
├────────┬──────────────────┬────────────────────────────────────┤
│ 导航栏  │ symbol-list      │ main-area (flex-1)                 │
│ W=200px│ W=240px          │ ┌─ toolbar H=36px ───────────────┐ │
│ (shell)│ code+名称+最新价  │ │ 周期|K线/分时|指标|宫格|回到最新 │ │
│        │ +涨跌幅           │ ├─ main-chart (flex-1) ──────────┤ │
│        │ 顶部搜索过滤 H=32 │ │ K线+MA(5/10/20) / 分时线        │ │
│        │                  │ ├─ sub-chart H=20% ──────────────┤ │
│        │                  │ │ 成交量                          │ │
└────────┴──────────────────┴────────────────────────────────────┘
min-width: 1280px（桌面优先，不响应式）
```

宫格模式（toolbar 切换，替代 main-area 内容）：

```
┌─ grid-view (flex-1) ────────────────────────────┐
│ grid-cell ×4 (2×2) 或 ×6 (2×3)                   │
│ 每格：K线缩略图+MA（无副图）+code/名称/涨跌幅表头   │
└─────────────────────────────────────────────────┘
```

### L1.5 可视化样机（静态 HTML，tangle 生成，浏览器直接打开看效果）

``` {.html file=design/06-web/preview/01-dashboard.html}
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>页面① 行情看板 — 布局样机</title>
<style>
  body { margin:0; font:14px/1.5 sans-serif; background:#f3f4f6; color:#111; }
  .frame { min-width:1280px; margin:16px; background:#fff; border:1px solid #d1d5db; }
  .frame h2 { margin:0; padding:8px 12px; background:#111827; color:#fff; font-size:14px; }
  .region { position:relative; box-sizing:border-box; }
  .tag { position:absolute; top:4px; left:6px; font-size:11px; color:#6b7280; }
  .topbar { height:40px; display:flex; align-items:center; gap:24px; padding:0 12px; background:#f9fafb; border-bottom:1px solid #e5e7eb; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:4px; }
  .green { background:#10b981; } .yellow { background:#f59e0b; }
  .body { display:flex; height:560px; }
  .nav { width:200px; background:#1f2937; color:#d1d5db; padding:8px 0; }
  .nav div { padding:8px 16px; } .nav .on { background:#374151; color:#fff; }
  .nav .off { color:#6b7280; }
  .syms { width:240px; border-right:1px solid #e5e7eb; display:flex; flex-direction:column; }
  .search { height:32px; margin:6px; border:1px solid #d1d5db; border-radius:4px; padding:0 8px; color:#9ca3af; display:flex; align-items:center; }
  .sym { display:flex; justify-content:space-between; padding:6px 12px; border-bottom:1px solid #f3f4f6; }
  .sym .up { color:#dc2626; } .sym .down { color:#16a34a; } /* A股：红涨绿跌 */
  .main { flex:1; display:flex; flex-direction:column; }
  .toolbar { height:36px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; gap:8px; padding:0 8px; }
  .btn { border:1px solid #d1d5db; border-radius:4px; padding:2px 10px; font-size:12px; background:#fff; }
  .btn.on { background:#2563eb; color:#fff; border-color:#2563eb; }
  .chart { flex:1; position:relative; background:#fff; }
  .sub { height:20%; border-top:1px solid #e5e7eb; position:relative; }
  .grid { flex:1; display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:1px; background:#e5e7eb; }
  .cell { background:#fff; position:relative; }
  .note { margin:8px 16px; color:#6b7280; font-size:12px; }
</style>
</head>
<body>

<div class="frame">
  <h2>单图聚焦模式（默认）— min-width 1280px</h2>
  <!-- 顶部状态条（shell 级，全站共用） -->
  <div class="topbar region" data-region="topbar">
    <span><span class="dot green"></span>交易中 10:23</span>
    <span><span class="dot green"></span>采集正常</span>
    <span>1m 源健康 2/2（点击→数据源诊断）</span>
  </div>
  <div class="body">
    <!-- 左侧导航（shell 级，8 页） -->
    <div class="nav region" data-region="nav">
      <div class="on">① 行情看板</div><div>② 数据源诊断</div><div>③ 标的管理</div>
      <div class="off">④ 数据质量（W2）</div><div class="off">⑤ 回测（W3）</div>
      <div class="off">⑥ 交易（W4）</div><div class="off">⑦ 告警（W2）</div><div class="off">⑧ 设置</div>
    </div>
    <!-- symbol-list：GET /api/symbols + WS quote -->
    <div class="syms region" data-region="symbol-list">
      <span class="tag">symbol-list W=240</span>
      <div class="search">搜索 code / 名称…</div>
      <div class="sym"><span><b>518880</b> 黄金ETF</span><span class="up">2.431 +0.62%</span></div>
      <div class="sym"><span><b>513310</b> 纳指ETF</span><span class="down">1.587 −0.31%</span></div>
      <div class="sym"><span><b>161226</b> 白银LOF</span><span class="up">0.982 +1.15%</span></div>
      <div class="sym"><span><b>159776</b> 港股通医药</span><span class="down">0.874 −0.80%</span></div>
      <div class="sym" style="color:#9ca3af"><span>…共 44 只</span><span></span></div>
    </div>
    <!-- main-area -->
    <div class="main">
      <!-- toolbar H=36 -->
      <div class="toolbar region" data-region="toolbar">
        <span class="tag">toolbar H=36</span>
        <span class="btn">1m</span><span class="btn">5m</span><span class="btn on">15m</span><span class="btn">1h</span><span class="btn">日</span>
        <span style="color:#d1d5db">|</span>
        <span class="btn on">K线</span><span class="btn">分时</span>
        <span style="color:#d1d5db">|</span>
        <span class="btn on">MA</span><span class="btn">MACD</span><span class="btn">KDJ</span><span class="btn">BOLL</span>
        <span style="color:#d1d5db">|</span>
        <span class="btn">宫格</span>
        <span style="flex:1"></span>
        <span class="btn">回到最新</span>
      </div>
      <!-- main-chart：GET /api/kline + WS bar -->
      <div class="chart region" data-region="main-chart">
        <span class="tag">main-chart（K线+MA(5/10/20)，十字光标/缩放/翻页）</span>
        <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 600 300">
          <g>
            <line x1="40" y1="120" x2="40" y2="200" stroke="#dc2626"/><rect x="35" y="140" width="10" height="40" fill="#dc2626"/>
            <line x1="70" y1="100" x2="70" y2="170" stroke="#dc2626"/><rect x="65" y="115" width="10" height="35" fill="#dc2626"/>
            <line x1="100" y1="130" x2="100" y2="210" stroke="#16a34a"/><rect x="95" y="140" width="10" height="50" fill="#16a34a"/>
            <line x1="130" y1="90" x2="130" y2="160" stroke="#dc2626"/><rect x="125" y="105" width="10" height="35" fill="#dc2626"/>
            <line x1="160" y1="80" x2="160" y2="150" stroke="#dc2626"/><rect x="155" y="95" width="10" height="35" fill="#dc2626"/>
            <line x1="190" y1="110" x2="190" y2="190" stroke="#16a34a"/><rect x="185" y="120" width="10" height="50" fill="#16a34a"/>
            <line x1="220" y1="70" x2="220" y2="140" stroke="#dc2626"/><rect x="215" y="85" width="10" height="35" fill="#dc2626"/>
            <polyline points="40,170 70,135 100,175 130,125 160,115 190,155 220,105" fill="none" stroke="#f59e0b" stroke-width="1.5"/>
            <polyline points="40,180 70,150 100,180 130,140 160,130 190,165 220,120" fill="none" stroke="#3b82f6" stroke-width="1.5"/>
          </g>
          <text x="500" y="30" font-size="12" fill="#f59e0b">MA5</text>
          <text x="540" y="30" font-size="12" fill="#3b82f6">MA10</text>
        </svg>
      </div>
      <!-- sub-chart：成交量 H=20% -->
      <div class="sub region" data-region="sub-chart">
        <span class="tag">sub-chart 成交量 H=20%（随主图，无独立交互）</span>
        <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 600 60">
          <rect x="35" y="20" width="10" height="40" fill="#dc2626" opacity="0.7"/>
          <rect x="65" y="10" width="10" height="50" fill="#dc2626" opacity="0.7"/>
          <rect x="95" y="30" width="10" height="30" fill="#16a34a" opacity="0.7"/>
          <rect x="125" y="15" width="10" height="45" fill="#dc2626" opacity="0.7"/>
          <rect x="155" y="25" width="10" height="35" fill="#dc2626" opacity="0.7"/>
          <rect x="185" y="35" width="10" height="25" fill="#16a34a" opacity="0.7"/>
          <rect x="215" y="5" width="10" height="55" fill="#dc2626" opacity="0.7"/>
        </svg>
      </div>
    </div>
  </div>
</div>

<div class="frame">
  <h2>宫格模式（toolbar 切换，替代主图区；2×2 或 2×3）</h2>
  <div class="body" style="height:480px">
    <div class="nav region"><div class="on">① 行情看板</div></div>
    <div class="syms region"><div class="search">搜索 code / 名称…</div></div>
    <div class="main">
      <div class="toolbar region"><span class="btn">单图</span><span class="btn on">2×2</span><span class="btn">2×3</span></div>
      <div class="grid region" data-region="grid-view">
        <div class="cell"><span class="tag">518880 黄金ETF <b style="color:#dc2626">+0.62%</b>（K线+MA 缩略，点格进单图）</span></div>
        <div class="cell"><span class="tag">513310 纳指ETF <b style="color:#16a34a">−0.31%</b></span></div>
        <div class="cell"><span class="tag">161226 白银LOF <b style="color:#dc2626">+1.15%</b></span></div>
        <div class="cell"><span class="tag">159776 港股通医药 <b style="color:#16a34a">−0.80%</b></span></div>
      </div>
    </div>
  </div>
</div>

<p class="note">样机仅表达布局/区域/尺寸与数据源归属（见各区域标签），非视觉设计稿。三态（loading/空/错误）与交互契约见文档 L2 表。</p>
</body>
</html>
```

### L2 区域规格表

| 区域 id | 内容 | 数据源 | loading/空/错误态 | 交互 |
|---|---|---|---|---|
| `symbol-list` | 注册集合：code+名称+最新价+涨跌幅 | `GET /api/symbols`（含 latest 快照）+ WS `{type:"quote"}` | 骨架行 / 「未注册标的，去标的管理」引导链 / 顶部错误条+重试 | 点击切主图；搜索框过滤（code/名称模糊） |
| `toolbar` | 周期(1m/5m/15m/1h/日，默认15m)、K线/分时 Tab、指标勾选(MA默认开；MACD/KDJ/BOLL默认关)、宫格切换、回到最新 | 本地状态 | 不可能空（静态控件）/ — / — | 见 §2/§3 行为 |
| `main-chart` | K线+MA(5/10/20)；分时 Tab=当日价格线+均价线（1m bar 客户端计算） | `GET /api/kline`（merge 视图）+ WS `{type:"bar"}`；1m 读 raw、高周期读 cagg | 骨架图 / 「该时段无数据」占位 / 错误占位+重试 | 十字光标；缩放/平移（手动后不强拉）；向前翻页 `?before=&limit=` |
| `sub-chart` | 成交量副图（默认开） | 同 main-chart | 随主图 / 随主图 / 随主图 | 无独立交互 |
| `grid-view` | 2×2 / 2×3 宫格缩略图 | 同 main-chart，每格独立订阅 | 每格独立骨架/无数据/错误 | 点格进单图聚焦；工具栏切回 |

### L3 布局骨架（tangle 生成；结构+锚点+尺寸类，视觉样式手写）

``` {.tsx file=web/src/layouts/DashboardGrid.tsx}
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

/** 标快照（GET /api/symbols 含 latest 字段 + WS {type:"quote"} 增量） */
export interface SymbolSnapshot {
  code: string; name: string; last: number; changePct: number;
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

      <main data-region="main-area" className="flex flex-1 flex-col">

        {/* toolbar：静态控件无三态；周期/Tab/指标勾选/宫格/回到最新 */}
        <div data-region="toolbar" className="h-9 border-b">
          {/* <PeriodSwitch/> <ChartTab/> <IndicatorToggles/> <GridSwitch/> <BackToLatest/> */}
        </div>

        {props.gridMode === 'single' ? (
          <>
            {/* main-chart：GET /api/kline（merge 视图，1m 读 raw、高周期读 cagg）+ WS {type:"bar"}；
                三态=骨架图/「该时段无数据」占位/错误占位+重试；手动缩放后不强拉 */}
            <div data-region="main-chart" className="flex-1">
              {/* <KlineChart/> 或 <TimeshareChart/>（chartTab 切换） */}
            </div>
            {/* sub-chart：成交量，随主图数据/三态，无独立交互 */}
            <div data-region="sub-chart" className="h-1/5">
              {/* <VolumeChart/> */}
            </div>
          </>
        ) : (
          /* grid-view：2×2/2×3，每格独立订阅独立三态；点格→onSelectSymbol+回单图 */
          <div data-region="grid-view" className="grid flex-1 grid-cols-2">
            {/* <GridCell/> ×4 或 ×6（grid2x3 时 grid-rows-3） */}
          </div>
        )}
      </main>
    </div>
  );
}
```

## 2. 图表（定稿 1b）

- 图表库：**klinecharts**
- 周期切换：1m / 5m / 15m / 1h / 日；**默认 15m**（用户拍板）；数据源：1m 读 kline_raw 直查，高周期读对应 cagg
- 主图：K线 + MA(5/10/20)（默认开）
- 副图1：成交量（默认开）
- 可选指标（勾选）：MACD / KDJ / BOLL（默认关）
- **分时图视图**：切换 Tab「K线 / 分时」；分时=当日价格线+均价线（由 1m bar 客户端计算，零额外接口）
- 十字光标、图例、涨跌幅着色（红涨绿跌，A 股惯例）

## 3. 实时行为（定稿 1c）

- WebSocket 订阅当前标的：新 bar `appendBar`，当分钟未成型 bar 随快照/周期聚合 `updateBar` 闪动更新
- 缩放跟随策略：用户未手动缩放 → 保持跟随最新 bar（视口锁定最右）；用户手动缩放/平移过 → 不再强拉，工具栏提供「回到最新」按钮

## 4. 数据范围（定稿 1d）

- 默认加载：当日 + 前一交易日；用户向前滚动/缩小时按需向前分页加载（REST `?before=<ts>&limit=`）
- 日内成交密集区叠加：**Wave 2**（随筹码功能一起，ADR-011）

## 5. API 依赖

| 用途 | 接口 |
|---|---|
| 标列表+最新价 | `GET /api/symbols`（含 latest 快照字段） |
| 历史 bar | `GET /api/kline?code=&period=&before=&limit=`（merge 视图，准确层优先） |
| 实时推送 | `WS /ws` 订阅 `{type:"bar", code, period}` / `{type:"quote", code}` |

## 6. 验收（Wave 1）

- [ ] 默认 15m 打开 518880，MA+量副图正确渲染
- [ ] 宫格切换无状态丢失；搜索过滤可用
- [ ] 盘中 WS 推送 bar 追加/闪动正常；手动缩放后不被强拉，「回到最新」恢复跟随
- [ ] 向前翻页加载历史无重复/缺漏（分页游标测试）
