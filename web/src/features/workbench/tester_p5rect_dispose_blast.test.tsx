/**
 * **tester 独立复验（ADR-024 P5 整改 · ⑤ `WorkbenchStore.dispose()` 爆炸半径）** —— 第 254 号验收单。
 *
 * 目的：把「dev（StrictMode 双调用）下工作台恒卡」的**机制**钉住，并给出与生产无关的证据：
 *  A. 机制单元证据：同一 store 实例上 `init() → dispose() → init()` ⇒ `patch()` 被丢弃（`disposed`
 *     单向且无复位）⇒ `catalog.loading` 恒 true；
 *  B. `<StrictMode>` 包裹挂载 `WorkbenchPage` ⇒ 恒卡（= dev 现象）；
 *  C. **不**包 `<StrictMode>` 挂载同一组件 ⇒ 正常加载（= 生产现象；StrictMode 的双调用是 dev-only）
 *     ⇒ 该缺陷**不可由「卸载—重建」在 React 生产构建下触发**（重建会拿到**新** store 实例，见 D）；
 *  D. 卸载后重新挂载 ⇒ **新** store 实例（useMemo 随组件实例重建）⇒ 正常加载。
 *
 * ⚠️ 本文件为 tester 车道（未 add）；不改生产代码。C/D 是全绿断言，若未来生产也会命中 dispose
 * 复用路径，C/D 必须变红 —— 即本文件是 ⑤ 结论的**可证伪探针**。
 */
import { describe, it, expect, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, waitFor, screen } from '@testing-library/react';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { createMockClient } from '@/api/mock';
import { WorkbenchStore } from './store';
import { ConfigPanel } from './ConfigPanel';
import { WorkbenchPage } from './WorkbenchPage';

function fakeWs(): WsClient {
  return {
    subscribe: vi.fn(() => () => {}),
    onStatusChange: vi.fn(() => () => {}),
    connect: vi.fn(),
  } as unknown as WsClient;
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('tester·⑤ dispose() 单向 disposed=true（机制 + 生产可达性探针）', () => {
  it('A. 机制：同一实例 init→dispose→init ⇒ patch 被丢弃（disposed 无复位）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') }) as unknown as ApiClient;
    const store = new WorkbenchStore({ api, ws: fakeWs() });

    await store.init();
    expect(store.state.catalog.data, '首次 init 后 catalog 应有数据').not.toBeNull();

    // 对照组：未 dispose 的实例上再 patch 会换 state 对象
    const fresh = new WorkbenchStore({ api, ws: fakeWs() });
    const freshBefore = fresh.state;
    await fresh.loadCatalog();
    expect(fresh.state, '对照组：未 dispose ⇒ patch 生效（state 换新对象）').not.toBe(freshBefore);

    // 被 dispose 的实例：state 对象**一字不变**（所有 patch 被静默丢弃）
    const before = store.state;
    store.dispose();
    await store.init(); // 复用同一实例（= StrictMode 的 mount→unmount→mount 语义）
    await store.loadCatalog();
    await tick();
    expect(
      store.state,
      'dispose 后复用同一实例：patch 被静默丢弃 ⇒ state 对象保持 dispose 前快照（= dev 恒卡机制）',
    ).toBe(before);
    console.log(
      `[⑤-A] dispose→init 后 state 未变（loading=${store.state.catalog.loading} data!=null=${store.state.catalog.data !== null}）；对照组 patch 生效`,
    );
  });

  it('B. `<StrictMode>` 挂载 WorkbenchPage ⇒ 恒卡（dev 现象）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') }) as unknown as ApiClient;
    render(
      <StrictMode>
        <WorkbenchPage api={api} ws={fakeWs()} />
      </StrictMode>,
    );
    await tick(150);
    const sel = screen.getByTestId('wb-add-strategy') as HTMLSelectElement;
    console.log(
      `[⑤-B] StrictMode 挂载：option 数=${sel.options.length} 第一项="${sel.options[0]?.textContent}"`,
    );
    expect(sel.options.length, 'StrictMode（dev）下应只有占位项').toBe(1);
    expect(sel.options[0]!.textContent).toContain('加载中');
  });

  it('C. **不**含 StrictMode 挂载 WorkbenchPage ⇒ 正常加载（= 生产构建现象）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') }) as unknown as ApiClient;
    render(<WorkbenchPage api={api} ws={fakeWs()} />);
    await waitFor(() => {
      const sel = screen.getByTestId('wb-add-strategy') as HTMLSelectElement;
      expect(sel.options.length).toBeGreaterThan(1);
    });
    const sel = screen.getByTestId('wb-add-strategy') as HTMLSelectElement;
    console.log(`[⑤-C] 非 StrictMode 挂载：option 数=${sel.options.length}`);
  });

  it('D. 卸载后重建 ⇒ 新 store 实例 ⇒ 正常加载（生产路由往返不命中 dispose 复用）', async () => {
    const api = createMockClient({ now: new Date('2026-09-09T06:00:00Z') }) as unknown as ApiClient;
    const ws = fakeWs();
    const first = render(<WorkbenchPage api={api} ws={ws} />);
    await waitFor(() => expect((screen.getByTestId('wb-add-strategy') as HTMLSelectElement).options.length).toBeGreaterThan(1));
    first.unmount();
    await tick();
    render(<WorkbenchPage api={api} ws={ws} />);
    await waitFor(() => expect((screen.getByTestId('wb-add-strategy') as HTMLSelectElement).options.length).toBeGreaterThan(1));
    console.log('[⑤-D] 卸载→重建后仍正常加载（新 store 实例）');
  });

  it('E. 组件层旁证：ConfigPanel 的 catalogLoading=true ⇒ 占位「加载中…」', () => {
    render(
      <ConfigPanel
        catalog={null}
        catalogLoading
        catalogError={null}
        symbols={null}
        presets={null}
        submitting={false}
        submitError={null}
        clampNotice={null}
        guardPrompt={null}
        loadAvailableRange={async () => ({ symbol: '518520', period: 'M1', available_from: null, available_to: null })}
        onSubmit={() => {}}
        onConfirmGuard={() => {}}
        onDismissGuard={() => {}}
        onApplyPreset={async () => ({ slots: [], buy_threshold: 60, sell_threshold: 40, policy: { LumpSum: { position_pct: 1.0 } }, stop: null, initial_capital: 100000, fee: { rate_pct: 0, min_fee: 0, slippage_bp: 0 } })}
        onCreatePreset={async () => {}}
        onUpdatePreset={async () => {}}
        onRenamePreset={async () => {}}
        onDeletePreset={async () => {}}
        onRetryCatalog={() => {}}
      />,
    );
    const sel = screen.getByTestId('wb-add-strategy') as HTMLSelectElement;
    expect(sel.options[0]!.textContent).toContain('加载中');
    console.log('[⑤-E] catalogLoading=true ⇒ 占位文案「加载中…」（与 dev 实测一致）');
  });
});
