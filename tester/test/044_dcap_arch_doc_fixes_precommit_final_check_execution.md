# tester 执行报告 044 —— 架构师本轮 4 处文档修正验收 + 提交前终检

> **本报告文件位置**：`tester/test/044_dcap_arch_doc_fixes_precommit_final_check_execution.md`
> 类型：**执行报告**（验收既有产物 + 跑既有测试/门禁；**未设计、未新增任何测试**）

- 时间戳：2026-09-13T20:02 +08:00
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- HEAD：`3f5425c23bd5a940f95b6951a9da0c714fdfc5d4`（`docs(report): dcap P0–P2 …`，2026-09-13 18:40:46）
- 工作区：HEAD 之后 P3/P4/P5 + 架构师文档修正**全部未提交**（见 §5 归因表）
- 约束遵守：只读 + 可跑测试；**未修改/新建/删除任何仓库文件**（仅本报告）；未 `git add/commit/stash`；未 tangle；未起 8081/8082；未写生产数据面。测试命令仅产生 `target/`、`node_modules` 等既有忽略物，`git status` 在全部命令执行前后同为 **73 行**（无新增/消失条目）；随后仅新增本报告 1 条 ⇒ 当前 **74 行**（唯一变化 = 本报告）。

---

## 0. 命令与原始输出（全量）

```text
$ git diff --cached --stat        # → 空（无暂存）
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
TANGLE_EXIT=0

$ cargo test -p mcp --lib strategy_guide_returns_handbook_full_text
   Compiling mcp v0.1.0 (/home/eestock/workspace/git/eestock/eestock-rs/crates/mcp)   ← include_str! 内嵌手册 ⇒ 确实重编
    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.08s
     Running unittests src/lib.rs (target/debug/deps/mcp-bbe84a26d21e268e)
running 1 test
test tools::tests::strategy_guide_returns_handbook_full_text ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 64 filtered out; finished in 0.00s
EXIT=0

$ cargo build -p web
   Compiling web v0.1.0 (/home/eestock/workspace/git/eestock/eestock-rs/crates/web)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.95s
EXIT=0

$ cd web && npx vitest run
 Test Files  56 passed (56)
      Tests  558 passed (558)
   Duration  5.25s
EXIT=0

$ cd web && npx tsc -b
(无输出)
EXIT=0
```

---

## 1. 4 处修正逐项验收（file:line + 原文）

### (a) `design/12-strategy-system/04-strategy-programming-guide.md:227`（§12.2 表后注）—— **已不再声称 ma/rsi 是 `min=1`** ✅

原文（L227）：

> `- \`n\` 的下界是 **2**（\`n=1\` 恒为 0，无意义），与手册 §1/§5 的示例（\`min:1\`）不同；仓内参考插件实际普遍为 \`min:2\`。`

- 全文 `min` 出现处仅：L16/L17（§1 双均线示例 `fast min:1` / `slow min:2`）、L127（§5 示例 `period min:1`）、L132（说明句）、L227（本条）、L271（单参数 min/max 说明）、L290–292（§12.6 示例 `n min:2`）。**没有任何一处把 `ma_rsi` 与 `min=1` 绑定**；`ma_rsi` 在手册中只出现一次（L177，§10 插件清单），无 min 主张。⇒ nit① 已消除。
- 与事实一致（依据 = 仓内参考插件实际 schema）：
  `ma_rsi.js:22-26 fast/slow/rsi_period min:2`；`dual_ma.js:25,26 min:2`；`macd.js:27-29 min:2`；`boll.js:28`、`kdj.js:30-32`、`momentum.js:25`、`atr_channel.js:30,31`、`dcap.js:22-24 min:2` ⇒「仓内参考插件实际普遍为 `min:2`」为真。
- 「手册 §1/§5 的示例（`min:1`）」亦为真（L16、L127）。⇒ 措辞与依据一致。

### (b) `design/99-decisions-log.md:222`（ADR-021「产出物」末条）—— **已改为「已随 P3 落地」** ✅

