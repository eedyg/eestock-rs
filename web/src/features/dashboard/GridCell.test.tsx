import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import type { SymbolSnapshot } from '@/api/types';

// jsdom 无 canvas：klinecharts 整体打桩（GridCell 的图表初始化只取桩）
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
  setPaneOptions: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
};
vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartStub),
  dispose: vi.fn(),
}));

// KlineDataFeed 整体打桩（数据流行为由 feed/store 测试覆盖；此处只验证渲染）
vi.mock('./feed', () => ({
  KlineDataFeed: vi.fn().mockImplementation(() => ({
    bars: [],
    status: 'idle',
    loadInitial: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  })),
}));

import { GridCell } from './GridCell';
import { stubApi } from '@/test/apiStub';

function fakeApi(): ApiClient {
  const api = stubApi({});
  return api;
}
function fakeWs(): WsClient {
  return { subscribe: vi.fn(() => () => {}) } as unknown as WsClient;
}

const ENABLED_DATA_PLUS: SymbolSnapshot = { code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62 };
const ENABLED_DATA_MINUS: SymbolSnapshot = { code: '513310', name: '纳指ETF', enabled: true, last: 1.587, changePct: -0.31 };
const DISABLED: SymbolSnapshot = { code: 'TEST_OFF', name: '停用验证标的', enabled: false, last: null, changePct: 0 };
const ENABLED_NO_DATA: SymbolSnapshot = { code: 'TEST_NODATA', name: '无数据验证标的', enabled: true, last: null, changePct: 0 };

function renderCell(symbol: SymbolSnapshot) {
  return render(<GridCell symbol={symbol} period="15m" api={fakeApi()} ws={fakeWs()} onPick={vi.fn()} />);
}

describe('GridCell（宫格单格：表头 D2 + 布局 R1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── R2：与 SymbolList 同口径（停用/无数据不伪造 0.00%）──
  it('enabled 有数据（正涨）→ 表头显示 +0.62%（保色 up）', () => {
    renderCell(ENABLED_DATA_PLUS);
    expect(screen.getByText('+0.62%')).toBeInTheDocument();
    expect(screen.getByText('+0.62%')).toHaveClass('text-up');
  });

  it('enabled 有数据（负跌）→ 表头显示 -0.31%（保色 down）', () => {
    renderCell(ENABLED_DATA_MINUS);
    expect(screen.getByText('-0.31%')).toBeInTheDocument();
    expect(screen.getByText('-0.31%')).toHaveClass('text-down');
  });

  it('enabled=false → 表头显示「已停用」，不得伪造 0.00%', () => {
    renderCell(DISABLED);
    expect(screen.getByText('已停用')).toBeInTheDocument();
    expect(screen.queryByText(/[+-]0\.00%/)).toBeNull();
    expect(screen.queryByText('0.00%')).toBeNull();
  });

  it('enabled=true 但 last=null → 表头显示「无数据」，不得伪造 0.00%', () => {
    renderCell(ENABLED_NO_DATA);
    expect(screen.getByText('无数据')).toBeInTheDocument();
    expect(screen.queryByText(/[+-]0\.00%/)).toBeNull();
    expect(screen.queryByText('0.00%')).toBeNull();
  });

  it('停用/无数据格仍渲染 code/名称（不崩）', () => {
    renderCell(DISABLED);
    expect(screen.getByText('TEST_OFF')).toBeInTheDocument();
    expect(screen.getByText('停用验证标的')).toBeInTheDocument();
    const el = screen.getByText('TEST_OFF').closest('[data-grid-cell]');
    expect(el).not.toBeNull();
  });

  // ── R1：外层 flex 列 min-h-0 → chart 容器 flex-1 拿到真实高度 ──
  it('外层 data-grid-cell 具备 min-h-0（chart 容器 flex-1 不被 auto 行压成 0 高）', () => {
    const { container } = renderCell(ENABLED_DATA_PLUS);
    const cell = container.querySelector('[data-grid-cell]');
    expect(cell).not.toBeNull();
    expect(cell).toHaveClass('min-h-0');
  });
});
