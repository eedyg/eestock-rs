# dcap 指标 — 派单草案（GitHub issues）

> ⚠️ 交付形式说明：本机 **未安装 `gh` CLI**（`which gh` 为空），无法自动建 issue。
> 以下为可直接粘贴的 issue 草案（标题 / 标签 / 正文 / 验收）。要自动建单，请先安装并登录 `gh`（`gh auth login`），届时可一键导入。
> 依赖顺序：**#1 → #2 → #3 / #4 → #5 → #6（独立）**。

---

## #1 [chore] 验证 entangled 对 js 产物的门禁有效性（无假绿）

**labels**: `area/tooling`, `phase/P0`
**背景**：ADR-021。**JS 是 Entangled 2.4.3 的内置语言**（`config/language.py:46` 已含 `["javascript","js","ecma"]`）⇒ **`entangled.toml` 无需任何修改**；但本仓**从未产出过 js 文件**，故首次使用前必须验证门禁对 js 有效。
**范围**
- 用最小占位块（`{.js file=<临时路径>}`）验证：`entangled tangle` 能生成该文件、`./scripts/check-tangle.sh` 能检出其漂移（**双向**：改文档不 tangle / 改产物不回写文档）
- 回归 ADR-018 的"假绿"用例（冲突仍 exit=0 的旧失败模式），确认新产物类型不引入假绿
- 验证后删除占位产物与临时文件，保证工作树干净
**验收**
- 两个方向的漂移都被硬失败捕获（附退出码与输出）
- ADR-018 假绿回归用例通过
- 工作树无残留（`git status --porcelain` 前后一致）
**不做**：不改 `entangled.toml`；不改业务代码；不使用 `tangle --force` 让门禁变绿

---

## #2 [feat] dcap CORE 内核 + 双产物（TDD：T1–T4）

**labels**: `area/indicator`, `phase/P1`, `tdd`
**依据**：`design/14-dcap-indicator/02-spec.md` §1/§3/§4、`03-test-plan.md` §0/T1–T4、ADR-021
**范围**
- **tester 先写失败测试**：T1（`r=1 ≡ 遗留 DCAP`，容差 `1e-12`）、T2（`smooth=0 ≡ 原始`，逐位）、T4（跨运行时逐位，含 ≥5 组 `r≠1`）
- **coder 后实现**：在 `02-spec.md` 写入两个 `file=` 块（`web/src/features/indicators/dcap.ts`、`crates/strategy-core/reference-plugins/dcap.js`），`// === DCAP CORE BEGIN/END ===` 之间**逐字节相同**；跑 `entangled tangle` 生成
- 浮点铁律：**禁 `Math.pow/exp/log`**（`w *= r` 迭代）、**禁增量累加**（每 bar 窗口内同序重算）
**验收**
- T1–T4 绿；T3 镜像体断言绿（含"删哨兵必红"负例）
- CORE 区间逐字节一致（证据：diff 输出为空）
**不做**：不实现 `on_bar` 包装层（#3）；不改 ABI

---

## #3 [feat] dcap 插件（ABI 完整 + 播种）：T5–T7 / T12

**labels**: `area/strategy-plugin`, `phase/P2`, `tdd`
**依据**：`02-spec.md` §5、`03-test-plan.md` T5/T6/T7/T12
**范围**
- 包装层：`PARAMS_SCHEMA`（9 参数，含 `n_s<n_m<n_l`）、`init`、`on_bar`（数据不足 → 50）、`save`/`load`（三滚动窗 + 三 SMA 尾窗）
- `crates/strategy-core/src/reference.rs` 加第 8 条 + `include_str!`
- 既有测试同步：播种计数 11 → 12、`BUILTIN_ORDER` 追加 `dcap`
**验收**
- T5（参数负例，含 `smooth=0` 时 `m` 仍须校验）、T6（首次有值位置按 `n_i+m−1` 逐线）、T7（**故意漏一个状态字段时必须红**）、T12 绿
- 双跑 sha256 一致（重放确定性）
**不做**：不改 `clamp_score`/`aggregate`/`classify`/`ExecutionPolicy`；不按 r 下单

