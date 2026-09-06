import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiClient } from '@/api/client';
import type { Bar, Trade } from '@/api/types';
import { stubApi } from '@/test/apiStub';
import { TradeDetailModal } from './TradeDetailModal';

// jsdom 无 canvas：klinecharts 整体打桩（图表适配行为由 feed/KlineChart 测试注入覆盖；
// 此处仅验证弹窗对 KlineChart 的接线：容器/overlay/指标勾选）。
const chartStub = {
  setSymbol: vi.fn(),
  setPeriod: vi.fn(),
  setDataLoader: vi.fn(),
  createIndicator: vi.fn(),
  removeIndicator: vi.fn(),
  setStyles: vi.fn(),
  subscribeAction: vi.fn(),
  unsubscribeAction: vi.fn(),
  scrollToRealTime: vi.fn(),
  setBarSpace: vi.fn(),
  convertToPixel: vi.fn(() => ({ x: 100, y: 100 })),
  createOverlay: vi.fn(),
  removeOverlay: vi.fn(),
  resize: vi.fn(),
};
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
  registerOverlay: vi.fn(),
}));

const trade: Trade = {
  open_ts: 1700000000,
  close_ts: 1700086400,
  open_bar: 1,
  close_bar: 2,
  open_price: 10,
  close_price: 11,
  shares: 1000,
  gross_value: 11000,
  commission: 5,
  stamp_duty: 5.5,
  pnl: 1000,
  hold_bars: 1,
};

// 已加载 bar 集合：落在开→平 ± buffer 窗口内（对各周期 1m/5m/15m/1d 均覆盖），
// 且 trade.open_ts/close_ts（D1 桶边界）本身不是这些 1m bar 的 ts（无同类 bar，模拟 D1→1m 场景）。
const BARS: Bar[] = [
  { ts: '2023-11-14T22:00:00.000Z', open: 9.9, high: 10.1, low: 9.8, close: 10, volume: 1000, amount: 10000 },
  { ts: '2023-11-14T22:10:00.000Z', open: 10, high: 10.2, low: 9.9, close: 10.1, volume: 1200, amount: 12120 },
  { ts: '2023-11-15T22:00:00.000Z', open: 10.1, high: 11.2, low: 10, close: 11, volume: 1500, amount: 16500 },
];
// 开仓/平仓 ts 在「已加载 bar 集合」里吸附后的目标 bar ts（D1 桶边界 22:13:20Z → 最近 22:10 / 次日 22:00）。
const SNAPPED_OPEN_TS = Date.parse('2023-11-14T22:10:00.000Z');
const SNAPPED_CLOSE_TS = Date.parse('2023-11-15T22:00:00.000Z');

function fakeApi(): ApiClient {
  return stubApi({ getKline: vi.fn(async () => BARS) });
}

