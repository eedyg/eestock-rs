# ADR-024 P5 整改单 —— 交付报告（N1 / N2 / N3 / N4 / N6 + §3.1(N5) 定稿对齐）

- **本报告文件位置**：`coder/report/adr024_p5_rectification.md`
- 角色：coder（本单只修 tester 验收报告 `tester/report/adr024_p5_verification.md` §2 列举的硬缺口；**未** `git commit`）
- 依据：`tester/report/adr024_p5_verification.md` §2.1–§2.6（N1–N6）+ `design/16-backtest-scalability/02-spec.md` §3.1.1/§3.1 步骤 5/§5.1 + `contract-vectors.json` + 架构师 N1 裁决（A 选型 / 错误码命名 / 两模块全 400 结构化 / 前端按 code 分支）
- 证据目录：`coder/evidence/adr024_p5_rect/`（**27 个原始输出 + `pw/` harness/规格/5 张真渲染截图**）
- 时区：2026-09-18 CST。临时库：`tmp_p5r_1789719693`（462 MB）、`tmp_p5r_final_1789720950`（436 MB）、`tmp_p5r_fixt_1789721128`（490 MB）—— 全部 `DROP … WITH (FORCE)`，见 §6。
- ⚠️ 本 run 撞 30 分钟硬上限（**≠ 失败**）：证据 01–40 已全部落盘，报告为本轮补写；**N4 在本 run 内已真跑通**（非未决，见 §4）。

---

## 0. 判词（结论最前）

| 项 | 级别 | 结论 | 一句话 |
|---|---|---|---|
| **N1** 结构化错误覆盖不全 | HIGH | ✅ **已修（红→绿 + 反向证据）** | 两个 handler 模块内**所有 400** 统一为 `{error:{code,message,detail}}`；`code` 由 application 校验点**同源给出**（web 不再产出字符串形状、**零消息解析**）；59 条表驱动 HTTP 用例逐条断言 `(400, code)`，tester 红探针 `t_p5_http_structured_error_shape` 已转绿 |
| **N2** mock 复活已删日历档 | HIGH | ✅ **已修（红→绿 + 双向反向证据）** | mock 的 `MOCK_TESTRUN_{D1,MINUTE}_MAX_SPAN_DAYS` 与「试算区间超限」分支**物理删除**；改为「无日历档 + 可得区间收缩 + `range_empty` + `resource_guard`（confirm 语义，阈值镜像后端常量）」；其测试**改写为新语义**并与 `contract-vectors.json.span_limit_semantics` **运行期绑定**（向量瞬时扰动 ⇒ 必红，逐字节复原） |
| **N3** 旧断言静默残留 | MEDIUM | ✅ **已修（按契约推导改写 + 反向证据）** | `api_strategies.rs` 的「D1 > 5 年 ⇒ 400」改为「6 年 D1 + **有数据** ⇒ 200（真跑 1,705 bar）+ 回显」/「无交集 ⇒ 400 `range_empty` + 回显可用区间」；把日历档加回源头 ⇒ 该用例**必红**（已取证） |
| **N4** 前端真渲染缺口 | MEDIUM | ✅ **本 run 已解锁并真跑通** | 卡点根因**不是** catalog 数据侧，而是 **vite dev + `StrictMode` 下 `WorkbenchStore.dispose()` 单向置 `disposed=true`** ⇒ 所有 patch 被丢弃 ⇒ 下拉恒「加载中…」（网络 200 亦然）。真渲染改走**生产构建**（app 托管 `./web/dist`）+ 临时库夹具；四项**全部真渲染通过**：下拉 24 项 / `range_empty` **按 code 渲染** / `clamped` 提示条 / `resource_guard` 二次确认 → 确认后 201 + 新 run 入历史 |
| **N6** 环境卫生 | 卫生 | ✅ **已达标** | 本单 3 个临时库全部 `DROP … WITH (FORCE)`；回读库清单只剩 `{eestock, postgres}`（+系统模板）；无残留进程；一次性 harness 目录已删（规格/转录/截图落 `coder/evidence/adr024_p5_rect/pw/`） |
| **N5**（架构师已定稿，本单只做对齐确认） | LOW-MED | ✅ **实现与定稿一致** | 见 §5：任一端 `clamped` ⇒ 两端按真实首/末 bar 收窄；`effective_to = 末根 in-range bar ts + 1s`；**喂给引擎的 bar 集合不变**（取数先于该调整） |

