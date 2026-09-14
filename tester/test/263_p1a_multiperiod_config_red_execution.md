# 263 — P1-A 多周期配置面 + 关闭态等价 · Red 执行报告

- **本报告位置**：`tester/test/263_p1a_multiperiod_config_red_execution.md`
- **类型**：Execution report（执行**本轮新落**的红测试；本轮无既有用例执行）
- **设计报告**：`tester/design/263_p1a_multiperiod_config_red_design.md`
- **证据目录**：`tester/evidence/263_p1a_multiperiod_config_red/`
  - `vitest_red_2files.txt`（2 个新增前端文件，原始输出）
  - `vitest_full_suite_red.txt`（全量前端套件，原始输出）
  - `tsc_b.txt`（`npx tsc -b`，**0 字节 = 零输出 = 通过**）
  - `cargo_api_multi_period_red.txt`（Rust HTTP 配置面，原始输出）
  - `cargo_pane_budget_red.txt`（Rust 总 pane 护栏单目标，编译失败原始输出）
  - `cargo_web_all_targets_norun_red.txt`（`cargo test -p web --no-run`：整 crate 因缺符号编译失败）
  - `baseline_capture_d6462da.txt` + `README_baseline_capture.md` + `frozen_fp_selfcheck.txt`（现状指纹基线与自检）
- **仓库 / 提交**：`/home/eestock/workspace/git/eestock/eestock-rs` @ `d6462da229f9264777e414be827d9d1017600778`（`d6462da`）
- **执行时间**：2026-09-14T20:32–20:34+08:00（本机时钟）
- **环境**：`web/` 下 `npx vitest run`（vitest，jsdom）、`npx tsc -b`；仓库根 `cargo test -p web --test <target>`（TimescaleDB `127.0.0.1:5433` 可用）
- **约束遵守**：未改生产实现/接口/架构；未 `git add/commit/stash`；未跑 tangle；未重启/触碰线上（PID 3112540 未动，**对 8081/8082 零请求**——
  端点请求只打到测试自建 `127.0.0.1:0` 临时 axum 实例，进程随测试结束退出）；临时实例用临时端口且已随进程收尾；
  **未做任何失败分析与修复尝试**（无 core dump：4 个前端用例为模块解析错误、Rust 为断言失败/编译错误，均无 crash）。

---

## 1. 结果总览

| 套件 | 命令（cwd） | 退出码 | total | passed | failed | skipped | 判读 |
|---|---|---|---|---|---|---|---|
| 前端新增 2 文件 | `npx vitest run src/features/dashboard/multiPeriodStore.test.ts src/features/dashboard/multiPeriodClosedEquivalence.test.tsx`（`web/`） | 1 | 9 | 0 | **9** | 0 | 全部 `Cannot find module` ⇒ store/容器尚不存在（预期红） |
| 前端全量套件 | `npx vitest run`（`web/`） | 1 | 626 | 617 | **9** | 0 | Test Files 2 failed / 66 passed（68）⇒ **既有 617 例零回归** |
| 类型检查 | `npx tsc -b`（`web/`） | 0 | — | — | 0 | — | 零输出（红阶段不被模块缺失阻塞，变量 specifier 生效） |
| Rust HTTP 配置面 | `cargo test -p web --test api_multi_period_config -- --test-threads=1`（仓库根） | 101 | 15 | 1 | **14** | 0 | 14 例 404 Not Found（路由未注册）+ 1 例库卫生自检绿 |
| Rust 总 pane 护栏 | `cargo test -p web --test multi_period_pane_budget`（仓库根） | 101 | — | — | — | — | **编译失败 `E0432`**（`web::dto` 三符号缺失）⇒ 无测试可执行 |
| Rust 整 crate（对照） | `cargo test -p web --no-run`（仓库根） | 101 | — | — | — | — | 同上 ⇒ **红阶段勿整 crate 跑**，用单目标（设计报告 §7 运行注意） |

**合计**：新增 **28** 个用例（前端 9 + Rust HTTP 15 + Rust 纯函数 4）；当前 **27 红 / 1 绿**（绿 = 库卫生自检，见 §4）。

