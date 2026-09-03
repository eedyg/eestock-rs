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
