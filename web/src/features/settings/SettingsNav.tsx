import type { SettingsSection } from '@/layouts/SettingsGrid';

/** settings-nav（08-settings §L2）：静态控件；分组锚点滚动定位，当前分组高亮。 */
const SECTIONS: { id: SettingsSection; label: string; danger?: boolean }[] = [
  { id: 'source-config', label: '数据源参数' },
  { id: 'collector-config', label: '采集参数' },
  { id: 'mcp-config', label: 'MCP 配置' },
  { id: 'system-info', label: '系统信息' },
  { id: 'log-viewer', label: '日志查看' },
  { id: 'danger-zone', label: '⚠ 危险操作', danger: true },
];

export function SettingsNav({
  activeSection,
  onNavigateSection,
}: {
  activeSection: SettingsSection;
  onNavigateSection(s: SettingsSection): void;
}) {
  return (
    <nav className="flex flex-col gap-1 px-1 py-2">
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          onClick={(e) => {
            e.preventDefault();
            const el = document.querySelector<HTMLElement>(`[data-region="${s.id}"]`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            onNavigateSection(s.id);
          }}
          data-active={activeSection === s.id}
          className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
            activeSection === s.id
              ? 'bg-[rgba(56,189,248,.1)] text-txt outline outline-1 outline-[rgba(56,189,248,.3)]'
              : s.danger
                ? 'text-up hover:text-txt'
                : 'text-dim hover:text-txt'
          }`}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}
