// ~/~ begin <<design/06-web/03-symbols.md#web/src/layouts/SymbolsGrid.tsx>>[init]
// 由 design/06-web/03-symbols.md L3 代码块 tangle 生成，禁止手改
// 骨架职责：Props 契约 + 区域→组件映射 + 数据源/三态内联注释 + 定稿默认值；视觉样式与数据获取实现在组件内手写

/** 已定稿默认值（定稿 P3，勿改常量改文档） */
export const SYMBOLS_DEFAULTS = {
  intervalSec: 60,                // 抓取间隔默认 60s
  minIntervalSec: 60,             // 间隔下限 60s
  enabled: true,                  // 启用开关默认开
  settlementByCategory: true,     // 交收规则按分类预填：跨境/债券/商品/货币→T0，股票型→T1
  bseRejected: true,              // 北交所前缀（4/8/920）拒绝并提示「暂不支持」
} as const;

export type Settlement = 'T0' | 'T1';
export type FormMode = 'register' | 'edit';

/** 页面 Props 契约 */
export interface SymbolsGridProps {
  formMode: FormMode | null;                   // null=弹窗关闭
  editingCode: string | null;                  // 编辑模式的 code（主键只读）
  onOpenRegister(): void;                      // table-toolbar「+ 注册标的」
  onOpenEdit(code: string): void;              // 行操作「编辑」
  onDisable(code: string): void;               // 行操作「停用」：PATCH {enabled:false}（仅停用，无物理删除）
  onSubmitForm(mode: FormMode, values: SymbolFormValues): void;  // 注册 POST / 编辑 PATCH
  onCloseForm(): void;
}

/** 表单值（注册/编辑共用；编辑时 code 只读） */
export interface SymbolFormValues {
  code: string;                    // 6 位数字；市场前缀校验；北交所拒绝
  intervalSec: number;             // ≥ SYMBOLS_DEFAULTS.minIntervalSec，热生效
  settlement: Settlement;          // ⚠️ 修改需二次确认（回测/交易撮合规则输入）
  enabled: boolean;
  name: string;                    // 注册时服务端反查，失败留空可手工改
}

export function SymbolsGrid(props: SymbolsGridProps) {
  return (
    <div data-region="symbols" className="flex min-w-[1280px] flex-1 flex-col">

      {/* table-toolbar：静态控件无三态；注册入口 + 标的计数 */}
      <div data-region="table-toolbar" className="flex h-12 items-center border-b px-4">
        {/* <RegisterButton onOpenRegister/> */}
      </div>

      {/* symbol-table：GET /api/symbols?with_stats=1；
          三态=骨架行/「未注册标的」空态+注册引导/错误条+重试；停用行置灰 */}
      <div data-region="symbol-table" className="flex-1">
        {/* <SymbolTable onOpenEdit onDisable/>（操作列：编辑/停用） */}
      </div>

      {props.formMode && (
        /* form-dialog：注册 POST /api/symbols（服务端反查名称）/ 编辑 PATCH /api/symbols/{code}；
            三态=提交中禁用+spinner/不可能空/校验内联+提交错误提示；
            settlement 修改二次确认；code 编辑态只读；遮罩点击不关闭 */
        <div data-region="form-dialog" className="fixed inset-0 flex items-center justify-center">
          {/* <SymbolFormDialog mode editingCode values onSubmitForm onCloseForm/> W=480 */}
        </div>
      )}
    </div>
  );
}
// ~/~ end
