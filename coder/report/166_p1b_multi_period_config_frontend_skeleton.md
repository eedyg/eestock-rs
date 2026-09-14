# 166 — P1-B 多周期配置面（三层）+ 前端骨架（enabled=false 与现状等价）

- **本报告位置**：`coder/report/166_p1b_multi_period_config_frontend_skeleton.md`
- **类型**：Coder change report（实现 + 自测）
- **仓库 / 提交**：`/home/eestock/workspace/git/eestock/eestock-rs` @ `d6462da`（工作区改动；**无 staged / 无 commit**）
- **权威依据**：`design/15-multi-period/01-adr.md`（ADR-022 口径 2/5/9/10/11/12）、`02-spec.md`（§2 配置 7 校验、§6 布局、§7 护栏、§9 可观测性）、`03-test-plan.md`（T6/T8bis/T11）、`04-implementation-plan.md` P1
- **前置（未改动）**：P1-A 红测试 4 文件（sha256 与 `tester/design/263_*` 逐一相符，见 §6）
- **证据目录**：`coder/evidence/166_p1b_multi_period/`

---

## 1. 改动文件清单（显式区分 tangle 生成物 / 手写）

### 1.1 tangle 生成物（**doc-first**：改 `design/07-app-plane/00-web-api.md` 对应 block → /tmp 沙箱重生成 → 只拷回这 3 个目标文件）

| 文件 | 性质 | 改动 | 改动来源（文档哪一块） |
|---|---|---|---|
| `design/07-app-plane/00-web-api.md` | **事实源（tangle 源文档）** | +177 行 | 三个 `file=` block 内：`dto.rs` block（多周期 DTO/常量/校验/读落韧性）、`rest.rs` block（GET/PUT handler）、`lib.rs` block（路由注册） |
| `crates/web/src/dto.rs` | **生成物** | +145 行 | 上述 `dto.rs` block |
| `crates/web/src/rest.rs` | **生成物** | +30 行 | 上述 `rest.rs` block |
| `crates/web/src/lib.rs` | **生成物** | +2 行 | 上述 `lib.rs` block |

生成物由 `/~ begin <<design/07-app-plane/00-web-api.md#...>>[init]` 标记，**禁止手改**；本轮全部经沙箱重生成得到，未手改。

### 1.2 手写文件（非 tangle）

| 文件 | 性质 | 改动 |
|---|---|---|
| `web/src/features/dashboard/multiPeriodStore.ts` | **新增** | 109 行（运行态 store：enabled/periods/heights/indicators/syncDegraded/lastSpanDiffMinutes + load/setEnabled/applyServerConfig/dispose） |
| `web/src/features/dashboard/MultiPeriodChartStack.tsx` | **新增** | 22 行（容器；`enabled=false`/尚无卫星 ⇒ 透传 children） |
| `web/src/api/types.ts` | 手写 | +11 行（`MultiPeriodConfigDto`） |
| `web/src/api/client.ts` | 手写 | +8 行（`getMultiPeriodConfig` / `saveMultiPeriodConfig`） |
| `web/src/api/mock.ts` | 手写 | +67 行（默认 + 同构校验 + 内存态 + 两方法） |
| `web/src/features/dashboard/DashboardPage.tsx` | 手写 | +69/−16（接线 store + 开关乐观更新 + 包裹容器） |
| `web/src/features/dashboard/Toolbar.tsx` | 手写 | +13 行（「多周期」开关入口，可选 props，默认 `aria-pressed=false`） |

合计：9 个已跟踪文件 `+506/−16`，另 2 个新增文件（131 行）。`design/15-multi-period/{02-spec,03-test-plan}.md` 的 `M` 状态为 **P1-A 既有**，本轮未触碰。

---

## 2. 架构分层对齐

