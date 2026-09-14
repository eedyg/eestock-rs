# 263 — P1-A 多周期配置面 + 关闭态等价 · 红测试设计报告

- **本报告位置**：`tester/design/263_p1a_multiperiod_config_red_design.md`
- **类型**：Design report（本任务**新设计并编写**的红测试；非既有用例执行）
- **执行报告（Red 证据）**：`tester/test/263_p1a_multiperiod_config_red_execution.md`
- **证据目录**：`tester/evidence/263_p1a_multiperiod_config_red/`
- **仓库 / 提交**：`/home/eestock/workspace/git/eestock/eestock-rs` @ `d6462da`（工作区：4 个新增未跟踪测试文件，**无 staged**）
- **权威依据**：`design/15-multi-period/01-adr.md`（ADR-022 口径 1/2/3/5/9/10/12）、`02-spec.md`（§1/§2 配置 7 校验、§6 布局、§7 护栏 5 条、§9 可观测性）、`03-test-plan.md`（T6 / T8bis / T11）、`04-implementation-plan.md` P1。
- **性质**：**只写测试**。未改任何生产实现/接口/架构；未 `git add/commit/stash`；未跑 tangle；未触碰线上（PID 3112540）；**对线上 0 请求**（端点请求只打到本进程自建 `127.0.0.1:0` 临时 axum 实例）；无临时实例/端口残留（进程随测试结束退出）。

---

## 1. 目标与范围（被指派）

把 `04-implementation-plan.md` **P1（骨架与隔离 + 配置面）** 的可验证面落成**红测试**：

| # | 任务书条目 | 本报告落地 |
|---|---|---|
| 1 | **T6 配置面 7 条校验 + 护栏**（`GET/PUT /api/config/multi_period`） | `crates/web/tests/api_multi_period_config.rs`（15 例）+ `crates/web/tests/multi_period_pane_budget.rs`（4 例，总 pane 护栏纯函数契约） |
| 2 | **T8bis 降级口径的配置/状态面占位**（只验「可观测字段存在且可读出」） | `web/src/features/dashboard/multiPeriodStore.test.ts` 的 T8bis 例（`syncDegraded` / `lastSpanDiffMinutes`） |
| 3 | **T11 关闭态等价 + 零残留** | `web/src/features/dashboard/multiPeriodClosedEquivalence.test.tsx`（4 例）+ `multiPeriodStore.test.ts`（关闭态默认 / 零副作用 / 开关往返） |

**明确不做（本轮范围外，非疏漏）**：不做卫星实例（P2）、不做跨图同步与 `ChartSyncGroup` 算法（P3）、不做 LIVE 段（P4）、不做布局持久化拖拽（P5）、不测 UI 角标（P2/P3）、不改任何产品代码、不调参、不 tangle。

---

## 2. 测试策略

| 层 | 手段 | 为什么 |
|---|---|---|
| Rust HTTP 集成（配置面/护栏） | 真实起 axum（`web::build_router` + 现有 `AppState`）+ `reqwest` 断言，**真实 TimescaleDB :5433**（形状照 `api_ma_config.rs` 三层） | 端点/DTO/`ConfigStore` 三层是 tangle 产物，行为只能在 HTTP 面上验；`app_config` 键存在性/坏值回退必须真库 |
| Rust 纯函数单元（总 pane 护栏） | 直接调用 `web::dto::{MULTI_PERIOD_MAX_PANES, multi_period_pane_count, verify_multi_period_panes}` | v1 下 HTTP 面**无法表达 >12**（见 §9(c)）⇒ 护栏只能锚定在 dto 纯函数上，才能有牙齿（缺护栏必红） |
| 前端 store 单元 | 变量 specifier 动态 `import()` + 假 `ApiClient`（调用计数） | store 尚不存在 ⇒ 逐用例 red；`enabled=false` 的**零副作用**（不建 feed/订阅/请求）与 T8bis 字段可读出都是状态面断言 |
| 前端页面/容器集成 | `@testing-library/react` 渲染 `DashboardPage`（jsdom + klinecharts 桩）+ **DOM 结构指纹**与**记账计数** | 「关闭态与现状等价」必须逐节点/逐资源计数验证；指纹法见 §4.3 |

