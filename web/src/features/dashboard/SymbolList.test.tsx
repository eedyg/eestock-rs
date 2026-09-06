import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SymbolList } from './SymbolList';
import type { SymbolSnapshot } from '@/api/types';

const SYMBOLS: SymbolSnapshot[] = [
  { code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62 },
  { code: '513310', name: '纳指ETF', enabled: true, last: 1.587, changePct: -0.31 },
  { code: '159776', name: '港股通医药', enabled: false, last: null, changePct: 0 },
  { code: '161226', name: '白银LOF', enabled: true, last: null, changePct: 0 },
];

/** 收藏/非收藏混合集合（收藏 favoriteSort 非升序，验证复制后按升序展示） */
const MIXED: SymbolSnapshot[] = [
  { code: '161226', name: '白银LOF', enabled: true, last: 0.982, changePct: 1.15 },
  { code: '513310', name: '纳指ETF', enabled: true, last: 1.587, changePct: -0.31, favorite: true, favoriteSort: 1 },
  { code: '518880', name: '黄金ETF', enabled: true, last: 2.431, changePct: 0.62, favorite: true, favoriteSort: 2 },
];

function renderList(props?: Partial<Parameters<typeof SymbolList>[0]>) {
  const defaults = {
    symbols: SYMBOLS,
    status: 'ready' as const,
    selected: '518880',
    search: '',
    onSearchChange: vi.fn(),
    onSelect: vi.fn(),
    onRetry: vi.fn(),
    onToggleFavorite: vi.fn(async () => {}),
    onReorderFavorites: vi.fn(async () => {}),
  };
  const merged = { ...defaults, ...props };
  return { ...render(<MemoryRouter><SymbolList {...merged} /></MemoryRouter>), props: merged };
}

/** 列出行按钮的 code 顺序（每个行按钮内 <b> 即 code） */
function rowCodes(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button')].map((b) => b.querySelector('b')?.textContent ?? '');
}

/** 收藏切换 harness：模拟 store 乐观更新（加/移出收藏区并按 favoriteSort 归位），使星标交互可在单元测试中观察到。 */
function FavoritedHarness({ initial }: { initial: SymbolSnapshot[] }) {
  const [symbols, setSymbols] = useState<SymbolSnapshot[]>(initial);
  const toggle = async (code: string) => {
    setSymbols((prev) => {
      const target = prev.find((s) => s.code === code);
      if (!target) return prev;
      if (target.favorite === true) {
        return prev.map((s) => (s.code === code ? { ...s, favorite: false, favoriteSort: null } : s));
      }
      const max = prev
        .filter((s) => s.favorite === true)
        .reduce((m, s) => Math.max(m, s.favoriteSort ?? 0), 0);
      return prev.map((s) => (s.code === code ? { ...s, favorite: true, favoriteSort: max + 1 } : s));
    });
  };
  return (
    <SymbolList
      symbols={symbols}
      status="ready"
      selected=""
      search=""
      onSearchChange={vi.fn()}
      onSelect={vi.fn()}
      onRetry={vi.fn()}
      onToggleFavorite={toggle}
      onReorderFavorites={vi.fn(async () => {})}
    />
  );
}

