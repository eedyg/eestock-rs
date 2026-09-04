import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SymbolsStore } from './store';
import { stubApi } from '@/test/apiStub';
import { ApiError, type SymbolRow } from '@/api/types';
import type { ApiClient } from '@/api/client';

const ROWS: SymbolRow[] = [
  { code: '518880', name: '黄金ETF', interval_secs: 60, settlement: 'T0', enabled: true, latest: { ts: '2026-09-04T02:23:00Z', last: 2.431, change_pct: 0.62 }, today_bars: 205 },
  { code: '159776', name: '港股通医药', interval_secs: 60, settlement: 'T1', enabled: false, latest: null, today_bars: 0 },
];

describe('SymbolsStore（页面③状态机）', () => {
  let api: ApiClient;
  beforeEach(() => {
    vi.clearAllMocks();
    api = stubApi({
      getSymbolsAdmin: vi.fn(async () => ROWS.map((r) => ({ ...r }))),
    });
  });

  it('init 加载列表（with_stats）→ ready；失败 → error 态，retry 恢复', async () => {
    const store = new SymbolsStore({ api });
    expect(store.state.list.loading).toBe(true);
    await store.init();
    expect(store.state.list.data).toHaveLength(2);
    expect(api.getSymbolsAdmin).toHaveBeenCalled();
    (api.getSymbolsAdmin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('net'));
    await store.loadList();
    expect(store.state.list.error).toBeTruthy();
    await store.loadList();
    expect(store.state.list.error).toBeNull();
  });

  it('openRegister：默认 60s/T1/启用；openEdit：载入行值 + 记录原 settlement', async () => {
    const store = new SymbolsStore({ api });
    await store.init();
    store.openRegister();
    expect(store.state.form?.mode).toBe('register');
    expect(store.state.form?.values).toMatchObject({
      code: '', intervalSec: 60, settlement: 'T1', enabled: true, name: '',
    });
    store.openEdit('518880');
    expect(store.state.form?.mode).toBe('edit');
    expect(store.state.form?.values).toMatchObject({
      code: '518880', intervalSec: 60, settlement: 'T0', name: '黄金ETF',
    });
    expect(store.state.form?.originalSettlement).toBe('T0');
    store.closeForm();
    expect(store.state.form).toBeNull();
  });

  it('submit 校验失败不调 API（北交所 code 内联错误）', async () => {
    const store = new SymbolsStore({ api });
    await store.init();
    store.openRegister();
    store.setFormValue({ code: '830799' });
    await store.submit();
    expect(api.registerSymbol).not.toHaveBeenCalled();
    expect(store.state.form?.errors.code).toContain('北交所');
  });

  it('submit 注册成功：POST → 关弹窗 + 列表刷新含新标的', async () => {
    // 有状态 fake：register 追加到列表（getSymbolsAdmin 默认覆写是静态的）
    const extra: SymbolRow[] = [];
    api = stubApi({
      getSymbolsAdmin: vi.fn(async () => [...ROWS, ...extra].map((r) => ({ ...r }))),
      registerSymbol: vi.fn(async (input) => {
        const row: SymbolRow = {
          code: input.code,
          name: input.name ?? null,
          interval_secs: input.interval_secs ?? 60,
          settlement: input.settlement ?? 'T1',
          enabled: input.enabled ?? true,
          latest: null,
          today_bars: 0,
        };
        extra.push(row);
        return row;
      }),
    });
    const store = new SymbolsStore({ api });
    await store.init();
    store.openRegister();
    store.setFormValue({ code: '600519', name: '贵州茅台' });
    await store.submit();
    expect(api.registerSymbol).toHaveBeenCalledWith({
      code: '600519', name: '贵州茅台', interval_secs: 60, settlement: 'T1', enabled: true,
    });
    expect(store.state.form).toBeNull();
    expect(store.state.list.data?.some((r) => r.code === '600519')).toBe(true);
  });

  it('submit 服务端错误（409/422）→ submitError 展示且弹窗保持', async () => {
    (api.registerSymbol as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(409, 'HTTP 409: code 已注册（编辑用 PATCH）'),
    );
    const store = new SymbolsStore({ api });
    await store.init();
    store.openRegister();
    store.setFormValue({ code: '600519' });
    await store.submit();
    expect(store.state.form?.submitError).toContain('已注册');
    expect(store.state.form).not.toBeNull();
  });

  it('编辑：settlement 变更未确认 → 拦截；确认后 PATCH 成功', async () => {
    const store = new SymbolsStore({ api });
    await store.init();
    store.openEdit('518880');
    store.setFormValue({ settlement: 'T1' });
    await store.submit();
    expect(api.updateSymbol).not.toHaveBeenCalled();
    expect(store.state.form?.errors.settlement).toContain('二次确认');
    store.confirmSettlement(true);
    await store.submit();
    expect(api.updateSymbol).toHaveBeenCalledWith('518880', {
      name: '黄金ETF', interval_secs: 60, settlement: 'T1', enabled: true,
    });
    expect(store.state.form).toBeNull();
  });

  it('setEnabled(false)：确认后 PATCH enabled:false（仅停用无物理删除）；取消确认不调 API', async () => {
    const confirm = vi.fn(() => true);
    const store = new SymbolsStore({ api, confirm });
    await store.init();
    await store.setEnabled('518880', false);
    expect(confirm).toHaveBeenCalled();
    expect(api.updateSymbol).toHaveBeenCalledWith('518880', { enabled: false });
    const confirm2 = vi.fn(() => false);
    const store2 = new SymbolsStore({ api, confirm: confirm2 });
    await store2.init();
    await store2.setEnabled('518880', false);
    expect(api.updateSymbol).toHaveBeenCalledTimes(1); // 未新增调用
  });

  it('setEnabled(true)：停用行启用无需确认', async () => {
    const confirm = vi.fn(() => true);
    const store = new SymbolsStore({ api, confirm });
    await store.init();
    await store.setEnabled('159776', true);
    expect(confirm).not.toHaveBeenCalled();
    expect(api.updateSymbol).toHaveBeenCalledWith('159776', { enabled: true });
  });
});
