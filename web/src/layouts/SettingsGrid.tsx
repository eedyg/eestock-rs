// ~/~ begin <<design/06-web/08-settings.md#web/src/layouts/SettingsGrid.tsx>>[init]
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
// ~/~ end