原文（L222 末段）：

> `… 编程手册 dcap 章节（\`design/12-strategy-system/04-strategy-programming-guide.md\` §12）；**配置端点行已随 P3 落地**（\`design/07-app-plane/00-web-api.md\`）。`

- 全文已无「待落 / 同期待 / 待确认」字样（`grep -n "待落\|同期待\|待确认" design/99-decisions-log.md` → 无匹配）。
- 依据核实：`design/07-app-plane/00-web-api.md:75` `GET /api/config/dcap`、`:76` `PUT /api/config/dcap`（两者均为本次工作区新增行，属 P3 文档面）；实现面 `crates/web/src/rest.rs`/`lib.rs` 有对应路由与处理器；真实 axum+DB 行为已由车道 B 实测（`tester/test/038_…:82-90`：GET 无键 200/8 参不含 `th`、PUT 合法 200 回显、非单调/越界 400 且不落库）。⇒ 表述与依据一致。

### (c) `design/14-dcap-indicator/02-spec.md:177`（§6 表「取数 warmup」行）—— **两侧口径已写明** ✅

原文（L177）：

> `| 取数 warmup | **仅当 DCAP 指标开启时**：前端取数 \`limit = viewport_bars + (n_l + m − 1)\`，**多取部分仅供计算、不上图**；**关闭时 \`limit = viewport_bars\`（不动 ADR-020 既有取数口径）**。架构裁决 2026-09-13（依据 P3 实现 + 独立验收实测：开 60/3 → 182、关 → 120、服务端 \`n_l=200,m=5\` → 324） | 否则视口最左侧永远缺一段；关闭时无 dcap 线，不需前置数据，避免无谓扩大取数 |`

### (d) `design/14-dcap-indicator/03-test-plan.md:103-107`（T10）—— **同一口径已写进测试契约** ✅

原文（L103–107）：

```
### T10 图表取数 warmup
- **DCAP 开启时**：请求 `limit = viewport_bars + (n_l + m − 1)` 后，**视口最左侧那根 bar 已有 dcap 值**（不断线）；
- **DCAP 关闭时**：`limit` 严格等于 `viewport_bars`（`warmupBars = 0`）——不得因为 dcap 而扩大关闭态的取数（ADR-020 口径不变）；
- 实测基准（P3 验收）：开 60/3 → `limit=182`（`viewport=120`）；关 → `120`；服务端 `n_l=200,m=5` → `324`；
- 反例（不 warmup）首根为 `null`（记录为已知表现）。
```

**(c)/(d) 两侧一致性与基准自洽性** ✅

| 维度 | 02-spec §6:177 | 03-test-plan T10:104-106 | 一致？ |
|---|---|---|---|
| 开启 | `limit = viewport_bars + (n_l + m − 1)`，多取不上图 | `limit = viewport_bars + (n_l + m − 1)`，最左那根有值 | ✅ |
| 关闭 | `limit = viewport_bars`，不动 ADR-020 口径 | `limit` 严格等于 `viewport_bars`（`warmupBars = 0`） | ✅ |
| 基准 | 开 60/3 → 182；关 → 120；服务端 `n_l=200,m=5` → 324 | 同三组数 | ✅ 数字逐字相同 |

算术自洽（view port=120）：`120 + (60+3−1) = 182` ✅；关闭 = `120` ✅；`120 + (200+5−1) = 324` ✅。
基准有实测出处（非杜撰）：`tester/test/038_dcap_p3_p4_laneB_acceptance_execution.md:74-80` 表格逐行给出 `KlineDataFeed{warmupBars:62,viewportBars:120} → 实调 182`、无 warmup → 120、Dashboard 默认关 → 120、开（默认 60/3）→ 182、开且服务端 `n_l=200,m=5` → 324。
实现面亦一致：`web/src/features/indicators/dcapIndicator.ts:73-75 dcapWarmupBars = n_l + m − 1`；`web/src/features/dashboard/DashboardPage.tsx:218 const dcapWarmup = indicators.dcap ? dcapWarmupBars(dcapParams) : 0;`；`web/src/features/dashboard/feed.ts:83-89` 非法/缺省 warmup → 0，`initialLimit = pageSize + warmupBars`，取数用 `limit: this.initialLimit`。⇒ 关闭态确实退化为 ADR-020 口径。