### 2.1 mock / stub 策略

- **不 mock klinecharts 之外的东西**：Rust 侧不打桩（真库 + 真 axum）；前端侧照既有惯例 `vi.mock('klinecharts')`（jsdom 无 canvas），
  chart 桩由 `@/test/chartStoreStub` 派生 `getIndicators`，**不引入跨用例状态**。
- **假 WsClient 带订阅登记表**（`handlers: Map<topic, Set<handler>>`）⇒ `bar:` 订阅数、topic 名、退订均可断言（替代「订阅计数」证据）。
- **假 ApiClient**：底座 `@/test/apiStub` 的 `stubApi` + 覆写 `getKline` / `getMultiPeriodConfig`（逐方法 `vi.fn` 计数）。
- **不 mock 时间/轮询**：关闭态等价只断言「无**额外**请求」，静默窗 120ms 内计数不变（分钟级兜底轮询不会干扰）。
- **模块缺失的表达**：前端用**变量 specifier** 的 `await import()`（红阶段逐用例报 `Cannot find module`，且不阻塞 `tsc -b`，
  与 P0.1-A `251_*` 同一手法）；Rust 用**符号缺失的编译错误**（`E0432`）。

---

## 3. 分层覆盖计划

| 覆盖层 | 覆盖内容 | 对应用例 |
|---|---|---|
| L1 服务端读侧（无键/坏值回退） | 无键 ⇒ 200 默认；9 类坏形状/越界旧值 ⇒ 200 回默认（**不 500**） | `api_multi_period_config.rs` ×2 |
| L2 服务端写侧（正例/边界） | 合法 PUT 回显+读回一致；`1d`基准+`1w`卫星合法；heights 边界 80/1200 合法；v1 最大合法形态（4 周期）合法 | 同文件 ×4 |
| L3 服务端写侧（负例全列） | 基准 `1mo`／卫星 < 基准／卫星含 `1mo`／`1w` 但基准 < `1d`／周期数 > 4（且**不落库、不截断**）／周期重复／`heights` 键不一致（缺键+多键）／`heights` 越界（<80、>1200）／`indicators` 未支持项 | 同文件 ×9 |
| L4 护栏（总 pane ≤12） | 常量 12 + 公式（1 + Σ卫星指标 pane）+ **边界含 12 / 拒 13** + 超限必须 `Err` 且含 `pane` | `multi_period_pane_budget.rs` ×4 |
| L5 前端状态面（T11-1/T8bis） | 关闭态默认；`load()` 镜像服务端；可观测字段存在且可读出；零副作用；开关往返零残留 | `multiPeriodStore.test.ts` ×5 |
| L6 前端渲染面（T11） | main-chart 子树 DOM 结构指纹 == 现状冻结值；记账等价（实例/订阅/请求）；容器透传；零残留 + 开关默认关 | `multiPeriodClosedEquivalence.test.tsx` ×4 |
| 回归安全网 | 既有前端套件 617 例零回归；`tsc -b` 通过 | 见执行报告 §2 |

---

## 4. 用例清单

### 4.1 `crates/web/tests/api_multi_period_config.rs`（15 例；红 = 404 路由未注册）

