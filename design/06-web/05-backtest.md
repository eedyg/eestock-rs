# 06-web / 05 — 回测工作台（页面⑤）

> Grill P5 定稿（2026-09-02）。5a 选 A（内置策略库，**全新经典策略，不移植旧项目策略**）；
> 5c 参考成熟方案（TradingView Strategy Tester / Freqtrade UI，**不参考 histview**）；其余按推荐。

## 1. 布局（三层法表达，规范见 00-shell.md；样板 01-dashboard.md §1）

### L1 ASCII 线框

单次结果视图（默认，选中已完成任务后）：

```
┌────────────────────────────────────────────────────────────────────┐
│ 顶部状态条 H=44px（shell 级，见 00-shell）                           │
├────────┬──────────────────┬────────────────────────────────────────┤
│ 导航栏  │ strategy-form    │ task-list H=140px                      │
│ W=208px│ W=320px          │ 任务：状态/进度%/当前回测日期（WS 推进度）│
│ (shell)│ 策略下拉          ├────────────────────────────────────────┤
│        │ 参数表单          │ result-overview H=40%（flex 比例）      │
│        │ 周期/手续费/滑点  │ 净值曲线+回撤曲线（双图联动，回撤着色） │
│        │ [提交回测]        ├────────────────────────────────────────┤
│        │ 网格：起:止:步长  │ metric-cards H=88px（绩效指标分组卡）   │
│        │                  ├────────────────────────────────────────┤
│        │                  │ trade-table（flex-1）交易明细，排序筛选 │
│        │                  ├────────────────────────────────────────┤
│        │                  │ period-heatmap H=180px（月/周收益热力） │
└────────┴──────────────────┴────────────────────────────────────────┘
min-width: 1280px（桌面优先，不响应式）
```

对比视图（task-list 勾选 2-N 次回测，替代结果区上部）：

```
├─ compare-view（替代 result-overview + metric-cards）──────────────┤
│ 叠加净值曲线（2-N 条）+ 指标并排表（每列一次回测）                  │
```

网格排行视图（参数网格提交后，替代结果区下部）：

```
├─ grid-rank（替代 trade-table + period-heatmap）───────────────────┤
│ 网格任务组排行表：参数组合/总收益/夏普（排序），点行进单次详情      │
```

### L1.5 可视化样机（静态 HTML，tangle 生成，浏览器直接打开看效果）

