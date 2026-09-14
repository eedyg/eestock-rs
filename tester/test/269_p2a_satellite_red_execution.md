# 269 — P2-A 红测试执行报告（T2 / T5 除 LIVE / T8 / G4 前置）

- **本文件路径**：`tester/test/269_p2a_satellite_red_execution.md`
- 设计报告：`tester/design/269_p2a_satellite_red_design.md`
- 角色：Tester（**只执行与取证**；未修任何失败、未改产品代码）
- 时间：2026-09-14 21:37–21:45（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs` @ `2632c9e0bb1a7e0fe2013f8e688aca6f5f03a920`
  （web 侧 `klinecharts 10.0.3`；工作树仅新增 tester 侧文件，见 §6）
- 证据目录：`tester/evidence/269_p2a_red/`

---

## 1. 本轮新增/加强的测试文件

| 文件 | 新增/加强 | 用例数 |
|---|---|---|
| `web/src/features/dashboard/multiPeriodSatellite.test.tsx` | **新增**（T2×3 / T5×3 / T8×4） | 10 |
| `web/src/features/dashboard/multiPeriodNoLocalAggregation.test.ts` | **新增**（T8 代码级门禁 5） | 5 |
| `web/tester/p2-satellite-harness/{harness.html,run.mjs}` | **新增**（真身 klinecharts 库事实 11 检查） | 11 检查 |
| `design/15-multi-period/03-test-plan.md` | §1 G4 **增补散文 2 行**（无代码块、无 `file=` 块） | — |

既有测试文件**零改动**（只新增，不改判据强度）。

---

## 2. 执行命令与结果

### 2.1 红测试（主）—— `npx vitest run src/features/dashboard/multiPeriodSatellite.test.tsx`

```
cd web && npx vitest run src/features/dashboard/multiPeriodSatellite.test.tsx
```

| 指标 | 值 |
|---|---|
| Test Files | **1 failed (1)** |
| Tests | **10 failed (10)** |
| 崩溃 / core dump | **无**（无 `pageerror`/无进程信号、无 core 文件） |
| 退出码 | 1 |
| 原始输出 | `tester/evidence/269_p2a_red/vitest_multiPeriodSatellite_red.txt` |

**失败用例全表**（失败原因 = 卫星实例尚不存在，`MultiPeriodChartStack(enabled=true)` 目前只透传 children）：

| # | 用例名 | 错误信息（截断） | 崩溃/core | 失败归因 |
|---|---|---|---|---|
| 1 | T2-1 `卫星 candle_pane 必须用 state:"minimize"+minHeight:0 折叠、separator.size=0；且不得依赖 height:0` | `每个实例各 1 次 init（基准 1 + 卫星 1）: expected "spy" to be called 2 times, but got 1 times` | 否 | 卫星实例缺失 |
| 2 | T2-2 `卫星实例高度 = heights[period]（指标 pane 填满实例容器）` | `卫星实例数 = periods[1..] 长度（1）: expected +0 to be 1` | 否 | 无 `[data-mp-satellite]` DOM |
| 3 | T2-3 `缩放/滚动后仍成立：不重建实例、折叠不回弹、分隔条仍为 0` | `缩放/滚动不得重建实例（init 计数不变）: expected "spy" to be called 2 times, but got 1 times` | 否 | 卫星实例缺失 |
| 4 | T5-1 `基准勾选 {MA,MACD,KDJ,BOLL,DCAP} ⇒ 每个卫星各自非空且集合一致` | `实例数 = 1 基准 + 1 卫星: expected 1 to be 2` | 否 | 卫星实例缺失 |
| 5 | T5-2 `叠加指标必须走 addOverlayIndicator：所有 createIndicator 显式 isStack=true 且无静默顶掉` | `前置：每实例 1 次 init（基准 1 + 卫星 1）: expected "spy" to be called 2 times, but got 1 times` | 否 | 卫星实例缺失（前置守卫） |
| 6 | T5-3 `DCAP 逐实例：precision 5 + 0 参考线（zero figure）+ 数据不足断线` | `前置：每实例 1 次 init（基准 1 + 卫星 1）: expected "spy" to be called 2 times, but got 1 times` | 否 | 卫星实例缺失（前置守卫） |
| 7 | T8-1 `每实例 1 个 KlineDataFeed：4 次 init / 每周期各 1 次初始化 HTTP / 4 个 bar: 订阅` | `4 周期 ⇒ 4 个 chart 实例（每实例一个 feed）: expected "spy" to be called 4 times, but got 1 times` | 否 | 卫星实例缺失 |
| 8 | T8-2 `每分钟兜底 ≤4、按 (code,period) 各自成 key（不跨周期合并）、并发闸 ≤3` | `前置：4 实例已建: expected "spy" to be called 4 times, but got 1 times` | 否 | 卫星实例缺失（前置守卫） |
| 9 | T8-3 `warmup 口径：DCAP 显示时每实例都必须 warmup（窗口 limit = viewport+warmup 或 before 游标补取）` | `前置：4 个实例都必须有取数记录: expected [ '15m' ] to deeply equal [ '15m', '1h', '1m', '5m' ]` | 否 | 无卫星取数 |
| 10 | T8-4 `禁止本地聚合（行为级）：每周期请求命中各自 period，不得用基准周期聚合替代` | `expected [ '15m' ] to deeply equal [ '15m', '1h', '1m', '5m' ]` | 否 | 无卫星取数 |

> 观察到的实际状态（非缺陷）：启用多周期后页面仍只有 **1 个 chart 实例**、**1 个** `bar:518880:15m` 订阅、**1 次** `getKline({period:'15m'})`。**本测试不分析根因、不提出修复**（参见 §5）。

### 2.2 代码级门禁（T8）—— `npx vitest run src/features/dashboard/multiPeriodNoLocalAggregation.test.ts`

```
Test Files  1 passed (1)
     Tests  5 passed (5)
