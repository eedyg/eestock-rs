/** 表格工具条 H=48（03-symbols L2：注册入口 + 标的计数；静态控件无三态） */
export function SymbolsToolbar({
  count,
  onOpenRegister,
}: {
  count: number | null;
  onOpenRegister(): void;
}) {
  return (
    <div className="flex w-full items-center gap-3">
      <button
        type="button"
        onClick={onOpenRegister}
        className="rounded-lg bg-gradient-to-br from-acc1 to-acc2 px-3 py-1 text-xs text-white shadow-[0_2px_10px_rgba(56,189,248,0.35)]"
      >
        + 注册标的
      </button>
      <span className="flex-1" />
      {count !== null && (
        <span className="num flex items-center gap-[7px] rounded-full border border-line bg-white/5 px-3 py-1 text-xs">
          {`共 ${count} 只`}
        </span>
      )}
    </div>
  );
}