---

## 2. 前端（vitest）

```
 Test Files  2 failed | 66 passed (68)
      Tests  9 failed | 617 passed (626)
```

### 2.1 失败用例表（9 例；错误信息 + 出处，无 crash/core）

| # | 用例 | 错误信息（原文摘要） | 栈/出处 |
|---|---|---|---|
| 1 | `multiPeriodStore` › T11-1 关闭态默认 | `Cannot find module './multiPeriodStore'` … `Failed to load url ./multiPeriodStore` | `multiPeriodStore.test.ts:51` `loadStoreClass` |
| 2 | `multiPeriodStore` › load() 镜像服务端配置 | 同上 | 同上 |
| 3 | `multiPeriodStore` › T8bis 降级可观测字段存在且可读出 | 同上 | 同上 |
| 4 | `multiPeriodStore` › 关闭态零副作用 | 同上 | 同上 |
| 5 | `multiPeriodStore` › 开关往返零残留 | 同上 | 同上 |
| 6 | T11 关闭态等价 › 关闭态 DOM 结构等价（main-chart 指纹） | `Cannot find module './MultiPeriodChartStack'` | `multiPeriodClosedEquivalence.test.tsx:61` `loadStack` |
| 7 | T11 关闭态等价 › 关闭态记账等价 | 同上 | 同上 |
| 8 | T11 关闭态等价 › 关闭态容器透传 | 同上 | 同上 |
| 9 | T11 关闭态等价 › 关闭态零残留 | 同上 | 同上 |

**Crash / core dump**：无（9 例均为模块解析失败；`0` 个 core 文件）。

### 2.2 现状指纹基线自检（**非失败**，验证冻结常量正确）

临时去掉模块加载后仅跑 E1（DOM 指纹断言）：

```
 ✓ src/features/dashboard/multiPeriodClosedEquivalence.test.tsx (4 tests | 3 skipped) 40ms
 Test Files  1 passed (1)
      Tests  1 passed | 3 skipped (4)
```

⇒ 冻结指纹 `[div[data-region=main-chart] → div[data-region=sub-chart] + div[data-testid=kline-chart]]` 与现状渲染**逐节点一致**
（该自检后已逐字节还原测试文件；最终文件 sha256 见设计报告 §8）。原始输出：`frozen_fp_selfcheck.txt`。

---

## 3. Rust（cargo）

### 3.1 HTTP 配置面（`api_multi_period_config`）

```
test result: FAILED. 1 passed; 14 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.30s
```

| # | 用例 | 状态 | 错误信息（原文摘要） |
|---|---|---|---|
| R1 | `t6_get_without_key_returns_defaults_200` | FAILED | `assertion left == right failed: GET 无键 ⇒ 200（不得 500）`，`left: 404 / right: 200`，body `{"error":"not found"}`（`api_multi_period_config.rs:186`） |
| R2 | `t6_get_falls_back_to_defaults_on_bad_or_out_of_range_stored_values` | FAILED | 同上（`...:249`，首个样本「字段类型错」即红） |
| R3 | `t6_put_valid_roundtrip_200_and_readback_identical` | FAILED | `PUT 合法 ⇒ 200`，`404 / 200`（`...:271`） |
| R4 | `t6_put_valid_1d_base_with_1w_satellite_is_accepted` | FAILED | `基准 1d + 卫星 1w ⇒ 必须 200`，`404 / 200`（`...:294`） |
| R5 | `t6_put_rejects_base_1mo` | FAILED | `【基准 1mo】必须 400`，`404 / 400`（`...:163`） |
| R6 | `t6_put_rejects_satellite_below_base` | FAILED | 同上（`404 / 400`） |
| R7 | `t6_put_rejects_satellite_1mo` | FAILED | 同上 |
| R8 | `t6_put_rejects_1w_when_base_below_1d` | FAILED | 同上 |
| R9 | `t6_put_rejects_more_than_4_periods_without_silent_truncation` | FAILED | 前置合法 PUT 即 `404 / 200` |
| R10 | `t6_put_rejects_duplicate_periods` | FAILED | `404 / 400` |
| R11 | `t6_put_rejects_heights_keys_mismatching_periods` | FAILED | `404 / 400` |
| R12 | `t6_put_rejects_heights_out_of_range` | FAILED | `404 / 400` |
| R13 | `t6_put_rejects_unsupported_indicators` | FAILED | `assertion ... 【indicators=[macd]】必须 400，收到 404 Not Found`（`404 / 400`） |
| R14 | `t6_max_legal_config_is_accepted` | FAILED | `404 / 200`（`...:500`） |
| R15 | `t6_zz_cleanup_leaves_no_multi_period_key` | **ok** | 库卫生自检（只碰 DB，不碰端点）⇒ 绿 |

