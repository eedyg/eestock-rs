# 028 — AlertList 视觉告警基线残余页高跳变修复（max-h → 定高 h-[680px]）

报告文件位置：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/028_alertlist_h680_visual_baseline.md`
（本报告自身路径即上述；/home/eestock/workspace/git/eestock 为仓库根。）

## 1. 需求 / 问题
N2 视觉告警基线的残余页高跳变。`AlertList` 列表容器用 `max-h-[680px] overflow-y-auto`，
容器在内容 < 680px 时**随内容收缩**（0/1 条时收缩到内容高），≥680px 后**封顶 680**，
导致 空/少态 与 溢出态 之间列表盒高度一次性跳变。要求把 `max-h-[680px]` 改为**定高 `h-[680px]`**
（容器恒 680px、内部滚动），使页面高度在 0/1/30 条告警下恒定。

## 2. 根因确认（代码 + 实测）
`AlertList` 非空分支返回的容器 className 为 `max-h-[680px] overflow-y-auto p-3 text-xs`。
Tailwind `max-h-[680px]` = `max-height:680px`：容器高度 = min(内容高, 680)。
- 内容 < 680（1 条）时容器收缩到 ~70px；
- 内容 ≥ 680（30 条）时容器封顶 680px；
- 空态（0 条）走 `p-6` 空 div（~64px，无 max-h）。

这一「随内容收缩」正是根因：列表盒高度随数据量变化，若其参与区域盒/页面高度计算，
则跨数据态会跳变。实测确认（见第 6 节）：`max-h` 下列表盒高度 1 条=70px，30 条=680px（Δ610）。

> 说明（诚实记录）：在当前实际布局中（AppShell `h-screen` 定高壳 + `data-region="alert-list"` 为 `flex-1`），
> 区域盒（`[data-region="alert-list"]` 盒高）在 flex 布局下恒定 712px（被 flex 拉伸），
> 顶层页面高度被 `h-screen` 锁定为视口高（800px）。因此任务描述中「720↔751 的 →fullPage 高度跳变」
> 在本环境**未复现**；但「列表容器随内容收缩」这一根因**确认存在**（70↔680），且本修复将其消除。
> 若 parent 环境区域盒为「内容驱动」，本修复即为安全网。相关结论见第 6、8 节。

## 3. 改动文件（仅一处）
`web/src/features/alerts/AlertList.tsx` 第 62 行，容器 className 一处：
- 前：`max-h-[680px] overflow-y-auto p-3 text-xs`
- 后：`h-[680px] overflow-y-auto p-3 text-xs`

其余逻辑（三态分支、空态 `p-6`、loading 骨架、error+重试、行渲染）零改动。
只改此文件，未改其它源码 / DB / SQL / Rust；未新增依赖/接口/契约。

## 4. 架构对齐
- 变更属 **web 前端 UI 表现层**（feature 组件容器样式），未触碰接口、事件契约、layer 边界、store、数据面。
- 纯 Tailwind class 替换；不含逻辑/行为变化。
- 影响面：`AlertList` 仅被 `AlertsPage.tsx`（经 `RegionPortal`）挂载到 `data-region="alert-list"`；
  变更不影响其 props/返回值结构，仅改变非空分支容器渲染高度。

## 5. TDD 过程（Red → Green → Refactor）
- Red（复现）：Playwright 用路由拦截 `GET /api/alerts` 分别返回 1/30/0 条，量
  `document.documentElement.scrollHeight` 与告警容器盒高。在 `VITE_API_MOCK=0`（真实 HTTP 客户端）构建下，
  `max-h` 版本测得：1 条容器高 70px、30 条容器高 680px、scrollHeight 1404、空态 64px；
  区域盒 712px、页面高 800px。确认容器高度随内容变化（Δ610）。
- Green（修改）：换成 `h-[680px]`，重建测得：1 条容器 680px、30 条容器 680px（Δ0）、
  30 条仍内部可滚（scrollHeight 1404 > clientHeight 680、overflow auto）。
- Refactor：无多余抽象；改动精确到单个 class。vitest 全绿、build 通过。

## 6. 修改前后页高/盒高对比（同 harness：自建静态服务 + 路由拦截 + `VITE_API_MOCK=0` 构建）
| 数据态 | 容器盒高(max-h) | 容器盒高(h-680) | 内部可滚(30条) | 区域盒高(两者) | 页面高(两者) |
|--------|----------------|----------------|--------------|--------------|------------|
| 0 条   | 64px（p-6 空 div） | 64px（空 div 不变） | — | 712px | 800px |
| 1 条   | 70px           | **680px**      | — | 712px | 800px |
| 30 条  | 680px          | **680px**      | scrollHeight 1404 > client 680 | 712px | 800px |

- **1 vs 30 容器盒高**：改前 `70 vs 680`（Δ610）→ 改后 `680 vs 680`（**0 差**）。
- **30 条内部可滚**：`h-[680px]` 下 `scrollHeight=1404 > clientHeight=680` 且 `overflow-y=auto` ✓。
- `max-height` 计算值由 `680px` → `none`（class 已由 max-h 换成 h）。

## 7. 基线重生成情况（对应代码态）
命令：`cd web && VITE_API_MOCK=0 VITE_PROXY_TARGET=http://localhost:8081 npx vite dev --port 8100`
（运行本次改动后的源码，后端走真实 /api 代理）；随后
`E2E_BASE_URL=http://127.0.0.1:8100 npx playwright test e2e/visual.e2e.ts -g "告警" --update-snapshots`。

