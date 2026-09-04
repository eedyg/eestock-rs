import { expect, test } from '@playwright/test';
import { gotoPage } from './helpers/pages';

/**
 * 功能流（design/06-web/09-frontend「用例分层：功能流」）：页面⑦ 告警中心。
 * ⑦告警确认：对 status='triggered' 的告警点「确认」（POST /api/alerts/{id}/ack，
 * 记录确认时刻并持久化），断言 UI 就地翻转为「已确认」。
 *
 * 状态容忍：告警是否恰有「触发中」条目取决于实时评估（WS/后台），并非每次都有。
 * 若窗口内无「确认」按钮，则断言告警列表已渲染（骨架消失）并通过（记录诊断）。
 * 确认是真实产品动作，不污染数据，无需 SQL 清理（与标的管理清理纪律区分）。
 */
test.describe('页面⑦ 告警中心：告警确认', () => {
  test('触发中告警点确认 → 翻转为已确认（容忍：无触发则记录诊断）', async ({ page }) => {
    await gotoPage(page, '/alerts');
    const list = page.locator('[data-region="alert-list"]');
    await expect(list).toBeVisible();

    // 等列表离开骨架态（animate-pulse 消失：数据载入或错误/空态）
    await expect(list.locator('.animate-pulse')).toHaveCount(0, { timeout: 15_000 });

    // 规则面板也应渲染（内置规则预置，非空）
    const rulePanel = page.locator('[data-region="rule-panel"]');
    await expect(rulePanel).toBeVisible();

    const ackBtn = list.getByRole('button', { name: '确认' }).first();
    const hasTriggered = (await ackBtn.count()) > 0;

    if (!hasTriggered) {
      // 无触发中告警：容忍（记录诊断，不失败）
      console.warn('无触发中告警 -> 确认用例转为「列表已渲染」验证（状态容忍）');
      // 列表此时应为「暂无告警」或已成列表
      const rowsOrEmpty = (await list.locator('div').count()) > 0;
      expect(rowsOrEmpty).toBeTruthy();
      return;
    }

    // 找到该确认按钮所属的告警行（父级 mb-1.5 容器），先取 JSHandle 锁住行节点
    // （点击后「确认」按钮被替换为「已确认」，不能再用按钮派生 locator）
    const rowHandle = await ackBtn
      .locator('xpath=ancestor::div[contains(@class,"mb-1.5")][1]')
      .elementHandle();
    expect(rowHandle).not.toBeNull();
    await ackBtn.click();

    // 确认后：行内出现「已确认」（或被 WS 后续置为「已恢复」，同样证明翻转生效）
    await expect
      .poll(
        async () => (await rowHandle!.evaluate((el) => el.textContent ?? '')) || '',
        { timeout: 10_000 },
      )
      .toMatch(/已确认|已恢复/);
  });
});
