import { defineConfig } from '@playwright/test';

/**
 * tester 独立复验 harness（ADR-024 P5 整改 · 第 254 号验收单）。
 * 目标：真浏览器（chromium）跑 **生产构建 SPA**（app 托管 ./web/dist）与 **vite dev** 两条车道。
 * baseURL 由 env `E2E_BASE_URL` 给出。
 */
export default defineConfig({
  outputDir: './artifacts',
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'off',
    screenshot: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