---

## #4 [feat] dcap 前端副图 + 参数面板 + 取数 warmup：T8 / T10

**labels**: `area/web`, `phase/P3`, `tdd`
**依据**：`02-spec.md` §6、`03-test-plan.md` T8/T10
**范围**
- `web/src/features/indicators/dcapIndicator.ts`：`registerIndicator` 自定义**副图**指标，名 `DCAP`，3 figure（s/m/l），**`precision: 5`**，`calcParams=[n_s,n_m,n_l,r_s,r_m,r_l,smooth,m]`
- `Toolbar.tsx` 指标列表加 DCAP（**默认关**）+ 参数面板（形态照 MA windows）
- `design/06-web/01-dashboard.md` 改 `DASHBOARD_DEFAULTS.indicators` → `entangled tangle` → `DashboardGrid.tsx`（**生成物，禁止手改**）
- 取数 `limit = viewport_bars + (n_l + m − 1)`（多取部分仅供计算）
**验收**
- T8：**精度对比双向截图**——不设 precision（默认 4 位）下 `0.004578…` 丢第 5 位（→ `0.0046`）vs `precision: 5` 下 `0.00458`；`0.0048` 在 5 位下渲染为 `0.00480`；数据不足断线不抛异常；三线 + 副图独立 Y 轴；`0.00048` 折叠形态记录；600 根 / `n_l=250` / `m=60` 单次 < 16 ms
- T10：加 warmup 后视口最左根有值
**不做**：不动 MA 配置；不叠主图

---

## #5 [feat] dcap 配置 API + 前端读取韧性：T11

**labels**: `area/web`, `area/api`, `phase/P3`, `tdd`
**依据**：`02-spec.md` §7、`03-test-plan.md` T11
**范围**
- 照 MA 三层：`crates/web/src/dto.rs`（`DcapConfig` + `validate_dcap_config`，强制 `n_s<n_m<n_l`）、`rest.rs` + `lib.rs` 路由 `GET/PUT /api/config/dcap`、`storage/config_store.rs`（key=`dcap`；**无需新迁移**）
- 前端 mount 读取重试 + focus 重读（ADR-020 韧性教训）
- `design/07-app-plane/00-web-api.md` 增两行端点契约
**验收**
- T11 绿：无键/坏 JSON → 默认不 500；非法 → 400；读回一致；重读触发可测
**不做**：`th` 不进此接口（属策略参数）；不动 `/api/config/ma`

---

## #6 [docs] dcap 文档收口 + 编程手册章节 + ADR 登记

**labels**: `area/docs`, `phase/P4`
**范围**
- `design/12-strategy-system/04-strategy-programming-guide.md` 补 dcap 章节（参数表、`s`/`m`/`l` 语义、用法示例、数据不足语义）
- `design/99-decisions-log.md` 登记 ADR-021
- `02-spec.md` 与实现一致性复核（`./scripts/check-tangle.sh` 绿）
**验收**
- QA checklist（`03-test-plan.md` §2）逐条打勾；DocSidebar 可见
**不做**：不动 MCP 工具契约（`strategy_list` 体积属既有债务）

---

## #7 [research] dcap 有效性验证（SWEEP IS/OOS）— 独立任务，不阻塞上线

**labels**: `area/research`, `phase/P5`
**依据**：`03-test-plan.md` §3
**范围**
- IS 前 70% 中位数冻结 Top10 → OOS 一次性裁决 → 双跑 sha256 一致
- 参数空间：`r ∈ {1.00,1.02,1.05,1.2}`、`m ∈ {1,3,5,10}`、`smooth` 固定 1
- **必须带入先验**：`r=1` 即遗留 DCAP（`dcap12` 五年领先、`dcap8<−1%` 最强子信号、**15m 阶梯定投捕获 0.088 < 日线 0.207**）
**验收**
- 报告给出"`r≠1` 是否带来 `r=1` 之外的边际"的明确结论（含 IS→OOS 衰减）
**不做**：不因研究结论回改指标口径（口径变更须另起 ADR）
