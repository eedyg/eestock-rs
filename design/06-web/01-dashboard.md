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
  :root {
    --bg:#0b0e17; --panel:#121627; --panel2:#171c33; --line:rgba(255,255,255,.07);
    --txt:#e5e9f2; --dim:#8b93b0; --up:#ff5c6c; --down:#00e0a4;
    --acc1:#38bdf8; --acc2:#a78bfa;
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
  /* 顶部状态条 */
  .topbar { height:44px; display:flex; align-items:center; gap:14px; padding:0 18px; border-bottom:1px solid var(--line); }
  .pill { display:flex; align-items:center; gap:7px; padding:4px 12px; border-radius:999px;
          background:rgba(255,255,255,.04); border:1px solid var(--line); font-size:12px; }
  .dot { width:8px; height:8px; border-radius:50%; }
  .live { background:#00e0a4; box-shadow:0 0 8px #00e0a4aa; animation:pulse 2s infinite; }
  @keyframes pulse { 50% { opacity:.45; } }
  /* 主体 */
  .body { display:flex; height:560px; }
  .nav { width:208px; padding:14px 10px; border-right:1px solid var(--line); }
  .nav div { padding:9px 14px; margin:2px 0; border-radius:10px; color:var(--dim); font-size:13px; }
  .nav .on { color:#fff; background:linear-gradient(90deg, rgba(56,189,248,.18), rgba(167,139,250,.14));
             border-left:3px solid var(--acc1); }
  .nav .off { opacity:.4; }
  /* 标的列表 */
  .syms { width:248px; border-right:1px solid var(--line); padding:12px; }
  .search { height:34px; border-radius:10px; background:var(--panel2); border:1px solid var(--line);
            color:var(--dim); display:flex; align-items:center; padding:0 12px; font-size:12px; margin-bottom:10px; }
  .sym { display:flex; justify-content:space-between; align-items:center; padding:9px 12px; border-radius:10px; margin-bottom:4px; }
  .sym:hover { background:rgba(255,255,255,.04); }
  .sym.on { background:rgba(56,189,248,.12); outline:1px solid rgba(56,189,248,.35); }
  .sym b { font-weight:600; } .sym small { color:var(--dim); display:block; font-size:11px; }
  .up { color:var(--up); } .down { color:var(--down); }
  /* 主区 */
  .main { flex:1; display:flex; flex-direction:column; }
  .toolbar { height:42px; display:flex; align-items:center; gap:6px; padding:0 14px; border-bottom:1px solid var(--line); }
  .btn { padding:4px 12px; border-radius:8px; font-size:12px; color:var(--dim); border:1px solid transparent; }
  .btn.on { color:#fff; background:linear-gradient(135deg, var(--acc1), var(--acc2)); box-shadow:0 2px 10px rgba(56,189,248,.35); }
  .btn.ghost { border-color:var(--line); }
  .sep { width:1px; height:16px; background:var(--line); margin:0 6px; }
  .chart { flex:1; }
  .sub { height:20%; border-top:1px solid var(--line); }
  /* 宫格 */
  .grid { flex:1; display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:10px; }
  .cell { background:var(--panel2); border:1px solid var(--line); border-radius:12px; }
  .note { max-width:1280px; margin:0 auto; color:var(--dim); font-size:12px; }
</style>
</head>
<body>

<div class="frame">
  <h2>单图聚焦模式（默认）· min-width 1280</h2>
  <div class="topbar region" data-region="topbar">
    <span class="pill"><span class="dot live"></span>交易中 10:23</span>
    <span class="pill"><span class="dot live"></span>采集正常</span>
    <span class="pill">1m 源健康 <b class="num">2/2</b> →数据源诊断</span>
  </div>
  <div class="body">
    <div class="nav region" data-region="nav">
      <div class="on">① 行情看板</div><div>② 数据源诊断</div><div>③ 标的管理</div>
      <div class="off">④ 数据质量 · W2</div><div class="off">⑤ 回测 · W3</div>
      <div class="off">⑥ 交易 · W4</div><div class="off">⑦ 告警 · W2</div><div class="off">⑧ 设置</div>
    </div>
    <div class="syms region" data-region="symbol-list">
      <span class="tag">symbol-list W=248</span>
      <div class="search" style="margin-top:14px">⌕ 搜索 code / 名称…</div>
      <div class="sym on"><span><b class="num">518880</b><small>黄金ETF</small></span><span class="up num">2.431<br>+0.62%</span></div>
      <div class="sym"><span><b class="num">513310</b><small>纳指ETF</small></span><span class="down num">1.587<br>−0.31%</span></div>
      <div class="sym"><span><b class="num">161226</b><small>白银LOF</small></span><span class="up num">0.982<br>+1.15%</span></div>
      <div class="sym"><span><b class="num">159776</b><small>港股通医药</small></span><span class="down num">0.874<br>−0.80%</span></div>
      <div class="sym" style="color:var(--dim)"><span>… 共 44 只</span></div>
    </div>
    <div class="main">
      <div class="toolbar region" data-region="toolbar">
        <span class="btn ghost">1m</span><span class="btn ghost">5m</span><span class="btn on">15m</span><span class="btn ghost">1h</span><span class="btn ghost">日</span>
        <span class="sep"></span>
        <span class="btn on">K线</span><span class="btn ghost">分时</span>
        <span class="sep"></span>
        <span class="btn on">MA</span><span class="btn ghost">MACD</span><span class="btn ghost">KDJ</span><span class="btn ghost">BOLL</span>
        <span class="sep"></span>
        <span class="btn ghost">宫格</span>
        <span style="flex:1"></span>
        <span class="btn ghost">回到最新</span>
      </div>
      <div class="chart region" data-region="main-chart">
        <span class="tag">main-chart · K线+MA(5/10/20) · 十字光标/缩放/翻页</span>
        <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 600 300">
          <g opacity="0.25" stroke="#fff" stroke-width="0.5">
            <line x1="0" y1="60" x2="600" y2="60"/><line x1="0" y1="120" x2="600" y2="120"/>
            <line x1="0" y1="180" x2="600" y2="180"/><line x1="0" y1="240" x2="600" y2="240"/>
          </g>
          <g>
            <line x1="60" y1="120" x2="60" y2="205" stroke="#ff5c6c"/><rect x="54" y="140" width="12" height="42" rx="2" fill="#ff5c6c"/>
            <line x1="95" y1="98" x2="95" y2="172" stroke="#ff5c6c"/><rect x="89" y="114" width="12" height="36" rx="2" fill="#ff5c6c"/>
            <line x1="130" y1="132" x2="130" y2="215" stroke="#00e0a4"/><rect x="124" y="142" width="12" height="52" rx="2" fill="#00e0a4"/>
            <line x1="165" y1="88" x2="165" y2="162" stroke="#ff5c6c"/><rect x="159" y="104" width="12" height="36" rx="2" fill="#ff5c6c"/>
            <line x1="200" y1="78" x2="200" y2="152" stroke="#ff5c6c"/><rect x="194" y="94" width="12" height="36" rx="2" fill="#ff5c6c"/>
            <line x1="235" y1="112" x2="235" y2="195" stroke="#00e0a4"/><rect x="229" y="122" width="12" height="52" rx="2" fill="#00e0a4"/>
            <line x1="270" y1="66" x2="270" y2="142" stroke="#ff5c6c"/><rect x="264" y="82" width="12" height="38" rx="2" fill="#ff5c6c"/>
            <line x1="305" y1="58" x2="305" y2="130" stroke="#ff5c6c"/><rect x="299" y="72" width="12" height="36" rx="2" fill="#ff5c6c"/>
          </g>
          <polyline points="60,172 95,135 130,180 165,125 200,115 235,158 270,105 305,92" fill="none" stroke="#38bdf8" stroke-width="2"/>
          <polyline points="60,185 95,150 130,185 165,142 200,132 235,170 270,122 305,108" fill="none" stroke="#a78bfa" stroke-width="2"/>
          <text x="480" y="34" font-size="12" fill="#38bdf8">MA5</text>
          <text x="525" y="34" font-size="12" fill="#a78bfa">MA10</text>
          <text x="24" y="96" font-size="15" fill="#ff5c6c" font-weight="bold">2.431 <tspan font-size="12">+0.62%</tspan></text>
        </svg>
      </div>
      <div class="sub region" data-region="sub-chart">
        <span class="tag">sub-chart · 成交量 H=20%（随主图）</span>
        <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 600 60">
          <rect x="54" y="18" width="12" height="42" rx="2" fill="#ff5c6c" opacity=".55"/>
          <rect x="89" y="8" width="12" height="52" rx="2" fill="#ff5c6c" opacity=".55"/>
          <rect x="124" y="30" width="12" height="30" rx="2" fill="#00e0a4" opacity=".55"/>
          <rect x="159" y="14" width="12" height="46" rx="2" fill="#ff5c6c" opacity=".55"/>
          <rect x="194" y="24" width="12" height="36" rx="2" fill="#ff5c6c" opacity=".55"/>
          <rect x="229" y="34" width="12" height="26" rx="2" fill="#00e0a4" opacity=".55"/>
          <rect x="264" y="4" width="12" height="56" rx="2" fill="#ff5c6c" opacity=".55"/>
          <rect x="299" y="12" width="12" height="48" rx="2" fill="#ff5c6c" opacity=".55"/>
        </svg>
      </div>
    </div>
  </div>
</div>

<div class="frame">
  <h2>宫格模式 · toolbar 切换 · 2×2 / 2×3</h2>
  <div class="body" style="height:470px">
    <div class="nav region"><div class="on">① 行情看板</div></div>
    <div class="syms region"><div class="search" style="margin-top:14px">⌕ 搜索…</div></div>
    <div class="main">
      <div class="toolbar region"><span class="btn ghost">单图</span><span class="btn on">2×2</span><span class="btn ghost">2×3</span></div>
      <div class="grid region" data-region="grid-view">
        <div class="cell"><span class="tag"><b class="num">518880</b> 黄金ETF <b class="up num">+0.62%</b> · K线+MA 缩略，点格进单图</span></div>
        <div class="cell"><span class="tag"><b class="num">513310</b> 纳指ETF <b class="down num">−0.31%</b></span></div>
        <div class="cell"><span class="tag"><b class="num">161226</b> 白银LOF <b class="up num">+1.15%</b></span></div>
        <div class="cell"><span class="tag"><b class="num">159776</b> 港股通医药 <b class="down num">−0.80%</b></span></div>
      </div>
    </div>
  </div>
</div>

<p class="note">样机仅表达布局/区域/尺寸与风格基调（深色交易终端风：霓虹涨跌色 + 玻璃拟态卡片 + 渐变强调色），非最终视觉设计稿。三态与交互契约见 L2 表。</p>
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
  period: '15m',                    // 周期：1m/5m/15m/1h/1d/1w(周)/1mo(月)，默认 15m
  indicators: { ma: true, macd: false, kdj: false, boll: false },
  maWindows: [5, 10, 20],
  view: 'single',                   // 'single' | 'grid2x2' | 'grid2x3'
  chartTab: 'kline',                // 'kline' | '分时'(timeshare，1m bar 客户端计算)
  initialRange: 'today+prevTradingDay',
} as const;

export type Period = '1m' | '5m' | '15m' | '1h' | '1d' | '1w' | '1mo';
export type GridMode = 'single' | 'grid2x2' | 'grid2x3';

/** 标快照（GET /api/symbols 含 latest 字段 + WS {type:"quote"} 增量）
 *  D2：enabled=false 渲染「已停用」；last=null（启用但尚未采到数据）渲染「无数据」，不伪造 0.000。
 *  Wave 3 页面① 看板收藏：favorite=true 收藏区（按 favoriteSort 升序置顶）；favoriteSort=null 非收藏。/api/symbols
 *  恒输出 favorite/favorite_sort（后端 always 序列化），此处标记 optional 以兼容既有快照构造；client/mock 恒填充。 */
export interface SymbolSnapshot {
  code: string;
  name: string;
  enabled: boolean;
  last: number | null; // 无最新数据（latest=null）→ null；有数据为最新价
  changePct: number;
  favorite?: boolean; // 是否收藏（缺失视为非收藏）
  favoriteSort?: number | null; // 收藏排序（sort_order，起点 1；非收藏 null）
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
```

## 2. 图表（定稿 1b）

> **2026-09-04 修复记录（KlineChart 容器缺陷）**：原实现用 `h-[125%]` 跨 main-chart / sub-chart
> 两个骨架锚点（klinecharts 副图需同容器分 pane），在 flex-1 父级下被解析为 ~2^25 px 高（见
> coder/report/014 §7.1），导致 K 线巨比例只渲染左上小部分、canvas 33M 高、滚动高度爆炸、浏览器卡崩溃。
> 定稿修复：`main-area`/`main-chart` 加 `min-h-0` 打破 flex 反馈循环；`main-chart` 改 `relative min-h-0 flex-1`
> 承接整段图表区，KlineChart 容器改 `h-full`（有界、随 autoResize 正确测量，非 `h-[125%]`）；
> `sub-chart` 作为 region 锚点以绝对定位占位（region 契约不变）。

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
- **quote 契约单一化（K1，2026-09-04）**：`WS {type:"quote"}` 载荷字段定为 **camelCase** `changePct`（与 REST `/api/symbols` 客户端归一化后一致）；`DashboardStore` 容错归一化 `msg.change_pct ?? msg.changePct`，防空值 `toFixed` 崩溃双保险（历史帧/其他源再踩不崩）。
- **分时盘中自动刷新（O1，2026-09-04）**：`TimeshareChart` 复用 `KlineDataFeed`（period `1m`）的 `onChange`/`onRealtime`，订阅 `WS {type:"bar", code, period:"1m"}`；当日价格线 + 均价线随新 1m bar `appendBar`（更晚 ts）/`updateBar`（同 ts 未成型当根）实时前进，零额外接口。仅当日 bar 参与计算，跨周期/跨日 bar 忽略。

## 4. 数据范围（定稿 1d）

- 默认加载：当日 + 前一交易日；用户向前滚动/缩小时按需向前分页加载（REST `?before=<ts>&limit=`）
- 日内成交密集区叠加：**Wave 2**（随筹码功能一起，ADR-011）

## 5. API 依赖

| 用途 | 接口 |
|---|---|
| 标列表+最新价 | `GET /api/symbols`（含 latest 快照字段） |
| 历史 bar | `GET /api/kline?code=&period=&before=&limit=`（merge 视图，准确层优先） |
| 实时推送 | `WS /ws` 订阅 `{type:"bar", code, period}` / `{type:"quote", code}`（quote=**camelCase** `changePct`） |

## 6. 验收（Wave 1）

- [ ] 默认 15m 打开 518880，MA+量副图正确渲染
- [ ] 宫格切换无状态丢失；搜索过滤可用
- [ ] 盘中 WS 推送 bar 追加/闪动正常；手动缩放后不被强拉，「回到最新」恢复跟随
- [ ] 向前翻页加载历史无重复/缺漏（分页游标测试）

## 补定稿（2026-09-04，用户追加确认）
- **默认视口** = 当日 + 前一交易日（定稿 1d 不变）；**向前滚动分页**可达最近 10-20 个交易日（分页加载复用 `?before=&limit=`，feed.pageSize 与视口对齐，避免"缩到一小截"；默认 pageSize 改为与"2 交易日"匹配，滚动再加载后续）
- **实时 bar 动态效果**（新增）：WS 推送进行中当根 bar（`updateBar`/实时态）时，用**虚线 + 闪烁/跳动**强标记，与已收盘实体直条明确区分，形成每秒跳动更新感；实现遵循 klinecharts 实时 bar 能力，主图 K 线适用，宫格缩略图可简化为仅最新值跳动

### 补定稿落位（2026-09-04 实现记录，供 coder 核对）
- **pageSize = 2 交易日**：`feed.ts` 新增 `BARS_PER_TRADING_DAY`（1m=241、5m=49、15m=17、1h=5、1d=1，经真数据核对）与 `defaultPageSizeForPeriod(period)`，默认 pageSize 由 500 改为 2×交易日 bar 数（15m=34）；向前分页继续复用 `?before=&limit=`（可达 10-20 交易日）。
  - ⚠️ 注：设计原记"15m≈192 根"，经 `GET /api/kline?code=159337&period=15m` 实测为 **18 根/交易日**（2 交易日=36），故按"2 交易日"折算取 34，而非 192（192 系按全日 24h 估算，与 A 股 4h 交易时段不符）。
- **横向铺满修复**：K线蜡烛左侧大片空白死区起因 = klinecharts 默认 barSpace=10 → 可见 bar 数≈容器宽/10（15m 下来约 95 根），而 15m 仅 2 交易日 ≈36 根，不足填满窗口，scrollToRealTime 锚右 → 蜡烛只占右 ~40%、左 ~48% 死区。修复：`KlineChart.tsx` 按容器实际宽度 + 默认视口（2 交易日）设置 `chart.setBarSpace(空间)`（初次 load 后固定，向前分页不再变窄），使蜡烛横向铺满整个图表区、左右无死区（实测 15m leftBlank≈0.4%）。
- **实时 bar 虚线+闪烁**：klinecharts 无内建"未收盘 bar 虚线"样式，采用轻量 overlay 补充——`KlineChart.tsx` 在实时回调中用 `chart.convertToPixel({timestamp})` 定位最近（进行中）一根 bar 的像素 x，叠加一条 `border-dashed` 竖线 + `animate-pulse` 蓝点 + 实时价标签，每秒跳动更新（见 `[data-realtime-marker]`）。
