# 06-web / 02 — 数据源诊断面板（页面②）

> Grill P2 定稿（2026-09-02，全按推荐）。diagnose 系统的 Web 门面。

## 1. 布局（三层法表达，规范见 00-shell.md；样板 01-dashboard.md §1）

### L1 ASCII 线框

默认视图（详情区折叠，卡片墙为主）：

```
┌────────────────────────────────────────────────────────────────┐
│ 顶部状态条 H=44px（shell 级，见 00-shell）                       │
├────────┬───────────────────────────────────────────────────────┤
│ 导航栏  │ summary-bar H=56px                                    │
│ W=208px│ 1m源2/2 · 快照池健康 · 系统状态灯 · 运行时长 · 交易时段 │
│ (shell)├───────────────────────────────────────────────────────┤
│        │ source-cards（卡片墙 flex-wrap，每卡 W=280 H=140）      │
│        │ 状态灯+角色+成功率+延迟+错误摘要 [+熔断源复位按钮]      │
│        ├───────────────────────────────────────────────────────┤
│        │ gap-cards（单标的缺口摘要：标的选择器+GapReportList，随窗口滚动）     │
│        ├───────────────────────────────────────────────────────┤
│        │ alert-preview H=160px（最近 10 条告警，只读）           │
└────────┴───────────────────────────────────────────────────────┘
min-width: 1280px（桌面优先，不响应式）
```

详情展开视图（点击 source-cards 某卡，detail-panel 展开于卡片墙与缺口区之间）：

```
├───────────────────────────────────────────────────────┤
│ source-cards（同上，选中卡高亮描边）                    │
├─ detail-panel H=320px ────────────────────────────────┤
│ ┌ 成功率/延迟时序曲线 ECharts（flex-1）┐┌ 事件流水 W=40% ┐│
│ │ 范围切换 1h/今日/3日                 ││ 最近50条        ││
│ ├ 分歧率统计行 H=48 ──────────────────┤│ 带 Trace ID    ││
│ ├ 限流计数器组 H=48：403/429/连接重置 ─┤│ 点击可复制      ││
│ └──────────────────────────────────────┘└───────────────┘│
├───────────────────────────────────────────────────────┤
│ gap-cards / alert-preview（同上，整体下移）             │
```

### L1.5 可视化样机（静态 HTML，tangle 生成，浏览器直接打开看效果）

