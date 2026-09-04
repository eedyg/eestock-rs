# 06-web / 07 — 告警中心（页面⑦，Wave 2）

> Grill P7 定稿（2026-09-02，全按推荐）。站外通知：不需要（局域网自用）。

## 1. 布局（三层法表达，规范见 00-shell.md；样板 01-dashboard.md §1）

### L1 ASCII 线框

默认视图（列表 + 规则面板双栏）：

```
┌────────────────────────────────────────────────────────────────┐
│ 顶部状态条 H=44px（shell 级，见 00-shell；critical toast        │
│ 由 shell 右上角强弹，不占本页区域）                              │
├────────┬───────────────────────────────────────────────────────┤
│ 导航栏  │ alert-filter H=48px                                   │
│ W=208px│ 级别 ▾ │ 时间范围 ▾ │ 来源 ▾                           │
│ (shell)├───────────────────────────────────────┬───────────────┤
│        │ alert-list（flex-1）                   │ rule-panel    │
│        │ 级别│来源│内容│时刻│状态│[确认]        │ W=360px       │
│        │ 聚合条目：触发计数+最近触发时刻         │ 内置规则列表： │
│        │ 未确认高亮                              │ 阈值/开关/静默 │
│        │                                       │ 时长（可调）   │
└────────┴───────────────────────────────────────┴───────────────┘
min-width: 1280px（桌面优先，不响应式）
```

### L1.5 可视化样机（静态 HTML，tangle 生成，浏览器直接打开看效果）

