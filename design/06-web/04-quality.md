# 06-web / 04 — 数据质量（页面④）

> Grill P4 定稿（2026-09-02，全按推荐）。回答核心问题：「自抓数据有多靠谱？」

## 1. 布局（三层法表达，规范见 00-shell.md；样板 01-dashboard.md §1）

### L1 ASCII 线框

表格视图（默认，主视图=分歧表）：

```
┌────────────────────────────────────────────────────────────────┐
│ 顶部状态条 H=44px（shell 级，见 00-shell）                       │
├────────┬───────────────────────────────────────────────────────┤
│ 导航栏  │ filter-bar H=48px                                     │
│ W=208px│ 标的选择 │ 日期范围 │ 视图切换 [分歧表|叠加图]          │
│ (shell)├───────────────────────────────────────────────────────┤
│        │ divergence-table（flex-1，默认偏差降序）               │
│        │ 时刻│raw收盘│accurate收盘│偏差%│raw来源                 │
│        │ 汇总行 H=40：比对总数/一致率/最大偏差                   │
│        ├───────────────────────────────────────────────────────┤
│        │ accuracy-cards H=120px（源一致率排行卡，flex 横排）     │
│        ├──────────────────────────────┬────────────────────────┤
│        │ sync-panel（W=50%）           │ gap-report（W=50%）     │
│        │ tushare 状态+剩余积分+触发    │ 缺口日期列表 H=220      │
└────────┴──────────────────────────────┴────────────────────────┘
min-width: 1280px（桌面优先，不响应式）
```

叠加图视图（filter-bar 切换，overlay-chart 替代 divergence-table）：

```
├─ overlay-chart（flex-1）───────────────────────────────────────┤
│ 双线叠加：raw 收盘线 vs accurate 收盘线（偏小区间用缩放肉眼分辨）│
```

### L1.5 可视化样机（静态 HTML，tangle 生成，浏览器直接打开看效果）