**P5 冻结判据（本单视角）**：tester §0.1 列为「须修复后才可冻结」的 N1/N2 已修并有反向证据，N3 顺手订正，N4 真渲染已闭环；**建议由 tester 独立复验**（复用 `crates/web/tests/tester_p5_indep.rs::t_p5_http_structured_error_shape` 作门禁探针，现为绿）。

---

## 1. N1 —— 结构化错误覆盖不全（HIGH）

### 1.1 结论
`{"error":"<字符串>"}` 与 `{error:{code,message,detail}}` **两种类型混用**已消除：`crates/web/src/workbench.rs` 与 `crates/web/src/strategies.rs` 两模块内**所有 400** 走同一结构化出口；`error` 字段恒为**对象**（含 `code`/`message`/`detail`，`detail` 恒为对象，提交/试算路径并含请求 `period`）。

### 1.2 设计（按架构师裁决 A）
- **码与校验点同源**：`application/src/error.rs` 新增 `pub mod codes`（27 个稳定常量 + `ALL` 表）；`WorkbenchValidation` / `StrategyValidation` 改为携带 `code: &'static str` + `message: String`，提供 `new(code,msg)` / `code()` / `message()`，`Display` 仍输出原消息文本（既有日志与断言可读）。
- **web 只读码、不解析消息**：`map_svc_err_ctx(err, ctx)` 对 `StructuredError` / `WorkbenchValidation` / `StrategyValidation` 一律走结构化 400（`ctx` 合并进 `detail`，如 `period`）；404/409/500/503 保持原形状（`err()` 已加注释限定「只允许用于非 400」）。
- **strategy-core 字符串错误的归类**：`EnsembleConfig::validate` / `ExecutionPolicy::validate` 产出 `String`，而 strategy-core **不属本单范围**（不改引擎）⇒ 单点 `application::error::classify_config_error()` 按**稳定消息前缀**归类（`buy_threshold…` → `threshold_invalid`；`initial_capital…` → `capital_invalid`；`LumpSum/Dca…` → `policy_invalid`；其余 → `request_invalid`），**归类结果由 HTTP 级表驱动用例钉住**（不是 web 侧解析）。
- **前端按 code 分支**：新增 `web/src/api/errorMessages.ts`（`code → 中文提示` 映射 + `errorDisplayText()`：已知码 → 「中文提示（服务端原文）」；**未知码 ⇒ 回退服务端 `message`**；无码 ⇒ `message`）；工作台提交（`features/workbench/store.ts`）与在线试算（`features/strategies/TestRunPanel.tsx`）接入。
- **错误码命名（架构师确认 + 模块内自明码）**：`range_empty` / `resource_guard` / `period_invalid` / `from_after_to` / `timestamp_invalid` / `symbol_required` / `symbol_unregistered` / `slots_invalid` / `weight_invalid` / `params_invalid` / `threshold_invalid` / `policy_invalid` / `stop_invalid` / `fee_invalid` / `capital_invalid` / `version_not_runnable` / `source_invalid` / `mode_invalid` / `code_invalid` / `name_required` / `code_required` / `ids_required` / `status_invalid` / `kind_invalid` / `level_invalid` / `config_invalid` / `request_invalid`。
  - 「两模块内所有 400 一律结构化」这一硬要求带出的**新增自明码**：`status_invalid` / `kind_invalid` / `level_invalid` / `config_invalid` / `code_invalid` / `ids_required`（其余为架构师已确认清单）。全部登记在 `codes::ALL`，**改名即契约变更**。

### 1.3 红 → 绿
| 阶段 | 命令 | 结果 | 证据 |
|---|---|---|---|
| **红（tester 探针）** | `cargo test -p web --test tester_p5_indep t_p5_http_structured_error_shape` | **FAILED**：`period_invalid` / `from_after_to` 实得 `{"error":"<字符串>"}` | `01_red_n1_tester_probe.txt` |
| **红（本单表驱动）** | `cargo test -p web --test adr024_structured_errors` | **FAILED**：`[runs/symbol_required] error 必须是对象（禁与字符串混用）: {"error":"symbol 必填"}` | `02_red_n1_table.txt` |
| **绿（表驱动）** | 同上 | **ok**（1 passed；模块内 59 条 400 断言全绿） | `03_green_n1_table.txt` |
| **绿（tester 探针）** | `cargo test -p web --test tester_p5_indep t_p5_http_structured_error_shape` | **ok**（P5 冻结门禁探针转绿） | `04_green_n1_tester_probe.txt` |