### 附加确认：`03-test-plan.md` §3.1/§3.2 的归属 = 架构师本人所为 ✅（非车道 B 产物）

- 「归属待确认」段落为本轮工作区新增，随架构师文档修正一并出现：`design/14-dcap-indicator/03-test-plan.md:143`（§3.1 策略层扫描结论，标注「历史存档，仅参考，不作为产品裁决依据」，存档指向 `tester/report/020_…`、`tester/evidence/022_dcap_p5/`）与 `:150`（§3.2 现行验证口径「只验证指标本身」，用户裁决 2026-09-13）。
- 与用户裁决、与车道 B 的 P5 报告结论方向一致，未见与 `tester/report/020/021` 冲突之处；本报告不评判其内容正确性，仅确认归属与落位。

---

## 2. 一致性复检

### 2.1 手册 §12 与 `02-spec.md` §2/§3/§4/§5/§6/§7（逐项比对）

| 手册位置 | 手册内容（摘要） | 02-spec 依据 | 结论 |
|---|---|---|---|
| §12.2:213-228 | 9 参数标量表：`n_s/n_m/n_l` int 8/26/60，2–250；`r_*` 1.0，0.5–2.0；`smooth` 1，0–1；`m` 3，1–60；`th` 0.01，0.001–0.5 | §2:43-59 | ✅ 默认值/范围/类型一致 |
| §12.2:228 | 跨字段 `n_s<n_m<n_l`，两入口行为不同 → 见 §12.5 | §2:61-67 | ✅ |
| §12.5:269-283 | 插件面 `n_m←max(n_m,n_s+1)`、`n_l←max(n_l,n_m+1)`（顺序归一、确定+幂等、仅 `init` 一次）；配置端点面严格 400、不写库 | §2:63-66、§3:74、§7:198 | ✅ |
| §12.1:195-212 | `A_k=A_1·r^(k−1)`；`ROI=Σw_k(P_n/P_k−1)=P_n/H_w−1`；买价=估值价=close；`[−1,+∞)`；`r=1` ≡ 遗留 DCAP | §1.2:15-27 | ✅ |
| §12.3:230-245 | 三线 `s/m/l` 各 `(n_i,r_i)`；`SMA(m)`；`m=1` 或 `smooth=0` 与原始值**逐位相同** | §3:70-75 | ✅ |
| §12.4:246-268 | 数据不足 `< n_i`（开平滑 `< n_i+m−1`）⇒ 该线无值/不入 N；三线全不足 ⇒ 50 且**不打 `ctx.log`**；`per_i/clamp`、`score=clamp(50−(50/N)Σper_i,0,100)` | §3:73、§4:128-136、§9:245（"不打 `ctx.log`"） | ✅ |
| §12.6:290-292 | 示例 schema `n` 26/min 2、`r` 1.0/0.5–2.0、`th` 0.01/0.001–0.5 | §2 | ✅ |
| §12.6:300-325 | 示例 CORE 两步法：①`k=1..n` 升序迭代乘法 ②`k=n→1` 回加；`n>=1` 守卫与「非法价按数据不足」 | §4:117-127（浮点铁律）；生成物 `dcap.ts:69`/`dcap.js:88` 同守卫 | ✅ 与产物一致 |

**warmup 在手册中的描述**：`grep -n "warmup\|多取\|viewport_bars\|limit" design/12-strategy-system/04-strategy-programming-guide.md` → **无匹配**（`取数`/`limit` 亦无）。手册 §12 只讲指标语义、参数、评分与用法示例，不涉及前端取数 ⇒ **与 (c) 无需同步（无冲突面）**。

### 2.2 `file=` 计数（架构师改过的文档不得引入 tangle 块）

