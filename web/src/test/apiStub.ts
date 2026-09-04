import { vi } from 'vitest';
import type { ApiClient } from '@/api/client';
import { createMockClient } from '@/api/mock';

/**
 * 以契约 mock 为底座、逐方法可覆写的 ApiClient stub（行为测试用）。
 * 新增接口方法时仅需改此处与 mock，页面测试 fake 不再逐个补方法。
 */
export function stubApi(overrides: Partial<ApiClient> = {}): ApiClient {
  const base = createMockClient() as unknown as Record<string, unknown>;
  const stubbed = Object.fromEntries(
    Object.entries(base).map(([k, v]) => [k, vi.fn(v as (...args: never[]) => unknown)]),
  );
  return { ...stubbed, ...overrides } as unknown as ApiClient;
}