**新测试载体**：`crates/web/tests/adr024_structured_errors.rs`
- `every_400_path_is_structured_with_code`：**表驱动**枚举两条路径的每条 400（提交 19 条 + 工作台其它端点 13 条 + `/api/strategies` 族 10 条 + 试算 13 条），逐条断言 `status==400` + `error` 为对象 + `code` 期望值 + `message` 为字符串 + `detail` 为对象；另断言提交/试算 `detail.period` 回显（架构师要求）。
- `frontend_code_message_map_covers_every_backend_code`：parity —— 读 `web/src/api/errorMessages.ts` 源码，断言 `codes::ALL` **每一个**码都有前端中文映射（后端加码而前端未覆盖 ⇒ 红）。

### 1.4 反向证据（架构师硬要求：源头改码 ⇒ 用例必红）
把 `web/src/workbench.rs::submit_run` 的 `symbol 必填` **源头**从 `codes::SYMBOL_REQUIRED` 改为 `codes::REQUEST_INVALID`：

```
assertion `left == right` failed: [runs/symbol_required] code 不符:
  {"error":{"code":"request_invalid","detail":{},"message":"symbol 必填"}}
  left: String("request_invalid")   right: String("symbol_required")
test result: FAILED. 0 passed; 1 failed
```
查证后复原：`sha256(crates/web/src/workbench.rs) = c85a317db4b6bd952412cbf8da5a726883fb39a79dddc53a70170bf8c16ba8eb`（扰动前后**逐字节一致**），用例复绿。证据：`06_reverse_n1_code_perturbed_red.txt`。

### 1.5 影响面（手工，因 gitnexus 索引不可用——见 §8）
- `WorkbenchValidation` 引用 60 处 / `StrategyValidation` 46 处（application/src + tests 的 `downcast_ref` 全部**继续编译**；仅 2 处读 `.0` 的既有断言按新形状改读 `.message`，并顺手加了 `code()` 断言）。
- `map_svc_err` 调用点 33 处（两模块 handlers）；`err()` 仅剩 8 处且全部非 400。
- 既有 web 测试中 3 处「断言 400 消息为字符串」的用例按新契约更新：`adr024_workbench_period_ssot.rs`（`period_invalid`）、`api_workbench.rs`（draft ⇒ `version_not_runnable`、period ⇒ `period_invalid`）、`api_strategies.rs`（发布门禁 ⇒ `code_invalid`）。

---

## 2. N2 —— 前端 mock 复活已删日历档（HIGH）

### 2.1 结论
`web/src/api/mock.ts` 的 `MOCK_TESTRUN_D1_MAX_SPAN_DAYS = 366*5` / `MOCK_TESTRUN_MINUTE_MAX_SPAN_DAYS = 93` 与「试算区间超限」分支**物理删除**（不是调值），改为与后端同口径：
1. **无日历档**（`contract-vectors.json::span_limit_semantics.calendar_day_cap = null`）；
2. **可得区间收缩**（`intersect_available_range`；mock 无真实数据面 ⇒ 桩口径「自 518880 真库起点 2013-07-29 至客户端 now」）；
3. **`range_empty`**（未注册标的 = 无数据；或请求与可得区间无交集）——错误体带 `code` + `available_from/to` 回显（与 N1 结构化形状同构）；
4. **`resource_guard`**（`confirm` 语义，阈值 = 后端常量镜像 `MAX_BARS_GUARD=2_000_000` / `GUARD_CONFIRM_BARS=200_000`；预估耗时同镜像 `0.85 + bars×6.25e-4`）；
5. **P5 回显补齐**（tester §2.2「同层缺口」）：`requested_*` / `effective_*` / `clamped` / `clamp_reason` / `estimated_bars` / `downsampled` / `original_points`；`StrategyTestRunReq` 增可选 `confirm?: boolean`（与后端 `TestRunReq.confirm` 同语义，向后兼容）。

