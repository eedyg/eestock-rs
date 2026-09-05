/** log-viewer（08-settings §L2）：S1 占位——日志跟随需日志采集层（tracing ring buffer），归 S2。 */
export function LogViewer() {
  return (
    <div className="flex h-40 items-center justify-center rounded-xl border border-line bg-[#080a12] text-xs text-dim">
      <div className="text-center">
        <div>日志跟随将在下一阶段上线（需日志采集层）</div>
        <div className="mt-1 text-[11px] opacity-70">级别过滤 / WS 持续推送（S2）</div>
      </div>
    </div>
  );
}