**Crash / core dump**：无（均为断言失败，无 panic-in-drop/abort；`0` 个 core 文件）。
**统一失败根因（现象，不做分析）**：全部为 `404 Not Found`（`/api/config/multi_period` 未注册）。

### 3.2 总 pane 护栏（`multi_period_pane_budget`）

```
error[E0432]: unresolved imports `web::dto::multi_period_pane_count`, `web::dto::verify_multi_period_panes`, `web::dto::MULTI_PERIOD_MAX_PANES`
  --> crates/web/tests/multi_period_pane_budget.rs:19:16
error: could not compile `web` (test "multi_period_pane_budget") due to 1 previous error
```

⇒ 无测试用例被执行（0 total）；红 = **符号缺失的编译失败**（4 个 `#[test]` 函数待实现落地后执行）。

### 3.3 对照：整 crate 目标构建

```
cargo test -p web --no-run  →  error: could not compile `web` (test "multi_period_pane_budget")
warning: build failed, waiting for other jobs to finish...
```

⇒ 红阶段 `cargo test -p web`（不带 `--test`）必然失败；**取证/开发用单目标**（设计报告 §7「运行注意」）。
实现方落地 `web::dto` 三符号（`MULTI_PERIOD_MAX_PANES` / `multi_period_pane_count` / `verify_multi_period_panes`）后即恢复。

---

## 4. 库卫生（共享 `app_config`）与收尾取证

| 项 | 证据 |
|---|---|
| 运行前后 `app_config` 键集合 | 运行后 `psql` 实查：仅 `dcap`、`kline` 两键，**无 `multi_period`** 残留（`t6_zz_cleanup_leaves_no_multi_period_key` 亦为绿） |
| 写入策略 | HTTP 面全部落库写入一律 `enabled=false`；`seed_raw` 只落「坏形状/越界旧值」（GET 回默认关闭）⇒ 即使异常残留也不改变线上行为 |
| 端点请求面 | 仅本进程 `127.0.0.1:0` 临时 axum；对线上 8081/8082 **零请求** |
| 临时进程/端口 | 随测试进程退出（无监听残留）；未重启 PID 3112540 |

---

## 5. 覆盖与未覆盖

**本轮覆盖**：设计报告 §3 的 L1–L6 全部层（服务端读/写/护栏、前端状态/渲染/记账、回归安全网）均已运行取证。

**未覆盖（明确不做，随设计报告 §7）**：卫星实例（T2）、跨图同步（T3/T4）、LIVE 段（T5）、像素取证（T10）、
预算计数 G3（T8）、布局持久化（T9）、失败可见（T12）、`enabled=true` 的 HTTP 往返（共享库卫生，见设计报告 §7(d)）、
P2 起需补的「总 pane >12 的 HTTP 级负例」（§7(c)）。

**无源码/实现改动**：`git status` 仅 4 个新增未跟踪测试文件 + 证据/报告目录；**无 staged**；生产代码零 diff。

---

## 6. 结论

- 28 例红测试已落地且**按预期红**：前端 9 例（模块缺失）、Rust HTTP 14 例（404 端点缺失）、Rust 纯函数 4 例（符号缺失 ⇒ 编译失败）；
  唯一绿例 = 库卫生自检（证明清理路径可用）。
- 既有前端 617 例零回归、`tsc -b` 通过。
- 共享库/线上零残留、零写请求至线上。

VERDICT: RED-READY