### 2.2 红 → 绿
| 阶段 | 命令 | 结果 | 证据 |
|---|---|---|---|
| **红** | `npx vitest run src/api/mock.test.ts`（测试先改写为新语义） | **3 failed**（向量绑定/无日历档/回显） | `07_red_n2_mock.txt` |
| **绿** | 同上 | **53 passed** | `08_green_n2_mock.txt` |

**测试改写（不得只删断言）**：`MINOR-4` 用例整体重写为 `N2-MINOR-4（重写）：试算无日历档——与 contract-vectors.json::span_limit_semantics 绑定`，断言链：
① 向量 `calendar_day_cap === null` + `deleted_constants` 含两个已删常量；② D1 七年跨度（旧档 5 年 ⇒ 旧 mock 必 400）⇒ **受理**；③ 起点早于可得数据 ⇒ `clamped=true` / `clamp_reason='data_range'` / `effective_from>requested_from` / `effective_to==requested_to`；④ `clamp.mode === 'intersect_available_range'` 且 **`clamp.echo_fields` 全部回显**（向量增字段 ⇒ 红）；⑤ M1×1 年 ⇒ `resource_guard`（码取自向量）+ `confirm=true` ⇒ 放行；⑥ 无数据 ⇒ `empty_intersection.code` + 可用区间回显；⑦ 短区间回归保护。另加「源码级防漂移」（不得复活 `*MAX_SPAN_DAYS` 常量/旧文案）与「P5 回显可见」两条用例。

### 2.3 反向证据（两条，均逐字节复原）
1. **把日历档加回 mock** ⇒ `09_reverse_n2_calendar_cap_red.txt`：**2 failed / 51 passed**；复原后 `sha256(web/src/api/mock.ts) = f6b54020f14953cc30cb84a928fc7ae11a06f47bcc14ee7fe6f016017d1e1b4e`（前后一致），复跑 **53 passed**。
2. **向量绑定真实性**（架构师硬要求「向量改 ⇒ 断言必须变红」）：把 `contract-vectors.json` 的 `calendar_day_cap` 瞬时改为 `1830` ⇒ `12_reverse_n2_vector_perturbed_red.txt`：**FAILED: expected 1830 to be null**（`N2-MINOR-4…与 contract-vectors…绑定` 用例红）；立即复原，`sha256 = 838530eeb02edcefa315cbc5ae1d485fe44e8bde51e43c1cf06c9f00a520281d` **前后一致**、`git diff design/16-backtest-scalability/contract-vectors.json` 为空，复跑 **53 passed**。⚠️ 该扰动为**取证**性质（<60s，未纳入 stage，未留在工作区）。

---

## 3. N3 —— 旧断言静默残留（MEDIUM，测试诚实性）

### 3.1 结论
`crates/web/tests/api_strategies.rs::test_run_both_modes_and_errors` 中「区间超限（D1 > 5 年）→ 400」已**按契约推导改写**（不是换个理由的 400）：
- **(a) 长区间 + 有数据 ⇒ 受理**：用**真库 518880 D1 真数据**（临时库基线供应）请求 `2020-01-01 → 2026-01-01`（**6 年 > 旧 5 年档**）⇒ `200` + `bar_count > 1000`（真跑，非仅校验通过）+ `requested_*` 回显 + `clamped=false` + `effective_* == requested_*`；
- **(b) 无交集 ⇒ `range_empty` 且回显可用区间**：请求 `2030-01-01 → 2031-01-01` ⇒ `400` + `error.code == "range_empty"` + `detail.available_from/to` 为字符串（**不再是「区间超限」语义**）。

### 3.2 绿 + 反向证据
| 阶段 | 命令 | 结果 | 证据 |
|---|---|---|---|
| 绿 | `cargo test -p web --test api_strategies` | **9 passed / 0 failed** | `10_green_n3_web_strategies.txt` |
| **反向（日历档回归 ⇒ 必红）** | 在 `application/src/strategy.rs::test_run` 源头临时加回 `D1 > 366*5 天 ⇒ 400` | **FAILED**：`6 年 D1 + 有数据 ⇒ 应受理（日历档已删）: {"error":{"code":"request_invalid",…}} left: 400 right: 200` | `11_reverse_n3_calendar_cap_red.txt` |