``` {.html file=design/06-web/preview/02-sources.html}
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>页面② 数据源诊断 — 布局样机</title>
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
  .d-warn { background:var(--warn); box-shadow:0 0 8px #fbbf24aa; }
  .d-crit { background:var(--up); box-shadow:0 0 8px #ff5c6caa; animation:pulse 2s infinite; }
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
  .btn.danger { color:var(--up); border:1px solid rgba(255,92,108,.4); }
  .up { color:var(--up); } .down { color:var(--down); } .warn { color:var(--warn); }
  /* summary-bar */
  .sumbar { height:56px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; padding:0 18px; }
  /* source-cards */
  .cards { display:flex; flex-wrap:wrap; gap:10px; padding:12px; border-bottom:1px solid var(--line); }
  .card { width:280px; height:140px; background:var(--panel2); border:1px solid var(--line); border-radius:12px;
          padding:24px 12px 10px; position:relative; font-size:12px; color:var(--dim); }
  .card b { color:var(--txt); font-size:13px; }
  .card.sel { outline:1px solid rgba(56,189,248,.5); box-shadow:0 0 16px rgba(56,189,248,.2); }
  .role { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; margin-left:6px;
          background:rgba(56,189,248,.12); color:var(--acc1); border:1px solid rgba(56,189,248,.3); }
  .role.off { background:rgba(255,92,108,.12); color:var(--up); border-color:rgba(255,92,108,.35); }
  /* detail-panel */
  .detail { height:320px; display:flex; border-bottom:1px solid var(--line); }
  .dleft { flex:1; display:flex; flex-direction:column; border-right:1px solid var(--line); }
  .dchart { flex:1; position:relative; }
  .drow { height:48px; border-top:1px solid var(--line); display:flex; align-items:center; gap:16px; padding:0 14px; font-size:12px; color:var(--dim); position:relative; }
  .dstream { width:40%; padding:24px 14px 8px; font-size:12px; color:var(--dim); position:relative; }
  .dstream div { padding:4px 0; border-bottom:1px solid var(--line); }
  /* gap-cards / alert-preview */
  .gaps { display:flex; flex-wrap:wrap; gap:10px; padding:12px; border-bottom:1px solid var(--line); }
  .gap { width:200px; height:88px; background:var(--panel2); border:1px solid var(--line); border-radius:12px;
         padding:22px 12px 8px; position:relative; font-size:12px; color:var(--dim); }
  .gap.w { border-color:rgba(251,191,36,.45); box-shadow:inset 0 0 18px rgba(251,191,36,.08); }
  .gap.c { border-color:rgba(255,92,108,.5); box-shadow:inset 0 0 18px rgba(255,92,108,.1); }
  .alerts { height:160px; padding:24px 14px 8px; font-size:12px; color:var(--dim); position:relative; }
  .alerts div { padding:4px 0; border-bottom:1px solid var(--line); }
  .note { max-width:1280px; margin:0 auto; color:var(--dim); font-size:12px; }
</style>
</head>
<body>

<div class="frame">
  <h2>默认视图（详情区折叠）· min-width 1280</h2>
  <div class="topbar region" data-region="topbar">
    <span class="pill"><span class="dot live"></span>交易中 10:23</span>
    <span class="pill"><span class="dot live"></span>采集正常</span>
    <span class="pill">1m 源健康 <b class="num">2/2</b></span>
  </div>
  <div class="body">
    <div class="nav region" data-region="nav">
      <div>① 行情看板</div><div class="on">② 数据源诊断</div><div>③ 标的管理</div>
      <div class="off">④ 数据质量 · W2</div><div class="off">⑤ 回测 · W3</div>
      <div class="off">⑥ 交易 · W4</div><div class="off">⑦ 告警 · W2</div><div class="off">⑧ 设置</div>
    </div>
    <div class="page">
      <!-- summary-bar H=56：GET /api/sources/health + WS source_health -->
      <div class="sumbar region" data-region="summary-bar">
        <span class="pill">1m源 <b class="num">2/2</b></span>
        <span class="pill">快照池 <b class="num">5/5</b></span>
        <span class="pill"><span class="dot live"></span>系统正常</span>
        <span class="pill">采集运行 <b class="num">3天 04:12</b></span>
        <span class="pill">盘中 · 连续竞价</span>
      </div>
      <!-- source-cards：GET /api/sources/health + WS source_health；复位 POST /api/sources/{id}/reset -->
      <div class="cards region" data-region="source-cards">
        <span class="tag">source-cards · 每源一卡 · WS 变更时闪烁</span>
        <div class="card">
          <b>腾讯ifzq</b><span class="role">1m全速</span><br>
          <span class="dot live"></span>健康 · 成功率 <b class="num down">99.2%</b>（1h）· P50 <span class="num">180ms</span><br>
          最近错误：无
        </div>
        <div class="card">
          <b>新浪jsonp</b><span class="role">1m全速</span><br>
          <span class="dot d-warn"></span>降级 · 成功率 <b class="num warn">91.5%</b>（1h）· P50 <span class="num">420ms</span><br>
          10:21 超时（已重试成功）
        </div>
        <div class="card">
          <b>腾讯qt</b><span class="role off">熔断中</span><br>
          <span class="dot d-crit"></span>熔断 · 连续失败 <span class="num">3</span> 次 · 10:18 连接重置<br>
          <span class="btn danger" style="margin-top:4px;display:inline-block">手动复位</span>
        </div>
        <div class="card">
          <b>push2delay（东财系）</b><span class="role">快照心跳</span><br>
          <span class="dot live"></span>健康 · 轮转序末位（ADR-006）<br>
          最近错误：无
        </div>
      </div>
      <!-- gap-cards：GET /api/collection/gaps?date=today -->
      <div class="gaps region" data-region="gap-cards">
        <span class="tag">gap-cards · 当日 1m 缺口率 · &gt;5% 黄、&gt;20% 红</span>
        <div class="gap"><b style="color:var(--txt)" class="num">518880</b> 黄金ETF<br>应有 <span class="num">205</span> / 实有 <span class="num">205</span><br>缺口率 <b class="num down">0.0%</b></div>
        <div class="gap w"><b style="color:var(--txt)" class="num">513310</b> 纳指ETF<br>应有 <span class="num">205</span> / 实有 <span class="num">189</span><br>缺口率 <b class="num warn">7.8%</b></div>
        <div class="gap c"><b style="color:var(--txt)" class="num">159776</b> 港股通医药<br>应有 <span class="num">205</span> / 实有 <span class="num">150</span><br>缺口率 <b class="num up">26.8%</b></div>
      </div>
      <!-- alert-preview：GET /api/alerts?limit=10（页面⑦接口复用，只读） -->
      <div class="alerts region" data-region="alert-preview">
        <span class="tag">alert-preview H=160 · 最近 10 条只读 · 完整配置在页面⑦</span>
        <div><span class="up">●</span> 10:18 腾讯qt 连续失败 3 次，已熔断</div>
        <div><span class="warn">●</span> 10:05 <span class="num">159776</span> 当日缺口率 <span class="num">26.8%</span>（&gt;20%）</div>
        <div><span class="down">●</span> 09:47 新浪jsonp 恢复，回到轮转序列</div>
      </div>
    </div>
  </div>
</div>

<div class="frame">
  <h2>详情展开视图 · 点击卡片 · detail-panel H=320</h2>
  <div class="body">
    <div class="nav region"><div class="on">② 数据源诊断</div></div>
    <div class="page">
      <div class="sumbar region"><span class="pill">1m源 <b class="num">2/2</b></span><span class="pill">快照池 <b class="num">5/5</b></span><span class="pill"><span class="dot d-warn"></span>任一1m源熔断→🟡</span></div>
      <div class="cards region">
        <div class="card sel"><b>腾讯qt</b><span class="role off">熔断中</span><br><span class="dot d-crit"></span>熔断 · 连续失败 3 次<br><span class="btn danger" style="margin-top:4px;display:inline-block">手动复位</span></div>
        <div class="card"><b>腾讯ifzq</b><br><span class="dot live"></span>健康</div>
        <div class="card"><b>新浪jsonp</b><br><span class="dot d-warn"></span>降级</div>
      </div>
      <!-- detail-panel：GET metrics/events/divergence -->
      <div class="detail region" data-region="detail-panel">
        <div class="dleft">
          <div class="dchart">
            <span class="tag">成功率/延迟时序 ECharts · 范围 <span class="btn on">1h</span> <span class="btn ghost">今日</span> <span class="btn ghost">3日</span></span>
            <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 500 160" style="margin-top:22px">
              <g opacity="0.2" stroke="#fff" stroke-width="0.5">
                <line x1="0" y1="40" x2="500" y2="40"/><line x1="0" y1="80" x2="500" y2="80"/><line x1="0" y1="120" x2="500" y2="120"/>
              </g>
              <polyline points="0,18 60,22 120,20 180,26 240,140 300,150 360,146 420,148 500,142" fill="none" stroke="#38bdf8" stroke-width="2"/>
              <text x="10" y="14" font-size="11" fill="#38bdf8">成功率%（x=240 起熔断跌落）</text>
            </svg>
          </div>
          <div class="drow"><span class="tag" style="top:2px">分歧率统计</span>与腾讯锚分歧：DIVERGE <b class="num warn">12</b> bar（&gt;0.5% 口径，028 cross 线上化）</div>
          <div class="drow"><span class="tag" style="top:2px">限流计数器组</span>403 ×<span class="num">0</span> · 429 ×<span class="num warn">2</span> · 连接重置 ×<span class="num up">5</span>（封禁观测点）</div>
        </div>
        <div class="dstream">
          <span class="tag">事件流水 · 最近 50 条 · Trace ID 点击可复制</span>
          <div>10:18:42 <span class="up">熔断</span> <span class="num">trace:9f3c…a1</span></div>
          <div>10:18:41 <span class="up">失败</span> 连接重置 <span class="num">trace:9f3c…9e</span></div>
          <div>10:17:02 <span class="warn">失败</span> 超时 <span class="num">trace:8b21…77</span></div>
          <div>10:15:59 <span class="warn">限流</span> 429 <span class="num">trace:8b1f…02</span></div>
        </div>
      </div>
      <div class="gaps region"><div class="gap"><b style="color:var(--txt)" class="num">518880</b> 缺口率 <b class="num down">0.0%</b></div></div>
      <div class="alerts region"><div><span class="up">●</span> 10:18 腾讯qt 已熔断</div></div>
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
| `summary-bar` | 1m 可用源/总数、快照池健康/总数、系统状态灯（任一 1m 源熔断🟡/全部熔断🔴）、采集运行时长、当前交易时段 | `GET /api/sources/health` + WS `{type:"source_health"}`；交易时段为客户端计算（时段写死 09:30-11:30/13:00-15:00） | 骨架条 / 不可能空（采集服务在线即有计数；服务宕机由 shell 状态灯表达）/ 顶部错误条+重试 | 只读展示 |
| `source-cards` | 每源一卡：状态灯（🟢健康/🟡降级/🔴熔断）、角色标签（1m全速/快照心跳/熔断中）、近 1h 成功率、P50 延迟、最近错误摘要（含时刻）；熔断源附手动复位按钮 | `GET /api/sources/health` + WS `{type:"source_health"}` 推送变更；复位 `POST /api/sources/{id}/reset` | 骨架卡 / 「无数据源配置」占位（内置源编译期注册，正常不可能空）/ 错误占位+重试 | 点卡展开/折叠 detail-panel（选中高亮）；WS 状态变化卡片闪烁+状态迁移动画；复位点击立即摘除熔断、回到轮转序列（操作记录进事件流水） |
| `detail-panel` | 成功率/延迟时序曲线（ECharts，范围 1h/今日/3日）；事件流水最近 50 条（成功/失败/限流/熔断，带 Trace ID）；分歧率统计（与腾讯锚 >0.5% 记 DIVERGE）；限流计数器组（403/429/连接重置累计） | `GET /api/sources/{id}/metrics?range=` / `GET /api/sources/{id}/events?limit=50` / `GET /api/sources/{id}/divergence?range=` | 骨架图+骨架行 / 「该范围无事件」占位 / 错误占位+重试 | 范围切换重查；Trace ID 点击复制；再次点卡或关闭折叠 |
| 缺口摘要 | 单标的近 7 日缺口日/分钟段（复用页面④ GapReportList 形态；标的选择器默认首个） | `GET /api/quality/gaps?code=&from=&to=`（00-web-api §1.1，单 code） | 骨架行 / 「该范围无缺口」占位 / 错误占位+重试 | 标的选择切换即重查；只读（注：标的级全量缺口归页面④，本页只作单标的信息参考） |
| `alert-preview` | 最近 10 条告警事件流（只读预览；完整规则配置在页面⑦，Wave 2） | `GET /api/alerts?limit=10`（复用页面⑦接口；⚠️ 本页 §8 API 依赖节未列此端点，见「待裁决」） | 骨架行 / 「暂无告警」占位 / 错误占位+重试 | 只读；点击是否跳页面⑦待裁决 |

### L3 布局骨架（tangle 生成；结构+锚点+尺寸类，视觉样式手写）

``` {.tsx file=web/src/layouts/SourcesGrid.tsx}
// 由 design/06-web/02-sources.md L3 代码块 tangle 生成，禁止手改
// 骨架职责：Props 契约 + 区域→组件映射 + 数据源/三态内联注释 + 定稿默认值；视觉样式与数据获取实现在组件内手写