| 变更 | 层 | 说明 |
|---|---|---|
| `dto.rs` 纯函数（`MultiPeriodConfigDto` / `validate_multi_period_config` / `multi_period_pane_count` / `verify_multi_period_panes` / `multi_period_config_or_default`） | Presentation / web 线格式 | 形状与 `DcapConfigDto` 完全一致（纯函数校验 + serde DTO）；**不引入新端口/依赖** |
| `rest.rs` GET/PUT handler | Presentation / web | 走**既有** `ConfigStore`（`app_config`，key=`multi_period`，迁移 0021，**无需新迁移**，先例 `kline`/`dcap`） |
| `lib.rs` 路由 | Presentation / web | 新增 `GET/PUT /api/config/multi_period`，与 MA/dcap 同构 |
| `multiPeriodStore.ts` | 前端运行态 | 与既有 `DashboardStore` 并列；`useSyncExternalStore` 绑定；**不持数据流**（不订阅 WS、不发 K 线请求） |
| `MultiPeriodChartStack.tsx` | 前端容器骨架 | P1 只做透传/隔离；卫星实例属 P2 |
| `client/types/mock` | 前端 API 契约 | 与后端 DTO 同构镜像（mock 校验同后端口径） |

未触碰：引擎/ABI、dcap 口径、`state.rs`（复用既有 `config` 字段，无需扩展）、任何 tangle 之外的分层边界。

---

## 3. 解决的问题 / 新增能力

1. **服务端配置面**：`GET/PUT /api/config/multi_period`，落既有 `app_config`（key=`multi_period`）。GET：无键/坏 JSON/类型错/缺字段/越界旧值 ⇒ 200 回默认（`enabled=false` + 单基准 + 高度 420 + `["dcap"]`，**绝不 500**）。PUT：严格 400，错误信息含被拒字段名（`periods`/`heights`/`indicators`），**拒绝时绝不落库/不回显被截断配置**。
   - 校验（`02-spec` §2 七条）：①基准 ∈ {1m,5m,15m,1h,1d,1w}；②卫星 ≥ 基准且不含 `1mo`；③含 `1w` ⇒ 基准 ≥ `1d`；④总周期 ≤4；⑤`heights` 键 = `periods` 且每值 ∈ [80,1200]；⑥`indicators ⊆ {dcap}`；⑦周期去重。
   - 护栏（§7.4）：总 pane ≤12（`1 + Σ_卫星(指标数)`），超限**明确 Err 拒绝保存**（错误含 `pane`，不静默截断）。
2. **前端骨架**：`multiPeriodStore`（配置态 + T8bis 可观测字段占位）+ `MultiPeriodChartStack`（P1 无卫星实例）+ Toolbar 最小「多周期」开关（乐观更新 + 失败回滚，照 MA/dcap）。
3. **`enabled=false` 与现状逐字节等价**（本轮最重要约束，见 §5/§7）。`enabled=true` 但尚无卫星周期 ⇒ 仍单图，无空卫星/报错。

---

## 4. 实现要点（架构内的关键决策）

- **校验顺序**：`periods` 去重（check 7）**先于** `heights` 键一致性（check 5）——因为「重复周期」用例的 `heights` 会因对象键覆盖而与 `periods` 长度不符；先查重可保证错误字段名是 `periods`（P1-A 断言要求）。
- **错误体形状**：`{"error": msg}`（复用既有 `err(400, msg)`），**不含**任何配置字段 ⇒ 满足「拒绝不静默截断/不归一化」断言。
- **PUT 用 `Json<serde_json::Value>` + `from_value`**（照 dcap）⇒ 形状非法时返回 **400**（而非 axum 缺字段的 422）。
- **容器零包裹层**：`MultiPeriodChartStack` 返回 `<>{children}</>` ⇒ DOM 指纹逐字节不变（T11）。
- **store 不持数据流**：`load()` 只镜像服务端配置；`setEnabled()` 同步乐观更新，关闭时运行态字段归零；服务端读写由 DashboardPage 的开关 handler 负责（乐观更新 + 失败回滚），与既有 `saveMaWindows`/`saveDcapParams` 同一写法。
- **P2 预留**：容器内注有 P2 挂载卫星的位置注释；store 已含 `syncDegraded`/`lastSpanDiffMinutes`（P2/P3 读出）。

---

## 5. 测试覆盖

**未新增/未修改任何既有测试**（只允许加强；本轮不新增断言面，全部复用 P1-A 红测试）。

红测试转绿（P1-A 4 文件，sha256 **逐一未变**，见 §6）：

