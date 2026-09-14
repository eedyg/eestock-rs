# P1-C 独立验收执行报告（Tester）

- **本文件路径**：`tester/test/264_p1c_independent_acceptance_execution.md`
- 时间：2026-09-14 20:43–20:48（本地，UTC+8）｜HEAD `d6462da229f9264777e414be827d9d1017600778` **+ 工作树 P1 未提交改动**
- 设计报告：`tester/design/264_p1c_independent_acceptance_design.md`
- 证据目录：`tester/evidence/264_p1c/`
- 纪律：仓库文件**零改动**（`git diff --cached` 空；tracked 改动清单与本轮开始时逐条一致）；未 `git add/commit/stash`；未向线上（PID 3112540，8081/8082）发任何请求（本轮全部请求只打临时实例 `127.0.0.1:18099`，该实例已拆除）；共享库 `app_config` 的 `multi_period` 键**已删除并 psql 复核 `count(*)=0`**（与基线一致：基线即无键）。

---

## 0. 总览

| # | 验收项 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | T6 配置面（§2 七条 + §7.4 + GET 鲁棒 + 边界 4 周期 + 不落库 + 清理） | **部分不通过**（1 条规格项未实现：`indicators` 去重） | §2；`t6_http_responses.txt`、`t6_followup_excerpts.txt` |
| 2 | `enabled=false` 等价性（HEAD 构建 vs 工作树构建） | 通过（2 处差异，均已解释且为规格内新增） | §3；`eq_head_d6462da.json` vs `eq_worktree.json` |
| 3 | 开关行为（乐观更新/回滚/零残留/`enabled=true` 单图） | 通过 | §4；`toggle_behavior.json` |
| 4 | 生成物一致性（check-tangle + 自建沙箱 sha256 全量清单） | 通过 | §5；`check_tangle.log`、`generated_manifest.sha256` |
| 5 | 回归（vitest / tsc / cargo / 线上 0 写） | 通过 | §6 |
| 6 | 反向证据（突变检验） | 通过 | §7 |
| 7 | 卫生与归因 | 通过 | §8 |

**独立复现的实现车道自述数字**：`vitest` 68 files / **626 passed**（一致）；`tsc -b` = 0（一致）；`cargo test -p web` = **103 passed / 0 failed**（含 `api_multi_period_config` 15/15、`multi_period_pane_budget` 4/4，一致）；`check-tangle` exit=0（一致）；既有生成物 139 个中仅 3 个与 HEAD 有差异（我自算清单，见 §5）。

---

## 1. 逐项结论与证据

### 1.1 项 1 — T6 配置面（真实 axum，临时端口 18099，共享 DB 同一键）

启动方式：`./target/debug/eestock-app --config /tmp/p1c/app_p1c.toml`（`listen=127.0.0.1:18099`，`database_url` 同 dev 库；未触碰线上进程）。请求脚本 `t6_probe.py`（自建，19 个用例）。

| 用例 | 期望 | 实测 | 判定 |
|---|---|---|---|
| GET 无键 ⇒ 默认 | 200 `{enabled:false,periods:["1m"],heights:{"1m":420},indicators:["dcap"]}` | 同左 | ✅ |
| §2-1 `periods[0]="1mo"` | 400 含 `periods` | 400 含 `periods` | ✅ |
| §2-1 卫星 `"1mo"` | 400 含 `periods` | 400 含 `periods` | ✅ |
| §2-2 卫星 < 基准（15m→5m） | 400 含 `periods` | 400 含 `periods` | ✅ |
| §2-3 含 `1w` 且基准 `1h` | 400 含 `periods` | 400 含 `periods` | ✅ |
| §2-3 **正向** 基准 `1d` + `1w` | 200 | 200 | ✅ |
| §2-4 周期数 5 > 4 | 400 含 `periods` | 400 `{"error":"periods 最多 4 个，收到 5"}` | ✅ |
| §2-5 `heights` 键缺项 / 多项 | 400 | 400（键一致性强校验） | ✅ |
| §2-5 `height=79` / `1201` | 400 | 400 | ✅ |
| §2-5 边界 `80` / `1200` | 200 | 200 | ✅ |
| §2-6 `indicators=["macd"]` | 400 含 `indicators` | 400 含 `indicators` | ✅ |
| §2-6 `indicators=["dcap","dcap"]`（**去重**） | 去重后落库/读回 `["dcap"]` | **200 且原样落库/读回 `["dcap","dcap"]`（未去重）** | ❌ **D1** |
| §2-7 周期重复 | 400 含 `periods` | 400 含 `periods` | ✅ |
| **边界：v1 最大合法形态 4 周期** | 200 | 200，读回 `periods`/`heights` 完全一致 | ✅ |
| 合法 PUT 读回一致 | 200 且一致 | 200 且一致 | ✅ |
| 负例不落库 | 非法 PUT 后 GET == 上次被接受值 | 一致（`t6_followup_excerpts.txt`：invalid(5 periods) 400 后 GET 仍为 `["1m","5m"]` 配置；DB 行同步复核） | ✅ |
| 请求体形状非法（`heights` 为数组） | 400（不 500） | 400 `multi_period 请求体非法：invalid type: sequence, expected a map` | ✅ |
| GET 坏值①非对象 JSON（SQL 置 `"oops"`） | 200 默认 | 200 默认 | ✅ |
| GET 坏值②越界旧值（`1mo`+height 9999+未支持指标） | 200 默认 | 200 默认 | ✅ |
| GET 坏值③缺字段（`{"enabled":true}`） | 200 默认 | 200 默认 | ✅ |
| §7.4 pane 预算（`["dcap"]×11`，计 23 > 12） | 400 明确报错 | 400 `{"error":"总 pane 数 23 超上限 12（基准 1 + Σ_卫星指标 pane）"}` | ✅（但见 **D2**） |