```

性质：**事实固定（当前工作树无任何 bar 聚合实现 ⇒ 绿）**；反向证据：一旦实现引入本地聚合/降分辨率复用，本文件必红。
原始输出：`tester/evidence/269_p2a_red/vitest_noLocalAggregation.txt`。

### 2.3 真身 klinecharts harness（T2 库事实 + G4 前置）—— `node tester/p2-satellite-harness/run.mjs`

```
klinecharts version = 10.0.3（UMD bundle 本地读取）
PASS  L1 库事实：setPaneOptions({height:0}) 单独使用不会把高度变 0（被静默忽略）      # 393 → 393
PASS  L1b 库事实：height:0 后高度确实不是 0
PASS  L2 state:minimize+minHeight:0 ⇒ candle pane rect 高度 = 0                    # rect {top:8,bottom:8,height:0}
PASS  L2b 指标 pane 填满实例容器                                                   # 指标 pane rect 高 493 / 容器 520
PASS  L3 separator.size=0 ⇒ 相邻 pane 间隙 = 0                                     # gapPx 0
PASS  L4 缩放/滚动后 candle pane 仍为 0 高                                          # setBarSpace(30)+scrollToDataIndex(120)
PASS  L4b 缩放/滚动后间隙仍为 0
PASS  L5 零高 pane 下 getConvertPictureUrl() 抛错（⇒ G4 禁用图表导出）                # InvalidStateError
PASS  L6 指标确实被绘制（画布 fillText 打点阳性对照）
PASS  L6b 0 参考线图例被绘制
PASS  L7 state:normal 可还原                                                       # 394
pageerrors/console = none
non-file network requests = 0
```

- `getConvertPictureUrl` 抛错原文（G4 前置依据）：
  `Failed to execute 'drawImage' on 'CanvasRenderingContext2D': The image argument is a canvas element with a width or height of 0.`
- 证据：`tester/evidence/269_p2a_red/p2_satellite_harness.json` + `p2_satellite_harness.png`（页面截图）。
- 网络：**0 个非 `file://` 请求** ⇒ 未触碰线上（0 写请求；未重启 PID 3112540）。