``` {.html file=design/06-web/preview/04-quality.html}
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>页面④ 数据质量 — 布局样机</title>
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
  .up { color:var(--up); } .down { color:var(--down); } .warn { color:var(--warn); }
  /* filter-bar */
  .fbar { height:48px; display:flex; align-items:center; gap:10px; padding:0 18px; border-bottom:1px solid var(--line); }
  .sel { height:30px; border-radius:8px; background:var(--panel2); border:1px solid var(--line);
         color:var(--dim); display:flex; align-items:center; padding:0 12px; font-size:12px; }
  /* divergence-table */
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; padding:10px 14px; color:var(--dim); font-weight:500; font-size:12px;
       border-bottom:1px solid var(--line); letter-spacing:.04em; }
  td { padding:8px 14px; border-bottom:1px solid var(--line); }
  tr:hover td { background:rgba(255,255,255,.03); }
  .sumrow td { color:var(--txt); background:rgba(56,189,248,.06); font-weight:600; }
  /* accuracy-cards */
  .acards { display:flex; gap:10px; padding:12px; border-bottom:1px solid var(--line); height:120px; }
  .acard { flex:1; background:var(--panel2); border:1px solid var(--line); border-radius:12px;
           padding:22px 14px 10px; position:relative; font-size:12px; color:var(--dim); }
  .acard b { color:var(--txt); font-size:13px; }
  /* sync-panel / gap-report */
  .split { display:flex; height:220px; }
  .half { width:50%; padding:24px 16px 10px; position:relative; font-size:12px; color:var(--dim); }
  .half + .half { border-left:1px solid var(--line); }
  .half div.row { padding:4px 0; border-bottom:1px solid var(--line); }
  .quota { display:inline-block; padding:4px 14px; border-radius:10px; background:rgba(251,191,36,.1);
           border:1px solid rgba(251,191,36,.4); color:var(--warn); font-size:13px; }
  /* overlay-chart */
  .ochart { height:300px; position:relative; }
  .note { max-width:1280px; margin:0 auto; color:var(--dim); font-size:12px; }
</style>
</head>
<body>

<div class="frame">
  <h2>表格视图（默认）· min-width 1280</h2>
  <div class="topbar region" data-region="topbar">
    <span class="pill"><span class="dot live"></span>交易中 10:23</span>
    <span class="pill"><span class="dot live"></span>采集正常</span>
    <span class="pill">1m 源健康 <b class="num">2/2</b></span>
  </div>
  <div class="body">
    <div class="nav region" data-region="nav">
      <div>① 行情看板</div><div>② 数据源诊断</div><div>③ 标的管理</div>
      <div class="on">④ 数据质量</div>
      <div class="off">⑤ 回测 · W3</div><div class="off">⑥ 交易 · W4</div>
      <div class="off">⑦ 告警 · W2</div><div class="off">⑧ 设置</div>
    </div>
    <div class="page">
      <!-- filter-bar H=48 -->
      <div class="fbar region" data-region="filter-bar">
        <span class="sel num">518880 黄金ETF ▾</span>
        <span class="sel num">2026-09-01 ~ 2026-09-03 ▾</span>
        <span style="flex:1"></span>
        <span class="btn on">分歧表</span><span class="btn ghost">叠加图</span>
      </div>
      <!-- divergence-table：GET /api/quality/divergence?code=&from=&to= -->
      <div class="region" data-region="divergence-table">
        <span class="tag">divergence-table · 默认偏差降序 · 点行跳行情看板对应时刻</span>
        <table>
          <tr><th>时刻</th><th>raw 收盘</th><th>accurate 收盘</th><th>偏差%</th><th>raw 来源</th></tr>
          <tr><td class="num">09-02 10:41</td><td class="num">2.468</td><td class="num">2.431</td><td class="num up">+1.52%</td><td>SinaJsonp</td></tr>
          <tr><td class="num">09-02 13:07</td><td class="num">2.402</td><td class="num">2.419</td><td class="num up">−0.70%</td><td>SinaJsonp</td></tr>
          <tr><td class="num">09-01 14:55</td><td class="num">2.455</td><td class="num">2.441</td><td class="num warn">+0.57%</td><td>TencentIfzq</td></tr>
          <tr class="sumrow"><td colspan="2">汇总：比对 <span class="num">615</span> bar</td><td>一致率 <span class="num down">99.5%</span>（≤0.5% 计一致）</td><td>最大偏差 <span class="num up">1.52%</span></td><td></td></tr>
        </table>
      </div>
      <!-- accuracy-cards：GET /api/quality/source-accuracy?from=&to= -->
      <div class="acards region" data-region="accuracy-cards">
        <span class="tag">accuracy-cards · 源一致率排行（源权重/轮转序调整依据）</span>
        <div class="acard"><b>TencentIfzq</b><br>一致率 <b class="num down">99.8%</b> · 平均偏差 <span class="num">0.02%</span><br>样本 <span class="num">615</span> bar</div>
        <div class="acard"><b>SinaJsonp</b><br>一致率 <b class="num warn">97.1%</b> · 平均偏差 <span class="num">0.31%</span><br>样本 <span class="num">615</span> bar</div>
      </div>
      <div class="split">
        <!-- sync-panel：GET /api/tushare/status + POST /api/tushare/sync -->
        <div class="half region" data-region="sync-panel">
          <span class="tag">sync-panel · tushare 同步状态 + 手动触发</span>
          <div class="row">最近同步 <span class="num">09-03 06:30</span> · 覆盖 <span class="num">44</span> 只 · 新增 <span class="num">9,020</span> 行 · 耗时 <span class="num">42s</span></div>
          <div class="row" style="border:none;margin-top:6px">剩余积分 <span class="quota num">4,820 / 5,000</span>（quota 硬约束，醒目展示）</div>
          <div class="row" style="border:none;margin-top:8px"><span class="sel num">标的 ▾</span> <span class="sel num">日期范围 ▾</span> <span class="btn on">手动同步</span>（异步任务，完成刷新本区）</div>
        </div>
        <!-- gap-report：GET /api/quality/gaps?code=&from=&to= -->
        <div class="half region" data-region="gap-report">
          <span class="tag">gap-report · 历史缺口日期列表（复盘视角，互补页面②实时缺口）</span>
          <div class="row"><span class="num">09-02</span> 缺 <span class="num">10:41-10:45</span>（<span class="num">5</span> bar）· <span class="num">13:07</span>（<span class="num">1</span> bar）</div>
          <div class="row"><span class="num">08-28</span> 缺 <span class="num">14:30-15:00</span>（<span class="num">31</span> bar）</div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="frame">
  <h2>叠加图视图 · filter-bar 切换 · overlay-chart 替代分歧表</h2>
  <div class="body">
    <div class="nav region"><div class="on">④ 数据质量</div></div>
    <div class="page">
      <div class="fbar region"><span class="sel num">518880 黄金ETF ▾</span><span style="flex:1"></span><span class="btn ghost">分歧表</span><span class="btn on">叠加图</span></div>
      <!-- overlay-chart：同 divergence 数据，客户端渲染 -->
      <div class="ochart region" data-region="overlay-chart">
        <span class="tag">overlay-chart · raw vs accurate 收盘双线 · 偏小区间缩放分辨</span>
        <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 900 260">
          <g opacity="0.2" stroke="#fff" stroke-width="0.5">
            <line x1="0" y1="65" x2="900" y2="65"/><line x1="0" y1="130" x2="900" y2="130"/><line x1="0" y1="195" x2="900" y2="195"/>
          </g>
          <polyline points="0,140 100,120 200,150 300,110 400,135 500,60 600,140 700,125 800,150 900,130" fill="none" stroke="#38bdf8" stroke-width="2"/>
          <polyline points="0,142 100,121 200,151 300,111 400,136 500,118 600,141 700,126 800,151 900,131" fill="none" stroke="#a78bfa" stroke-width="2" stroke-dasharray="6 4"/>
          <text x="16" y="30" font-size="12" fill="#38bdf8">raw 收盘</text>
          <text x="100" y="30" font-size="12" fill="#a78bfa">accurate 收盘（x=500 附近偏差 1.52% 肉眼可见）</text>
        </svg>
      </div>
    </div>
  </div>
</div>

<p class="note">样机仅表达布局/区域/尺寸与风格基调（深色交易终端风，同 01-dashboard 基线），非最终视觉设计稿。三态与交互契约见 L2 表。</p>
</body>
</html>
```