> 注：`t6_probe.py` 自身标记的 2 个 "ok=false" 已逐条复核为**脚本判据问题**，不是产品缺陷：(a) "11×dcap" 期望错误信息含 `indicators`，实际由 **pane 护栏**拦下（这反而是重要发现，见 D1/D3）；(b) "负例后 GET 仍默认"用例在序列中位于已成功的合法 PUT 之后，GET 自然返回上次被接受值 —— 已用后续定点序列证明"非法 PUT 不改写库"。

**清理复核**：`DELETE FROM app_config WHERE key='multi_period'` → 1 行；`select count(*)` → **0**；随后 `GET` → 200 默认。基线（动手前）同样是 0 行，**收敛一致**。

### 1.2 项 2 — `enabled=false` 等价性（本轮核心）

方法：`git archive HEAD` → `/tmp/p1c/head/web`；工作树 `web/`（config+src）→ `/tmp/p1c/wt/web`；**同一份探针源码**分别运行，dump 后逐字段比对。

| 度量 | HEAD `d6462da` | 工作树（P1） | 判定 |
|---|---|---|---|
| `[data-region=main-chart]` 原始 innerHTML | — | — | **逐字节一致** ✅ |
| `[data-region=sub-chart]` 原始 innerHTML | — | — | **逐字节一致** ✅ |
| main-chart 结构指纹（tag+深度+`data-*`/type/aria） | 3 行 | 3 行，逐行相同 | **一致** ✅ |
| `klinecharts.init` / `dispose` | 1 / 0 | 1 / 0 | 一致 ✅（无卫星实例、无重复 init） |
| WS 订阅 topic 计数 | `{bar:518880:15m:1, quote:1}` | `{bar:518880:15m:1, quote:1}` | 一致 ✅（订阅数、形状、周期全同） |
| `getKline` 调用 | 1 次（`518880/15m`） | 1 次（同） | 一致 ✅（无其它周期取数） |
| 图表桩调用计数 | setStyles 1, subscribeAction 2, setDataLoader 1, setSymbol 1, setPeriod 1, removeOverlay 1, removeIndicator 1, createIndicator 2, getIndicators 1, scrollToRealTime 1 | **完全相同** | 一致 ✅（指标注册与 pane 结构无任何变化） |
| ApiClient 调用计数 | getSymbols 1, getMaConfig 1, getDcapConfig 1, getKlineConfig 1, getKline 1 | **+ getMultiPeriodConfig 1** | 差异 Δ1（见下） |
| 整页 innerHTML 长度 | 8205 | 8518 | 差异 +313 字符（见下） |
| 「多周期」开关存在 | 无 | 有（`aria-pressed="false"`） | 差异 Δ2（见下） |

**差异逐条解释（P1 派单原文要求"任何差异都要解释"）**：

- **Δ1 = 恰好 1 次 `GET /api/config/multi_period`（挂载时）**：这是 `02-spec.md` §2「配置落既有 `ConfigStore`/`app_config`（口径 12）」的**必要读取**，属新增只读请求；不是 K 线请求、不建 feed、不产生 WS/订阅副作用（计数已证）。实现车道等价测试的判据亦显式允许 ≤1 次（P1 关闭态允许的差异）。**判定：规格内允许**，但严格讲"逐字节等价"应表述为"图表面逐字节等价 + 1 次配置读"。
- **Δ2 = Toolbar 新增「多周期」按钮（+ 1 个分隔 span）**：恰 313 字符，落在 toolbar 区域，**不在 `[data-region=main-chart]` 子树内**（该子树逐字节一致）；默认 `aria-pressed="false"`，0 副作用（无请求/订阅/实例）。**判定：派单允许的新控件**（派单明确要求实现"Toolbar「多周期」开关"）。