| # | 用例名 | Given-When-Then 断言要点 | 当前 |
|---|---|---|---|
| R1 | `t6_get_without_key_returns_defaults_200` | G 清键；W `GET`；T 200 + `enabled=false` + `periods` 恰 1 个合法基准 + `heights` 同键唯一且 = 420 + `indicators=["dcap"]` | **红** |
| R2 | `t6_get_falls_back_to_defaults_on_bad_or_out_of_range_stored_values` | G 逐样本落库 9 类坏值（类型错/非对象标量/缺字段/高度 5000/周期数 5/重复/含 `1mo`/`1w` 基准<`1d`/未支持指标）；W `GET`；T 每样本 200 + 默认口径（**不 500**） | **红** |
| R3 | `t6_put_valid_roundtrip_200_and_readback_identical` | G 清键；W `PUT` 合法（1m+5m+15m）；T 200 + 回显 == 请求 + `GET` 读回 == 请求 | **红** |
| R4 | `t6_put_valid_1d_base_with_1w_satellite_is_accepted` | 口径 10 正向面：基准 `1d` + 卫星 `1w` ⇒ 200（护栏不得误拒） | **红** |
| R5 | `t6_put_rejects_base_1mo` | 基准 `1mo`（+`1mo,1w` 变体）⇒ 400 且错误含 `periods` | **红** |
| R6 | `t6_put_rejects_satellite_below_base` | `5m+1m`、`1d+1h` ⇒ 400 且含 `periods` | **红** |
| R7 | `t6_put_rejects_satellite_1mo` | `1m+1mo` ⇒ 400 且含 `periods`（1mo 是最大周期，唯「≥基准」拦不住） | **红** |
| R8 | `t6_put_rejects_1w_when_base_below_1d` | `1m+1w`、`1h+1w` ⇒ 400 且含 `periods` | **红** |
| R9 | `t6_put_rejects_more_than_4_periods_without_silent_truncation` | 前置落合法 3 周期 → PUT 5 周期 ⇒ 400 含 `periods`；随后 `GET` 仍为 3 周期（**不落库、不得静默截断为 4**） | **红** |
| R10 | `t6_put_rejects_duplicate_periods` | `1m,1m`、`1m,5m,5m` ⇒ 400 且含 `periods` | **红** |
| R11 | `t6_put_rejects_heights_keys_mismatching_periods` | 缺键（有 `5m` 无高度）与多键（无 `5m` 有高度）⇒ 400 且含 `heights` | **红** |
| R12 | `t6_put_rejects_heights_out_of_range` | 79 / 1201 ⇒ 400 且含 `heights`；**边界 80 / 1200 ⇒ 200**（防误拒） | **红** |
| R13 | `t6_put_rejects_unsupported_indicators` | `["macd"]`、`["dcap","boll"]` ⇒ 400 且含 `indicators` | **红** |
| R14 | `t6_max_legal_config_is_accepted` | v1 最大合法形态（4 周期 × `dcap` ⇒ pane 4 ≤ 12）⇒ 200 且回显一致 | **红** |
| R15 | `t6_zz_cleanup_leaves_no_multi_period_key` | 库卫生**自检**：清理后 `app_config` 无 `multi_period` 键 | **绿**（证明清理路径真落地） |

**拒绝语义的统一断言**（`assert_rejected`）：400 + body 含 `error` 且 **含被拒字段名** + **不得回显任何配置字段**（证明「明确报错、不静默截断/不静默归一化」）。

### 4.2 `crates/web/tests/multi_period_pane_budget.rs`（4 例；红 = `web::dto` 三符号缺失 ⇒ 编译失败 `E0432`）

| # | 用例名 | 断言要点 | 当前 |
|---|---|---|---|
| P1 | `pane_budget_cap_is_12` | `MULTI_PERIOD_MAX_PANES == 12` | **红（编译）** |
| P2 | `pane_count_formula_is_base_plus_per_satellite_panes` | `1`（单周期）/`2`（2 周期）/`4`（4 周期 × 1 指标 = v1 上限） | **红（编译）** |
| P3 | `pane_budget_boundary_is_inclusive_at_12_and_rejects_13` | `1+1×11 = 12` ⇒ `verify` 允许；`1+1×12 = 13` ⇒ 超限 | **红（编译）** |
| P4 | `over_budget_must_be_rejected_with_explicit_error_not_silent_truncation` | `1+3×5 = 16 > 12` ⇒ `verify_multi_period_panes` 返回 `Err` 且信息含 `pane`；对照 `1+3×2 = 7` 允许 | **红（编译）** |

### 4.3 `web/src/features/dashboard/multiPeriodStore.test.ts`（5 例；红 = `./multiPeriodStore` 不存在）

