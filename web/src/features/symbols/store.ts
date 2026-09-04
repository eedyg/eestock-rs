import { SYMBOLS_DEFAULTS } from '@/layouts/SymbolsGrid';
import type { FormMode, Settlement, SymbolFormValues, SymbolRow } from '@/api/types';
import { ApiError } from '@/api/types';
import type { ApiClient } from '@/api/client';
import { validateForm } from './validate';

export interface AsyncSlice<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export interface FormState {
  mode: FormMode;
  values: SymbolFormValues;
  /** 编辑态原 settlement（变更检测 → 二次确认）；注册态 null */
  originalSettlement: Settlement | null;
  settlementConfirmed: boolean;
  errors: Record<string, string>;
  submitting: boolean;
  submitError: string | null;
}

export interface SymbolsState {
  list: AsyncSlice<SymbolRow[]>;
  form: FormState | null;
  toggling: Record<string, boolean>;
}

type ConfirmFn = (message: string) => boolean;

/**
 * 页面③标的管理状态机（03-symbols L2）：
 * 列表 GET /api/symbols?with_stats=1；注册 POST / 编辑 PATCH；停用=PATCH {enabled:false}
 * （仅停用、历史保留、无物理删除入口）；settlement 变更二次确认（回测撮合规则输入）。
 */
export class SymbolsStore {
  private current: SymbolsState = {
    list: { data: null, loading: true, error: null },
    form: null,
    toggling: {},
  };
  private listeners = new Set<() => void>();
  private confirm: ConfirmFn;

  constructor(private deps: { api: ApiClient; confirm?: ConfirmFn }) {
    this.confirm = deps.confirm ?? ((m) => window.confirm(m));
  }

  get state(): SymbolsState {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): SymbolsState => this.current;

  private patch(p: Partial<SymbolsState>) {
    this.current = { ...this.current, ...p };
    this.listeners.forEach((l) => l());
  }

  private patchForm(p: Partial<FormState>) {
    if (!this.current.form) return;
    this.patch({ form: { ...this.current.form, ...p } });
  }

  async init(): Promise<void> {
    await this.loadList();
  }

  async loadList(): Promise<void> {
    this.patch({ list: { ...this.current.list, loading: true, error: null } });
    try {
      const data = await this.deps.api.getSymbolsAdmin();
      this.patch({ list: { data, loading: false, error: null } });
    } catch (e) {
      this.patch({ list: { data: null, loading: false, error: (e as Error).message } });
    }
  }

  openRegister(): void {
    this.patch({
      form: {
        mode: 'register',
        values: {
          code: '',
          intervalSec: SYMBOLS_DEFAULTS.intervalSec,
          settlement: 'T1', // 分类预填无行情源数据（ADR-017），默认 T1 人工确认可改
          enabled: SYMBOLS_DEFAULTS.enabled,
          name: '',
        },
        originalSettlement: null,
        settlementConfirmed: false,
        errors: {},
        submitting: false,
        submitError: null,
      },
    });
  }

  openEdit(code: string): void {
    const row = this.current.list.data?.find((r) => r.code === code);
    if (!row) return;
    const settlement = (row.settlement === 'T0' ? 'T0' : 'T1') as Settlement;
    this.patch({
      form: {
        mode: 'edit',
        values: {
          code: row.code,
          intervalSec: row.interval_secs,
          settlement,
          enabled: row.enabled,
          name: row.name ?? '',
        },
        originalSettlement: settlement,
        settlementConfirmed: false,
        errors: {},
        submitting: false,
        submitError: null,
      },
    });
  }

  closeForm(): void {
    this.patch({ form: null });
  }

  setFormValue(patch: Partial<SymbolFormValues>): void {
    if (!this.current.form) return;
    const values = { ...this.current.form.values, ...patch };
    // settlement 改回原值时清除确认需求
    const settlementConfirmed =
      this.current.form.originalSettlement !== null &&
      values.settlement === this.current.form.originalSettlement
        ? false
        : this.current.form.settlementConfirmed;
    this.patchForm({ values, settlementConfirmed, errors: {}, submitError: null });
  }

  confirmSettlement(v: boolean): void {
    this.patchForm({ settlementConfirmed: v, errors: {} });
  }

  /** 提交（注册 POST / 编辑 PATCH）：客户端校验 → API → 成功关窗刷新；服务端错误内联展示 */
  async submit(): Promise<void> {
    const form = this.current.form;
    if (!form || form.submitting) return;
    const errors = validateForm(
      form.mode,
      form.values,
      form.originalSettlement,
      form.settlementConfirmed,
    );
    if (Object.keys(errors).length > 0) {
      this.patchForm({ errors });
      return;
    }
    this.patchForm({ submitting: true, submitError: null });
    const v = form.values;
    try {
      if (form.mode === 'register') {
        await this.deps.api.registerSymbol({
          code: v.code,
          name: v.name || undefined,
          interval_secs: v.intervalSec,
          settlement: v.settlement,
          enabled: v.enabled,
        });
      } else {
        await this.deps.api.updateSymbol(v.code, {
          name: v.name || undefined,
          interval_secs: v.intervalSec,
          settlement: v.settlement,
          enabled: v.enabled,
        });
      }
      this.patch({ form: null });
      await this.loadList();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      this.patchForm({ submitting: false, submitError: msg });
    }
  }

  /** 启停切换：停用需确认（仅停用，历史数据保留，03-symbols §4）；启用无需确认 */
  async setEnabled(code: string, enabled: boolean): Promise<void> {
    if (!enabled && !this.confirm(`停用 ${code} 后采集停止（历史数据保留），确认停用？`)) {
      return;
    }
    this.patch({ toggling: { ...this.current.toggling, [code]: true } });
    try {
      await this.deps.api.updateSymbol(code, { enabled });
      await this.loadList();
    } finally {
      this.patch({ toggling: { ...this.current.toggling, [code]: false } });
    }
  }
}