**不可得项（诚实声明）**：jsdom 无渲染像素，本项给的是**结构化指纹 + 原始 DOM 原文**级证据，非截图；"真实浏览器像素等价"未在本轮覆盖（若要，需 e2e 且 P1 关闭态无写语义）。

### 1.3 项 3 — 开关行为（探针 B，工作树构建）

| 时点 | `aria-pressed` | init | WS topics | getKline | saveMultiPeriodConfig | 卫星节点 |
|---|---|---|---|---|---|---|
| t0 初始 | false | 1 | `{bar:518880:15m:1, quote:1}` | 1 | 0 | 0 |
| t1 点击后（PUT 未决） | **true（乐观更新生效）** | 1 | 同 | 1 | 1 | 0 |
| t2 PUT **失败**后 | **false（回滚生效）** | 1 | 同 | 1 | 1 | 0 |
| t3 PUT 成功后（`enabled=true`、单周期） | true | **1（仍单图）** | 同 | 1 | 2 | 0（无报错、无空卫星） |
| t4 再点击关闭后 | **false，零残留**（init/WS/图表调用序列与 t0 完全一致） | 1 | 同 | 1 | 3 | 0 |

PUT 报文形状（t1 捕获）：`{"enabled":true,"periods":["1m"],"heights":{"1m":420},"indicators":["dcap"]}` ✅。

### 1.4 项 4 — 生成物一致性

- `./scripts/check-tangle.sh` → `[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）`，**exit=0**（`check_tangle.log`）。
- **自建沙箱独立重生成**（`/tmp/p1c/sbx`，只读比对）：沙箱产出**139** 个生成文件；与工作树逐文件 sha256 比对 → **identical 139 / differs 0 / missing 0**；全量清单 `generated_manifest.sha256`（139 行，我自己算的）。
- 相对 HEAD 的生成物差异：`git diff --name-only HEAD` 中属生成物的恰为 **3** 个：`crates/web/src/dto.rs`、`crates/web/src/lib.rs`、`crates/web/src/rest.rs` ⇒ 其余 136 个与 HEAD 逐字节未变（与实现车道声明一致，但此处是**我自算的清单**）。

### 1.5 项 5 — 回归与线上隔离

| 命令 | 结果 |
|---|---|
| `npx vitest run`（web/） | **68 files / 626 passed / 0 failed**，exit 0 |
| `./node_modules/.bin/tsc -b` | exit **0**（注意：裸 `npx tsc -b` 会解析到非本地 tsc 而假红，实现车道若用裸 `npx` 需改路径——本报告用本地二进制） |
| `cargo test -p web` | **103 passed / 0 failed**，exit 0（含 `api_multi_period_config` 15/15、`multi_period_pane_budget` 4/4、`api_rest`/`api_ma_config`/`dcap` 等 ①②③④ 相关面无回归） |
| 线上 PID 3112540 | **存活未触碰**（8081/8082 仍由它监听；临时实例 pid 1656412 已 kill） |
| 向线上的写请求 | **0**（本轮所有请求目标只有 `127.0.0.1:18099`；线上日志 `logs/app_dev_8081_redeploy_20260914_115233.log` 中 `multi_period` 出现 **0** 次） |

### 1.6 项 6 — 反向证据（突变检验）

- **A 探针检出能力**：在 `/tmp/p1c/wt` 副本给 `MultiPeriodChartStack` 注入 `<div data-p1c-mutant>`（不改仓库），重跑探针 → `mainFP`/`mainHTML` **立刻与 HEAD 不等**，指纹新增行 `1:div[data-p1c-mutant=true]`（`eq_worktree_mutant_reverse.json`）⇒ 证明 §1.2 的"逐字节一致"不是空判据（探针有能力发现包裹层）。还原后 `diff -q` 复核副本文件与仓库文件一致。
- **§7.4 护栏可达性反证**：实现车道测试文件头称「v1 HTTP 面无法表达 >12 pane，故只用纯函数测试」；实测用 `indicators=["dcap"]×11`（3 周期）即可表达 23 pane 并被护栏拦下 ⇒ **该免责理由不成立**，pane 护栏本可由 HTTP 负例覆盖（见 D3）。

---

## 2. 缺陷 / 发现（不修复，仅报告）