复原：`sha256(crates/application/src/strategy.rs) = 013338bce9479a5baa547b8672a1f58615345a2174d05a9c84072a0769ad0911`（前后一致），复跑 9 passed。
> 同族**文案**（非断言）残留按 tester §2.3「建议随修」顺手处理了试算面板的误导措辞：`TestRunPanel` 新增 `downsampled` 显式提示（「评分序列已均匀抽样（保留首尾；原始 N 点）」），旧「仅展示前段」措辞只保留给事件/成交的**真截断**。其余 4 处注释文案未动（非本单判据，避免扩大范围）。

---

## 4. N4 —— 前端真渲染缺口（MEDIUM）：**本 run 已解锁并真跑通**

### 4.1 卡点根因（非数据侧）
tester §2.4 归因「第二实例工作台策略下拉为空」——**复现后定位**：
- 实测第二实例 `GET /api/strategies` **200 且 23 条 published**（4.7 ms）；反例：把临时库 `strategy/strategy_version` 清空后**重启应用，启动播种立刻写入 11 条 published 参考插件** ⇒ **真实例 catalog 不可能为空**。
- 真正卡点：`vite dev` 下 `main.tsx` 的 `<StrictMode>` 触发 mount→unmount→mount，而 `WorkbenchPage` 用 `useMemo` 复用同一 `WorkbenchStore`，`dispose()` **单向置 `disposed = true` 且无复位** ⇒ 其后所有 `patch()` 被丢弃 ⇒ `catalogLoading` 恒 true ⇒ 下拉恒「加载中…」。
- 证据 `25_n4_dev_mode_blocked_rootcause.txt`（dev）：下拉 `disabled=true`、只有一个 `option 加载中…`，**同一时刻网络 200**（`/api/strategies` 出现 2 次）。生产构建无 StrictMode 双调用 ⇒ 不复现。

### 4.2 解锁（**未改任何生产代码/接口**）
- 真渲染改走**生产构建**：`npm run build`（`22_frontend_build.txt`）→ 第二实例以 `--config /tmp/p5rect_app.toml`（`static_dir = ./web/dist`，仅临时配置文件，仓内未改）托管 SPA（`20_second_instance.log`：`static_dir:"./web/dist"`）。
- **临时库最小夹具**：`coder/evidence/adr024_p5_rect/pw/fixture.sh`（幂等）——catalog 为空时经**真 REST 门禁** create + publish 一条策略；本次实测 `23_n4_fixture.txt`：`catalog 现有条目 = 23 ⇒ 无需夹具`；清空调研 `26_n4_fixture_unlock_demo.txt`：清空后重启 → 应用**自动播种 12 条** ⇒ 夹具路径为安全网（非阻塞点）。
- 一次性 harness（`web/e2e-p5-rect/`）**用后已删**；规格/配置/转录/截图落 `coder/evidence/adr024_p5_rect/pw/`。

### 4.3 真渲染输出（`24_n4_real_render.txt`，真浏览器 + 真二实例 + 临时库，**1 passed，8.4s**）
```
[N4] 策略下拉 option 数 = 24                         # ① 解锁：catalog 真加载
[N4] 可用区间文案 = 可用区间：2013-07-29 ~ 2026-09-17   # ① min/max 随标的+周期联动
[N4] range_empty 渲染文案 = 提交失败：该标的该周期无数据（可用区间：2013-07-29T01:30:00+00:00 ~
     2026-09-17T07:00:01+00:00）（HTTP 400 /api/workbench/runs: 请求区间与可得区间无交集（…））
                                                     # ② **结构化错误按 code 渲染**（前端码映射 + 服务端原文）
[N4] clamped 提示条 = 已按实际数据范围收缩：2013-07-29 ~ 2013-08-02（原因：数据可得范围）  # ③
[N4] resource_guard 二次确认 = 预估 770236 根 bar（约 482.2 秒），达到二次确认阈值。        # ④
[N4] 确认后 clamped 提示条 = 已按实际数据范围收缩：2013-07-29 ~ 2026-09-16（原因：数据可得范围）
[N4] 新 run 行 = sr_1789720906265_000004 | 518880 · 1m · 09-18 16:41 | 运行中 2% | 取消
```
- 断言口径（防「陈旧文案」假绿）：确认后先 `guard-prompt` 隐藏，再 **poll 提示条文本必须变化**（`!==` 上一步文案）并匹配 `2026-09-\d\d`，最后断言**新 run 行出现**在运行历史。
- 旁证（API 直读，run 已完成）：`sr_1789720706979_000002 succeeded`，`effective=[2013-07-29T01:30:00Z, 2026-09-16T07:00:01Z)`、`requested=[2013-01-04T00:00:00Z, 2026-09-17T00:00:00Z)`、`clamped=true`、`estimated_bars=770236` —— 即 UI 二次确认后**真跑了 77 万 bar** 的 run。
- 截图：`pw/screenshots/01-available-range.png`、`02-range-empty-by-code.png`、`03-clamp-notice.png`、`04-guard-prompt.png`、`05-guard-confirmed-clamp.png`。

