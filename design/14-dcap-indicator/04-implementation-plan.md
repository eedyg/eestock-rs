# dcap 指标 — 实施计划（TDD 分期与派单）

> 依据：`01-adr.md`（ADR-021）、`02-spec.md`（契约）、`03-test-plan.md`（TDD 规格）。
> 纪律：**Red → Green → Refactor**；每个 Phase 的测试先由 tester 独立写/验，再交 coder 最小实现；架构师只审 diff 与口径，不写码、不写测试。

---

## 0. 前置事实（已核实，避免踩坑）

| 事实 | 依据 | 影响 |
|---|---|---|
| `design/` 文档 → 代码为**现行单向机制**，语法 ` ``` {.<lang> file=<path>} ` | `design/06-web/*.md` → `web/src/layouts/*Grid.tsx` | 本方案沿用，无新机制 |
| 仅有 **8 个 `web/src/layouts/*Grid.tsx`** 是生成物；`Toolbar.tsx` / `KlineChart.tsx` 是手写 | `grep -rho "file=web/src/…" design/` | 手写文件可直接改；**`DashboardGrid.tsx` 是生成物，改它必须改 `design/06-web/01-dashboard.md` 再 tangle** |
| **JS 是 Entangled 内置语言**（2.4.3：`config/language.py:46` 已含 `["javascript","js","ecma"]`），本仓只是**从未产出过 js 文件** | 独立核验 2026-09-13（`entangled-cli` 源码） | **无需改 `entangled.toml`**（ADR-021 D3）；但 `{.js file=}` 首用需一次机制验证（P0） |
| 配置先例分两条（**别混**）：形状 = MA（`dto.rs` 校验 + `rest.rs` 端点）；落库 = `/api/config/kline`（`app_config`，迁移 0021，key 自由文本无白名单）。MA 自己走的是 `ma_config`（迁移 0015） | `crates/web/src/dto.rs:41-53`、`rest.rs:362/365`、`crates/storage/src/ma_config.rs:25`、`config_store.rs:21/34`、`migrations/0021_app_config.sql`、`crates/web/src/settings.rs:72-75` | dcap 走 **ConfigStore/app_config**，照 kline 先例 ⇒ **无需新迁移** |
| `IndicatorName` 类型派生自 `DASHBOARD_DEFAULTS.indicators` | `web/src/features/dashboard/Toolbar.tsx:6` | 生成物里加 `dcap: false` 后类型自动扩展 |
| 播种集 = 7 参考插件 + 4 模板 = **11**，且 `reference_plugins()` **顺序被硬编码守护** | `crates/application/tests/strategy.rs:737`、`crates/strategy-core/src/reference.rs:110-118` | 加入 dcap ⇒ 两处测试必须同步改 |
| `gh` CLI 未安装 | `which gh` 空 | GitHub issues 以**草案文件**交付（见 `05-issue-drafts.md`） |

---

## 1. 交付物清单（文件级）

### 新增
| 路径 | 类型 | 负责 |
|---|---|---|
| `design/14-dcap-indicator/01-adr.md` … `05-issue-drafts.md` | 文档（事实源） | **架构师（本次已产出）** |
| `design/14-dcap-indicator/02-spec.md` 内的 CORE 块（两个 `file=` 块） | 文档块 | coder 写入（docs-as-source） |
| `web/src/features/indicators/dcap.ts` | **生成物** | `entangled tangle` |
| `crates/strategy-core/reference-plugins/dcap.js` | **生成物** | `entangled tangle` |
| `web/src/features/indicators/dcapIndicator.ts` | 手写（klinecharts 注册/figures/副图） | coder |
| `web/src/features/indicators/DcapParamsPanel.tsx` | 手写（Toolbar 内联参数面板，形态照 MA windows） | coder |
| `crates/web/src/dto.rs` 内 `DcapConfig` + `validate_dcap_config` | 手写 | coder |
| 测试文件（Rust + 前端） | 手写 | **tester** |

### 改动
| 路径 | 改动 | 备注 |
|---|---|---|
| ~~`entangled.toml`~~ | **不改**（JS 是内置语言，ADR-021 D3） | — |
| `crates/strategy-core/src/reference.rs` | `reference_plugins()` 加第 8 条 `dcap` + `include_str!` | 顺序测试同步 |
| `crates/application/tests/strategy.rs` | 播种计数 11 → 12 | 断言改名 |
| `crates/application/tests/simlive.rs` | 若依赖清单长度/顺序，同步 | tester 确认 |
| `crates/web/src/rest.rs` + `lib.rs` | `GET/PUT /api/config/dcap` 路由与处理器 | 照 MA 三层 |
| `web/src/features/dashboard/Toolbar.tsx` | 指标列表加 DCAP + 参数面板入口 | 手写 |
| `web/src/features/dashboard/KlineChart.tsx` | 注册 DCAP 副图 + `precision: 5` + 取数 warmup | 手写 |
| `design/06-web/01-dashboard.md` → `web/src/layouts/DashboardGrid.tsx` | `DASHBOARD_DEFAULTS.indicators` 加 `dcap: false` | **生成物，必须改文档** |
| `design/07-app-plane/00-web-api.md` | 增两行端点契约 | 事实源 |
| `design/12-strategy-system/04-strategy-programming-guide.md` | dcap 章节 + 参数表 + 用法示例 | 编程手册（编译期内嵌） |
| `design/99-decisions-log.md` | 登记 ADR-021 | 索引 |

---

## 2. 分期

### P0 — 机制验证（只验不改；先做，风险最先暴露）
1. **不改** `entangled.toml`（JS 是内置语言，ADR-021 D3）；
2. 用**最小占位块**（一个 `{.js file=…}` 块产出 1 行注释）验证：`tangle` 能生成、`check-tangle.sh` 能检出漂移、且**不引入 ADR-018 的"假绿"**（冲突仍 exit=0 的旧失败模式回归）。
- **验收**：T9 全绿。
- **理由**：先证机制再写业务代码，避免"写完 300 行才发现门禁对 js 产物无效"；验证不通过时**回退信号明确**（退回宿主侧实现需另起 ADR）。

### P1 — CORE 内核 + 双产物（TDD 核心）
1. tester 先落 **T1/T2/T4** 失败测试（黄金样本 + 跨运行时）；
2. coder 在 `02-spec.md` 写两个 `file=` 块（CORE 区间逐字节相同），跑 `entangled tangle` 生成两个产物；
3. tester 落 **T3 镜像体断言**；
4. 重构在测试保护下进行（可读性/命名）。
- **验收**：T1–T4 绿；CORE 满足 §0 浮点铁律（无 `pow`、无增量累加）。
- **派单**：coder（实现） + tester（测试与交叉验证，独立于 coder）。

### P2 — 插件（ABI 完整 + 播种）
1. coder 补 `PARAMS_SCHEMA` / `init` / `on_bar` / `save` / `load`（包装层，在 CORE 哨兵之外）；
2. tester 落 **T5/T6/T7/T12**；
3. `reference.rs` 加条目 + 两处既有测试同步（11→12、顺序 7→8）。
- **验收**：T5–T7、T12 绿；重放分叉测试（T7）必须真红过一次（故意漏 `save` 一个字段验证断言有效）。
- **注意**：该文件一旦播种即 sha256 冻结历史；**P2 之后不得再改内容而不加版本**。

### P3 — 前端图表与配置
1. 生成物 `dcap.ts` 落位；coder 写 `dcapIndicator.ts`（`registerIndicator`，**副图 + `precision: 5`**）与参数面板；
2. `design/06-web/01-dashboard.md` 改 `DASHBOARD_DEFAULTS` → tangle → `DashboardGrid.tsx`；
3. 后端 `GET/PUT /api/config/dcap`（dto 校验 + rest + `config_store` key=`dcap`）+ 前端读取韧性（重试/focus 重读）；
4. 取数 `limit = viewport_bars + (n_l + m − 1)`；
5. tester 落 **T8（含截图与性能）/T10/T11**。
- **验收**：T8/T10/T11 绿；`0.0048` 显示截图留证；600 根 + `n_l=250` + `m=60` 单次计算 < 16 ms（否则回到设计：缓存或降采样）。

### P4 — 文档收口
编程手册 dcap 章节、`00-web-api.md` 端点行、`99-decisions-log.md` 登记、`02-spec.md` 与实现一致性复核（`./scripts/check-tangle.sh` 绿）。
- **验收**：QA checklist（`03-test-plan.md` §2）逐条打勾。

### P5 — 有效性验证（**独立任务，不阻塞 P0–P4**）
按 `03-test-plan.md` §3 的 SWEEP 纪律执行（IS 前 70% 冻结参数 → OOS 一次性裁决 → 双跑 sha256 一致）。**明确先验**：`r=1` 已是遗留 DCAP（15m 捕获弱），增量只在 `r` 接近 1 的区间。

---

## 3. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 两份产物**浮点不逐位一致**（`pow` 或增量累加） | 高 | §0 铁律写进 spec 契约；T4 必须含 `r≠1` 样例；code review 检查点 |
| 首次产出 js 生成物时门禁出假绿 | 中 | P0 机制验证（只验不改）+ ADR-018 假绿回归用例 |
| `DashboardGrid.tsx` 手改违 ADR-007 | 中 | 计划中显式标注"生成物，必须改文档"；check-tangle 兜底 |
| 播种集变更打破既有测试 / MCP 体积再增 | 低 | T12 显式覆盖；体积列为已知债务（不新增通道） |
| 前端渲染精度坑（**默认 `precision = 4`**：`0.004578…` 丢第 5 位） | 中 | 显式 `precision: 5`；T8 留 4 位/5 位对比截图（`0.0048` 在 5 位下渲染为 `0.00480`） |
| 性能：600 根 × `n_l+m` 每帧重算 | 中 | T8 性能门槛；超限则退回"生成时算一次 + 视口切片"方案（需架构裁决） |

---

## 4. 提交与验收流程（沿用项目既有流程）

1. coder 实施 → **架构师亲审 diff**（重点：CORE 是否逐字节一致、浮点铁律、是否越界改了 ABI/引擎）；
2. tester 独立验收（T1–T12 + QA checklist）；
3. findings 立项裁决（MAJOR → 回改 spec/ADR 再实施）；
4. 统一 commit（`feat:` 与 `docs:` 分笔）；`git add crates/` 时剔除 tester 夹具（`zz_tester_*.rs`）；
5. 需要上线时按既有部署/核验流程（8081/8082，部署后 `cargo build --bin eestock-app` 空跑证明部署二进制 == HEAD）。

---

## 5. 本计划**明确不做**（防止范围蔓延）

- 不改插件 ABI（`clamp_score` / `SCORE` 契约 / `ParamKind` 均不动）；不加数组或 bool 参数类型；
- 不改 `aggregate` / `classify` / 60-40 阈值 / `NEUTRAL_SCORE`；
- 不改 `ExecutionPolicy`（不加 `DcaMode::Geometric`，不按 r 下单）；
- 不动 `GET/PUT /api/config/ma`；
- 不在 run 结果（`per_bar`）里新增 raw 值字段（留痕用 `ctx.log` 兜底）；
- 不做锚定式（实盘定投计划）跟踪 —— dcap 是**纯滚动指标**。
