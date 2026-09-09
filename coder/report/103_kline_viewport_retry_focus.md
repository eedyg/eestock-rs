# 103 — 看板「默认K线数量」配置偶发失败时不生效（getKlineConfig 失败被静默吞掉）

> 本报告文件位置：`eestock-rs/coder/report/103_kline_viewport_retry_focus.md`
> 关联前置：`100_settings_s2_config_persist_deploy.md`、`101_kline_viewport_config.md`、`102_kline_viewport_config_deploy.md`

## 根因

`DashboardPage` 挂载时执行：

```ts
api.getKlineConfig().then((cfg) => setViewportDays(cfg.viewport_days)).catch(() => {})
```

`catch(() => {})` 把失败**静默吞掉**并兜底为默认 `DEFAULT_KLINE_VIEWPORT_DAYS`（=2），**无重试**、**无提示**、**无收敛**。
若 `/api/config/kline` 偶发失败/网络抖动，页面将**永久停留默认视口**（用户配置的可视化 K 线数量不生效），且永不恢复为配置值。

已探针证实：正常加载生效（limit=68 等配置值），仅配置失败路径停在默认值。

## 修复目标

让 K 线视口配置读取**收敛到配置值**：

1. **失败重试**：最多 3 次、指数退避 500ms→1s，耗尽仍失败才用默认 2（至少真实重试，穿越瞬态）。
2. **聚焦/可见重读**：`window` `focus` 与 `visibilitychange`(visible) 时重读 `getKlineConfig`；重读成功则 `setViewportDays`（跨 tab 改配置 / 从后台回来能刷新）。
3. **保持 feed 重建依赖 viewportDays**：`useMemo` 已含 `viewportDays` 依赖，无需改。

## 实现方式

全部改动收敛在 `web/src/features/dashboard/DashboardPage.tsx`（+ 测试），未触碰接口/层边界：

- 新增模块级（同文件导出）纯函数：

  ```ts
  export async function readViewportDays(api, opts?): Promise<number>
  ```

  循环最多 `attempts`（默认 3）次调用 `api.getKlineConfig()`；成功返回 `cfg.viewport_days`；
  失败在非末次时按 `backoffMs`（默认 `[500, 1000]`）指数退避等待；末次仍失败则抛出（由调用方兜底，不再静默吞错）。
  `sleep` 可注入（测试用瞬时等待），`attempts`/`backoffMs` 可配置。

- 挂载读取改为 `readViewportDays(api).then(set).catch(兜底默认 2)`（重试穿越瞬态，耗尽才回退默认）。
- 新增第二个 `useEffect`：监听 `window` `focus` 与 `document` `visibilitychange`（仅 `visible`），
  触发 `readViewportDays(api)`；成功 `setViewportDays(days)`，失败保持当前值（不回落默认）。

## TDD（Red → Green）

- **Red**：先写测试（helper 单元 + 组件集成），运行确认 7 个新用例失败（`readViewportDays` 未导出 / 重试与重读行为缺失），既有 19 用例仍绿。
- **Green**：实现后 26 用例全绿。

### 新增测试（`DashboardPage.test.tsx`）

1. `readViewportDays` 首次失败 → 重试成功 → 返回配置值；`getKlineConfig` 调用次数=尝试数；退避 1 次=500ms。
2. `readViewportDays` 连续失败 → 全部尝试后抛出（组件据此保持默认 2，而非静默收敛）。
3. `readViewportDays` 指数退避：连续失败 3 次 → 依次等 500ms/1000ms。
4. 组件：mount 首次失败 → 重试成功 → feed 用配置 `viewport_days` 计算 pageSize（穿越瞬态；34×17=578）。
5. 组件：连续失败 → 重试 3 次后仍失败 → 保持默认 2（feed 用默认 pageSize 34，不静默收敛）。
6. 组件：`window` focus → 重读成功 → 更新 viewportDays → feed 用新 pageSize（10→20 → 170→340）。
7. 组件：`visibilitychange`(visible) → 重读成功 → 更新 viewportDays（5→30 → 85→510）。

mock api 通过 `stubApi` 覆写 `getKlineConfig`（`mockRejectedValueOnce`/`mockResolvedValueOnce` 控制失败/次数/时序）。

## 验证

- `cd eestock-rs/web && npx vitest run src/features/dashboard/` → **11 files / 113 tests passed**（dashboard 全覆盖）。
- `VITE_API_MOCK=0 npx tsc -b` → **exit 0**（无类型错误）。
- `VITE_API_MOCK=0 npx vite build` → **exit 0**（仅既有 chunk>500kB 警告，非本次引入）。
- 全量 `npx vitest run` → 383 用例中 7 失败，均集中在 `src/features/alerts/`，为**既有**失败（对 `alerts/` 单独在还原改动后基线复跑同样 7 失败），与本次改动无关。

## 残留风险

1. **退避次数解读**：需求写「如最多 3 次、指数退避 500ms/1s/2s」为示例（“如”）。已按「最多 3 次」= 3 次总尝试（首试 + 2 重试），退避仅需 `[500,1000]` 2 段；「2s」未使用。若希望 3 次**重试**（4 总尝试）并含 2s 退避，调整 `KlineViewportReadOptions.attempts=4` 与 `backoffMs=[500,1000,2000]` 即可，接口已参数化。
2. **同窗口配置变更**：focus/visibilitychange 只覆盖「跨 tab 改配置 / 从后台回来」场景；若用户在当前焦点窗口内改配置（settings 页）后直接回看板，不会触发 focus 事件，需手动切换焦点/刷新。属需求边界，未扩展。
3. **StrictMode 双挂载**：dev 下 React StrictMode 可能双跑挂载 effect，`cancelled` 标志已处理（第 1 次 mount 的 `cancelled` 置 true 防 setState），多次 GET 影响可忽略。
4. **全量套件既有失败**：`alerts` 相关 7 失败与本次无关（基线复现），已单独标注。

## 更改文件清单（工作区修改；未 commit、未 stage）

- `web/src/features/dashboard/DashboardPage.tsx`（+67 / −6）
- `web/src/features/dashboard/DashboardPage.test.tsx`（+149 / −1）
