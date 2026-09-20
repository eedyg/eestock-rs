# ADR-028 D4.1 复验二轮（解除冻结）—— 执行报告

- 本报告路径：`tester/test/305_adr028_d41_features_verify2_execution.md`
- 主报告（判词与逐项证据）：`tester/evidence/20260920_adr028_features_verify2/report.md`
- 设计报告（二轮章节）：`tester/design/304_adr028_d41_features_verify_design.md`
- 时间：2026-09-20 10:46–11:01（Asia/Shanghai）；commit `aa5444eb98e2e4876e8d6a3fb414c87ca08966d2`（+ 未提交工作树改动）
- 真身：`http://localhost:8081` —— **主机进程** `./target/debug/eestock-app --config /tmp/app_dev_8081.toml`（`static_dir=./web/dist`，按请求读盘）；bundle `/assets/index-BY728MHs.js`，sha256 `f2504232e7a4fba582943fdbe020235013fef27752313db6cc69531f37d0fa0e`
- 本轮规格：`web/e2e/adr028-features-verify.e2e.ts`（维护：T0 锚点 + T7 加固）、`web/e2e/adr028-features-verify2.e2e.ts`（新增 V1/V2/V3）

## 1. 总览（线上真身 :8081）

| # | 套件 | 命令（均 `timeout` 前缀，`--workers=1 --retries=0`） | 总数/通过/失败/跳过 | 结果 |
|---|---|---|---|---|
| 1 | 自建复验规格（维护后） | `E2E_BASE_URL=http://localhost:8081 ADR028V_OUT=…/raw/spec1 npx playwright test e2e/adr028-features-verify.e2e.ts --reporter=list` | 10 / **10** / 0 / 0（1.1m） | **passed** |
| 2 | R1/R2/R3 独立复验规格（新增） | `E2E_BASE_URL=http://localhost:8081 ADR028V2_OUT=…/raw npx playwright test e2e/adr028-features-verify2.e2e.ts --reporter=list` | 3 / **3** / 0 / 0（29.7s） | **passed** |
| 3 | 回归：窗口同步 | `E2E_BASE_URL=http://localhost:8081 ADR028_E2E_OUT=…/raw/spec_out/window-sync npx playwright test e2e/adr028-window-sync.e2e.ts --reporter=list` | 6 / **6** / 0 / 0（23.5s） | **passed** |
| 4 | 回归：轴对齐探针 v2 | `E2E_BASE_URL=http://localhost:8081 ADR027_ALIGN_OUT=…/raw/spec_out/axis-align-probe npx playwright test e2e/adr028-axis-align-probe.e2e.ts --reporter=list` | 2 / **2** / 0 / 0（43.4s） | **passed** |
| 5 | 类型检查 | `npx tsc -b` | — / — / 0 / 0（exit 0，空输出） | **passed** |
| 6 | 单测子集（10 文件，`--maxWorkers=1` + `NODE_OPTIONS=--max-old-space-size=2048`） | `npx vitest run <…10 files…> --maxWorkers=1 --reporter=basic` | 99 / **99** / 0 / 0（4.94s） | **passed** |
| 7 | 离线像素复算（R3 交叉核对） | `python3 tester/evidence/20260920_adr028_features_verify2/raw/pixel_dots.py` | 27 点全覆盖；与页面侧 27/27 一致（最大逐通道差 0） | **passed** |

- **崩溃 / core dump：无**（无进程异常退出、无 core 文件；唯一"失败"均为断言失败，见 §2）。
- 退出码：套件 1–7 均为 0。
- 跳过用例：0（vitest 无 skipped/todo）。
- 覆盖率工具：本轮未启用（`vitest --coverage` 未纳入资源纪律范围）⇒ 无覆盖率数字；覆盖改以「层 × 用例」矩阵记录（设计报告二轮章节 §D）。

## 2. 变异反证的**预期红**运行（独立列出，非行为回归）

