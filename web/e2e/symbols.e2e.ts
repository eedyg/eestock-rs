import { expect, test } from '@playwright/test';
import { gotoPage } from './helpers/pages';
import { cleanupSymbol, countCode, preClean, psql } from './helpers/db';

/**
 * 功能流（design/06-web/09-frontend「用例分层：功能流」）：页面③ 标的管理。
 * ③注册临时真实标的 → 列表出现 → 停用 → SQL 清理。
 *
 * 写操作纪律（tester/report/006 §10 同源）：测试用真实市场标的、测试后 SQL 清理、留台账。
 * 本用例唯一 code=510300（真实沪深300ETF，非已注册集），用唯一外键 code 隔离，
 * 不与既有 44 个 code 冲突；`test.afterEach` 兜底清理，`preClean` 开头清残留。
 */

const TEST_CODE = '510300';
const TEST_NAME = '沪深300ETF(E2E临时)';
const NAME_PLACEHOLDER = '留空可后续编辑补录';

test.describe('页面③ 标的管理：注册临时真实标的→停用→SQL清理', () => {
  test.beforeEach(() => {
    preClean(TEST_CODE);
  });

  test.afterEach(() => {
    // 兜底：即使断言中途失败也清理，防残留
    cleanupSymbol(TEST_CODE);
  });

  test('注册 → 列表出现 → 停用 → SQL 清理归零', async ({ page }) => {
    // 停用需 window.confirm 二次确认（03-symbols §4），自动接受
    page.on('dialog', (d) => d.accept());

    await gotoPage(page, '/symbols');
    const table = page.locator('[data-region="symbol-table"]');
    await expect(table).toBeVisible();

    // 打开注册模态
    await page.getByRole('button', { name: /注册标的/ }).first().click();
    const dialog = page.locator('[data-region="form-dialog"]');
    await expect(dialog).toBeVisible();

    // 填 code（code 输入 placeholder="600519"）+ 名称
    await dialog.getByPlaceholder('600519').fill(TEST_CODE);
    await dialog.getByPlaceholder(NAME_PLACEHOLDER).fill(TEST_NAME);

    // 保存（enabled 默认 true；服务端反查名称，留空则用 name 兜底）
    await dialog.getByRole('button', { name: '保存' }).click();

    // 等列表出现该 code（POST → 关窗 → 刷新列表）
    await expect(table.getByText(TEST_CODE)).toBeVisible({ timeout: 15_000 });

    // 停用：该行「停用」按钮 → confirm 接受 → PATCH enabled:false → 刷新
    const row = table.locator('tr', { hasText: TEST_CODE });
    await row.getByRole('button', { name: '停用' }).click();
    await expect(row.getByRole('button', { name: '启用' })).toBeVisible({ timeout: 15_000 });

    // SQL 清理 → 复核归零（台账由 cleanupSymbol 写入 sql-ledger.md）
    const ledger = cleanupSymbol(TEST_CODE);
    const after = JSON.parse(ledger.after) as Record<string, number>;
    expect(after.symbols).toBe(0);
    const live = psql(`SELECT count(*) FROM symbols WHERE code='${TEST_CODE}';`);
    expect(live).toBe('0');
  });
});
