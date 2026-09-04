import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { SymbolsGrid } from '@/layouts/SymbolsGrid';
import { defaultApi } from '@/api';
import type { ApiClient } from '@/api/client';
import { RegionPortal } from '@/components/RegionPortal';
import { SymbolsStore } from './store';
import { SymbolsToolbar } from './SymbolsToolbar';
import { SymbolTable } from './SymbolTable';
import { SymbolFormDialog } from './SymbolFormDialog';

/**
 * 页面③标的管理：以 tangle 骨架 SymbolsGrid 为布局基座（骨架零改动），
 * 业务组件经 RegionPortal 挂入 data-region 锚点（09-frontend.md §3）。
 */
export function SymbolsPage({
  api = defaultApi,
  confirm,
}: {
  api?: ApiClient;
  confirm?: (message: string) => boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const store = useMemo(() => new SymbolsStore({ api, confirm }), [api, confirm]);
  useEffect(() => {
    void store.init();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const form = state.form;

  return (
    <div ref={rootRef} className="flex min-w-0 flex-1">
      <SymbolsGrid
        formMode={form?.mode ?? null}
        editingCode={form?.mode === 'edit' ? form.values.code : null}
        onOpenRegister={() => store.openRegister()}
        onOpenEdit={(code) => store.openEdit(code)}
        onDisable={(code) => void store.setEnabled(code, false)}
        onSubmitForm={() => void store.submit()}
        onCloseForm={() => store.closeForm()}
      />
      <RegionPortal root={rootRef} region="table-toolbar">
        <SymbolsToolbar
          count={state.list.data?.length ?? null}
          onOpenRegister={() => store.openRegister()}
        />
      </RegionPortal>
      <RegionPortal root={rootRef} region="symbol-table">
        {state.list.error && (
          <div className="flex items-center gap-3 p-3 text-xs text-up">
            <span>加载失败：{state.list.error}</span>
            <button
              type="button"
              onClick={() => void store.loadList()}
              className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt"
            >
              重试
            </button>
          </div>
        )}
        {!state.list.error && (
          <SymbolTable
            rows={state.list.data}
            loading={state.list.loading}
            toggling={state.toggling}
            onOpenEdit={(code) => store.openEdit(code)}
            onToggleEnabled={(code, enabled) => void store.setEnabled(code, enabled)}
            onOpenRegister={() => store.openRegister()}
          />
        )}
      </RegionPortal>
      {form && (
        <RegionPortal root={rootRef} region="form-dialog">
          {/* 遮罩点击不关闭（03-symbols 定稿）：遮罩本身无 onClick，仅 取消/保存 控制 */}
          <SymbolFormDialog
            form={form}
            onChange={(patch) => store.setFormValue(patch)}
            onConfirmSettlement={(v) => store.confirmSettlement(v)}
            onSubmit={() => void store.submit()}
            onClose={() => store.closeForm()}
          />
        </RegionPortal>
      )}
    </div>
  );
}
