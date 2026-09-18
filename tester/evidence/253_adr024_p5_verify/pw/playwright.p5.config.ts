import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: './pw-artifacts',
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  use: { baseURL: process.env.E2E_BASE_URL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', trace: 'off' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
