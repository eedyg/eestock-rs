# 06-web / 08 — 系统设置（页面⑧，拆入各波次）

> Grill P8 定稿（2026-09-02，全按推荐）。

## 1. 布局（三层法表达，规范见 00-shell.md；样板 01-dashboard.md §1）

### L1 ASCII 线框

默认视图（左侧分组锚点导航 + 右侧分组区块纵向排列，滚动定位）：

```
┌────────────────────────────────────────────────────────────────┐
│ 顶部状态条 H=44px（shell 级，见 00-shell）                       │
├────────┬───────────────┬────────────────────────────────────────┤
│ 导航栏  │ settings-nav  │ 内容列（flex-1，纵向滚动）             │
│ W=208px│ W=180px       │ ┌─ source-config ────────────────────┐ │
│ (shell)│ 分组锚点：     │ │ 轮转序拖拽排序（东财系末位锁定）     │ │
│        │ ·数据源       │ │ 每源参数（速率/抖动/熔断次数/退避）  │ │
│        │ ·采集         │ │ 每源启停开关                        │ │
│        │ ·MCP          │ ├─ collector-config ──────────────────┤ │
│        │ ·系统信息     │ │ 全局默认抓取间隔；交易时段写死只读    │ │
│        │ ·日志         │ ├─ mcp-config ────────────────────────┤ │
│        │ ·危险操作     │ │ 总开关/交易工具开关(二次确认)/限额    │ │
│        │               │ ├─ system-info H=120 ─────────────────┤ │
│        │               │ │ 版本/crate版本/DB状态/运行时长       │ │
│        │               │ ├─ log-viewer H=240 ──────────────────┤ │
│        │               │ │ tail 日志 + 级别过滤（WS 推送）      │ │
│        │               │ ├─ danger-zone（红色边框）─────────────┤ │
│        │               │ │ 清空 kline_raw / 全部熔断重置        │ │
│        │               │ │ （二次确认，需 confirm 字段）        │ │
└────────┴───────────────┴────────────────────────────────────────┘
min-width: 1280px（桌面优先，不响应式）
```

### L1.5 可视化样机（静态 HTML，tangle 生成，浏览器直接打开看效果）