### 4.4 遗留（**观察项，未修，需架构师裁决**）
`WorkbenchStore.dispose()` 未复位 `disposed` ⇒ **vite dev（严格模式）下工作台不可用**（catalog 恒加载中）。本单**按纪律未改**（不在 N1–N4 判据内、属行为变更）。建议另立一张小单：`dispose()` 后允许 `init()` 复位，或在 `WorkbenchPage` 用 `useEffect` 之外的生命周期持有 store（并给 jsdom 用例：dispose→init 后 patch 生效）。

---

## 5. §3.1 步骤 5（N5 定稿）对齐确认

架构师定稿语义：**任一端被夹（`clamped=true`）⇒ 两端都按区间内真实首/末 bar 收窄**；`effective_from = 首根 in-range bar ts`；`effective_to = 末根 in-range bar ts + 1s`（半开）；**不得影响喂给引擎的 bar 集合**。

实现核对（逐条，只读）：
| 定稿条文 | 实现 | 位置 | 一致 |
|---|---|---|---|
| 任一端 clamped ⇒ 两端都按真实首/末 bar 收窄 | `if clamped { actual_from = in_range[0].ts; actual_to = in_range.last().ts + 1 }` + 两端分别收紧 | `application/src/workbench.rs:607-617`、`application/src/strategy.rs:843-853` | ✅ |
| `effective_from = 首根 in-range bar ts` | `DateTime::from_timestamp(in_range[0].ts, 0)`（`actual_from > eff_from` 时才覆盖；构造上 `in_range` 起于 `eff_from` ⇒ 等值情形即同值） | 同上 608-613 / 844-849 | ✅ |
| `effective_to = 末根 in-range bar ts + 1s` | `DateTime::from_timestamp(in_range[last].ts + 1, 0)`（仅当早于 `eff_to` 时覆盖；对齐情形同值） | 同上 609-616 / 845-852 | ✅ |
| 不影响喂给引擎的 bar 集合 | `all = bar_read.bars(..., eff_to)`、`in_range` 切片**先于**该调整；调整只改 `eff_from/eff_to`（落库 `from_ts/to_ts` 与响应回显） | `workbench.rs:597`、`strategy.rs:831`（取数在其上）、落库 `create_run(from_ts: eff_from, to_ts: eff_to)` | ✅ |
| 提交端与执行端不一致时以执行时为准（D3） | 提交端按缓存 `available_range` 收缩；执行端实取 bar 后再收窄 | 同上 | ✅ |

**与 tester §1.3/§2.5 的实测偏差说明**：tester 观察到的「左端被夹时右端也被收窄」「`effective_to` = 区间内末 bar +1s」正是**定稿语义**（不再是 U2 旧声称的「仅被夹端生效」）；差异仅落在落库 `from_ts/to_ts` 与回显（≤1 根 bar），**引擎 bar 集合不变** ⇒ 与定稿一致，无需改 `design/16-*`。

---

## 6. N6 —— 环境卫生（teardown 输出原文，`40_n6_teardown.txt`）

```
# N6 teardown（2026-09-18T16:46:30+08:00）—— 全单最终回读
$ psql -Atc "select datname, pg_size_pretty(pg_database_size(datname)) ..."   # 删除前
eestock 2452 MB
postgres 7519 kB
template0 7361 kB
template1 7361 kB
tmp_p5r_fixt_1789721128 490 MB

$ for db in $(... datname like 'tmp_p5r%'); do psql -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)"; done
DROP DATABASE

# 删除后库清单（业务库须只剩 eestock / postgres；template0/1 为系统模板）
eestock
postgres
template0
template1

# 残留进程（app/vite）计数（期望 0）
0
# 一次性 harness 目录（期望：不存在）
ls: cannot access 'web/e2e-p5-rect': No such file or directory
ls: cannot access 'web/pw-artifacts': No such file or directory
```
本单曾创建 3 个临时库（`tmp_p5r_1789719693` 462 MB / `tmp_p5r_final_1789720950` 436 MB / `tmp_p5r_fixt_1789721128` 490 MB），**全部 `DROP … WITH (FORCE)`**；另在收尾复核：`ps` 无 app/vite 残留、`web/e2e-p5-rect` 与 `web/pw-artifacts` 已删。**上一轮遗留的 `tmp_p5_1789716888` 已由 tester 代删**（本单起始库清单即已干净，`00_tempdb_init.log` 起始态可证）。