| 测试文件 | 用例数 | 红（P1-A） | 绿（本轮） |
|---|---|---|---|
| `crates/web/tests/api_multi_period_config.rs` | 15 | 14 红（404）+ 1 绿（库卫生） | **15 全绿** |
| `crates/web/tests/multi_period_pane_budget.rs` | 4 | 编译失败（`E0432` 三符号缺失） | **4 全绿** |
| `web/src/features/dashboard/multiPeriodStore.test.ts` | 5 | 5 红（`Cannot find module`） | **5 全绿** |
| `web/src/features/dashboard/multiPeriodClosedEquivalence.test.tsx` | 4 | 4 红（模块缺失） | **4 全绿** |

既有回归：前端 **617 → 626**（+9 红测试转绿，68 文件全绿）；后端 `cargo test -p web` 全绿。

---

## 6. 沙箱重生成 + 门禁 + 既有生成物 sha256 零变化证据

### 6.1 沙箱重生成（**未在仓库内跑 tangle**）

```
$ rm -rf /tmp/mp1/sbx && mkdir -p /tmp/mp1/sbx
$ cp -a entangled.toml /tmp/mp1/sbx/ && cp -a design /tmp/mp1/sbx/design
$ cd /tmp/mp1/sbx && entangled tangle -f      # 全量重生成（沙箱内，--force 仅出现在隔离副本）
... WARNING conflicts found, but continuing anyway ...   （沙箱无 filedb，属预期）
$ # 与仓库逐字节比对，并**只拷回**被改动的 3 个目标文件：
DIFF: crates/web/src/dto.rs
DIFF: crates/web/src/lib.rs
DIFF: crates/web/src/rest.rs
$ cp -a crates/web/src/{dto,lib,rest}.rs /home/eestock/.../eestock-rs/crates/web/src/
```

### 6.2 门禁 `./scripts/check-tangle.sh` → **exit=0**

```
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
exit=0
```
（证据：`coder/evidence/166_p1b_multi_period/check_tangle.txt`）

### 6.3 既有生成物 **sha256 零变化**（141 个 `file=` 目标中 139 个当时存在）

```
$ # baseline（改动前）vs after（拷回后），逐文件 sha256 清单 diff：
93,95c93,95
< d6bb8be...  crates/web/src/dto.rs      → 3736511...  crates/web/src/dto.rs
< fdb0230...  crates/web/src/lib.rs      → cefedb8...  crates/web/src/lib.rs
< bf3a4ff...  crates/web/src/rest.rs     → 22bfb3b...  crates/web/src/rest.rs
---
total generated targets: 139  changed: 3  unchanged: 136
```
**仅 3 个预期目标变化，其余 136 个既有生成物 sha256 逐字节零变化。**
（证据：`coder/evidence/166_p1b_multi_period/sha256_zero_change.txt`、`final_generated_sha256.txt`）

### 6.4 P1-A 红测试文件 sha256 未变（未篡改断言）

```
1bf0422...  crates/web/tests/api_multi_period_config.rs          （= 263 设计报告）
4780f73...  crates/web/tests/multi_period_pane_budget.rs          （= 263 设计报告）
d08522a...  web/src/features/dashboard/multiPeriodStore.test.ts   （= 263 设计报告）
d76ee3a...  web/src/features/dashboard/multiPeriodClosedEquivalence.test.tsx（= 263 设计报告）
```

---

## 7. 「`enabled=false` 与现状等价」证据（DOM / 请求 / 订阅计数）

由 `multiPeriodClosedEquivalence.test.tsx` 4 例锁定（全绿）：

- **DOM 结构等价（E1）**：`[data-region="main-chart"]` 子树结构指纹 == 现状冻结指纹
  ```
  0:div[data-region=main-chart]
  1:div[data-region=sub-chart]
  1:div[data-testid=kline-chart]
  ```
  ⇒ 容器不得新增任何包裹元素（实现为 `<>{children}</>` 透传）。
