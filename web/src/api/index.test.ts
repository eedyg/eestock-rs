import { describe, it, expect, vi, afterEach } from 'vitest';

// 防回归（mock 构建事故）：默认值必须站在生产一侧——
// 仅 VITE_API_MOCK === '1' 才启用契约 mock；未设置 / '0' / 其他值一律走真实 HTTP client。
// 用 sentinel 替换两个工厂，动态 import + resetModules 让模块级 useMock 在不同 env 下重新求值。

const MOCK_SENTINEL = { __kind: 'mock' };
const HTTP_SENTINEL = { __kind: 'http' };

vi.mock('./mock', () => ({ createMockClient: () => MOCK_SENTINEL }));
vi.mock('./client', () => ({ createHttpClient: () => HTTP_SENTINEL }));

async function loadDefaultApi(): Promise<unknown> {
  vi.resetModules();
  const mod = await import('./index');
  return mod.defaultApi;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('defaultApi 数据源选择（构建期 env VITE_API_MOCK）', () => {
  it('未设置 VITE_API_MOCK → 真实 HTTP client（默认站在生产一侧）', async () => {
    vi.stubEnv('VITE_API_MOCK', undefined as unknown as string);
    expect(await loadDefaultApi()).toBe(HTTP_SENTINEL);
  });

  it("VITE_API_MOCK='0' → 真实 HTTP client", async () => {
    vi.stubEnv('VITE_API_MOCK', '0');
    expect(await loadDefaultApi()).toBe(HTTP_SENTINEL);
  });

  it("VITE_API_MOCK='1' → 契约 mock client（仅此值启用）", async () => {
    vi.stubEnv('VITE_API_MOCK', '1');
    expect(await loadDefaultApi()).toBe(MOCK_SENTINEL);
  });

  it("VITE_API_MOCK 为其他值（如 'true'）→ 真实 HTTP client（不猜测，只认 '1'）", async () => {
    vi.stubEnv('VITE_API_MOCK', 'true');
    expect(await loadDefaultApi()).toBe(HTTP_SENTINEL);
  });
});
