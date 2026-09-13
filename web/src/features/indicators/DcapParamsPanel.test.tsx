/**
 * DCAP 参数面板（Toolbar 内联编辑，形态照 MA windows）—— 单测
 *
 * 本文件位置：`web/src/features/indicators/DcapParamsPanel.test.tsx`
 * 被测文件：  `web/src/features/indicators/DcapParamsPanel.tsx`（手写）
 * 权威口径：  `design/14-dcap-indicator/02-spec.md` §7（配置面：Toolbar 内联面板，形态同 MA windows）
 * 运行：      cd web && npx vitest run src/features/indicators/DcapParamsPanel.test.tsx
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { DcapParamsPanel } from './DcapParamsPanel';
import { DEFAULT_DCAP_PARAMS } from './dcapIndicator';

function open(overrides: Partial<Parameters<typeof DcapParamsPanel>[0]> = {}) {
  const onSave = overrides.onSave ?? vi.fn(async () => {});
  const view = render(
    <DcapParamsPanel params={overrides.params ?? DEFAULT_DCAP_PARAMS} onSave={onSave} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'DCAP 配置' }));
  return { onSave, unmount: view.unmount };
}

function field(key: string): HTMLInputElement | HTMLSelectElement {
  return screen.getByTestId(`dcap-input-${key}`) as HTMLInputElement | HTMLSelectElement;
}

function setValue(key: string, value: string) {
  fireEvent.change(field(key), { target: { value } });
}

describe('DcapParamsPanel（内联参数面板，8 显示参数；不含 th）', () => {
  it('收起态：按钮显示 DCAP(n_s,n_m,n_l) 摘要，面板未展开', () => {
    render(<DcapParamsPanel params={DEFAULT_DCAP_PARAMS} onSave={vi.fn(async () => {})} />);
    const btn = screen.getByRole('button', { name: 'DCAP 配置' });
    expect(btn).toHaveTextContent('DCAP(8,26,60)');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'DCAP 参数' })).toBeNull();
  });

  it('展开态：8 个显示参数输入齐备，初值 = 当前参数', () => {
    open();
    expect(screen.getByRole('group', { name: 'DCAP 参数' })).toBeInTheDocument();
    for (const key of ['n_s', 'n_m', 'n_l', 'r_s', 'r_m', 'r_l', 'smooth', 'm']) {
      expect(field(key), `${key} 输入存在`).toBeInTheDocument();
    }
    expect(field('n_s').value).toBe('8');
    expect(field('n_l').value).toBe('60');
    expect(field('r_s').value).toBe('1');
    expect(field('m').value).toBe('3');
    expect(field('smooth').value).toBe('1');
    // th 不在此面板（只属策略参数）：面板内不存在 th 输入
    expect(screen.queryByTestId('dcap-input-th')).toBeNull();
  });

  it('保存合法编辑 → onSave 收到解析后的 8 参数（r 保留小数、smooth=0、m 整数）', async () => {
    const { onSave } = open();
    setValue('n_s', '5');
    setValue('n_m', '20');
    setValue('n_l', '120');
    setValue('r_s', '1.5');
    setValue('r_l', '1.02');
    setValue('smooth', '0');
    setValue('m', '5');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      n_s: 5, n_m: 20, n_l: 120, r_s: 1.5, r_m: 1, r_l: 1.02, smooth: 0, m: 5,
    });
  });

  it('非单调 n（n_s ≥ n_m）→ 拒绝：不调用 onSave，给出错误提示', async () => {
    const { onSave } = open();
    setValue('n_s', '26');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('n_s < n_m < n_l');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('越界（n_l=251 / m=61 / r=2.01 / 非整数 n）→ 拒绝且不调用 onSave', async () => {
    const cases: Array<[string, string]> = [['n_l', '251'], ['m', '61'], ['r_m', '2.01'], ['n_m', '26.5']];
    for (const [key, value] of cases) {
      const { onSave, unmount } = open();
      setValue(key, value);
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      await waitFor(() => expect(screen.getByRole('alert'), `${key}=${value} 应报错`).toBeInTheDocument());
      expect(onSave, `${key}=${value} 不得落库`).not.toHaveBeenCalled();
      expect(screen.getByRole('group', { name: 'DCAP 参数' }), '面板仍开着').toBeInTheDocument();
      unmount();
    }
  });

  it('服务端保存失败 → 面板保持打开并报错（不静默吞错）', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('HTTP 400');
    });
    open({ onSave });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('group', { name: 'DCAP 参数' })).toBeInTheDocument();
  });

  it('外部参数变化（面板关闭时）→ 草稿同步；保存成功后收起面板', async () => {
    const onSave = vi.fn(async () => {});
    const { rerender } = render(<DcapParamsPanel params={DEFAULT_DCAP_PARAMS} onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'DCAP 配置' })).toHaveTextContent('DCAP(8,26,60)');
    rerender(<DcapParamsPanel params={{ ...DEFAULT_DCAP_PARAMS, n_l: 120 }} onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'DCAP 配置' })).toHaveTextContent('DCAP(8,26,120)');
    fireEvent.click(screen.getByRole('button', { name: 'DCAP 配置' }));
    expect(field('n_l').value).toBe('120');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await act(async () => {});
    expect(onSave).toHaveBeenCalledWith({ ...DEFAULT_DCAP_PARAMS, n_l: 120 });
    expect(screen.queryByRole('group', { name: 'DCAP 参数' })).toBeNull();
  });
});