| 文档 | `file=` 计数 | 本轮 diff 新增 `file=` 行 |
|---|---|---|
| `design/12-strategy-system/04-strategy-programming-guide.md` | **0** | 无 |
| `design/99-decisions-log.md` | **0** | 无 |
| `design/14-dcap-indicator/03-test-plan.md` | **0** | 无 |
| `design/14-dcap-indicator/02-spec.md` | 2（`:265` `{.ts file=web/src/features/indicators/dcap.ts}`、`:450` `{.js file=crates/strategy-core/reference-plugins/dcap.js}`）| 无（两处为 P1 既有单一源块，本轮未触碰） |

`git diff -U0 <4 文档> | grep "^+.*file="` → `(none)` ✅

---

## 3. 回归（编译 + 测试）

- `cargo test -p mcp --lib strategy_guide_returns_handbook_full_text` → **1 passed / 0 failed**，且日志显示 `Compiling mcp`（`include_str!` 内嵌手册 ⇒ 手动重编确实发生，非缓存假绿）。
- `cargo build -p web` → exit 0（`Compiling web`）。
- `cd web && npx vitest run` → **Test Files 56 passed (56) / Tests 558 passed (558)**，0 failed / 0 skipped；本轮相关用例在列：`dcapWarmupP3.test.ts (5)`、`dcapIndicator.test.ts (15)`、`dcap.test.ts (10)`、`dcapMirror.test.ts (11)`、`dcapNormalize.test.ts (5)`、`dcapInsufficient.test.ts (4)`。
- `cd web && npx tsc -b` → exit 0，无输出。

**失败用例：0。崩溃 / core dump：无**（无 `*.core`、无 panic 输出、无 `SIGABRT`；上列命令 exit 均 0）。

---

## 4. 门禁

`./scripts/check-tangle.sh` → `[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。` **exit=0** ✅
—— 该结果同时构成 §6 的关键证据：`02-spec.md` 的算法正文块（§10.1/§10.2）未被本轮改动，生成物 `web/src/features/indicators/dcap.ts`、`crates/strategy-core/reference-plugins/dcap.js` 相对 HEAD 也无改动（不在 `git status` 列表）。

---

## 5. 提交前终检

- `git diff --cached` → **空**（无暂存）；`git diff --cached --stat | wc -l` → `0`。
- `git status --porcelain` → 命令期 **73 行**（21 tracked 改动 + 52 untracked 条目），写入本报告后 **74 行**，归因如下。

### 5.1 tracked 改动（21）—— 全部属本轮 dcap 工作流

| 类别 | 文件 |
|---|---|
| P3 后端配置 API | `crates/web/src/dto.rs`、`crates/web/src/rest.rs`、`crates/web/src/lib.rs` |
| P3 前端 | `web/src/api/{client,mock,types}.ts`(+`client.test.ts`/`mock.test.ts`)、`web/src/features/dashboard/{DashboardPage.tsx,KlineChart.tsx,KlineChart.test.tsx,Toolbar.tsx,Toolbar.test.tsx,feed.ts}`、`web/src/layouts/DashboardGrid.tsx` |
| P3 文档 | `design/06-web/01-dashboard.md`（DCAP 默认关 + warmup + 端点行）、`design/07-app-plane/00-web-api.md`（`GET/PUT /api/config/dcap` 契约） |
| P4 文档 | `design/12-strategy-system/04-strategy-programming-guide.md`（§10 8 款插件 + §12 dcap 章节）、`design/99-decisions-log.md`（ADR-021 登记） |
| 架构师文档修正 | `04-strategy-programming-guide.md:227`（nit①）、`99-decisions-log.md:222`（nit②）、`02-spec.md:177`（(c)）、`03-test-plan.md:104-106,143-158`（(d)+§3.1/§3.2） |

**未发现任何不属于本轮 dcap 工作流的 tracked 改动**（逐文件抽查 diff 主题：`DashboardGrid.tsx` 仅 `indicators` 加 `dcap:false`；`KlineChart.test.tsx`/`Toolbar.test.tsx` 仅 fixture 补 `dcap:false`；`feed.ts` 仅新增 `warmupBars`/`initialLimit`）✅