### 2.4 类型检查 —— `npx tsc -b`

```
cd web && npx tsc -b    # 退出码 0，无输出
```

### 2.5 全量回归（既有测试零回归核验）—— `npx vitest run`

| 指标 | 值 |
|---|---|
| Test Files | **1 failed | 70 passed (71)** |
| Tests | **10 failed | 656 passed (666)** |
| 失败文件 | **仅** `src/features/dashboard/multiPeriodSatellite.test.tsx`（本轮新增红测试） |
| 既有测试回归 | **0**（新增前基线 = 656 passed / 71 files 全绿口径；本轮只新增文件） |
| 原始输出 | `tester/evidence/269_p2a_red/vitest_full_suite.txt` |

---

## 3. 覆盖与计数小结

| 门禁/项 | 断言条数（本轮） | 状态 |
|---|---|---|
| T2 折叠面（state/minHeight/separator/实例数/DOM 高度） | 3 用例 / 12 断言 | 红（实现前） |
| T2 库事实（`height:0` 单独无效 + 真渲染几何） | 7 检查 | 绿（事实固定） |
| T5 指标继承 + 叠加入口 + DCAP 三事实 | 3 用例 | 红（实现前） |
| T8 记账面（init/取数/WS/兜底/warmup/周期身份） | 4 用例 | 红（实现前） |
| T8 代码级「禁止本地聚合」 | 5 用例 | 绿（事实固定＋反向证据） |
| G4 前置声明 | 1 处文档（test-plan §1）+ harness L5/L6 | 已完成 |

---

## 4. 未证实/未覆盖（诚实标注）

1. **G4 产品级像素证据**不在本轮：按 `03-test-plan.md` §1 增补声明，像素级证据**由阶段 3 用页面截图 + 画布像素采样**完成；本轮只固定「库级画布绘制确实发生」与「导出接口必抛错」两条前置事实。
2. **真实几何的多实例堆叠**（多个卫星同时折叠后的总高、分隔条累计）不在本轮：属阶段 3（页面截图）与 P5（高度拖拽）。
3. **`config.indicators` 与基准勾选集合的裁定**：本文件按 `02-spec.md` §4.1 取「基准勾选集合」为继承源（见设计报告 §4.2）；若架构师改判，T5 需同步改口径。
4. 内存/帧率量级（4 实例）未测（同 `03-test-plan.md` §4 未证实项），属阶段 3。

---

## 5. 纪律声明

- **未分析失败根因、未尝试修复**：本条仅为「执行与取证」报告；失败原因归因于「P2 卫星实例尚未实现」由设计报告 §1（范围）给出，未做代码级根因分析。
- **未改产品代码**：本轮改动仅 tester 侧（新增测试 + harness + 证据 + 1 处 test-plan 散文增补）。
- **未跑 tangle**、**未 git add/commit/stash**、**未触碰线上**（0 写请求）、**未重启 PID 3112540**。
- harness 全程 `file://` + 合成数据，浏览器进程由 runner 自行关闭（无残留）。

---

## 6. 工作树状态（本轮写文件清单）

```
?? tester/design/269_p2a_satellite_red_design.md
?? tester/test/269_p2a_satellite_red_execution.md
?? tester/evidence/269_p2a_red/                      (4 文件: 2 json/txt 证据 + 2 vitest 日志 + png)
?? web/src/features/dashboard/multiPeriodSatellite.test.tsx
?? web/src/features/dashboard/multiPeriodNoLocalAggregation.test.ts
?? web/tester/p2-satellite-harness/                  (harness.html + run.mjs)
 M design/15-multi-period/03-test-plan.md            (仅 §1 G4 增补 2 行散文，+2)
```

- `git diff --cached --name-only` ⇒ **空**（无暂存文件）。
- 产品代码（`web/src/**` 除测试、`crates/**`）**零改动**；`design/**` 仅上述 1 处散文增补（不含 `file=` 代码块 ⇒ 不影响 tangle 生成物）。