| # | 用例名 | 断言要点 | 当前 |
|---|---|---|---|
| S1 | T11-1 关闭态默认 | `load()` 后 `enabled=false` / `periods=["1m"]` / `heights={"1m":420}` / `indicators=["dcap"]` / **未发起 K 线取数** | **红** |
| S2 | `load()` 镜像服务端配置 | 服务端给 `1d+1w` 与自定义高度 ⇒ 状态原样镜像（不在前端硬编码、不改写） | **红** |
| S3 | T8bis 可观测字段 | `syncDegraded`、`lastSpanDiffMinutes` **存在于快照**、类型正确、关闭态默认 `false`/`null`、可经 `getSnapshot()` 读出 | **红** |
| S4 | 关闭态零副作用 | 配置读取失败 ⇒ 保持默认关闭且不抛穿；`subscribe` 通知/退订正确；**全程 0 次 K 线请求** | **红** |
| S5 | 开关往返零残留 | `setEnabled(true)` → `setEnabled(false)`：`enabled=false` + 运行态字段归零（`syncDegraded=false`、`lastSpanDiffMinutes=null`）+ 快照 == 初始关闭态 + 无新增请求/配置读取 | **红** |

### 4.4 `web/src/features/dashboard/multiPeriodClosedEquivalence.test.tsx`（4 例；红 = 容器/store 不存在）

| # | 用例名 | 断言要点 | 当前 |
|---|---|---|---|
| E1 | 关闭态 DOM 结构等价 | `[data-region="main-chart"]` 子树结构指纹 == **现状冻结指纹**（3 行，见 §7）⇒ **不得新增任何包裹层** | **红** |
| E2 | 关闭态记账等价 | `init` 恰 1 次；`bar:` 订阅恰 `["bar:518880:15m"]`；`getKline` 恰 1 次且 `period=15m`；`quote` 订阅 1 个；`getMultiPeriodConfig` ≤ 1 次 | **红** |
| E3 | 关闭态容器透传 | `MultiPeriodChartStack(enabled=false)` ⇒ `innerHTML` 逐节点等于 children；`init`/`dispose` 零调用 | **红** |
| E4 | 关闭态零残留 | 页面任意元素无 `satellite|卫星` 标记；120ms 静默窗内请求/订阅/实例数不变；「多周期」开关（若已加）默认 `aria-pressed=false` | **红** |

**指纹口径**：只含「标签层级 + `data-*` 属性 + `type`/`aria-pressed` + 非空文本」，**不含** class/id/style
（样式类变动不误报，但**任何新增/删除元素都会**被捕获）。冻结值取证于 P1 前 HEAD `d6462da`（`baseline_capture_d6462da.txt`），
并用 `frozen_fp_selfcheck.txt` 证明该常量与现状渲染一致（自检通过）。

---

## 5. 实现方需落地的接口契约（本报告只声明，不实现）

### 5.1 前端（`web/src/features/dashboard/`，**非 tangle 手写**）

```ts
// multiPeriodStore.ts
export interface MultiPeriodState {
  enabled: boolean;                     // 默认 false（口径 5：关闭 == 现状）
  periods: Period[];                    // [基准, ...卫星]；关闭态默认 [基准]
  heights: Record<string, number>;      // 键必须与 periods 一致（§6）
  indicators: string[];                 // 首版 ["dcap"]
  syncDegraded: boolean;                // T8bis 占位（口径 5 降级「可观测字段」；默认 false）
  lastSpanDiffMinutes: number | null;   // T8bis 占位（最近一次对齐跨度差，分钟；无记录 null）
}
export class MultiPeriodStore {
  constructor(deps: { api: ApiClient });
  get state(): MultiPeriodState;
  getSnapshot(): MultiPeriodState;                 // useSyncExternalStore 绑定（与 DashboardStore 并列）
  subscribe(l: () => void): () => void;
  load(): Promise<void>;                           // GET /api/config/multi_period；失败 ⇒ 保持默认关闭
  setEnabled(enabled: boolean): void;
  dispose(): void;
}
```
```tsx
// MultiPeriodChartStack.tsx —— P1 只要求「关闭态透传」这一条硬约束
export function MultiPeriodChartStack(props: { enabled?: boolean; children: React.ReactNode }): JSX.Element;
// enabled === false ⇒ 直接返回 children（Fragment/直接返回），**不得新增任何包裹元素**（§7.5）
```
```ts
// web/src/api/client.ts（手写文件）+ mock.ts：新增
getMultiPeriodConfig(): Promise<MultiPeriodConfigDto>;   // GET /api/config/multi_period
saveMultiPeriodConfig(cfg: MultiPeriodConfigDto): Promise<MultiPeriodConfigDto>; // PUT（P1 不强制本测试消费）
```

