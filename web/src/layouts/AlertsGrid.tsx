// ~/~ begin <<design/06-web/07-alerts.md#web/src/layouts/AlertsGrid.tsx>>[init]
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
// ~/~ end