``` {.html file=design/06-web/preview/08-settings.html}
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>页面⑧ 系统设置 — 布局样机</title>
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
  .btn.danger { color:var(--up); border:1px solid rgba(255,92,108,.45); }
  .up { color:var(--up); } .down { color:var(--down); } .warn { color:var(--warn); }
  /* settings-nav */
  .snav { width:180px; border-right:1px solid var(--line); padding:14px 10px; }
  .snav div { padding:8px 12px; margin:2px 0; border-radius:8px; color:var(--dim); font-size:12px; }
  .snav .on { color:#fff; background:rgba(56,189,248,.1); outline:1px solid rgba(56,189,248,.3); }
  .snav .danger { color:var(--up); }
  .content { flex:1; padding:14px 18px; }
  .sec { background:var(--panel2); border:1px solid var(--line); border-radius:12px;
         padding:24px 16px 14px; margin-bottom:14px; position:relative; font-size:12px; color:var(--dim); }
  .sec h4 { margin:0 0 10px; font-size:13px; color:var(--txt); }
  .sec.danger { border-color:rgba(255,92,108,.4); box-shadow:inset 0 0 24px rgba(255,92,108,.05); }
  .srcrow { display:flex; align-items:center; gap:12px; padding:7px 0; border-bottom:1px solid var(--line); }
  .drag { color:var(--dim); cursor:grab; }
  .lock { color:var(--warn); font-size:11px; }
  .inp { display:inline-flex; align-items:center; height:28px; border-radius:8px; background:var(--panel);
         border:1px solid var(--line); color:var(--txt); padding:0 10px; }
  .swt { display:inline-block; width:30px; height:16px; border-radius:999px; background:rgba(0,224,164,.25);
         border:1px solid rgba(0,224,164,.5); position:relative; vertical-align:middle; }
  .swt::after { content:""; position:absolute; top:2px; right:2px; width:10px; height:10px; border-radius:50%; background:var(--down); }
  .swt.off { background:rgba(255,255,255,.06); border-color:var(--line); }
  .swt.off::after { right:auto; left:2px; background:var(--dim); }
  .logs { height:240px; background:#080a12; border:1px solid var(--line); border-radius:10px;
          padding:10px 12px; font-family:"JetBrains Mono",monospace; font-size:11px; overflow:hidden; }
  .logs div { padding:2px 0; }
  .note { max-width:1280px; margin:0 auto; color:var(--dim); font-size:12px; }
</style>
</head>
<body>

<div class="frame">
  <h2>默认视图 · 分组锚点导航 + 纵向区块 · min-width 1280</h2>
  <div class="topbar region" data-region="topbar">
    <span class="pill"><span class="dot live"></span>交易中 10:23</span>
    <span class="pill"><span class="dot live"></span>采集正常</span>
  </div>
  <div class="body">
    <div class="nav region" data-region="nav">
      <div>① 行情看板</div><div>② 数据源诊断</div><div>③ 标的管理</div>
      <div>④ 数据质量</div><div class="off">⑤ 回测 · W3</div>
      <div class="off">⑥ 交易 · W4</div><div>⑦ 告警中心</div><div class="on">⑧ 系统设置</div>
    </div>
    <!-- settings-nav W=180：分组锚点 -->
    <div class="snav region" data-region="settings-nav">
      <div class="on">数据源参数</div><div>采集参数</div><div>MCP 配置</div>
      <div>系统信息</div><div>日志查看</div><div class="danger">⚠ 危险操作</div>
    </div>
    <div class="content">
      <!-- source-config：GET/PATCH /api/config/sources（轮转序校验东财末位） -->
      <div class="sec region" data-region="source-config">
        <span class="tag">source-config · GET/PATCH /api/config/sources</span>
        <h4>数据源参数（Wave 1）· 轮转序拖拽排序</h4>
        <div class="srcrow"><span class="drag">⠿</span><b style="color:var(--txt)">腾讯ifzq</b><span>速率 <span class="inp num">1 req/s</span> · 熔断连续失败 <span class="inp num">3</span> · 退避 <span class="num">5s→10s→30s</span></span><span class="swt" style="margin-left:auto"></span></div>
        <div class="srcrow"><span class="drag">⠿</span><b style="color:var(--txt)">新浪jsonp</b><span>速率 <span class="inp num">1 req/s</span> · 抖动 <span class="inp num">±200ms</span></span><span class="swt" style="margin-left:auto"></span></div>
        <div class="srcrow" style="opacity:.85"><span class="lock">🔒</span><b style="color:var(--txt)">push2delay（东财系）</b><span class="lock">锁定末位不可上移（ADR-006 硬约束，UI 层强制；拖到非末位被拒绝并提示）</span><span class="swt" style="margin-left:auto"></span></div>
      </div>
      <!-- collector-config：GET/PATCH /api/config/collector -->
      <div class="sec region" data-region="collector-config">
        <span class="tag">collector-config · GET/PATCH /api/config/collector</span>
        <h4>采集参数（Wave 1）</h4>
        全局默认抓取间隔（新注册标的默认值）<span class="inp num">60s</span>
        · 交易时段 <span class="num">09:30-11:30 / 13:00-15:00</span> <span class="lock">写死不开放（只读展示）</span>
      </div>
      <!-- mcp-config：GET/PATCH /api/config/mcp -->
      <div class="sec region" data-region="mcp-config">
        <span class="tag">mcp-config · GET/PATCH /api/config/mcp</span>
        <h4>MCP 配置（Wave 1）</h4>
        MCP 服务总开关 <span class="swt"></span>
        · 交易工具独立开关 <span class="swt off"></span> <span class="warn">默认关；开启需页面二次确认（ADR-009）</span><br>
        <span style="display:inline-block;margin-top:8px">每日下单限额：金额 <span class="inp num">50,000</span> · 笔数 <span class="inp num">20</span></span>
      </div>
      <!-- system-info：GET /api/system/info -->
      <div class="sec region" data-region="system-info">
        <span class="tag">system-info · GET /api/system/info</span>
        <h4>系统信息</h4>
        应用 <span class="num">v0.4.0</span> · crates：collector <span class="num">0.4.0</span> / storage <span class="num">0.3.2</span> / diagnose <span class="num">0.2.1</span>
        · DB <span class="dot live"></span>已连接 · 运行 <span class="num">3天 04:12</span>
      </div>
      <!-- log-viewer：GET /api/system/logs?level=&tail=200 + WS 推送 -->
      <div class="sec region" data-region="log-viewer">
        <span class="tag">log-viewer · GET /api/system/logs?level=&tail=200 + WS 持续推送</span>
        <h4>日志查看 <span class="sel" style="margin-left:8px">级别：INFO ▾</span></h4>
        <div class="logs">
          <div><span class="num" style="color:var(--dim)">10:23:01</span> <span style="color:var(--acc1)">INFO</span>  collect 518880 1m bar ok (180ms)</div>
          <div><span class="num" style="color:var(--dim)">10:23:01</span> <span style="color:var(--warn)">WARN</span>  sina_jsonp retry 1/3 (timeout)</div>
          <div><span class="num" style="color:var(--dim)">10:22:59</span> <span style="color:var(--up)">ERROR</span> tencent_qt connect reset, circuit failures=3</div>
        </div>
      </div>
      <!-- danger-zone：POST /api/system/purge-raw / reset-circuits（需 confirm 字段） -->
      <div class="sec danger region" data-region="danger-zone">
        <span class="tag">danger-zone · 红色区 · 二次确认缺失时拒绝执行</span>
        <h4 style="color:var(--up)">⚠ 危险操作（红色 + 二次确认）</h4>
        <span class="btn danger">清空 kline_raw</span>（raw 层数据，accurate 不动）
        <span class="btn danger" style="margin-left:12px">全部源熔断状态重置</span>
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
| `settings-nav` | 分组锚点导航：数据源/采集/MCP/系统信息/日志/危险操作 | 本地状态 | 不可能空（静态控件）/ — / — | 点击滚动定位到对应区块；当前分组高亮 |
| `source-config` | 轮转序拖拽排序（⚠️ 东财系 Push2delay 锁定最后不可上移，ADR-006 UI 层强制）；每源参数：token bucket 速率（默认 1 req/s）、抖动范围、熔断连续失败次数（默认 3）、退避档位（默认 5s→10s→30s）；每源启停开关 | `GET/PATCH /api/config/sources`（服务端校验东财末位） | 骨架区 / 不可能空（内置源编译期注册）/ 错误占位+重试；保存失败回滚并提示 | 拖拽排序保存后下周期生效；东财系拖到非末位被拒绝并提示 ADR-006；参数编辑即保存 |
| `collector-config` | 全局默认抓取间隔（新注册标的默认值）；交易时段写死不开放（09:30-11:30/13:00-15:00，只读展示） | `GET/PATCH /api/config/collector` | 骨架区 / 不可能空（配置必有默认值）/ 错误占位+重试 | 间隔编辑保存；交易时段只读 |
| `mcp-config` | MCP 服务总开关；交易工具独立开关（默认关，开启需页面二次确认 ADR-009）；每日下单限额（金额/笔数） | `GET/PATCH /api/config/mcp` | 骨架区 / 不可能空 / 错误占位+重试 | 开关切换；交易工具开启弹二次确认；限额编辑保存 |
| `system-info` | 版本信息：应用版本、各 crate 版本、DB 连接状态、运行时长 | `GET /api/system/info` | 骨架区 / 不可能空（进程在线即有信息；DB 断开以状态字段表达）/ 错误占位+重试 | 只读 |
| `log-viewer` | 页面内 tail 应用日志 + 级别过滤（免上服务器排障） | `GET /api/system/logs?level=&tail=200`（WS 持续推送） | 骨架行 / 「暂无该级别日志」/ 错误占位+重试 | 级别过滤切换重查；tail 滚动跟随 |
| `danger-zone` | 红色危险操作区：清空 kline_raw（raw 层，accurate 不动）、全部源熔断状态重置 | `POST /api/system/purge-raw` / `POST /api/system/reset-circuits`（需 confirm 字段） | 不可能空（静态控件）/ — / 操作失败错误提示 | 二次确认（confirm 字段缺失时服务端拒绝执行） |

### L3 布局骨架（tangle 生成；结构+锚点+尺寸类，视觉样式手写）

``` {.tsx file=web/src/layouts/SettingsGrid.tsx}
// 由 design/06-web/08-settings.md L3 代码块 tangle 生成，禁止手改
// 骨架职责：Props 契约 + 区域→组件映射 + 数据源/三态内联注释 + 定稿默认值；视觉样式与数据获取实现在组件内手写