function renderModal(overrides: Partial<Parameters<typeof TradeDetailModal>[0]> = {}) {
  return render(
    <TradeDetailModal
      trade={trade}
      code="518880"
      period="D1"
      api={fakeApi()}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

describe('TradeDetailModal（交易明细弹窗）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染交易字段：标的/方向/开平时刻/价格/数量/盈亏/时长/费用', () => {
    renderModal();

    // 标题 + 标的
    expect(screen.getByText('交易明细')).toBeInTheDocument();
    expect(screen.getByTestId('td-code')).toHaveTextContent('518880');

    // 方向（长仓引擎为买入；Trade 无 direction 字段，按做多口径派生）
    expect(screen.getByTestId('td-direction')).toHaveTextContent('买入');

    // 开仓/平仓时刻（fmtTs：MM-DD HH:mm）
    expect(screen.getByTestId('td-open-ts')).not.toHaveTextContent('—');
    expect(screen.getByTestId('td-close-ts')).not.toHaveTextContent('—');

    // 开/平价格
    expect(screen.getByTestId('td-open-price')).toHaveTextContent('10.000');
    expect(screen.getByTestId('td-close-price')).toHaveTextContent('11.000');

    // 数量
    expect(screen.getByTestId('td-shares')).toHaveTextContent('1,000');

    // 盈亏额 + 比例
    expect(screen.getByTestId('td-pnl')).toHaveTextContent('+1,000');
    expect(screen.getByTestId('td-pct')).toHaveTextContent('10.0%');

    // 持仓时长
    expect(screen.getByTestId('td-hold')).toHaveTextContent('1bar');

    // 相关费用
    expect(screen.getByTestId('td-fee')).toHaveTextContent('佣金');
    expect(screen.getByTestId('td-fee')).toHaveTextContent('印花税');
  });

  it('遮罩点击不关闭（防误触）', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await userEvent.click(screen.getByTestId('trade-detail-modal'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('点顶部关闭按钮关闭', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await userEvent.click(screen.getByTestId('trade-detail-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('复用 KlineChart：挂载 K 线容器，并按开平仓区间 + 前后 buffer 取数', async () => {
    const api = fakeApi();
    renderModal({ api });
    // K 线容器存在（KlineChart 挂载）
    expect(await screen.findByTestId('kline-chart')).toBeInTheDocument();
    // 默认周期 = run 周期（D1 → 1d），取数 code+period（区间由 before/limit 表达）
    await waitFor(() => {
      expect(api.getKline).toHaveBeenCalledWith(
        expect.objectContaining({ code: '518880', period: '1d' }),
      );
    });
    // 默认周期「日」按钮选中
    expect(screen.getByRole('button', { name: '日' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('周期切换 → 重建 ScopedKlineFeed 并重载新周期区间 bar', async () => {
    const api = fakeApi();
    renderModal({ api });
    await screen.findByTestId('kline-chart');
    await userEvent.click(screen.getByRole('button', { name: '5m' }));
    await waitFor(() => {
      expect(api.getKline).toHaveBeenCalledWith(
        expect.objectContaining({ code: '518880', period: '5m' }),
      );
    });
    expect(screen.getByRole('button', { name: '5m' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('指标勾选切换：点 MACD → KlineChart 同步创建 MACD 指标', async () => {
    renderModal();
    await screen.findByTestId('kline-chart');
    const macd = screen.getByRole('button', { name: 'MACD' });
    expect(macd).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(macd);
    expect(macd).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(chartStub.createIndicator).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'MACD' }),
        true,
      );
    });
  });

  it('开/平仓价位线 overlay 存在（createOverlay 收到开仓/平仓价 + 区间高亮）', async () => {
    renderModal();
    await screen.findByTestId('kline-chart');
    // 开仓价线（simpleTag 满宽价线），锚点 value=开仓价 10
    expect(chartStub.createOverlay).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'simpleTag',
        points: [expect.objectContaining({ value: 10 })],
      }),
    );
    // 平仓价线，锚点 value=平仓价 11
    expect(chartStub.createOverlay).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'simpleTag',
        points: [expect.objectContaining({ value: 11 })],
      }),
    );
    // 开平仓区间高亮（tradeRange overlay）
    expect(chartStub.createOverlay).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'tradeRange' }),
    );
  });

  it('K 线含开仓「B」/平仓「S」标记 overlay：吸附到已加载 bar 并钳位（On-Screen）', async () => {
    renderModal();
    await screen.findByTestId('kline-chart');
    // 开仓「B」：simpleAnnotation，extendData='B'，锚定「吸附后」开仓 bar ts（非原始 D1 桶 ts）
    await waitFor(() => {
      expect(chartStub.createOverlay).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'simpleAnnotation',
          extendData: 'B',
          points: [expect.objectContaining({ timestamp: SNAPPED_OPEN_TS })],
        }),
      );
      // 平仓「S」：simpleAnnotation，extendData='S'，锚定「吸附后」平仓 bar ts
      expect(chartStub.createOverlay).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'simpleAnnotation',
          extendData: 'S',
          points: [expect.objectContaining({ timestamp: SNAPPED_CLOSE_TS })],
        }),
      );
    });
  });

  it('周期切换（D1→更细 1m）→ B/S 标记按新周期已加载 bar 重新吸附锚定（On-Screen）', async () => {
    renderModal();
    await screen.findByTestId('kline-chart');
    // 切到更细周期 1m（触发新的 ScopedKlineFeed + KlineChart 重建）
    await userEvent.click(screen.getByRole('button', { name: '1m' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '1m' })).toHaveAttribute('aria-pressed', 'true');
    });
    // B/S 基于 1m 已加载 bar 重新吸附（仍锚定「吸附后」真实 bar ts，落于已加载范围内）
    await waitFor(() => {
      expect(chartStub.createOverlay).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'simpleAnnotation',
          extendData: 'B',
          points: [expect.objectContaining({ timestamp: SNAPPED_OPEN_TS })],
        }),
      );
      expect(chartStub.createOverlay).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'simpleAnnotation',
          extendData: 'S',
          points: [expect.objectContaining({ timestamp: SNAPPED_CLOSE_TS })],
        }),
      );
    });
  });

  it('resize 手柄存在且拖动可调整弹窗尺寸', async () => {
    renderModal();
    await screen.findByTestId('kline-chart');
    const handle = screen.getByTestId('trade-detail-resize');
    expect(handle).toBeInTheDocument();
    const dialog = screen.getByTestId('trade-detail-dialog');
    const beforeW = Number.parseFloat(dialog.style.width) || 0;
    // jsdom 无 PointerEvent：fireEvent.pointerDown 不携带坐标；手动派发带坐标的 pointerdown
    act(() => {
      handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }));
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 250 }));
      window.dispatchEvent(new MouseEvent('pointerup', {}));
    });
    await waitFor(() => {
      expect(Number.parseFloat(dialog.style.width)).toBeGreaterThan(beforeW);
    });
  });
});