| ID | 严重度 | 位置 | 事实（可复现） | 影响 |
|---|---|---|---|---|
| **D1** | 中 | `crates/web/src/dto.rs`（`indicators` 校验 + `multi_period_pane_count`）、`rest.rs` PUT | `PUT indicators=["dcap","dcap"]` → **200**，且 `app_config.multi_period` 落库与 GET 读回均为 `["dcap","dcap"]`（**未去重**，`02-spec.md` §2 校验 6 明写"去重"）；同时 pane 计数按**原始数组长度**计 ⇒ `["dcap"]×11` 被判 **23 pane > 12** 而 **400** | ① 契约面与规格 §2-6 不符；② 语义等价的配置（重复指标名）被 pane 预算**误拒**；③ 使实现车道"HTTP 无法表达 >12"的论断失效（护栏可达） |
| **D2** | 低 | `dto.rs` pane 护栏错误串 | 被拒时报 `总 pane 数 23 超上限 12（基准 1 + Σ_卫星指标 pane）`，**不含被拒字段名**（对照：`periods`/`indicators` 负例均含字段名） | 与"明确报错并拒绝保存"口径兼容，但与"错误含被拒字段名"的一致性要求不符（前端/调用方无法按字段定位） |
| **D3** | 低（测试论证） | `crates/web/tests/multi_period_pane_budget.rs` 头注释 | 声称"HTTP 面在本期无法表达 >12 ⇒ 只做纯函数契约测试" | 免责理由被 §1.6 反证；应补 HTTP 级 §7.4 负例（现成构造：`["dcap"]×11`） |
| **D4** | 低（覆盖） | `web/src/features/dashboard/` | Toolbar「多周期」开关的**乐观更新/失败回滚**无 UI 级测试（`multiPeriodStore.test.ts` 只覆盖 store 往返；`multiPeriodClosedEquivalence.test.tsx` 只覆盖关闭态） | 已由本报告探针 B 实测通过，但实现侧缺回归网 |

**最小修正建议（不越权实施）**：

1. **D1**：PUT 校验入口对 `indicators` 去重（`dedup`）后再校验/落库，并让 `multi_period_pane_count` 使用**去重后**集合；若产品选择"重复即拒绝"，则对重复项返回 400 且错误串含 `indicators`（二选一，勿保留第三种"保留重复且计入预算"）。
2. **D2**：pane 错误串加入被拒维度名（如 `multi_period 总 pane 数 23 超上限 12`，或 `{"error":"...","field":"pane"}`）。
3. **D3**：在 `api_multi_period_config.rs` 增加 HTTP 级 §7.4 负例（`indicators=["dcap"]×11` ⇒ 400），与纯函数测试并列。
4. **D4**：为 Toolbar 开关补 UI 级乐观更新 + 失败回滚 + 关闭零残留测试（可参照本报告探针 B 的口径）。

---

## 3. 卫生与归因

- **临时资产已全拆**：`eestock-app` 临时实例（pid 1656412）已 kill；`127.0.0.1:18099`/`18098` 已无监听（`ss -ltn | grep -c 18099` = 0）；`/tmp/p1c/{head,wt,sbx}`、探针文件仅存于 `/tmp`，仓库内只保留 `tester/design|test|evidence` 报告与证据。
- **共享库清理复核**：`app_config` 中 `multi_period` → **0 行**（`psql -tAc` 实测），GET 回默认。
- `git diff --cached` **空**；`git status --porcelain` 的 tracked 改动清单与本轮开始时**完全一致**（11 个 M），无新增仓库文件（除 `tester/` 下本轮报告与证据）。
- **tracked 改动归因**（`git diff --name-only HEAD`）：
  - `design/07-app-plane/00-web-api.md`（doc-first 事实源，P1 改）
  - `crates/web/src/{dto,rest,lib}.rs`（3 个生成物，由上式文档重生成）
  - `web/src/api/{client,mock,types}.ts`、`web/src/features/dashboard/{DashboardPage,Toolbar}.tsx`（前端接线）
  - `design/15-multi-period/{02-spec,03-test-plan}.md`（**本轮 P1 实现前由架构师所改**，非实现车道）
  - 未跟踪新增（属 P1 交付物）：`web/src/features/dashboard/{MultiPeriodChartStack,multiPeriodStore}.tsx/ts`、`multiPeriod*.test.*`、`crates/web/tests/{api_multi_period_config,multi_period_pane_budget}.rs`、`coder/report|evidence/166_*`
- 备注（不影响判定）：`web/tester/probe-165/`、`web/src/features/dashboard/feedRealtime*.test.ts` 等未跟踪文件为**本轮之前既有**，未被我触碰（`find -newermt` 无近期改动）。
- 残余风险（诚实）：为验证 GET 坏值鲁棒性，共享库 `multi_period` 键在 20:47 前后存在过约数秒的非法/越界值（期间含 `enabled=true`），现已删除并复核 0 行 ⇒ 线上"默认关闭"行为已恢复；若恰在该秒级窗口内有前端读配置，将回退为默认（不产生卫星图）。

---

VERDICT: FAIL(1)