### 5.2 untracked 新增（终检快照 52 条；+1 = 本报告 ⇒ 当前 53 条）—— 分类与**非本轮**条目

| 类别 | 条目 |
|---|---|
| P3 产物 | `coder/evidence/dcap_p3/`（13 文件）、`coder/report/158_dcap_p3_frontend_config_warmup_t8.md`、`web/src/features/indicators/{dcapIndicator.ts,dcapIndicator.test.ts,DcapParamsPanel.tsx,DcapParamsPanel.test.tsx}`、`web/src/features/dashboard/{dcapWarmupP3.test.ts,dcapWiringP3.test.tsx}` ⇒ 与 `04-implementation-plan.md:24-32` 交付物清单逐一对应，无计划外源码 |
| P4 文档 | `coder/report/157_dcap_p4_programming_guide_adr021.md` |
| P5 / 指标验证（tester） | `tester/evidence/022_dcap_p5/`、`tester/evidence/023_dcap_ind/`、`tester/report/020_dcap_p5_effectiveness_sweep.md`、`tester/report/021_dcap_indicator_intrinsic_validation.md`、`tester/test/038_…` |
| 本报告 | `tester/test/044_dcap_arch_doc_fixes_precommit_final_check_execution.md` |
| **非本轮（环境/工具类 untracked）** | `.claude/`、`AGENTS.md`、`CLAUDE.md`、`backup_symbols.sql`、`prod_tools_schemas_periphery.txt`、`logs/`（❗**未被 `.gitignore` 覆盖**，`git check-ignore logs` rc=1） |
| **非本轮（历史轮次 tester 报告）** | `tester/test/009_…`–`037_…`（29 份）、`tester/evidence/018/`、`tester/report/018_debt_batch1_acceptance.md`、`coder/backups/`（2026-09-11 strategy purge CSV×2） |

### 5.3 残留物专项检查

| 检查项 | 结果 |
|---|---|
| `zz_` 夹具 | 全仓 13 个：**11 个 tracked**（`tester/evidence/{010_mcp_batch,013_d11,016_d11_v11,019,legacy_fixtures}`，历史轮次有意留存）+ **2 个 untracked**：`tester/evidence/018/fixtures/zz_accept018_{errorred,mutation}_tmp.rs.txt`（轮次 018，非 dcap；`.txt` 后缀 ⇒ 不参与编译）。**本轮 dcap 无任何 `zz_` 残留**（车道 B 的 `zz_laneB_p3_scratch.test.tsx`、`zz_laneB_dcap_p3_verify.rs` 已删除，全仓 `find -name "zz_laneB*"` → 空） |
| `logs/` | **存在**（仓库根，untracked，`app_dev_8081_redeploy_*.log` 等，最新 2026-09-13 15:00；无 dcap 相关文件名）。**非本轮 dcap 产物，属环境/部署类** —— 见 §7 风险 |
| `.entangled/` | 存在（根 + `web/.entangled`）但被 `.gitignore:12` 覆盖 ⇒ **不进 `git status`、无提交风险** ✅ |
| 临时探针残留（dcap 目录） | `coder/evidence/dcap_p3/t8_probe_results.json`、`tester/evidence/023_dcap_ind/01_harness_dcap_ind_probe.rs` 为**显式证据文件**（非临时残留）；dcap 相关目录内无 `*.log`、无 `zz_`、无 `/tmp` 直投的临时脚本 |

---

## 6. `02-spec.md` / `03-test-plan.md` 改动范围（diff 摘要）

`git diff -U0` 的 hunks：

```
design/14-dcap-indicator/02-spec.md : @@ -177 +177 @@ on_bar(ctx):              ← 仅 1 行（§6 表 warmup 行）
design/14-dcap-indicator/03-test-plan.md :
  @@ -104 +104,3 @@   ← T10（§1 测试清单）：+ 关闭态口径 + 实测基准
  @@ -139,2 +141,20 @@ ← §3「有效性验证」尾段：先验句微调（删「建议先扫 1.00–1.05」）
                          + 删「参数空间建议：r 稀疏点(1.00/1.02/1.05/1.2)…」一行
                          + 新增 §3.1 历史存档、§3.2 现行验证口径
```