- **记账等价（E2）**：`klinecharts.init` 恰 **1** 次；`bar:` 订阅恰 **`["bar:518880:15m"]`**；`getKline` 恰 **1** 次（period=`15m`）；`quote` 订阅 1 个；`getMultiPeriodConfig` ≤1 次（配置读取本身不产生 K 线/WS 副作用）。
- **容器透明（E3）**：`MultiPeriodChartStack(enabled=false)` 渲染 `container.innerHTML === '<div data-sentinel="1"></div>'`；`init`/`dispose` 零调用。
- **零残留（E4）**：页面无任何 `satellite|卫星` 属性/值；120ms 静默窗内请求/订阅/实例数不变；「多周期」开关默认 `aria-pressed=false`。

---

## 8. 验证命令与输出

| 命令 | 结果 | 证据 |
|---|---|---|
| `cd web && npx tsc -b` | **exit=0** | `frontend_tsc_vitest_full.txt` |
| `cd web && npx vitest run`（全量） | **68 文件 / 626 通过（0 失败）** | 同上 |
| `cd web && npx vitest run multiPeriod*` | 2 文件 / **9 通过** | `vitest_red_to_green.txt` |
| `cargo test -p web` | **全绿**：lib 49 + `api_multi_period_config` 15 + `multi_period_pane_budget` 4 + `api_*` 系列（admin 3 / alerts 3 / favorites 2 / kline_period 1 / ma_config 1 / quality 1 / rest 2 / settings 6 / strategies 9 / workbench 6）+ ws_poller 1 | `cargo_web_tests.txt` |
| `./scripts/check-tangle.sh` | **exit=0** | `check_tangle.txt` |
| DB 残留检查 `SELECT count(*) FROM app_config WHERE key='multi_period'` | **0**（收敛「无键=默认关闭」） | 本报告 §9 |
| 线上进程 `PID 3112540` | 仍在运行（`./target/debug/eestock-app`），**未重启/未写** | 本报告 §9 |

---

## 9. 硬约束遵守

- **禁 tangle（仓库内）**：✅ 只在 `/tmp/mp1/sbx` 沙箱重生成，只拷回 3 个目标文件。
- **禁 git add/commit/stash**：✅ `git diff --cached --name-only` 为空（无 staged）。
- **不重启线上（PID 3112540）**：✅ 仅只读 `ps` 确认存活。
- **0 写请求（线上）**：✅ 全部测试只打 `127.0.0.1:0` 临时 axum 实例 + 本地 dev DB（:5433）；线上 HTTP 零请求。
- **临时实例/端口全拆**：✅ 测试进程自建 `127.0.0.1:0`，随测试结束退出；无残留。
- **不扩大范围**：✅ 不做卫星实例（P2）/跨图同步（P3）/LIVE 段（P4）；不改 dcap 口径；不改 ABI/引擎。

---

## 10. 残留风险 / 观察项

1. **共享 dev DB（:5433）与线上 app 同库**（P1-A 既有设计，非本轮引入）：`api_multi_period_config.rs` 会写 key=`multi_period`，但**全部写入 `enabled=false`** 且每例收尾清除；实测残留 `count=0`。即使异常残留，GET 回默认 `enabled=false` ⇒ 不改变线上行为。
2. **`indicators` 去重**：`02-spec` §2.6 提「去重」，实现取**集合成员校验**（重复项无害、不报错、不归一化）。无红测试覆盖该细项；若 P2 需严格去重归一，请另开断言。
3. **`enabled=true` 往返未落断言**（P1-A 设计报告 §7(d) 诚实声明）：本轮按惯例只落 `enabled=false`（避免影响线上默认）；P2 在隔离实例补。
4. **总 pane >12 无法经 HTTP 表达**（v1 `indicators ⊆ {dcap}`）：护栏锚定为 `web::dto` 纯函数契约（P1–P4 用例）；P2 扩张指标集合后须补 HTTP 级负例（P1-A 已声明）。
5. **Toolbar 开关在宫格模式的隐藏/强制关闭**（§7.1）留待 P2（本轮仅提供最小开关入口，未加单图限制）。

---

VERDICT: GREEN

（P1-A 红测试 28 例中可编译面全部转绿：前端 9 + Rust 纯函数 4 + Rust HTTP 15；`tsc -b`=0、`vitest` 626、`check-tangle`=0、`cargo test -p web` 全绿、既有生成物 sha256 零变化、`enabled=false` 等价由 DOM 指纹 + 记账计数锁定。）
