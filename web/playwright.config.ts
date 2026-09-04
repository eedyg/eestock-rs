import { defineConfig, devices } from '@playwright/test';

/**
 * Web E2E 测试栈（design/06-web/09-frontend.md「E2E 测试栈」定稿）。
 *
 * 运行目标：真实 app 容器 + 真实 DB（用户选 a）。baseURL 由 env `E2E_BASE_URL` 覆盖，
 * 默认 `http://localhost:8081`（docker-compose 应用面端口）。
 *
 * 关键口径：
 * - 只测 chromium；retries=1；失败截屏+trace 落 `web/e2e/artifacts/`。
 * - 断言状态容忍（交易日价格/时间在变），不锁死具体数值。
 * - 视觉回归基线存 `web/e2e/screenshots/`；对易变数据区用 mask 结构化基线（见 visual.e2e.ts）。
 * - testMatch 用 `*.e2e.ts`（vitest 默认只收 `*.spec|test.*`，避免 vitest 误跑 e2e；
 *   不改 vite.config.ts，遵守「只动 web/e2e、web/package.json、web/playwright.config.ts」范围）。
 */

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8081';

export default defineConfig({
  outputDir: './e2e/artifacts/test-results',
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  // workers=1 串行：真容器上有状态写用例（注册真实标的→停用→SQL清理）会瞬时改库；
  // 视觉基线/走查截图对“标的总数+源码表”敏感，串行避免并发截图采到测试标的造成误报。
  workers: 1,
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // 视觉基线统一落在 web/e2e/screenshots/（动态数据 mask 见各用例）
  snapshotPathTemplate:
    '{testDir}/screenshots/{testFilePath}-snapshots/{arg}{-projectName}{-platform}{ext}',
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    // 桌面最小宽 1280（index.html viewport=1280）
    viewport: { width: 1280, height: 800 },
    // 首页为 SPA，React 数据异步加载；给足超时避免真容器慢查询误报
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
