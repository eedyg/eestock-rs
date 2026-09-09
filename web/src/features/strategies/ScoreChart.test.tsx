import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScoreChart } from './ScoreChart';

describe('ScoreChart（试算评分曲线）', () => {
  it('buy/sell 信号标记按 ts 对齐 score 点渲染；无对应点的信号跳过', () => {
    render(
      <ScoreChart
        scores={[
          { ts: 100, score: 50 },
          { ts: 200, score: 70 },
          { ts: 300, score: 30 },
        ]}
        signals={[
          { ts: 200, signal: 'buy' },
          { ts: 300, signal: 'sell' },
          { ts: 200, signal: 'hold' }, // hold 不渲染
          { ts: 999, signal: 'buy' }, // 无对应 score 点 → 跳过
        ]}
      />,
    );
    expect(screen.getAllByTestId('signal-buy')).toHaveLength(1);
    expect(screen.getAllByTestId('signal-sell')).toHaveLength(1);
    expect(screen.getByTestId('score-chart')).toHaveTextContent('3 bar');
  });

  it('score=null（熔断 bar）断线：分段 polyline 不跨 null 点', () => {
    const { container } = render(
      <ScoreChart
        scores={[
          { ts: 100, score: 50 },
          { ts: 200, score: null },
          { ts: 300, score: 30 },
        ]}
      />,
    );
    // 两段独立 polyline（null 前/后各一）
    expect(container.querySelectorAll('polyline')).toHaveLength(2);
  });
});