### L2 区域规格表

| 区域 id | 内容 | 数据源 | loading/空/错误态 | 交互 |
|---|---|---|---|---|
| `filter-bar` | 标的筛选、日期范围筛选、视图切换（分歧表/叠加图） | 本地状态 | 不可能空（静态控件）/ — / — | 变更即重查 divergence-table 与 accuracy-cards；视图切换替换主视图 |
| `divergence-table` | 主视图分歧表：时刻、raw 收盘价、accurate 收盘价、偏差%、raw 来源（SourceId）；默认按偏差降序；汇总行：比对 bar 总数/一致率（偏差 ≤0.5% 计一致）/最大偏差 | `GET /api/quality/divergence?code=&from=&to=` | 骨架行 / 「该范围无比对数据」（accurate 未同步时常见，提示去 sync-panel 触发补拉）/ 错误条+重试 | 点行跳行情看板对应标的对应时刻（定位上下文）；列排序 |
| `overlay-chart` | 次要视图：raw vs accurate 收盘双线叠加图 | 同 divergence-table 数据，客户端渲染 | 随分歧表 / 随分歧表 / 随分歧表 | 缩放（偏小区间肉眼难辨时用） |
| `accuracy-cards` | 源一致率排行卡：每源（TencentIfzq/SinaJsonp）在比对窗口内的一致率、平均偏差、样本数 | `GET /api/quality/source-accuracy?from=&to=` | 骨架卡 / 「该窗口无比对样本」/ 错误占位+重试 | 只读（源权重/轮转序调整的数据依据） |
| `sync-panel` | tushare 最近同步：时刻、覆盖标的、新增行数、耗时、剩余积分（醒目展示，quota 硬约束）；手动同步触发：选标的+日期范围 | `GET /api/tushare/status`；触发 `POST /api/tushare/sync {codes, from, to}` | 骨架区 / 「从未同步」占位 / 错误占位+重试；同步中显示进行中状态 | 手动触发补拉 accurate（异步任务，完成后刷新本区）；任务进行中按钮禁用 |
| `gap-report` | 历史缺口报告：缺口日期列表（哪天、缺哪些分钟段：起止时刻、缺 bar 数） | `GET /api/quality/gaps?code=&from=&to=` | 骨架行 / 「该范围无缺口」/ 错误占位+重试 | 随 filter-bar 筛选重查；只读（与页面②今日缺口率互补：②看实时，④看复盘） |