``` {.html file=design/06-web/preview/05-backtest.html}
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>页面⑤ 回测工作台 — 布局样机</title>
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
  .btn { padding:4px 12px; border-radius:8px; font-size:12px; color:var(--dim); border:1px solid transparent; }
  .btn.on { color:#fff; background:linear-gradient(135deg, var(--acc1), var(--acc2)); box-shadow:0 2px 10px rgba(56,189,248,.35); }
  .btn.ghost { border-color:var(--line); }
  .up { color:var(--up); } .down { color:var(--down); } .warn { color:var(--warn); }
  /* strategy-form */
  .sform { width:320px; border-right:1px solid var(--line); padding:16px; font-size:12px; }
  .fld { margin-bottom:12px; }
  .fld label { display:block; color:var(--dim); margin-bottom:4px; }
  .fld .inp { height:32px; border-radius:8px; background:var(--panel2); border:1px solid var(--line);
              color:var(--txt); display:flex; align-items:center; padding:0 12px; }
  .main { flex:1; display:flex; flex-direction:column; }
  /* task-list */
  .tasks { height:140px; border-bottom:1px solid var(--line); padding:22px 14px 8px; font-size:12px; color:var(--dim); }
  .task { display:flex; align-items:center; gap:12px; padding:6px 0; border-bottom:1px solid var(--line); }
  .bar { flex:1; height:6px; border-radius:999px; background:rgba(255,255,255,.06); overflow:hidden; }
  .bar i { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg, var(--acc1), var(--acc2)); }
  .st-ok { color:var(--down); } .st-run { color:var(--acc1); } .st-q { color:var(--dim); }
  /* result-overview */
  .oview { height:260px; border-bottom:1px solid var(--line); position:relative; }
  /* metric-cards */
  .mcards { display:flex; gap:8px; padding:10px 12px; border-bottom:1px solid var(--line); height:88px; }
  .mcard { flex:1; background:var(--panel2); border:1px solid var(--line); border-radius:10px;
           padding:16px 10px 6px; position:relative; font-size:11px; color:var(--dim); }
  .mcard b { display:block; font-size:15px; }
  /* trade-table */
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th { text-align:left; padding:8px 12px; color:var(--dim); font-weight:500; font-size:11px; border-bottom:1px solid var(--line); }
  td { padding:7px 12px; border-bottom:1px solid var(--line); }
  /* period-heatmap */
  .heatmap { height:180px; padding:22px 14px 10px; }
  .hm { display:grid; grid-template-columns:80px repeat(12,1fr); gap:3px; font-size:10px; color:var(--dim); margin-top:18px; }
  .hm i { height:20px; border-radius:4px; display:block; }
  .note { max-width:1280px; margin:0 auto; color:var(--dim); font-size:12px; }
</style>
</head>
<body>

<div class="frame">
  <h2>单次结果视图（默认）· min-width 1280</h2>
  <div class="topbar region" data-region="topbar">
    <span class="pill"><span class="dot live"></span>交易中 10:23</span>
    <span class="pill"><span class="dot live"></span>采集正常</span>
  </div>
  <div class="body" style="height:760px">
    <div class="nav region" data-region="nav">
      <div>① 行情看板</div><div>② 数据源诊断</div><div>③ 标的管理</div>
      <div>④ 数据质量</div><div class="on">⑤ 回测工作台</div>
      <div class="off">⑥ 交易 · W4</div><div>⑦ 告警中心</div><div class="off">⑧ 设置</div>
    </div>
    <!-- strategy-form：GET /api/backtest/strategies + POST /api/backtest/runs -->
    <div class="sform region" data-region="strategy-form">
      <span class="tag">strategy-form W=320</span>
      <div class="fld" style="margin-top:14px"><label>策略（内置 7 款，编译期注册）</label><div class="inp">双均线交叉 ▾</div></div>
      <div class="fld"><label>快线 / 慢线</label><div class="inp num">5 / 20</div></div>
      <div class="fld"><label>标的 / 周期（1m/5m/15m/日）</label><div class="inp num">518880 · 15m</div></div>
      <div class="fld"><label>手续费% / 最低费用 / 滑点 bp</label><div class="inp num">0.01% · 5元 · 2bp</div></div>
      <div class="fld"><label>参数网格（数值参数「起:止:步长」，展开任务组并发）</label><div class="inp num">快线 3:9:2</div></div>
      <span class="btn on" style="display:block;text-align:center;margin-top:16px">提交回测</span>
    </div>
    <div class="main">
      <!-- task-list：GET /api/backtest/runs + WS 推进度 -->
      <div class="tasks region" data-region="task-list">
        <span class="tag">task-list · 异步任务制 · 多任务并行 · 勾选 2-N 进对比</span>
        <div class="task"><span class="st-ok">● 完成</span><span>双均线 5/20 · 518880 15m</span><span class="num">2026-09-03 09:41</span><span class="btn ghost">查看</span></div>
        <div class="task"><span class="st-run">● 运行中</span><span>网格交易 · 518880 15m</span><span class="bar"><i style="width:63%"></i></span><span class="num">63% · 回测至 08-21</span></div>
        <div class="task"><span class="st-q">○ 排队</span><span>海龟突破 20/10 · 513310 日</span><span class="num">—</span></div>
      </div>
      <!-- result-overview：GET /api/backtest/runs/{id} -->
      <div class="oview region" data-region="result-overview">
        <span class="tag">result-overview · 净值+回撤双图联动 · 回撤区间着色（TradingView Overview 式）</span>
        <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 900 240">
          <g opacity="0.2" stroke="#fff" stroke-width="0.5"><line x1="0" y1="60" x2="900" y2="60"/><line x1="0" y1="120" x2="900" y2="120"/><line x1="0" y1="200" x2="900" y2="200"/></g>
          <polyline points="0,150 100,140 200,120 300,135 400,95 500,105 600,70 700,85 800,55 900,48" fill="none" stroke="#38bdf8" stroke-width="2"/>
          <polyline points="0,200 100,202 200,208 300,224 400,206 500,210 600,203 700,214 800,201 900,200" fill="none" stroke="#ff5c6c" stroke-width="1.5"/>
          <rect x="300" y="200" width="100" height="40" fill="#ff5c6c" opacity="0.12"/>
          <text x="16" y="26" font-size="12" fill="#38bdf8">净值 1.186</text>
          <text x="16" y="196" font-size="11" fill="#ff5c6c">回撤（最大 −7.2%，着色区间）</text>
        </svg>
      </div>
      <!-- metric-cards -->
      <div class="mcards region" data-region="metric-cards">
        <span class="tag">metric-cards · 指标口径见 design/08-backtest 单测锁定</span>
        <div class="mcard">Net Profit<b class="num up">+18.6%</b></div>
        <div class="mcard">Max Drawdown<b class="num down">−7.2%</b></div>
        <div class="mcard">Sharpe<b class="num">1.42</b></div>
        <div class="mcard">胜率<b class="num">58.3%</b></div>
        <div class="mcard">盈亏比<b class="num">1.85</b></div>
        <div class="mcard">年化<b class="num up">+24.1%</b></div>
        <div class="mcard">总交易数<b class="num">96</b></div>
        <div class="mcard">平均持仓<b class="num">3.2天</b></div>
      </div>
      <!-- trade-table -->
      <div class="region" data-region="trade-table" style="flex:1">
        <span class="tag">trade-table · 排序筛选 · 点行跳 K 线对应区间</span>
        <table>
          <tr><th>开仓时刻</th><th>开/平仓价</th><th>数量</th><th>盈亏</th><th>持仓时长</th></tr>
          <tr><td class="num">08-04 10:15</td><td class="num">2.312 → 2.405</td><td class="num">10,000</td><td class="num up">+930 (+4.0%)</td><td class="num">4天</td></tr>
          <tr><td class="num">08-12 13:45</td><td class="num">2.418 → 2.377</td><td class="num">10,000</td><td class="num down">−410 (−1.7%)</td><td class="num">2天</td></tr>
          <tr><td class="num">08-19 09:45</td><td class="num">2.355 → 2.462</td><td class="num">10,000</td><td class="num up">+1,070 (+4.5%)</td><td class="num">6天</td></tr>
        </table>
      </div>
      <!-- period-heatmap -->
      <div class="heatmap region" data-region="period-heatmap">
        <span class="tag">period-heatmap · 月/周收益热力（Freqtrade UI 式）</span>
        <div class="hm">
          <span></span><span>1月</span><span>2月</span><span>3月</span><span>4月</span><span>5月</span><span>6月</span><span>7月</span><span>8月</span><span>9月</span><span>10月</span><span>11月</span><span>12月</span>
          <span>2026</span>
          <i style="background:rgba(0,224,164,.15)"></i><i style="background:rgba(0,224,164,.4)"></i><i style="background:rgba(255,92,108,.25)"></i>
          <i style="background:rgba(0,224,164,.55)"></i><i style="background:rgba(0,224,164,.25)"></i><i style="background:rgba(255,92,108,.4)"></i>
          <i style="background:rgba(0,224,164,.3)"></i><i style="background:rgba(0,224,164,.6)"></i><i style="background:rgba(255,255,255,.04)"></i>
          <i style="background:rgba(255,255,255,.04)"></i><i style="background:rgba(255,255,255,.04)"></i><i style="background:rgba(255,255,255,.04)"></i>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="frame">
  <h2>对比视图 · task-list 勾选 2-N 次 · compare-view 替代结果区上部</h2>
  <div class="body" style="height:380px">
    <div class="nav region"><div class="on">⑤ 回测工作台</div></div>
    <div class="main">
      <!-- compare-view：GET /api/backtest/compare?ids= -->
      <div class="oview region" data-region="compare-view" style="flex:1">
        <span class="tag">compare-view · 叠加净值曲线 + 指标并排表</span>
        <svg width="100%" height="60%" preserveAspectRatio="none" viewBox="0 0 900 160">
          <polyline points="0,120 150,110 300,95 450,105 600,70 750,80 900,50" fill="none" stroke="#38bdf8" stroke-width="2"/>
          <polyline points="0,120 150,125 300,100 450,118 600,90 750,70 900,75" fill="none" stroke="#a78bfa" stroke-width="2"/>
          <text x="16" y="24" font-size="11" fill="#38bdf8">双均线 5/20 +18.6%</text>
          <text x="180" y="24" font-size="11" fill="#a78bfa">网格交易 +15.2%</text>
        </svg>
        <table style="margin-top:8px">
          <tr><th>指标</th><th>双均线 5/20</th><th>网格交易</th></tr>
          <tr><td>Sharpe</td><td class="num">1.42</td><td class="num">1.31</td></tr>
          <tr><td>Max Drawdown</td><td class="num down">−7.2%</td><td class="num down">−4.1%</td></tr>
        </table>
      </div>
    </div>
  </div>
</div>

<div class="frame">
  <h2>网格排行视图 · 参数网格提交后 · grid-rank 替代结果区下部</h2>
  <div class="body" style="height:300px">
    <div class="nav region"><div class="on">⑤ 回测工作台</div></div>
    <div class="main">
      <!-- grid-rank：GET /api/backtest/runs（任务组） -->
      <div class="region" data-region="grid-rank" style="flex:1;padding-top:20px">
        <span class="tag">grid-rank · 网格任务组排行（按总收益/夏普排序）· 点行进单次详情</span>
        <table>
          <tr><th>#</th><th>参数组合</th><th>总收益</th><th>夏普</th><th>最大回撤</th></tr>
          <tr><td class="num">1</td><td class="num">快线7 / 慢线20</td><td class="num up">+21.3%</td><td class="num">1.55</td><td class="num down">−6.0%</td></tr>
          <tr><td class="num">2</td><td class="num">快线5 / 慢线20</td><td class="num up">+18.6%</td><td class="num">1.42</td><td class="num down">−7.2%</td></tr>
          <tr><td class="num">3</td><td class="num">快线9 / 慢线20</td><td class="num up">+14.9%</td><td class="num">1.28</td><td class="num down">−5.5%</td></tr>
          <tr><td class="num">…</td><td colspan="4" style="color:var(--dim)">3×3 网格 = 9 任务并发</td></tr>
        </table>
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
| `strategy-form` | 策略下拉（内置 7 款）+ 参数表单（schema 驱动）、周期（1m/5m/15m/日）、手续费%/最低费用/滑点 bp、参数网格「起:止:步长」、提交按钮 | `GET /api/backtest/strategies`（策略清单+参数 schema）；提交 `POST /api/backtest/runs` | 骨架表单 / 不可能空（内置策略编译期注册，清单必有 7 款）/ 加载失败错误占位+重试；提交错误内联提示 | 选策略动态渲染参数表单；提交后入队（异步任务制，页面不阻塞）；网格参数展开为任务组并发 |
| `task-list` | 任务列表：状态（排队/运行中/完成/失败）、进度百分比、当前回测日期 | `GET /api/backtest/runs` + WS 进度推送 | 骨架行 / 「暂无回测任务，从左侧提交」引导 / 错误条+重试 | 点已完成任务载入结果区；勾选 2-N 次进 compare-view；多任务并行 |
| `result-overview` | 净值曲线 + 回撤曲线（双图联动，回撤区间着色，TradingView Overview 式） | `GET /api/backtest/runs/{id}`（净值序列） | 骨架图 / 「选择已完成任务查看结果」占位（未选中任务时）/ 错误占位+重试 | 双图联动缩放 |
| `metric-cards` | 绩效指标分组卡：Net Profit / Max Drawdown / Sharpe / 胜率 / 盈亏比 / 年化 / 总交易数 / 平均持仓周期 | `GET /api/backtest/runs/{id}`（指标；口径在 design/08-backtest 定义并单测锁定） | 骨架卡 / 随 result-overview / 错误占位+重试 | 只读 |
| `trade-table` | 交易明细：每笔开平仓时刻/价格/数量/盈亏/持仓时长，排序筛选（Trades analysis 式） | `GET /api/backtest/runs/{id}`（交易序列） | 骨架行 / 「本次回测无交易」/ 错误占位+重试 | 排序筛选；点行跳转 K 线对应区间查看上下文 |
| `period-heatmap` | 按月/周收益热力表（Freqtrade UI 式，发现策略季节性） | `GET /api/backtest/runs/{id}` 净值序列客户端聚合 | 随 result-overview / 「数据不足一月」占位 / 随 result-overview | 月/周粒度切换 |
| `compare-view` | 2-N 次回测叠加净值曲线 + 指标并排表 | `GET /api/backtest/compare?ids=` | 骨架图 / 「至少勾选 2 次已完成回测」占位 / 错误占位+重试 | task-list 勾选触发；退出回单次视图 |
| `grid-rank` | 参数网格任务组排行表：参数组合/总收益/夏普等，按总收益/夏普排序 | `GET /api/backtest/runs`（网格任务组） | 骨架行 / 「无网格任务组」/ 错误条+重试 | 点行进该参数组合的单次详情（回单次结果视图）；不做智能寻优 |

### L3 布局骨架（tangle 生成；结构+锚点+尺寸类，视觉样式手写）

``` {.tsx file=web/src/layouts/BacktestGrid.tsx}
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
```

## 2. 策略形态（定稿 5a-A）

- Rust 实现 `Strategy` trait、编译期注册；页面下拉选策略 + 参数表单
- 新策略 = 一次代码迭代（文学式 design/08-backtest + TDD），非页面配置

### 内置策略清单（Wave 3 首批 7 个，经典热门款）

| # | 策略 | 说明 | 核心参数 |
|---|---|---|---|
| 1 | 双均线交叉 | 快/慢 EMA(SMA) 金叉买死叉卖 | 快线5/慢线20 |
| 2 | MACD 交叉 | DIF/DEA 金叉死叉 | 12/26/9 |
| 3 | BOLL 均值回归 | 触下轨买、回中轨卖（破下轨止损） | 20/2σ |
| 4 | RSI 超买超卖 | RSI<30 买、>70 卖 | 14/30/70 |
| 5 | KDJ 交叉 | K/D 低位金叉买、高位死叉卖 | 9/3/3 |
| 6 | **网格交易** | 价格区间内等距布买卖格（ETF 高频使用场景，518880 类标的刚需） | 区间上下沿/格数/每格金额 |
| 7 | 海龟突破 | N 日 Donchian 通道突破买、M 日反向突破卖 | 20/10 |

## 3. 执行形态（定稿）

- **异步任务制**：提交 → 队列 → 后台执行 → 任务列表（状态/进度百分比/当前回测日期）→ 完成查看；页面不阻塞，多任务并行

## 4. 结果展示（定稿：参考 TradingView Strategy Tester + Freqtrade UI）

布局对标成熟方案，四区：
1. **概览区**：净值曲线 + 回撤曲线（双图联动，回撤区间着色）——TradingView "Overview" 式
2. **绩效指标分组卡**（Net Profit / Max Drawdown / Sharpe / 胜率 / 盈亏比 / 年化 / 总交易数 / 平均持仓周期）——指标口径在 design/08-backtest 定义并单测锁定
3. **交易明细表**：每笔开平仓时刻/价格/数量/盈亏/持仓时长，排序筛选（TradingView "Trades analysis" 式）；点行跳转 K线对应区间查看上下文
4. **周期分析**：按月/周收益热力表（Freqtrade UI 式，发现策略季节性）
- **多次回测对比**：选 2-N 次叠加净值曲线 + 指标并排表

## 5. 回测输入（定稿）

- 数据：merge 视图（准确层优先，ADR-003）；周期 1m/5m/15m/日
- 手续费/滑点可配：费率%、最低费用、滑点 bp；默认值与旧系统口径一致（便于新旧引擎交叉验证）

## 6. 参数网格（定稿：简单版）

- 数值参数支持「起:止:步长」→ 展开任务组并发 → 结果排行表（按总收益/夏普排序，点行进详情）
- 不做智能寻优

## 7. API 依赖

| 用途 | 接口 |
|---|---|
| 策略清单+参数 schema | `GET /api/backtest/strategies` |
| 提交回测/网格 | `POST /api/backtest/runs` |
| 任务列表/进度 | `GET /api/backtest/runs`（WS 推进度） |
| 结果详情 | `GET /api/backtest/runs/{id}`（净值序列+交易+指标） |
| 对比 | `GET /api/backtest/compare?ids=` |

## 8. 验收（Wave 3）

- [ ] 7 个内置策略各有 golden 数据回测单测（固定输入→固定输出，指标口径锁定）
- [ ] 同一参数新旧引擎（旧 Go 回测）对账：双均线策略在相同时段交易点一致率 100%（交叉验证旧系统遗产正确性）
- [ ] 网格参数 3×3 展开为 9 任务并发完成，排行表正确
