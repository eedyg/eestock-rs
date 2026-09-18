/**
 * **tester 独立复验（ADR-024 P5 整改 N1 · 前端）** —— 2026-09-18 第 254 号验收单。
 *
 * 断言（**不复用 worker 断言**；worker 载体 = `web/src/api/errorMessages.test.ts`）：
 * 1. `code → 中文`：从 **后端源码** `crates/application/src/error.rs::codes::ALL` 解析码集合，
 *    逐码断言前端 `errorDisplayText` 给出「中文提示 + 服务端原文」（而非回退原文＝无映射）。
 * 2. **未知码 ⇒ 回退 `message`**（不得只显示「未知错误」/吞信息）。
 * 3. 两条**消费路径**各一条：工作台提交（`WorkbenchStore.submit`）/ 在线试算（`TestRunPanel`）。
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/api/types';
import type { ApiClient } from '@/api/client';
import type { WsClient } from '@/ws/WsClient';
import { errorDisplayText, isKnownErrorCode } from '@/api/errorMessages';
import { WorkbenchStore } from '@/features/workbench/store';
import { TestRunPanel } from '@/features/strategies/TestRunPanel';

const HERE = dirname(fileURLToPath(import.meta.url));
// web/src/features/strategies → 仓库根 → crates/application/src/error.rs
const ERROR_RS = readFileSync(
  resolve(HERE, '../../../../crates/application/src/error.rs'),
  'utf8',
);

/** 从后端 Rust 源码解析 `pub const NAME: &str = "value";` 与 `codes::ALL` 表（独立期望来源）。 */
function backendCodes(): string[] {
  const defined = new Map<string, string>();
  for (const line of ERROR_RS.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('pub const ')) continue;
    const m = /^pub const ([A-Z_0-9]+): &str = "(.*)";$/.exec(l);
    if (m) defined.set(m[1]!, m[2]!);
  }
  const block = ERROR_RS.split('pub const ALL: &[&str] = &[')[1]!.split('];')[0]!;
  return block
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((name) => {
      const v = defined.get(name);
      if (!v) throw new Error(`codes::ALL 里的 ${name} 无对应常量定义`);
      return v;
    });
}

const SERVER_MESSAGE = '服务端原文（人类可读，含上下文细节）';

describe('tester·N1 前端：code → 中文（独立期望 = application::error::codes::ALL）', () => {
  const codes = backendCodes();

  it('codes::ALL 解析成功且数量 ≥ 20（防解析失效的空断言）', () => {
    expect(codes.length).toBeGreaterThanOrEqual(20);
    expect(codes).toContain('range_empty');
    expect(codes).toContain('resource_guard');
  });

  it('后端每个码都被前端识别，且展示 ≠ 原文（= 命中中文映射，而非未知码回退）', () => {
    const notMapped: string[] = [];
    for (const code of codes) {
      const err = new ApiError(400, SERVER_MESSAGE, code, {});
      const text = errorDisplayText(err);
      if (!isKnownErrorCode(code) || text === SERVER_MESSAGE) notMapped.push(code);
      else expect(text).toContain(SERVER_MESSAGE); // 保留服务端原文（可诊断）
    }
    expect(notMapped, `前端未映射的后端码: ${notMapped.join(', ')}`).toEqual([]);
  });

  it('未知码 ⇒ 回退服务端 message（不吞信息、不显示「未知错误」）', () => {
    const text = errorDisplayText(new ApiError(400, SERVER_MESSAGE, 'code_from_the_future_2099'));
    expect(text).toBe(SERVER_MESSAGE);
    expect(isKnownErrorCode('code_from_the_future_2099')).toBe(false);
  });

  it('无 code（旧形状/网络错误）⇒ message 原样', () => {
    expect(errorDisplayText({ message: 'Failed to fetch' })).toBe('Failed to fetch');
  });

  it('range_empty 的 detail 回显可用区间（中文提示内联 detail）', () => {
    const text = errorDisplayText(
      new ApiError(400, SERVER_MESSAGE, 'range_empty', {
        available_from: '2026-01-01T00:00:00Z',
        available_to: '2026-02-01T00:00:00Z',
      }),
    );
    expect(text).toContain('2026-01-01T00:00:00Z');
    expect(text).toContain('2026-02-01T00:00:00Z');
  });
});

/** 极简 ws stub（不订阅任何主题）。 */
function wsStub(): WsClient {
  return { subscribe: vi.fn(() => () => {}) } as unknown as WsClient;
}

describe('tester·N1 消费路径 ①：工作台提交（WorkbenchStore.submit）', () => {
  function mkStore(submit: () => Promise<never>) {
    const api = { submitWorkbenchRun: vi.fn(submit) } as unknown as ApiClient;
    return new WorkbenchStore({ api, ws: wsStub() });
  }

  const req = {
    symbol: '518880',
    period: 'D1',
    from: '2026-01-01T00:00:00Z',
    to: '2026-02-01T00:00:00Z',
    slots: [{ version_id: 'sv_x', weight: 1 }],
    policy: { LumpSum: { position_pct: 1 } },
  } as never;

  it('已知码（period_invalid）⇒ submitError 为中文提示 + 服务端原文', async () => {
    const store = mkStore(() =>
      Promise.reject(new ApiError(400, SERVER_MESSAGE, 'period_invalid')),
    );
    await store.submit(req);
    const text = store.state.submitError!;
    expect(text).toContain('不支持的周期');
    expect(text).toContain(SERVER_MESSAGE);
  });

  it('未知码 ⇒ submitError 回退服务端 message', async () => {
    const store = mkStore(() =>
      Promise.reject(new ApiError(400, SERVER_MESSAGE, 'brand_new_code_2099')),
    );
    await store.submit(req);
    expect(store.state.submitError).toBe(SERVER_MESSAGE);
  });
});

describe('tester·N1 消费路径 ②：在线试算（TestRunPanel）', () => {
  const SCHEMA = [
    { key: 'fast', type: 'int' as const, default: 5, min: 1, max: 250, description: '快线' },
  ];

  it('已知码（period_invalid）⇒ 面板内联展示中文提示', async () => {
    const user = userEvent.setup();
    const api = {
      runStrategyTest: vi.fn(() =>
        Promise.reject(new ApiError(400, SERVER_MESSAGE, 'period_invalid')),
      ),
    } as unknown as ApiClient;
    render(<TestRunPanel api={api} code={'function on_bar(ctx){return 50;}'} schema={SCHEMA} />);
    await user.click(screen.getByTestId('tr-run'));
    await waitFor(() => expect(screen.getByTestId('tr-run-error')).toBeInTheDocument());
    expect(screen.getByTestId('tr-run-error').textContent).toContain('不支持的周期');
  });

  it('未知码 ⇒ 面板内联展示服务端 message（回退）', async () => {
    const user = userEvent.setup();
    const api = {
      runStrategyTest: vi.fn(() =>
        Promise.reject(new ApiError(400, SERVER_MESSAGE, 'brand_new_code_2099')),
      ),
    } as unknown as ApiClient;
    render(<TestRunPanel api={api} code={'function on_bar(ctx){return 50;}'} schema={SCHEMA} />);
    await user.click(screen.getByTestId('tr-run'));
    await waitFor(() =>
      expect(screen.getByTestId('tr-run-error').textContent).toContain(SERVER_MESSAGE),
    );
  });
});