### 5.2 服务端（`web/src/{dto,rest,lib}.rs` = **tangle 生成物** ⇒ 必须 doc-first）

- 契约先写进 `design/07-app-plane/00-web-api.md`（`file=` 块），再在 **/tmp 沙箱** 重生成后拷回（**禁在仓库内跑 tangle**）。
- 需要落地的符号与路由：

```rust
// crates/web/src/dto.rs
pub const MULTI_PERIOD_MAX_PANES: usize = 12;                      // §7.4
pub fn multi_period_pane_count(periods: &[String], indicators: &[String]) -> usize; // 1 + Σ卫星指标 pane
pub fn verify_multi_period_panes(periods: &[String], indicators: &[String]) -> Result<(), String>; // 超限 Err 含 "pane"
pub fn validate_multi_period_config(cfg: &MultiPeriodConfigDto) -> Result<(), String>; // 7 条校验 + pane 预算（须调用 verify_*）
pub fn multi_period_config_or_default(raw: Option<serde_json::Value>) -> MultiPeriodConfigDto; // 无键/坏值 ⇒ 默认（不 500）
pub struct MultiPeriodConfigDto {              // serde 字段名即 JSON 键名
    pub enabled: bool, pub periods: Vec<String>,
    pub heights: std::collections::BTreeMap<String, i64>, pub indicators: Vec<String>,
}

// crates/web/src/rest.rs + lib.rs
const K_MULTI_PERIOD: &str = "multi_period";   // app_config（0021，无需迁移）
.route("/api/config/multi_period", get(rest::get_multi_period_config).put(rest::put_multi_period_config))
```
- **错误信息必须含被拒字段名**（`periods` / `heights` / `indicators`），与 `validate_dcap_config` 的风格一致。

---

## 6. 边界与异常用例（汇总）

| 类别 | 用例 | 期望 |
|---|---|---|
| 读侧健壮性 | R1/R2（无键、9 类坏值） | 一律 200 回默认；**绝不 500** |
| 写侧边界（合法） | R12 heights `80`/`1200`；R14 4 周期；R4 基准 `1d`+卫星 `1w`；R3 合法往返 | 200 |
| 写侧边界（拒绝） | R5–R13（基准 `1mo`、卫星 < 基准、卫星 `1mo`、`1w` 基准 < `1d`、>4 周期、重复、heights 键不一致/越界、未支持指标） | 400 + 被拒字段名，且不落库 |
| 静默截断反例 | R9（>4 周期后 GET 仍为前置 3 周期） | 不得「截断成 4 后 200」 |
| 预算护栏 | P1–P4（12 含、13 拒；16 ⇒ Err 含 `pane`） | 明确报错 |
| 开关/生命周期 | S4/S5/E4（失败回退、退订、往返零残留、静默窗计数不变） | 零残留 |
| DOM 等价 | E1/E3（指纹、透传） | 逐节点一致 |
| 缺失依赖（红阶段） | 前端 `Cannot find module`；Rust `E0432` | 逐用例/单目标 red |

---

## 7. 覆盖目标与**未覆盖项**（诚实声明）

**覆盖目标**：P1 的三条被指派面 100% 落成可运行用例：T6（HTTP 15 例 + 纯函数 4 例）、T8bis（1 例）、T11（前端 8 例）。

**口径假设（本测试为唯一契约，实现方若有异议请先报价变更而非改断言）**：