describe('SymbolList（symbol-list 区域）', () => {
  it('渲染 code/名称/最新价/涨跌幅', () => {
    renderList();
    expect(screen.getByText('518880')).toBeInTheDocument();
    expect(screen.getByText('黄金ETF')).toBeInTheDocument();
    expect(screen.getByText('2.431')).toBeInTheDocument();
    expect(screen.getByText('+0.62%')).toBeInTheDocument();
    expect(screen.getByText('-0.31%')).toBeInTheDocument();
  });

  it('点击标的触发 onSelect', async () => {
    const { props } = renderList();
    await userEvent.click(screen.getByText('纳指ETF'));
    expect(props.onSelect).toHaveBeenCalledWith('513310');
  });

  it('搜索框输入触发 onSearchChange', async () => {
    const { props } = renderList();
    await userEvent.type(screen.getByPlaceholderText(/搜索/), '黄金');
    expect(props.onSearchChange).toHaveBeenCalled();
  });

  it('loading 态渲染骨架行', () => {
    renderList({ status: 'loading', symbols: [] });
    expect(screen.getByTestId('symbol-list-skeleton')).toBeInTheDocument();
  });

  it('空态：未注册标的引导链 → /symbols', () => {
    renderList({ symbols: [] });
    const link = screen.getByText(/去标的管理/).closest('a');
    expect(link).toHaveAttribute('href', '/symbols');
  });

  it('错误态：错误条 + 重试按钮', async () => {
    const { props } = renderList({ status: 'error', symbols: [] });
    expect(screen.getByText(/加载失败/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(props.onRetry).toHaveBeenCalled();
  });

  it('涨跌幅着色：涨 up / 跌 down', () => {
    renderList();
    expect(screen.getByText('+0.62%')).toHaveClass('text-up');
    expect(screen.getByText('-0.31%')).toHaveClass('text-down');
  });

  it('enabled=false → 渲染「已停用」(置灰，非 0.000)，行仍可点击加载K线', async () => {
    const { props } = renderList();
    const row = screen.getByText('港股通医药').closest('button')!;
    expect(row).toHaveTextContent('已停用');
    expect(screen.queryByText('0.000')).toBeNull();
    await userEvent.click(screen.getByText('港股通医药'));
    expect(props.onSelect).toHaveBeenCalledWith('159776');
  });

  it('enabled=true 但无 latest → 渲染「无数据」，非 0.000', () => {
    renderList();
    expect(screen.getByText('白银LOF')).toBeInTheDocument();
    expect(screen.getByText('无数据')).toBeInTheDocument();
    expect(screen.queryByText('0.000')).toBeNull();
  });

  // ── Wave 3 页面① 看板收藏（F2 前端）──

  it('收藏优先显示：favoriteSort 升序在上，非收藏在下', () => {
    const { container } = renderList({ symbols: MIXED });
    expect(rowCodes(container)).toEqual(['513310', '518880', '161226']);
    const rows = [...container.querySelectorAll('button')];
    expect(rows[0]!.getAttribute('data-fav')).toBe('true');
    expect(rows[1]!.getAttribute('data-fav')).toBe('true');
    expect(rows[2]!.getAttribute('data-fav')).toBeNull();
  });

  it('无收藏时不显示「已收藏」分组标签（空收藏区不占位）', () => {
    renderList(); // SYMBOLS 全非收藏
    expect(screen.queryByText(/已收藏/)).toBeNull();
  });

  it('收藏行带拖拽 handle；非收藏行无 handle', () => {
    const { container } = renderList({ symbols: MIXED });
    expect(container.querySelector('[data-handle="513310"]')).not.toBeNull();
    expect(container.querySelector('[data-handle="161226"]')).toBeNull();
  });

  it('星标点击：非收藏行 → 调 onToggleFavorite(code)（star 路径），不误触行选中', async () => {
    const { props } = renderList({ symbols: MIXED });
    await userEvent.click(screen.getByRole('button', { name: '收藏 161226' }));
    expect(props.onToggleFavorite).toHaveBeenCalledWith('161226');
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('星标点击：收藏行 → 调 onToggleFavorite(code)（unstar 路径），不误触行选中', async () => {
    const { props } = renderList({ symbols: MIXED });
    await userEvent.click(screen.getByRole('button', { name: '取消收藏 513310' }));
    expect(props.onToggleFavorite).toHaveBeenCalledWith('513310');
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('星标切换联动：点星后行移入/移出收藏区（乐观归位）', async () => {
    render(
      <MemoryRouter>
        <FavoritedHarness initial={MIXED} />
      </MemoryRouter>,
    );
    const order = () => [...document.querySelectorAll('button')].map((b) => b.querySelector('b')?.textContent ?? '');
    expect(order()).toEqual(['513310', '518880', '161226']);
    // 点非收藏 161226 的星 → 移入收藏区（按 favoriteSort 归位 → 收藏尾）
    await userEvent.click(screen.getByRole('button', { name: '收藏 161226' }));
    await waitFor(() => expect(order()).toEqual(['513310', '518880', '161226']));
    // 点收藏 513310 的星 → 移出收藏区（非收藏置后，收藏区只剩 518880/161226）
    await userEvent.click(screen.getByRole('button', { name: '取消收藏 513310' }));
    await waitFor(() => expect(order()).toEqual(['518880', '161226', '513310']));
  });

  it('拖拽重排：收藏行 drop 到新位置 → 调 onReorderFavorites(codes 新顺序)', () => {
    const { props } = renderList({ symbols: MIXED });
    const source = document.querySelector('[data-handle="513310"]')!;
    const target = screen.getByText('黄金ETF').closest('button')!; // 518880 row
    const tf = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn(() => '') };
    fireEvent.dragStart(source, { dataTransfer: tf });
    fireEvent.dragOver(target, { dataTransfer: tf });
    fireEvent.drop(target, { dataTransfer: tf });
    // 513310 拖到 518880 位置 → 新收藏顺序 ['518880', '513310']
    expect(props.onReorderFavorites).toHaveBeenCalledWith(['518880', '513310']);
  });
});