``` {.html file=design/06-web/preview/07-alerts.html}
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>页面⑦ 告警中心 — 布局样机</title>
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
  .body { display:flex; height:560px; }
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
  /* alert-filter */
  .fbar { height:48px; display:flex; align-items:center; gap:10px; padding:0 18px; border-bottom:1px solid var(--line); }
  .sel { height:30px; border-radius:8px; background:var(--panel2); border:1px solid var(--line);
         color:var(--dim); display:flex; align-items:center; padding:0 12px; font-size:12px; }
  .cols { display:flex; flex:1; }
  /* alert-list */
  .alist { flex:1; padding:22px 14px 8px; font-size:12px; }
  .a { display:flex; align-items:center; gap:12px; padding:9px 10px; border-radius:10px; margin-bottom:6px;
       background:var(--panel2); border:1px solid var(--line); }
  .a.unacked { border-left:3px solid var(--acc1); }
  .a.acked { opacity:.55; }
  .lvl { padding:1px 10px; border-radius:999px; font-size:11px; }
  .lvl.c { background:rgba(255,92,108,.14); color:var(--up); border:1px solid rgba(255,92,108,.4); }
  .lvl.w { background:rgba(251,191,36,.12); color:var(--warn); border:1px solid rgba(251,191,36,.35); }
  .lvl.i { background:rgba(56,189,248,.12); color:var(--acc1); border:1px solid rgba(56,189,248,.3); }
  .cnt { padding:0 8px; border-radius:999px; background:rgba(167,139,250,.15); color:var(--acc2); font-size:11px; }
  /* rule-panel */
  .rules { width:360px; border-left:1px solid var(--line); padding:22px 14px 8px; font-size:12px; color:var(--dim); }
  .rule { background:var(--panel2); border:1px solid var(--line); border-radius:10px; padding:10px 12px; margin-bottom:8px; position:relative; }
  .rule b { color:var(--txt); font-size:12px; }
  .swt { display:inline-block; width:30px; height:16px; border-radius:999px; background:rgba(0,224,164,.25);
         border:1px solid rgba(0,224,164,.5); position:relative; vertical-align:middle; }
  .swt::after { content:""; position:absolute; top:2px; right:2px; width:10px; height:10px; border-radius:50%; background:var(--down); }
  .swt.off { background:rgba(255,255,255,.06); border-color:var(--line); }
  .swt.off::after { right:auto; left:2px; background:var(--dim); }
  .note { max-width:1280px; margin:0 auto; color:var(--dim); font-size:12px; }
</style>
</head>
<body>

<div class="frame">
  <h2>默认视图 · min-width 1280 · critical toast 由 shell 右上角强弹（不占本页）</h2>
  <div class="topbar region" data-region="topbar">
    <span class="pill"><span class="dot live"></span>交易中 10:23</span>
    <span class="pill"><span class="dot live"></span>采集正常</span>
    <span class="pill">未确认告警 <b class="num up">3</b></span>
  </div>
  <div class="body">
    <div class="nav region" data-region="nav">
      <div>① 行情看板</div><div>② 数据源诊断</div><div>③ 标的管理</div>
      <div>④ 数据质量</div><div class="off">⑤ 回测 · W3</div>
      <div class="off">⑥ 交易 · W4</div><div class="on">⑦ 告警中心</div><div class="off">⑧ 设置</div>
    </div>
    <div class="page">
      <!-- alert-filter H=48 -->
      <div class="fbar region" data-region="alert-filter">
        <span class="sel">级别：全部 ▾</span>
        <span class="sel num">时间：今日 ▾</span>
        <span class="sel">来源：全部 ▾</span>
        <span style="flex:1"></span>
        <span class="pill">聚合防刷屏：同源+同规则+未恢复 → 一条</span>
      </div>
      <div class="cols">
        <!-- alert-list：GET /api/alerts?level=&from=&to=&source= + WS {type:"alert"} -->
        <div class="alist region" data-region="alert-list">
          <span class="tag">alert-list · 未确认高亮 · 「确认」=标记已读（记录确认时刻）</span>
          <div class="a unacked"><span class="lvl c">critical</span><span class="num" style="color:var(--dim)">10:18</span><span style="flex:1">腾讯qt 连续失败 3 次，已熔断</span><span class="cnt num">×1</span><span class="btn ghost">确认</span></div>
          <div class="a unacked"><span class="lvl w">warning</span><span class="num" style="color:var(--dim)">10:05</span><span style="flex:1"><span class="num">513310</span> 当日缺口率 <span class="num">7.8%</span>（&gt;5%）</span><span class="cnt num">×4</span><span class="btn ghost">确认</span></div>
          <div class="a unacked"><span class="lvl w">warning</span><span class="num" style="color:var(--dim)">09:58</span><span style="flex:1">新浪jsonp 限流信号突增（429 ×2）</span><span class="cnt num">×2</span><span class="btn ghost">确认</span></div>
          <div class="a acked"><span class="lvl i">info</span><span class="num" style="color:var(--dim)">09:47</span><span style="flex:1">腾讯qt 恢复，回到轮转序列</span><span class="cnt num">×1</span><span style="color:var(--dim)">已确认 09:50</span></div>
        </div>
        <!-- rule-panel：GET/PATCH /api/alert-rules -->
        <div class="rules region" data-region="rule-panel">
          <span class="tag">rule-panel W=360 · 内置规则：阈值/开关/静默时长可调 · 无自由规则编辑器</span>
          <div class="rule"><b>源熔断</b> <span class="lvl c">critical</span><br>阈值：连续失败 <span class="num">3</span> 次 · 静默 <span class="num">10</span> 分钟 <span class="swt" style="float:right"></span></div>
          <div class="rule"><b>缺口率</b> <span class="lvl w">warning</span><br>阈值：当日缺口率 &gt; <span class="num">5%</span>（&gt;20% 升 critical）· 静默 <span class="num">30</span> 分钟 <span class="swt" style="float:right"></span></div>
          <div class="rule"><b>限流突增</b> <span class="lvl w">warning</span><br>阈值：403/429/重置 窗口计数突增 · 静默 <span class="num">15</span> 分钟 <span class="swt" style="float:right"></span></div>
          <div class="rule"><b>分歧率超阈</b> <span class="lvl w">warning</span><br>阈值：&gt; <span class="num">0.5%</span> · 静默 <span class="num">60</span> 分钟 <span class="swt off" style="float:right"></span></div>
          <div class="rule" style="opacity:.5"><b>委托异常/废单</b> <span class="lvl w">warning</span><br>Wave 4 预留 <span class="swt off" style="float:right"></span></div>
        </div>
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
| `alert-filter` | 过滤：级别 + 时间范围 + 来源 | 本地状态 | 不可能空（静态控件）/ — / — | 变更即重查 alert-list |
| `alert-list` | 告警列表：级别/来源（源ID/标的/系统组件）/内容/时刻/状态（未确认·已确认）；**聚合防刷屏**：同源+同规则+未恢复的重复触发聚合为一条，显示触发计数与最近触发时刻；未确认高亮 | `GET /api/alerts?level=&from=&to=&source=` + WS `{type:"alert", level, ...}`（info/warning 静默入列表；critical 由 shell 右上角 toast 强弹） | 骨架行 / 「暂无告警」/ 错误条+重试 | 「确认」= 标记已读：`POST /api/alerts/{id}/ack`（记录确认时刻，持久化刷新不丢）；随 alert-filter 过滤 |
| `rule-panel` | 内置规则列表：每种告警预置规则，页面仅可调阈值、开关、静默时长（同一规则静默期内不再触发）；交易类规则 Wave 4 预留（置灰） | `GET /api/alert-rules`；调整 `PATCH /api/alert-rules`（阈值热生效） | 骨架卡 / 不可能空（内置规则预置）/ 错误占位+重试 | 阈值/开关/静默时长调整即保存热生效；不做自由规则编辑器 |

### L3 布局骨架（tangle 生成；结构+锚点+尺寸类，视觉样式手写）

``` {.tsx file=web/src/layouts/AlertsGrid.tsx}
// 由 design/06-web/07-alerts.md L3 代码块 tangle 生成，禁止手改
// 骨架职责：Props 契约 + 区域→组件映射 + 数据源/三态内联注释 + 定稿默认值；视觉样式与数据获取实现在组件内手写