| 变异 | 命令（对临时 preview `:4175`，线上 `:8081` 未触碰） | 结果 | 失败用例与错误摘要 | 崩溃/core |
|---|---|---|---|---|
| **M-LAYOUT**（图表区回退为 `h-[calc(100%-1.25rem)]` + 卡片去掉 `flex-col`） | `E2E_BASE_URL=http://localhost:4175 … npx playwright test e2e/adr028-features-verify.e2e.ts -g "T7" --workers=1 --retries=0` | **1 failed / 1**（预期红） | `T7 回归 [@mut]…`：`Error: 「全览」3 个采样点必须命中按钮自身或其子元素：[{f:0.5,tag:"canvas",selfOrChild:false},{f:0.15,tag:"canvas",selfOrChild:false},{f:0.85,tag:"button",selfOrChild:true}]`；同轮读数：溢出 **+27px**、两按钮真实 `click` 均 `TimeoutError: locator.click: Timeout 3000ms exceeded` | 无 |
| **M-R1**（`placeFillLabel` 调用回退为恒右侧左对齐） | `E2E_BASE_URL=http://localhost:4175 … npx playwright test e2e/adr028-features-verify2.e2e.ts -g "V1" --workers=1 --retries=0` | **1 failed / 1**（预期红） | `V1 R1 [@mut]…`：`Error: 标签右缘必须落在 pane 内（≤ pane 右缘 -1） Expected: <= 605 Received: 678.52861328125`；同轮读数：紧盒 ink 总墨量 **0**、跨度 **0** | 无 |

- 两次变异均在临时 outDir（`dist-mut`）+ 临时端口（4175，`--strictPort`，`timeout 600` 兜底）内完成；**线上产物全程未被触碰**。
- 复原：两文件 `cp` 回波次起点备份，sha256 相等（`KlineChart.tsx 3dc58efc…`、`KlineResultChart.tsx efa61a16…`）；`git diff --stat` 恢复为 `2 files changed, 63 insertions(+), 18 deletions(-)`；复原后重建 bundle sha256 == 线上 `f2504232…`（逐字节一致）；`web/dist-mut` 已删除。

## 3. 本轮规格维护记录（属规格维护，非放宽）

| 文件 | 改动 | 性质 |
|---|---|---|
| `web/e2e/adr028-features-verify.e2e.ts` | T0：硬编码旧 sha256 → 常量 `EXPECT_BUNDLE_NAME/SHA256`（新 bundle）+ 追加 URL/引用/逐字节三段断言；T7：两按钮 ×3 采样点 + 真实 click + 触发条件守卫 + 点击生效证据 + 布局不变量；文件头真身说明更新 | **加强**（锚点为逐字节真身锚定，注释明示「不得放宽、不得加 env 旁路」） |
| `web/e2e/adr028-features-verify2.e2e.ts` | 新增（V1 R1 / V2 R2 / V3 R3；含渲染器 font/fillText 仪表、合成位图读法、四档颜色判定、离线 PIL 交叉） | 新增 |

**未改动**：任何生产代码 / 接口 / 架构（两个被变异文件已逐字节复原；`git status` 中 `web/src` 的改动均为修复方与本波之前车道的既存改动，本轮无新增）。

## 4. 纪律

- 单车道、**未 spawn 子代理**；playwright 只跑 4 个相关规格（自建 ×2 + window-sync + axis-align-probe），另加 2 次**变异**针对性单用例运行；vitest 单次子集（10 文件）。
- 每步 `free -h`：`used 19–21Gi / available 25–27Gi`（无压力）。
- 结束核验：`pgrep -f '[v]ite preview'`（排除自身命令行文本）= **空**；playwright chromium 进程 = **0**；`web/dist-mut` 不存在；探针文件已删除（`web/dist/` 仅 `assets/`、`index.html`）；`:8081` 产物 sha256 与复验开始时一致（防漂移）。
- 未 `git add`/`commit` 任何内容；未修改既有证据目录（本轮产物全部落在 `tester/evidence/20260920_adr028_features_verify2/`）。

## 5. 遗留（详见主报告 §10）

1. 止损橙圆点**不可测**（全库 `StopTrigger=0`）——判据已内置，未来有样本自动开测。
2. 修复方为核验 T0 曾用默认 `ADR028V_OUT` 跑我方规格，**覆盖冻结轮原始红证据**（`tester/evidence/20260920_adr028_features_verify/raw/*` mtime 10:41–10:43）⇒ 本轮以自建变异重建等价红基线。
3. `Dockerfile.app` 缺 `crates/test-support` ⇒ 镜像级重建仍失败（车道外）；本环境 `:8081` 不依赖镜像。