---

## 7. 门禁（本单复跑，证据 31–35）

| 门禁 | 命令 | 结果 | 证据 |
|---|---|---|---|
| 后端全量（**fresh 临时库**） | `cargo test -p storage -p application -p web -p mcp` | **528 passed / 0 failed / 0 ignored** | `31_backend_full.txt` |
| 前端全量 | `npx vitest run` | **91 files / 879 tests passed** | `32_frontend_vitest.txt` |
| 类型 | `npx tsc -b` | exit=0 | `33_frontend_tsc.txt` |
| 构建 | `npm run build`（vite） | ✅ built（生产 SPA，真渲染所托管产物） | `34_frontend_build.txt` |
| tangle | `./scripts/check-tangle.sh` | ✅ exit=0（沙箱重生成 + 逐字节比对） | `35_check_tangle.txt` |
| 前端错误码 parity | `cargo test -p web --test adr024_structured_errors frontend_code_message_map_covers_every_backend_code` | ok | `03_green_n1_table.txt` |

**诚实登记**：`05_web_tests.txt` 是**迭代期**在「已被前序用例污染的临时库」上的运行记录，其中 `orphan_detect_endpoint_red::r1_orphan_endpoint_endpoint…`（断言库内孤儿 cagg 行 = 0）失败——**非本单改动引入**：孤儿行由 `crates/web/tests/tester_p5_indep.rs` 等文件创建的合成标的（`83xxxx` 前缀）在删除 `symbols` 后残留在 cagg 中造成（`kline_accurate` 中 `831637/834219` 无对应 symbol，实测 12 行）；换 **fresh 临时库**后该用例与全量一起 **0 failed**（`31_backend_full.txt`）。属既有**测试隔离债**，建议另立（与 tester §4 U2 同族）。

---

## 8. 范围、纪律与观察项

**改动文件（分层）**
- application（Application 层）：`src/error.rs`（码常量 + `ALL` + `classify_config_error`）、`src/workbench.rs`、`src/strategy.rs`（错误类型带码 + 各校验点赋码）；`tests/{workbench,strategy}.rs`（2 处 `.0` → `.message` + 加码断言）。
- web（Presentation 层）：`src/workbench.rs`、`src/strategies.rs`（结构化 400 出口 + `map_svc_err_ctx`）；`tests/adr024_structured_errors.rs`（新，表驱动 + parity）、`tests/api_strategies.rs`（N3 改写 + 发布门禁码断言）、`tests/api_workbench.rs`、`tests/adr024_workbench_period_ssot.rs`。
- frontend：`web/src/api/errorMessages.ts`（新，码→中文 + 未知码回退）、`web/src/api/errorMessages.test.ts`（新）、`web/src/api/mock.ts` + `mock.test.ts`（N2）、`web/src/api/types.ts`（`confirm?` + 已有 P5 字段）、`web/src/features/workbench/store.ts`、`web/src/features/strategies/TestRunPanel.tsx`。
- 证据/报告：`coder/evidence/adr024_p5_rect/**`（27 原始输出 + `pw/` harness/规格/5 截图）、本报告。

**未触碰（按单）**：引擎/指标/`strategy-runtime`；P4 分块与端点语义（`/fills`、`recorded`）；进度写库策略；`design/16-backtest-scalability/**`（除 §2.3 的**取证扰动**：向量瞬时改值后**逐字节复原**，工作区无残留）；`/api/quality`、`/api/kline` 等其它族 400 形状（**登记为「形状统一性债务」**，另立）；MCP 侧（有自身 `isError` 语义）；未部署、未 `git commit`、未 `git add -A`、未对活库应用 0027。