/** 已定稿默认值（定稿 P2，勿改常量改文档） */
export const SOURCES_DEFAULTS = {
  successRateWindow: '1h',        // 卡片成功率统计窗口：近 1h
  detailRange: '1h',              // 详情曲线默认范围：'1h' | 'today' | '3d'
  eventLimit: 50,                 // 事件流水条数
  alertPreviewLimit: 10,          // 告警预览条数（只读）
  gapRangeDays: 7,                // 缺口摘要窗口：近 7 个自然日（单标的，方案 A）
  divergenceThresholdPct: 0.5,    // 与腾讯锚分歧 >0.5% 记 DIVERGE
} as const;

export type DetailRange = '1h' | 'today' | '3d';

/** 页面 Props 契约 */
export interface SourcesGridProps {
  selectedSource: string | null;                 // 当前展开详情的源 id，null=折叠
  onSelectSource(id: string | null): void;       // 点卡展开/折叠 detail-panel
  detailRange: DetailRange;
  onDetailRangeChange(r: DetailRange): void;     // 详情曲线范围切换
  onResetCircuit(id: string): void;              // 熔断源手动复位：POST /api/sources/{id}/reset
}

export function SourcesGrid(props: SourcesGridProps) {
  return (
    <div data-region="sources" className="flex min-w-[1280px] flex-1 flex-col">

      {/* summary-bar：GET /api/sources/health + WS source_health；交易时段客户端计算；
          三态=骨架条/不可能空（服务在线即有计数）/错误条+重试；只读 */}
      <div data-region="summary-bar" className="h-14 border-b">
        {/* <SourcesSummaryBar/> */}
      </div>

      {/* source-cards：同 summary-bar 数据源；每源一卡，熔断卡附 <CircuitResetButton onResetCircuit/>；
          WS 状态变化卡片闪烁+迁移动画；三态=骨架卡/「无数据源配置」占位/错误占位+重试 */}
      <div data-region="source-cards" className="flex flex-wrap gap-2 border-b p-2">
        {/* <SourceCard/> ×N（选中卡高亮描边） */}
      </div>

      {props.selectedSource && (
        /* detail-panel：GET /api/sources/{id}/metrics?range= + events?limit=50 + divergence?range=；
            三态=骨架图+骨架行/「该范围无事件」占位/错误占位+重试 */
        <div data-region="detail-panel" className="flex h-80 border-b">
          {/* <MetricsChart range/>（flex-1） <DivergenceRow/> <RateLimitCounters/> */}
          {/* <EventStream limit=50/> W=40%（Trace ID 点击可复制） */}
        </div>
      )}

      {/* gap-cards（单标的缺口摘要）：GET /api/quality/gaps?code=&from=&to=（单 code，方案 A 裁决）；
          标的选择器复用 symbols 列表默认首个；三态=骨架行/「该范围无缺口」/错误占位+重试；只读 */}
      <div data-region="gap-cards" className="border-b p-2">
        {/* <GapCards symbols selectedCode slice onSelectCode onRetry/>（复用页面④ GapReportList 形态） */}
      </div>

      {/* alert-preview：GET /api/alerts?limit=10（复用页面⑦接口）只读；
          三态=骨架行/「暂无告警」/错误占位+重试 */}
      <div data-region="alert-preview" className="h-40">
        {/* <AlertPreviewList/> */}
      </div>
    </div>
  );
}
```

## 2. 全局汇总条（页顶）

- 1m 可用源数/总数（如 `1m源 2/2`）、快照池健康数/总数、系统整体状态灯（任一 1m 源熔断→🟡，全部熔断→🔴）、采集服务运行时长、当前交易时段状态（盘中/午休/闭市）

## 3. 源健康卡片墙

每源一张卡（腾讯ifzq/新浪jsonp/腾讯qt/新浪hq/同花顺/push2delay/交易所）：
- 状态灯：🟢健康 / 🟡降级 / 🔴熔断
- 当前角色标签：`1m全速` / `快照心跳` / `熔断中`
- 最近成功率（窗口：近 1h）、最近延迟（P50）
- 最近错误摘要（一条，含时刻）
- WS 状态变化时卡片闪烁提示 + 状态迁移动画

## 4. 详情区（点卡展开，ECharts）

- 成功率 / 延迟时间序列曲线（范围切换：1h / 今日 / 3 日）
- 事件流水：最近 50 条（成功/失败/限流/熔断），**带 Trace ID**（点击可复制）
- 分歧率统计：与腾讯锚的价格分歧（>0.5% 记 DIVERGE，028 cross 口径线上化）
- **限流信号计数器组**：403 / 429 / 连接重置 各自累计次数（封禁观测点）

## 5. 熔断控制

- 熔断源显示**手动复位按钮**（点击立即摘除熔断、回到轮转序列；操作记录进事件流水）

## 6. 采集质量区（单标的缺口摘要，方案 A 裁决）

- **单标的缺口摘要**：随上方标的选择器所选标的，展示近 7 个自然日（CST）内 `GET /api/quality/gaps?code=&from=&to=` 的单 code 缺口日/分钟段；复用页面④ `GapReportList` 形态（DRY）。
- **标的选择器**：复用 symbols 列表（页面①/④ 同源），默认选首个/上一标的（非任意）。
- 三态：骨架行 / 「该范围无缺口」占位 / 错误占位+重试。
- 缺口判定口径：工作日 + 09:30-11:30/13:00-15:00（Wave 1 简化，节假日噪音接受）；**标的级全量缺口归页面④**（04-quality §5 复盘口径），本页只作该标的信息参考。

> 设计契约修正（2026-09-04 走查修复）：原稿「每标的当日 1m 缺口率小卡墙」为设计稿超纲/错配——`/api/collection/gaps?date=today` 无可落地契约（ADR-014：契约以可实现为准），真实缺口端点仅单 code（00-web-api §1.1）。页②定位源健康诊断，标的级缺口归页面④质量域，故降级为单标的摘要。

## 7. 告警预览

- 页底内嵌最近 10 条告警事件流（只读预览；完整规则配置在页面⑦，Wave 2）

## 8. API 依赖

| 用途 | 接口 |
|---|---|
| 汇总+卡片 | `GET /api/sources/health`（WS `{type:"source_health"}` 推送变更） |
| 详情曲线/事件 | `GET /api/sources/{id}/metrics?range=` / `GET /api/sources/{id}/events?limit=50` |
| 分歧率 | `GET /api/sources/{id}/divergence?range=` |
| 熔断复位 | `POST /api/sources/{id}/reset` |
| 缺口摘要（单标的） | `GET /api/quality/gaps?code=&from=&to=`（单 code，00-web-api §1.1；标的级全量缺口归页面④） |

## 9. 验收（Wave 1）

- [ ] 杀掉腾讯源：卡片 🔴 + 汇总条 🟡 + WS 闪烁，事件流水出现熔断记录（带 Trace ID）
- [ ] 手动复位后源回到轮转，下周期恢复采集
- [ ] 缺口摘要与 DB 实际 bar 数一致（对账测试；单标的近 7 日窗口）
