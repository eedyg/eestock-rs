import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * tester·**⑤ `WorkbenchStore.dispose()` 单向 `disposed=true` 的爆炸半径** —— 第 254 号验收单。
 *
 * 机制（只读定位）：`WorkbenchPage` 用 `useMemo(() => new WorkbenchStore(...), [api, ws])` 持有 store，
 * `useEffect(..., [store])` 的清理函数调用 `store.dispose()`；`dispose()` **单向**置 `disposed = true`
 * 且无复位 ⇒ 其后所有 `patch()` 静默丢弃 ⇒ `catalogLoading` 恒 true ⇒ 下拉恒「加载中…」。
 *
 * 环境变量 `P5RV_EXPECT`：
 *   - `healthy`（生产构建，默认）：断言下拉**最终非空**；
 *   - `stuck`（vite dev + StrictMode）：断言下拉**恒为 1 个占位项**且同刻 `/api/strategies` 为 200
 *     —— 即缺陷在 dev 可达、且**不是**网络/数据问题。
 *
 * 生产可达性探针：SPA 内**路由往返**（NavLink 点击，无整页刷新）= 卸载 → dispose → 重建 store。
 * ⚠️ 每次读取都**先 poll（最长 20s）**，把「尚未加载完」与「store 被 dispose 恒卡」区分开。
 */
const EXPECT = process.env.P5RV_EXPECT ?? 'healthy';
const POLL_MS = 20_000;

type DropState = { ok: number; count: number; placeholder: string; settled: boolean };

function watchStrategies(page: Page) {
  const st = { ok: 0 };
  page.on('response', (r) => {
    if (r.url().includes('/api/strategies') && r.request().method() === 'GET' && r.status() === 200) st.ok += 1;
  });
  return st;
}

/** 读下拉状态：poll 到「option>1」或 20s 超时（超时即 settled=false ⇒ 恒卡）。 */
async function readDropdown(page: Page): Promise<DropState> {
  const addSel = page.getByTestId('wb-add-strategy');
  await expect(addSel).toBeVisible({ timeout: 15_000 });
  let settled = true;
  try {
    await expect.poll(async () => addSel.locator('option').count(), { timeout: POLL_MS }).toBeGreaterThan(1);
  } catch {
    settled = false;
  }
  const count = await addSel.locator('option').count();
  const placeholder = await addSel.locator('option').first().innerText();
  return { ok: 0, count, placeholder, settled };
}

async function enterWorkbench(page: Page, net: { ok: number }): Promise<DropState> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('workbench-page')).toBeVisible();
  await expect.poll(() => net.ok, { timeout: 15_000, message: '/api/strategies 应 200' }).toBeGreaterThan(0);
  const s = await readDropdown(page);
  return { ...s, ok: net.ok };
}

test('⑤-A 首屏：下拉状态（prod=healthy 期望 / dev=stuck 期望）', async ({ page }) => {
  const net = watchStrategies(page);
  const s = await enterWorkbench(page, net);
  console.log(
    `[⑤-A] P5RV_EXPECT=${EXPECT} /api/strategies 200 次数=${net.ok} option 数=${s.count} 恒卡=${!s.settled} 第1项="${s.placeholder}"`,
  );
  if (EXPECT === 'stuck') {
    expect(s.settled, 'dev（StrictMode）下应恒卡（20s 后仍只有占位项）').toBe(false);
    expect(s.count).toBe(1);
    expect(s.placeholder).toContain('加载中');
  } else {
    expect(s.settled, '生产构建首屏应加载出 catalog').toBe(true);
    expect(s.count).toBeGreaterThan(1);
    expect(s.placeholder).not.toContain('加载中');
  }
  await page.screenshot({ path: `artifacts/blast-01-first-mount-${EXPECT}.png` });
});

test('⑤-B 生产可达性探针：SPA 路由往返（卸载 → dispose → 重建）', async ({ page }) => {
  const net = watchStrategies(page);
  const s1 = await enterWorkbench(page, net);
  console.log(`[⑤-B] 首挂 option 数=${s1.count} 恒卡=${!s1.settled}`);

  const before = net.ok;
  await page.click('a[href="/"]');
  await expect(page.getByTestId('workbench-page')).toBeHidden({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await page.click('a[href="/backtest-workbench"]');
  await expect(page.getByTestId('workbench-page')).toBeVisible();
  await expect
    .poll(() => net.ok, { timeout: 15_000, message: '往返后应重新拉 catalog（200）' })
    .toBeGreaterThan(before);

  const s2 = await readDropdown(page);
  console.log(
    `[⑤-B] 往返后 option 数=${s2.count} 恒卡=${!s2.settled} 第1项="${s2.placeholder}"（/api/strategies 200 次数=${net.ok}）`,
  );
  await page.screenshot({ path: `artifacts/blast-02-roundtrip-${EXPECT}.png` });

  if (EXPECT === 'stuck') {
    expect(s2.settled, 'dev：每个挂载都被 StrictMode 双调用 ⇒ 往返后仍应恒卡').toBe(false);
  } else {
    expect(s2.settled, '生产：路由往返后下拉应仍可加载（否则 = 生产可达缺陷）').toBe(true);
    expect(s2.count).toBeGreaterThan(1);
  }
});

test('⑤-C 生产可达性探针：二次往返 + 整页重载', async ({ page }) => {
  const net = watchStrategies(page);
  await enterWorkbench(page, net);
  const results: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const before = net.ok;
    await page.click('a[href="/"]');
    await expect(page.getByTestId('workbench-page')).toBeHidden({ timeout: 15_000 });
    await page.click('a[href="/backtest-workbench"]');
    await expect(page.getByTestId('workbench-page')).toBeVisible();
    await expect.poll(() => net.ok, { timeout: 15_000 }).toBeGreaterThan(before);
    const s = await readDropdown(page);
    console.log(`[⑤-C] 第 ${i + 1} 次往返 option 数=${s.count} 恒卡=${!s.settled}`);
    results.push(s.settled ? s.count : 0);
  }
  for (const c of results) {
    if (EXPECT === 'stuck') expect(c).toBe(0);
    else expect(c).toBeGreaterThan(1);
  }
  // 整页重载（新 document、新 store）
  const before = net.ok;
  await page.reload();
  await expect(page.getByTestId('workbench-page')).toBeVisible();
  await expect.poll(() => net.ok, { timeout: 15_000 }).toBeGreaterThan(before);
  const s = await readDropdown(page);
  console.log(`[⑤-C] reload 后 option 数=${s.count} 恒卡=${!s.settled}`);
  if (EXPECT === 'stuck') expect(s.settled).toBe(false);
  else expect(s.count).toBeGreaterThan(1);
});