**其它观察项**
1. **gitnexus 索引不可用**：`node .gitnexus/run.cjs impact "WorkbenchValidation"` 返回 `LadybugDB unavailable … Database file version: 43, Current build storage version: 40` ⇒ `risk: UNKNOWN`（按 AGENTS.md **不当作低风险**）。故按文本检索做了手工影响面盘点（§1.5）并在此登记；如需图级结论须先修复索引（`npx gitnexus analyze`）。
2. **前端码集合防漂移**：`codes::ALL` ↔ `web/src/api/errorMessages.ts` 由 Rust 侧 parity 用例钉住；向量侧由 `mock.test.ts`/`errorMessages.test.ts` 钉住。
3. **N1 的 `classify_config_error`**：对 strategy-core 的 `String` 错误按稳定前缀归类（engine/指标不在本单范围）；该映射由 HTTP 级表驱动用例（`threshold_invalid`/`capital_invalid`/`policy_invalid`）固定，改前缀 ⇒ 用例红。
4. **N4 的 dev 模式缺陷**（§4.4）需架构师裁决是否另立小单。

---

## 9. 证据清单（`coder/evidence/adr024_p5_rect/`）

| 文件 | 内容 |
|---|---|
| `00_tempdb_init.log` | 起始临时库供应（幂等脚本；起始库清单干净） |
| `01_red_n1_tester_probe.txt` / `02_red_n1_table.txt` | **N1 红**（tester 探针 / 本单表驱动） |
| `03_green_n1_table.txt` / `04_green_n1_tester_probe.txt` | **N1 绿**（表驱动全绿 + 探针转绿） |
| `05_web_tests.txt` | 迭代期 `cargo test -p web`（含既有孤儿用例的隔离债，见 §7） |
| `06_reverse_n1_code_perturbed_red.txt` | **N1 反向证据**（源头改码 ⇒ 必红 + sha256 复原） |
| `07_red_n2_mock.txt` / `08_green_n2_mock.txt` | **N2 红→绿**（mock 新语义） |
| `09_reverse_n2_calendar_cap_red.txt` | **N2 反向证据①**（日历档加回 mock ⇒ 必红 + sha256 复原） |
| `10_green_n3_web_strategies.txt` / `11_reverse_n3_calendar_cap_red.txt` | **N3 绿 + 反向证据**（日历档回归 ⇒ 必红 + sha256 复原） |
| `12_reverse_n2_vector_perturbed_red.txt` | **N2 反向证据②**（`contract-vectors.json` 瞬时扰动 ⇒ 必红 + 逐字节复原） |
| `20_second_instance.log` / `21_vite_dev.log` | 真二实例（`static_dir=./web/dist`）/ vite dev 日志 |
| `22_frontend_build.txt` | 生产构建（真渲染所托管产物） |
| `23_n4_fixture.txt` / `26_n4_fixture_unlock_demo.txt` | **N4 夹具**（幂等 no-op + 空 catalog 调研：应用启动自播种） |
| `24_n4_real_render.txt` | **N4 真渲染转录**（四项全通过 + 新 run 行） |
| `25_n4_dev_mode_blocked_rootcause.txt` | **N4 卡点根因**（dev 模式下拉恒「加载中…」，网络 200） |
| `30_fresh_tempdb_init.log` / `31_backend_full.txt` | fresh 库供应 + 后端全量 **528/0** |
| `32_frontend_vitest.txt` / `33_frontend_tsc.txt` / `34_frontend_build.txt` / `35_check_tangle.txt` | 前端 879/0、tsc、build、tangle |
| `40_n6_teardown.txt` | **N6 teardown 原文**（DROP … WITH (FORCE) + 回读库清单 + 残留检查） |
| `pw/` | `p5_real_render.e2e.ts`（真渲染规格）、`probe.e2e.ts`（卡点探针）、`playwright.p5rect.config.ts`、`fixture.sh`、`screenshots/01–05*.png` |

**新增/改动测试载体**：`crates/web/tests/adr024_structured_errors.rs`（新）、`web/src/api/errorMessages.test.ts`（新）；`crates/web/tests/{api_strategies,api_workbench,adr024_workbench_period_ssot}.rs`、`crates/application/tests/{strategy,workbench}.rs`、`web/src/api/mock.test.ts`（按新契约改写）。tester 车道文件（`crates/web/tests/tester_p5_indep.rs` 等）**未 add、未改**。
