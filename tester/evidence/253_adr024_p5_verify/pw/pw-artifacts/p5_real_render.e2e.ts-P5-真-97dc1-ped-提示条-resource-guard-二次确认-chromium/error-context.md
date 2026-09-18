# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: p5_real_render.e2e.ts >> P5 真渲染：available_range 联动 min/max + clamped 提示条 + resource_guard 二次确认
- Location: e2e-tester-p5/p5_real_render.e2e.ts:4:1

# Error details

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 1
Received:   1

Call Log:
- Timeout 20000ms exceeded while waiting on the predicate
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - generic [ref=e5]: 已收盘 16:15
    - generic [ref=e8]: 采集停止
    - link "1m 源健康 0/0 →数据源诊断" [ref=e11] [cursor=pointer]:
      - /url: /sources
  - generic [ref=e14]:
    - navigation [ref=e15]:
      - list [ref=e16]:
        - listitem [ref=e17]:
          - link "① 行情看板" [ref=e18] [cursor=pointer]:
            - /url: /
        - listitem [ref=e19]:
          - link "② 数据源诊断" [ref=e20] [cursor=pointer]:
            - /url: /sources
        - listitem [ref=e21]:
          - link "③ 标的管理" [ref=e22] [cursor=pointer]:
            - /url: /symbols
        - listitem [ref=e23]:
          - link "④ 数据质量" [ref=e24] [cursor=pointer]:
            - /url: /quality
        - listitem [ref=e25]:
          - generic [ref=e26]:
            - generic [ref=e27]: ⑥ 交易面板
            - emphasis [ref=e28]: W4
        - listitem [ref=e29]:
          - link "⑦ 告警中心" [ref=e30] [cursor=pointer]:
            - /url: /alerts
        - listitem [ref=e31]:
          - link "⑧ 系统设置" [ref=e32] [cursor=pointer]:
            - /url: /settings
        - listitem [ref=e33]:
          - link "⑨ 模拟实盘" [ref=e34] [cursor=pointer]:
            - /url: /sim-live
        - listitem [ref=e35]:
          - link "⑩ 策略" [ref=e36] [cursor=pointer]:
            - /url: /strategies
        - listitem [ref=e37]:
          - link "⑪ 回测工作台" [ref=e38] [cursor=pointer]:
            - /url: /backtest-workbench
    - generic [ref=e39]:
      - generic [ref=e40]:
        - generic [ref=e42]:
          - generic [ref=e43]:
            - generic [ref=e44]: 组合预设
            - combobox [ref=e47]:
              - option "选择预设…" [selected]
            - generic [ref=e48]:
              - textbox "预设名" [ref=e49]
              - button "保存" [ref=e50] [cursor=pointer]
              - button "重命名" [disabled] [ref=e51]
              - button "删除" [disabled] [ref=e52]
          - generic [ref=e53]:
            - generic [ref=e54]: 策略（多选，加权聚合）
            - generic [ref=e55]:
              - combobox [disabled] [ref=e56]:
                - option "加载中…" [selected]
              - button "添加" [disabled] [ref=e57]
          - generic [ref=e58]:
            - generic [ref=e59]:
              - text: 名称（可选）
              - textbox "名称（可选）" [ref=e60]
            - generic [ref=e61]:
              - text: 标的
              - combobox "标的" [ref=e62]:
                - option "518880" [selected]
            - generic [ref=e63]:
              - text: 周期
              - combobox "周期" [ref=e64]:
                - option "M1" [selected]
                - option "M5"
                - option "M15"
                - option "M30"
                - option "H1"
                - option "D1"
            - generic [ref=e65]:
              - text: 初始资金
              - spinbutton "初始资金" [ref=e66]: "100000"
            - generic [ref=e67]:
              - text: 起始
              - textbox "起始" [ref=e68]: 2026-06-20
            - generic [ref=e69]:
              - text: 截止
              - textbox "截止" [ref=e70]: 2026-09-18
          - generic [ref=e71]: 可用区间：2013-07-29 ~ 2026-09-17
          - generic [ref=e72]:
            - generic [ref=e73]:
              - text: 买入阈值（≥ 买）
              - spinbutton "买入阈值（≥ 买）" [ref=e74]: "60"
            - generic [ref=e75]:
              - text: 卖出阈值（≤ 卖）
              - spinbutton "卖出阈值（≤ 卖）" [ref=e76]: "40"
          - generic [ref=e77]:
            - generic [ref=e78]:
              - text: 执行策略（ExecutionPolicy）
              - combobox "执行策略（ExecutionPolicy）" [ref=e79]:
                - option "LumpSum 一次性" [selected]
                - option "DCA 分批"
            - generic [ref=e80]:
              - text: 仓位比例 (0,1]
              - spinbutton "仓位比例 (0,1]" [ref=e81]: "1"
          - generic [ref=e83]:
            - checkbox "启用硬止损（触发即绕过评分平仓）" [ref=e84]
            - text: 启用硬止损（触发即绕过评分平仓）
          - generic [ref=e85]:
            - generic [ref=e86]:
              - text: 佣金率%
              - spinbutton "佣金率%" [ref=e87]: "0.025"
            - generic [ref=e88]:
              - text: 最低佣金
              - spinbutton "最低佣金" [ref=e89]: "5"
            - generic [ref=e90]:
              - text: 滑点 bp
              - spinbutton "滑点 bp" [ref=e91]: "2"
          - button "提交回测" [ref=e92] [cursor=pointer]
        - generic [ref=e95]:
          - generic [ref=e96]: 运行历史（勾选 0/4 对比）
          - button "刷新" [ref=e97] [cursor=pointer]
      - generic [ref=e100]: 选择左侧已完成运行查看结果（或勾选 2-4 个运行进入对比）
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | /** ADR-024 P5 真渲染（tester 独立验收）：真实浏览器 + 真实第二实例（临时库）+ vite dev（proxy /api）。 */
  4  | test('P5 真渲染：available_range 联动 min/max + clamped 提示条 + resource_guard 二次确认', async ({ page }) => {
  5  |   const apiCalls: string[] = [];
  6  |   page.on('response', (r) => { if (r.url().includes('/api/workbench/available_range')) apiCalls.push(r.url()); });
  7  | 
  8  |   const apiLog: string[] = [];
  9  |   page.on('response', async (r) => {
  10 |     if (r.url().includes('/api/strategies')) apiLog.push(`${r.status()} ${r.url()} ${(await r.text()).slice(0, 120)}`);
  11 |   });
  12 |   page.on('console', (m) => { if (m.type() === 'error') apiLog.push(`console.error: ${m.text()}`); });
  13 |   page.on('pageerror', (e) => apiLog.push(`pageerror: ${e.message}`));
  14 |   await page.goto('/backtest-workbench');
  15 |   await expect(page.getByTestId('workbench-page')).toBeVisible();
  16 | 
  17 |   // 标的 + 周期切换 ⇒ 日期控件 min/max 随 available_range 联动
  18 |   await page.getByTestId('wb-symbol').selectOption('518880');
  19 |   await page.getByTestId('wb-period').selectOption('M1');
  20 |   await expect(page.getByTestId('wb-date-from')).toHaveAttribute('min', '2013-07-29');
  21 |   await expect(page.getByTestId('wb-date-from')).toHaveAttribute('max', '2026-09-17');
  22 |   await expect(page.getByTestId('wb-available-range')).toContainText('2013-07-29');
  23 |   console.log('[真渲染] available_range 请求=', JSON.stringify(apiCalls));
  24 |   console.log('[真渲染] 可用区间文案=', await page.getByTestId('wb-available-range').innerText());
  25 |   await page.screenshot({ path: 'pw-artifacts/01-available-range.png', fullPage: false });
  26 | 
  27 |   // 切周期（M15）应重新拉取（联动）
  28 |   const n0 = apiCalls.length;
  29 |   await page.getByTestId('wb-period').selectOption('M15');
  30 |   await expect.poll(() => apiCalls.length).toBeGreaterThan(n0);
  31 |   console.log('[真渲染] 切 M15 后 available_range 文案=', await page.getByTestId('wb-available-range').innerText());
  32 | 
  33 |   // 回 M1，加一个 slot（真库 published 策略）
  34 |   await page.getByTestId('wb-period').selectOption('M1');
  35 |   const addSel = page.getByTestId('wb-add-strategy');
  36 |   console.log('[真渲染] /api/strategies 响应=', JSON.stringify(apiLog).slice(0, 300));
  37 |   console.log('[真渲染] select outerHTML=', (await addSel.evaluate((el) => el.outerHTML)).slice(0, 400));
  38 |   console.log('[真渲染] catalogError/页首文案=', (await page.getByTestId('wb-config').innerText()).slice(0, 300));
> 39 |   await expect.poll(async () => addSel.locator('option').count(), { timeout: 20_000 }).toBeGreaterThan(1);
     |                                                                                        ^ Error: expect(received).toBeGreaterThan(expected)
  40 |   const opts = await addSel.locator('option').count();
  41 |   console.log('[真渲染] 策略下拉 option 数=', opts);
  42 |   await addSel.selectOption({ index: 1 });
  43 |   await expect(page.getByTestId('wb-add-btn')).toBeEnabled();
  44 |   await page.getByTestId('wb-add-btn').click();
  45 |   await expect(page.locator('[data-testid^="slot-card-"]').first()).toBeVisible();
  46 | 
  47 |   // 左端早于可得区间 ⇒ 提交后应 clamped（旧日历档已删，不按天数拒绝）
  48 |   await page.getByTestId('wb-date-from').fill('2013-01-04');
  49 |   await page.getByTestId('wb-date-to').fill('2026-09-17');
  50 |   await page.getByTestId('wb-submit').click();
  51 | 
  52 |   // 全历史 M1（77 万 bar）⇒ 资源护栏二次确认（过渡期流程）
  53 |   await expect(page.getByTestId('wb-guard-prompt')).toBeVisible({ timeout: 30_000 });
  54 |   console.log('[真渲染] guard prompt=', await page.getByTestId('wb-guard-prompt').innerText());
  55 |   await page.screenshot({ path: 'pw-artifacts/02-guard-prompt.png' });
  56 |   await page.getByTestId('wb-guard-confirm').click();
  57 | 
  58 |   // 确认后重提 ⇒ 201 + clamped=true ⇒ 显著提示条（不弹确认框）
  59 |   await expect(page.getByTestId('wb-clamp-notice')).toBeVisible({ timeout: 30_000 });
  60 |   console.log('[真渲染] clamp notice=', await page.getByTestId('wb-clamp-notice').innerText());
  61 |   await page.screenshot({ path: 'pw-artifacts/03-clamp-notice.png' });
  62 |   await expect(page.getByTestId('wb-clamp-notice')).toContainText('收缩');
  63 | });
  64 | 
```