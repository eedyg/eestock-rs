import '@testing-library/jest-dom/vitest';

// jsdom 缺口补齐（klinecharts 在组件测试中整体 mock，此处为壳组件兜底）
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!('ResizeObserver' in globalThis)) {
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}