| # | 假设 | 理由 |
|---|---|---|
| (a) | GET 默认**只锁结构**（`enabled=false`、单个**合法**基准周期、基准高度 **420**、`["dcap"]`），**不钉**基准周期字面量 | 任务书只写「`periods=[基准]`」；`02-spec.md` §2 示例首元素为 `1m`、§6 默认基准 420 ⇒ 基准字面量属实现可选项，避免把未裁决口径钉死 |
| (b) | 关闭态**允许至多 1 次** `GET /api/config/multi_period` | 配置落服务端（口径 12）⇒ 前端必须读一次；该读取不产生任何 K 线/WS 副作用（K 线/订阅仍要求与现状**完全一致**） |
| (c) | 总 pane > 12 **在 v1 无法经 HTTP 表达**（`indicators ⊆ {dcap}` ⇒ 上限 4）⇒ 护栏锚定为 `web::dto` 纯函数契约（P1–P4） | 任何 >12 的 body 会先被「未支持指标」规则拒掉（错误字段名会是 `indicators`），无法隔离出 pane 预算判定。**P2 起「受支持指标集合」扩张后必须补 HTTP 级负例** |
| (d) | `enabled=true` 的 PUT/GET 往返**本轮不落断言** | 与本报告同库的线上 app 读同一个 `app_config`；若残留 `enabled=true` 行，多周期上线后会改变线上启动行为。故本文件所有落库写入一律 `enabled=false`，或「坏值 ⇒ GET 回默认关闭」。**P2 在隔离实例上补 `enabled=true` 往返** |
| (e) | T11「DOM 等价」= `[data-region="main-chart"]` 子树结构指纹；**不含 toolbar** | P1/§7.1 要求 toolbar 出现「多周期」开关 ⇒ 整页逐字节等价不可满足；图表区等价才是「关闭态回现状」的实质。开关另以「默认 `aria-pressed=false`」约束 |
| (f) | 容器 `enabled=false` 必须**透传 children（零包裹层）** | 实施计划 P1 原文「`enabled=false` 时 DOM/行为与现状**逐字节等价**」 |
| (g) | 「坏 JSON」以**形状非法/标量**表达 | `app_config.value` 为 `jsonb` ⇒ **语法非法 JSON 无法入库**；等价物为「非对象标量 / 字段类型错 / 缺字段」（与 `dcap_config_or_default` 的既有回退口径一致） |

**未覆盖（明确不做）**：卫星实例与隐藏 K 线（T2）、跨图同步/重入抑制/barSpace 锚定（T3/T4，P3）、LIVE 段（T5/P4）、
像素级渲染取证（T10/G4）、总预算 G3 的 WS/HTTP 计数（T8/P2）、布局持久化（T9/P5）、失败可见与退避（T12/P5）、
「多周期仅在单图模式可用」的宫格侧交互（P2+；本轮只验关闭态）。

**运行注意（红阶段）**：`crates/web/tests/multi_period_pane_budget.rs` 引用的三符号尚未落地 ⇒ **`cargo test -p web`（整 crate）会编译失败**；
红阶段取证/开发一律用单目标 `--test <name>`（证据见执行报告 §3.3）。实现落地 `web::dto` 三符号后即恢复。

---

## 8. 交付物与指纹（sha256）

| 文件 | 类型 | sha256 |
|---|---|---|
| `crates/web/tests/api_multi_period_config.rs` | 红测试（新增，HTTP 配置面 15 例） | `1bf04224861419d37a0e726d24e3b0a1b45be3efd5693c830541a1e0635b92b9` |
| `crates/web/tests/multi_period_pane_budget.rs` | 红测试（新增，总 pane 护栏 4 例；红阶段编译失败） | `4780f7306ca4250fa966c13f6697b6f79076ab52d047946404b9cd2001807a8d` |
| `web/src/features/dashboard/multiPeriodStore.test.ts` | 红测试（新增，store/T8bis/T11 5 例） | `d08522af6e0b86c3e67eedd800265695f0dd6f80112eee05d8da083ee2a50ee4` |
| `web/src/features/dashboard/multiPeriodClosedEquivalence.test.tsx` | 红测试（新增，T11 页面/容器 4 例） | `d76ee3a14ded39c61b436fb24cbb06c3791a05d0f38e18ec2d6f2b5b38aa3284` |

**仅测试与测试证据**：4 个新增测试文件 + `tester/evidence/263_p1a_multiperiod_config_red/**` + 本报告 + 执行报告。
生产代码/接口/架构**零改动**；`git` **无 staged**；线上进程未触碰。

VERDICT: RED-READY（28 例：前端 9 红 + Rust HTTP 14 红 / 1 绿（库卫生自检）+ Rust 纯函数 4 例编译失败红；既有 617 例前端零回归、`tsc -b` 通过；详见执行报告）