- 结果：**1 passed**；基线快照 `e2e/screenshots/visual.e2e.ts-snapshots/alerts-full-chromium-linux.png`
  **字节未变**（88167 字节，mtime 09-05 08:18，与重生成前一致）。即重生成得到与既有基线**完全相同**的图。
- 基线对应代码态：本修复后源码（`AlertList` 为 `h-[680px]`）+ 真实后端数据（经 vite dev 代理到 8081）。
- 因区域盒为 flex 恒 712px、告警列表整体被 mask `[data-region="alert-list"]` 屏蔽（仅屏蔽内容像素，不影响区域盒高），
  本改动未改变区域盒几何，故视觉基线像素无差异、快照文件未变（未纳入改动）。

## 8. 残留风险
- **空态高度差异仍在**：0 条走 `p-6` 空 div（~64px），非空走 680px 容器；两者容器自身高度不同。
  但当前布局下区域盒被 `flex-1` 拉伸恒 712px，故不影响页面高 / mask 视觉块。若 parent 环境区域盒为内容驱动，
  0↔非空交界仍可能带来一次高度变化（非本 PR 范围，但已是唯一残留）。
- **「720↔751 页面跳变」未在本环境复现**：页面高被 `h-screen` 恒定 800、区域盒被 `flex-1` 恒 712。若 parent 观察环境
  布局约束不同（如区域盒非 flex 拉伸），本修复（恒 680 容器）即为防跳变安全网；否则该跳变可能源于其它触发源（应在 parent 侧确认）。
- **视觉基线实际未变**：重生成后快照与既有字节一致。若 parent 预期基线有像素差异（因其环境区域盒内容驱动），
  则需在 parent 环境重跑重基线；本环境无法复现该差异。
- gitnexus_impact / GitNexus MCP 在本会话不可用（CLI `gitnexus_impact` 不存在、无 MCP 工具），
  已用手动影响面分析替代（见第 4 节）。风险等级低。

## 9. 验证
- `npx vitest run`：23 files / 179 tests 全绿。
- `npm run build`（含 `tsc -b`）：通过（vite build 输出 index-*.js / *.css，无类型/构建错误）。
- `VITE_API_MOCK=0 npm run build`：通过（用于本 harness 实测与基线重生成）。
- Playwright 复现/拟合（临时脚本已删除）：max-h 下 1vs30 容器 Δ610 → h-680 下 Δ0；30 条内部可滚。
- 基线重生成：alerts 视觉用例 1 passed，快照字节未变。

## 10. 提交范围
- `git add web/src/features/alerts/AlertList.tsx`（已 stage，`1 file changed, 1 insertion(+), 1 deletion(-)`）。
- 未 commit；除该文件外无其它改动进入暂存区（基线快照未变、未 stage）。
- `git status --short` 仅见该文件 ` M`；其余未跟踪文件均为既有（报告/日志/tester 等），非本次产出。