/** 已定稿默认值（定稿 P8，勿改常量改文档） */
export const SETTINGS_DEFAULTS = {
  tokenBucketRate: 1,                    // 每源 token bucket 默认 1 req/s（ADR-005 口径）
  circuitFailCount: 3,                   // 熔断连续失败次数默认 3
  backoffSteps: ['5s', '10s', '30s'],    // 退避档位默认 5s→10s→30s
  eastMoneyLastLocked: true,             // 东财系（Push2delay）锁定轮转序末位（ADR-006，UI 层强制）
  tradingHours: '09:30-11:30/13:00-15:00', // 交易时段写死不开放（只读展示）
  mcpTradingToolsDefaultOn: false,       // MCP 交易工具开关默认关，开启需二次确认（ADR-009）
  logTail: 200,                          // 日志 tail 默认 200 行
  dangerNeedsConfirm: true,              // 危险操作需 confirm 字段，缺失服务端拒绝
} as const;

/** 页面 Props 契约 */
export interface SettingsGridProps {
  activeSection: SettingsSection;
  onNavigateSection(s: SettingsSection): void;     // settings-nav 锚点滚动定位
  onSaveSourceConfig(patch: SourceConfigPatch): void;   // PATCH /api/config/sources（含轮转序；东财末位校验）
  onSaveCollectorConfig(patch: CollectorConfigPatch): void;  // PATCH /api/config/collector
  onSaveMcpConfig(patch: McpConfigPatch): void;         // PATCH /api/config/mcp
  onEnableMcpTradingTools(): void;                      // 交易工具开启：页面二次确认后才调用
  onSetLogLevel(level: string): void;                   // 日志级别过滤
  onPurgeRaw(confirm: string): void;                    // POST /api/system/purge-raw（需 confirm）
  onResetCircuits(confirm: string): void;               // POST /api/system/reset-circuits（需 confirm）
}