/** 已定稿默认值（定稿 P7，勿改常量改文档） */
export const ALERTS_DEFAULTS = {
  levels: ['info', 'warning', 'critical'],   // 分级：info / warning / critical
  criticalToast: true,        // 站内通知：仅 critical 由 shell 右上角 toast 强弹，info/warning 静默入列表
  externalNotify: false,      // 站外通知：无（不实现邮件/Webhook，局域网自用）
  aggregateDedup: true,       // 聚合防刷屏：同源+同规则+未恢复聚合为一条（计数+最近触发时刻）
  defaultRange: 'today',      // 默认时间范围：今日
  // 内置规则阈值默认值以后端预置为准（GET /api/alert-rules 返回），不在骨架硬编码
} as const;

export type AlertLevel = 'info' | 'warning' | 'critical';

/** 页面 Props 契约 */
export interface AlertsGridProps {
  filter: { level: AlertLevel | null; from: string; to: string; source: string | null };
  onFilterChange(f: AlertsGridProps['filter']): void;   // 变更即重查 GET /api/alerts?level=&from=&to=&source=
  onAck(id: string): void;                              // 「确认」：POST /api/alerts/{id}/ack（记录确认时刻，持久化）
  onUpdateRule(id: string, patch: RulePatch): void;     // PATCH /api/alert-rules（阈值/开关/静默时长，热生效）
}

/** 规则可调项（仅这三项可调，不做自由规则编辑器） */
export interface RulePatch {
  threshold?: number;
  enabled?: boolean;
  silenceMinutes?: number;      // 静默期内同一规则不再触发
}

export function AlertsGrid(_props: AlertsGridProps) {
  // Props 契约为页面状态对外接口（09-frontend §3：store 向其对齐）；骨架本体仅承载区域锚点，
  // 不消费 props（noUnusedParameters 以 _ 前缀豁免，与其他 Grid 内联消费 props 的风格并存）。
  return (
    <div data-region="alerts" className="flex min-w-[1280px] flex-1 flex-col">

      {/* alert-filter：静态控件无三态；级别+时间范围+来源，变更即重查 */}
      <div data-region="alert-filter" className="flex h-12 items-center gap-2 border-b px-4">
        {/* <LevelFilter/> <TimeRangeFilter/> <SourceFilter/> */}
      </div>

      <div className="flex flex-1">
        {/* alert-list：GET /api/alerts + WS {type:"alert"}（critical 由 shell toast 强弹）；
            聚合防刷屏（同源+同规则+未恢复 → 一条，计数+最近时刻）；未确认高亮；
            三态=骨架行/「暂无告警」/错误条+重试 */}
        <div data-region="alert-list" className="flex-1">
          {/* <AlertList onAck/>（级别/来源/内容/时刻/状态+[确认]） */}
        </div>

        {/* rule-panel：GET/PATCH /api/alert-rules；内置规则仅阈值/开关/静默时长可调，热生效；
            交易类规则 Wave 4 预留置灰；三态=骨架卡/不可能空（内置预置）/错误占位+重试 */}
        <div data-region="rule-panel" className="w-90 border-l p-3">
          {/* <RuleList onUpdateRule/> */}
        </div>
      </div>
    </div>
  );
}
```

## 2. 告警来源

| 类别 | 触发事件 | 默认级别 |
|---|---|---|
| 数据源 | 熔断 / 恢复（info）；连续失败 N 次（warning）；限流信号突增（warning）；分歧率超阈值（warning） | 见左 |
| 采集质量 | 标的当日缺口率 >5%（warning）/ >20%（critical） | 见左 |
| 系统 | 采集服务心跳超时、DB 连接异常（critical） | critical |
| 交易（Wave 4 预留） | 委托异常/废单 | warning |

## 3. 规则配置（内置规则 + 阈值可调）

- 每种告警预置规则；页面仅可调：阈值、开关、静默时长（同一规则静默期内不再触发）
- 不做自由规则编辑器

## 4. 通知方式

- **站内**：本页列表 + WebSocket 实时 toast（仅 critical 强弹，右上角；info/warning 静默入列表）
- **站外**：无（不实现邮件/Webhook）
- 分级：info / warning / critical

## 5. 列表交互

- 列：级别 / 来源（源ID/标的/系统组件）/ 内容 / 时刻 / 状态（未确认·已确认）
- 过滤：级别 + 时间范围 + 来源
- 「确认」= 标记已读（记录确认时刻）
- **聚合防刷屏**：同源+同规则+未恢复 的重复触发聚合为一条，显示触发计数与最近触发时刻

## 6. API 依赖

| 用途 | 接口 |
|---|---|
| 告警列表 | `GET /api/alerts?level=&from=&to=&source=` |
| 确认 | `POST /api/alerts/{id}/ack` |
| 规则查询/调整 | `GET/PATCH /api/alert-rules` |
| 实时 toast | `WS /ws {type:"alert", level, ...}` |

## 7. 验收（Wave 2）

- [ ] 制造源熔断：critical toast 弹出 + 列表新增；恢复后同源重复事件聚合为一条且计数正确
- [ ] 阈值调整热生效（如缺口率 5%→10% 后，原触发场景不再告警）
- [ ] 确认状态持久化，刷新页面不丢