| 结论项 | 判定 |
|---|---|
| 仅涉 warmup 口径与验证口径章节 | ✅ 02-spec 仅 §6 表 1 行；03-test-plan 仅 T10（§1）+ §3（有效性验证） |
| 参数表（§2）/公式（§1.2）/评分映射（§4 `dcapScore`）/浮点铁律（§4/§5）等已冻结口径未被改动 | ✅ diff 未触及任何代码块或参数行；生成物 `dcap.ts`/`dcap.js` 相对 HEAD 无改动；`check-tangle` exit=0 逐字节通过（若冻结面被改而未重生成必红） |
| §3.1/§3.2 属「验证口径」章节 | ✅ 均挂在 `## 3. 有效性验证` 之下（`03-test-plan.md:135` → `### 3.1` → `### 3.2`） |

---

## 7. 观测到的（非阻塞）问题与最小修正建议

> 以下均**未修改任何文件**，仅记录；不属 4 处修正的验收阻断项。

1. **`logs/` 未被 `.gitignore` 覆盖**（`git check-ignore logs` → rc=1，`git status` 显示 `?? logs/`）。若终局用 `git add -A` 会误纳入 2026-09-11~13 的部署日志。最小建议：提交时**按路径显式 `git add`**（只加 P3/P4/本次修正路径），或另行裁决是否把 `logs/` 加入 `.gitignore`（本报告不擅改 `.gitignore`）。
2. **`02-spec §19` 引用是简写**：`web/src/features/indicators/dcapIndicator.ts:71`、`DashboardPage.tsx:216`、`feed.ts:53` 及 `tester/test/038_…:80` 写「§6/§19」。`02-spec.md` 只到 §10，「19」实为 **§8 裁决附录第 19 项**（`02-spec.md:230`「取数 | 视口外多取 `n_l + m − 1` 根仅供计算」），非 §19 章节。内容无错，仅引用形式不可直达。最小建议：把注记改为「§6 表 + §8 #19」（可选，纯注释）。
3. **`design/06-web/01-dashboard.md` 的 warmup 措辞只写了开启侧**（L322-323「开 DCAP 时前端初始取数 `limit = viewport_bars + (n_l + m − 1)`…；否则视口最左侧永远缺一段」，及 L344 接口表的「开 DCAP 时 `limit = …`」）。**与 (c) 不冲突**（未主张关闭态也 warmup），但关闭侧 `limit = viewport_bars` 未明写。最小建议（可选，1 行）：在 L322 句末补「；DCAP 关闭时 `limit = viewport_bars`（ADR-020 口径不变）」。
4. **`03-test-plan.md` §3 引言与 §3.2 的口径张力（措辞级）**：§3 开头（L137）仍写「按既有 SWEEP 纪律独立排期：IS 前 70% 冻结参数（中位数）→ OOS 一次性裁决 → 双跑 sha256 一致」，而 §3.2（L150-156）要求「**不得引入策略层成分**」并给出指标侧验证清单。二者可共存（IS/OOS 切分本身不是策略层成分），但并列易被读成两条口径。最小建议（可选）：在 L137 末补「（其中「冻结参数 + 单次 OOS」协议沿用；策略层成分按 §3.2 剔除）」。**本报告不判定 §3.1/§3.2 内容正确性**（属有效性研究任务）。

---

## 8. 声明

- 本轮**未设计、未新增、未修改任何测试代码**；未修改实现/接口/架构/文档。
- 未尝试修复任何失败（本轮无失败）；未进入任何失败分支。
- 无永久性插桩加入；未 `git add/commit/stash`；未运行 `entangled tangle`（仅跑只读门禁脚本）；未启动 8081/8082；未写生产数据面。