export type SettingsSection =
  | 'source-config' | 'collector-config' | 'mcp-config'
  | 'kline-config'
  | 'system-info' | 'log-viewer' | 'danger-zone';

export interface SourceConfigPatch {
  rotationOrder?: string[];              // 拖拽后的轮转序（东财系必须末位，否则服务端拒绝）
  perSource?: Record<string, { ratePerSec?: number; jitterMs?: number; circuitFailCount?: number; backoffSteps?: string[]; enabled?: boolean }>;
}
export interface CollectorConfigPatch { defaultIntervalSec?: number }
export interface McpConfigPatch { enabled?: boolean; tradingToolsEnabled?: boolean; dailyLimitAmount?: number; dailyLimitCount?: number }

// 骨架 Props 契约由区域组件（经 RegionPortal 挂入 data-region 锚点）消费，骨架自身不读 props；
// 参数以 _ 前缀标记「契约声明、骨架未用」，满足 strict noUnusedParameters（S1 修复骨架潜在编译错误）。
export function SettingsGrid(_props: SettingsGridProps) {
  return (
    <div data-region="settings" className="flex min-w-[1280px] flex-1">

      {/* settings-nav：静态控件无三态；分组锚点滚动定位，当前分组高亮 */}
      <nav data-region="settings-nav" className="w-44 border-r p-2">
        {/* <SettingsNav activeSection onNavigateSection/> */}
      </nav>

      <div className="flex-1 overflow-y-auto p-4">

        {/* source-config：GET/PATCH /api/config/sources；东财系末位锁定（ADR-006 UI 强制+服务端校验）；
            三态=骨架区/不可能空（内置源编译期注册）/错误占位+重试（保存失败回滚提示） */}
        <section data-region="source-config" className="mb-4">
          {/* <SourceConfigPanel onSaveSourceConfig/>（拖拽轮转序+每源参数+启停开关） */}
        </section>

        {/* collector-config：GET/PATCH /api/config/collector；交易时段写死只读；
            三态=骨架区/不可能空/错误占位+重试 */}
        <section data-region="collector-config" className="mb-4">
          {/* <CollectorConfigPanel onSaveCollectorConfig/> */}
        </section>

        {/* mcp-config：GET/PATCH /api/config/mcp；交易工具开关默认关、开启二次确认（ADR-009）；
            三态=骨架区/不可能空/错误占位+重试 */}
        <section data-region="mcp-config" className="mb-4">
          {/* <McpConfigPanel onSaveMcpConfig onEnableMcpTradingTools/>（总开关/交易工具开关/每日限额） */}
        </section>

        {/* kline-config：GET/PUT /api/config/kline；默认K线视口（交易日数，缺省 2，1-50）；
            三态=骨架区/不可能空/错误占位+重试（保存失败回滚提示）；看板主图+宫格共用，回测弹窗不动 */}
        <section data-region="kline-config" className="mb-4">
          {/* <KlineConfigPanel/>（默认K线视口(交易日) 输入 → PUT /api/config/kline → 乐观更新/回显） */}
        </section>

        {/* system-info：GET /api/system/info；
            三态=骨架区/不可能空（DB 断开以状态字段表达）/错误占位+重试；只读 */}
        <section data-region="system-info" className="mb-4 h-28">
          {/* <SystemInfoPanel/>（应用/crate 版本、DB 状态、运行时长） */}
        </section>

        {/* log-viewer：GET /api/system/logs?level=&tail=200 + WS 持续推送；
            三态=骨架行/「暂无该级别日志」/错误占位+重试；级别过滤重查，滚动跟随 */}
        <section data-region="log-viewer" className="mb-4 h-60">
          {/* <LogViewer onSetLogLevel/> */}
        </section>

        {/* danger-zone：POST purge-raw / reset-circuits（需 confirm 字段，缺失拒绝）；
            三态=不可能空（静态控件）/—/操作失败错误提示；红色区+二次确认 */}
        <section data-region="danger-zone">
          {/* <DangerZone onPurgeRaw onResetCircuits/>（清空 kline_raw / 全部源熔断重置） */}
        </section>
      </div>
    </div>
  );
}
```

## 2. 数据源参数组（Wave 1）

- **轮转序调整**：拖拽排序；⚠️ 东财系（Push2delay）**锁定最后不可上移**（ADR-006 硬约束，UI 层强制）
- 每源参数：token bucket 速率（默认 1 req/s）、抖动范围、熔断连续失败次数（默认 3）、退避档位（默认 5s→10s→30s）——可配，默认值即 ADR-005 口径
- 每源启停开关

## 3. 采集参数组（Wave 1）

- 全局默认抓取间隔（新注册标的的默认值）
- 交易时段：**写死不开放**（09:30-11:30 / 13:00-15:00，无合理变更理由）

## 4. MCP 配置组（Wave 1）

- MCP 服务总开关
- **交易工具独立开关**：默认关；开启动作需页面二次确认（ADR-009）
- 每日下单限额参数（金额/笔数）

## 5. 系统信息与维护（各波次）

- 版本信息：应用版本、各 crate 版本、DB 连接状态、运行时长
- **页面内日志查看**：tail 应用日志 + 级别过滤（免上服务器排障）
- **危险操作区**（红色 + 二次确认）：
  - 清空 kline_raw（raw 层数据，accurate 不动）
  - 全部源熔断状态重置

## 6. API 依赖

| 用途 | 接口 |
|---|---|
| 源参数读写 | `GET/PATCH /api/config/sources`（轮转序校验东财末位） |
| 采集/MCP 配置 | `GET/PATCH /api/config/collector` / `GET/PATCH /api/config/mcp` |
| 系统信息 | `GET /api/system/info` |
| 日志 tail | `GET /api/system/logs?level=&tail=200`（WS 持续推送） |
| 危险操作 | `POST /api/system/purge-raw` / `POST /api/system/reset-circuits`（需 confirm 字段） |

## 7. 验收（对应波次）

- [ ] 轮转序拖拽保存后下周期生效；东财系拖到非末位被拒绝并提示 ADR-006 约束
- [ ] MCP 交易工具开关默认关，开启需二次确认；开启后 MCP 客户端方可见交易工具
- [ ] 危险操作二次确认缺失时拒绝执行