### L3 布局骨架（tangle 生成；结构+锚点+尺寸类，视觉样式手写）

``` {.tsx file=web/src/layouts/QualityGrid.tsx}
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
```

## 2. 主视图：raw vs accurate 分歧表

- 筛选：标的 + 日期范围
- 列：时刻、raw 收盘价、accurate 收盘价、偏差%、raw 来源（SourceId）
- 默认按偏差降序；汇总行：比对 bar 总数 / 一致率（偏差 ≤0.5% 计一致）/ 最大偏差
- 点行 → 跳行情看板对应标的对应时刻（定位上下文）
- 次要视图：双线叠加图（raw vs accurate 收盘线，偏小区间肉眼难辨时用缩放）

## 3. 源一致率排行卡片

- 每源（TencentIfzq / SinaJsonp）在比对窗口内的一致率、平均偏差、样本数
- 用途：源权重/轮转序调整的数据依据

## 4. tushare 同步状态区

- 最近同步：时刻、覆盖标的、新增行数、耗时、**剩余积分**（quota 硬约束，醒目展示）
- **手动同步触发**：选标的 + 日期范围 → 补拉 accurate（异步任务，完成后刷新状态区）

## 5. 历史缺口报告

- 选标的 + 日期范围 → 缺口日期列表：哪天、缺哪些分钟段（起止时刻、缺 bar 数）
- 与页面②「今日缺口率」互补：②看实时，④看复盘

## 6. 页面纪律

- **纯只读 + 同步触发；不提供任何修改数据的入口**（ADR-003：raw 层永不被修改，准确性由 merge 视图 accurate 优先保证）

## 7. API 依赖

| 用途 | 接口 |
|---|---|
| 分歧表 | `GET /api/quality/divergence?code=&from=&to=` |
| 源一致率排行 | `GET /api/quality/source-accuracy?from=&to=` |
| 同步状态 | `GET /api/tushare/status` |
| 手动同步 | `POST /api/tushare/sync {codes, from, to}`（⚠️ Wave 2 Phase A 暂缓：需数据面控制通道消费端，待父级裁决；本期前端隐藏手动触发按钮或置灰） |
| 缺口报告 | `GET /api/quality/gaps?code=&from=&to=` |

### 7.1 响应线格式（Wave 2 Phase A 后端定稿；threshold_pct 查询参数可调，默认 0.5 = consistencyThresholdPct）

- `divergence` → `{"code","from","to","threshold_pct","summary":{"compared_bars","divergent_bars","divergence_rate","consistency_rate","max_deviation_pct"},"rows":[{"ts,raw_close,accurate_close,deviation_pct,raw_source}]}`；rows 按 |偏差| 降序；无比对数据 → rows 空 + summary 比率/极值 null（空态「该范围无比对数据」+ 补拉引导）。**只比 close**（amount 跨层不可比，D4 结案）。
- `source-accuracy` → `{"from","to","threshold_pct","sources":[{"source,samples,consistency_rate,avg_deviation_pct,max_deviation_pct}]}`（一致率降序）。
- `gaps` → `{"code","from","to","days":[{"date","expected_bars","actual_bars","missing_bars","segments":[{"start","end","count","class"}]}]}`；仅含有缺口交易日（节假日/周末整日不出卡）；start/end 为 CST "HH:MM"；class ∈ `source_fault`（源故障时段）/ `upstream_no_data`（源可达无数据）/ `system_gap`（采集停摆/事件空窗，D5）。
- `tushare/status` → `{"checkpoints":[{"code,period,last_synced_date,updated_at}],"covered_codes","last_updated_at","last_event":{"ts,ok,err_kind}|null,"quota_remaining":null}`；quota 恒 null（积分余额未入库，前端渲染为 —）。

## 8. 验收（Wave 2）

- [ ] tushare 同步后，已知偏差 bar 在分歧表可见且数值与手工 SQL 对账一致
- [ ] 一致率排行随比对窗口变化正确重算
- [ ] 手动触发补拉后 accurate 行数增加、merge 视图对应时点切换为准确层值
