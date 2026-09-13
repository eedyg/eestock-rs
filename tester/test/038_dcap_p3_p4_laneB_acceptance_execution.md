# 车道 B — P3/P4 独立验收（执行报告）

- **报告自身路径**：`tester/test/038_dcap_p3_p4_laneB_acceptance_execution.md`
- **执行时间**：2026-09-13 19:30 ~ 19:36 CST
- **仓库根（主树）**：`/home/eestock/workspace/git/eestock/eestock-rs`，HEAD = `3f5425c23bd5a940f95b6951a9da0c714fdfc5d4`
- **口径来源**：`design/14-dcap-indicator/{01-adr.md,02-spec.md,03-test-plan.md(§3.2),04-implementation-plan.md}`
- **本报告性质**：**执行报告**（未新增/保留任何测试；所有临时取证文件均已删除，见 §8）
- **本车道未修改任何实现/文档/口径**；未 `git add/commit/stash/checkout`；未起 8081/8082；未跑 tangle；DB 仅读写 `app_config` key=`dcap`（已清理）

---

## 0. 结论摘要

| 项 | 范围 | 结论 |
|---|---|---|
| 1 | P3 测试面（vitest / tsc / cargo） | **PASS** — vitest 558/558（56 文件）、`tsc -b` exit=0、`cargo test -p web --lib` 49/49、集成 `api_settings`6 / `api_ma_config`1 / `api_rest`2 全绿 |
| 2 | P3 契约面（独立复现） | **PASS** — 副图注册（真实 klinecharts 10.0.3 实测）、warmup（**仅开启时**）、配置端点（真实 axum+DB 实测 200/400/默认）、MA 未动 |
| 3 | P3 反向证据（变红→按 sha256 还原→复绿） | **PASS** — 3 组变异全部变红；还原后 sha256 逐一 OK，复跑全绿，零残留 |
| 4 | P3 门禁 + 生成物来源 | **PASS** — `check-tangle.sh` exit=0（2 次）；自建沙箱重生成，6 文件逐字节相同 |
| 5 | P4 文档面 | **PASS（2 处非阻塞 nit）** — `file=` 计数 0/0；手册 §12 与 spec §2/§3/§4/§5/§7 无实质冲突；示例代码实测**位级**等于 T1 冻结值 |
| 6 | 既有断言未被削弱 | **PASS** — 全部 `-` 行仅为「补 `dcap:false`」/ 文档行 / 源码重构；新增行无 ignore/skip/only/容差放宽 |
| 7 | 工作树与残留 | **PASS（附 1 项归属待确认的既有改动）** — `git diff --cached` 空；无 strategy-core/application/ABI 改动；P5 仅留 `tester/report/020` + `tester/evidence/022`；`design/14-dcap-indicator/03-test-plan.md` **有非 P3/P4 来源的未提交改动**（见 §7.3） |

---

## 1. P3 测试面（项 1）

```
$ cd web && npx vitest run
 Test Files  56 passed (56)
      Tests  558 passed (558)

$ cd web && npx tsc -b ; echo $?
0

$ cargo test -p web --lib
test result: ok. 49 passed; 0 failed; 0 ignored; 0 measured

$ cargo test -p web --test api_settings --test api_ma_config --test api_rest
api_ma_config: 1 passed
api_rest:      2 passed
api_settings:  6 passed
```
未出现崩溃 / core dump / flake（本轮 2 次全量 vitest 均 558/558）。

---

## 2. P3 契约面（项 2，独立复现，不引用 worker 说法）

### 2.1 副图注册（真实 klinecharts 10.0.3 + Playwright chromium）

自建 harness（`/tmp/dcap_verify/`，esbuild 打包**仓库真实** `dcapIndicator.ts`/`dcap.ts`，**不使用 worker 的 spike**）：
走 `ensureDcapIndicatorRegistered()` → `chart.createIndicator({name:'DCAP', calcParams: dcapCalcParams(...)}, true)`，与 `KlineChart.tsx` 同款路径；同时建 `MA`（`paneId:'candle_pane'`）与一个「同模板但不设 precision」的对照 `DCAPNP`。

| 断言 | 实测 |
|---|---|
| 模板名/短名 | `DCAP` / `DCAP` |
| figures | `["s:line","m:line","l:line"]`（3 项，s/m/l） |
| precision | 模板 `5`，**真实实例 precision = 5** |
| precision 是显式覆盖 | 对照实例（不设 precision）**precision = 4**（证实 klinecharts 自定义指标默认 4） |
| paneId ≠ candle_pane | `DCAP` 实例 `paneId = indicator_pane_1789299117609_3`；`MA` 实例 `paneId = candle_pane` |
| 无 paneId 模板 | `hasPaneId=false`、`hasYAxisId=false`（副图由 isStack 建，不可能叠主轴） |
| calcParams | `[8,26,60,1,1,1,1,3]`，长度 **8**（不含 th） |
| 首值位置 | 默认参数下 `s=9 / m=27 / l=61`（0-based ⇒ 第 `n_i+m−1` 根），与 02-spec §6 断线口径一致 |
| T1 冻结值 | `computeDcapSeries([100,90,95], n=3, r=1.2, smooth=0)` = `0.0045787545787547845`（`Object.is` 位级相等）；`r=1` = `0.0018518518518517713`（位级相等） |
| 浏览器错误 | `errors: []`（无抛错，console 仅 klinecharts 版本 banner） |

### 2.2 取数 warmup —— **明确：条件是「仅开启时」**

自建临时 vitest（`zz_laneB_p3_scratch.test.tsx`，已删除）实测：

| 场景 | 实测 `api.getKline({limit})` |
|---|---|
| `KlineDataFeed{warmupBars:62, viewportBars:120}` | `initialLimit=182`，实调 **182** |
| `KlineDataFeed{无 warmup}` | **120**（warmup=0） |
| DashboardPage **DCAP 默认关** | **120**，且所有调用 limit 全为 120（warmup=0） |
| DashboardPage **开 DCAP（默认 60/3）** | **182** = 120 + (60+3−1) |
| DashboardPage 开 DCAP 且服务端 `n_l=200,m=5` | **324** = 120 + (200+5−1) |

⇒ **实测证据支持「仅开启时 warmup」口径**：关闭时 `warmupBars = 0`，`limit` 严格等于 `viewport_bars`（不改变 ADR-020 既有取数口径）；开启时 `limit = viewport_bars + (n_l + m − 1)`（多取部分不上图）。`dcapWarmupBars` 默认 62、上界 309（250+60−1）与 §6/§19 一致。

### 2.3 配置端点（真实 axum + 真实 DB :5433，自写 scratch 集成测试，已删除）

自写 `crates/web/tests/zz_laneB_dcap_p3_verify.rs`（装配同 `api_ma_config.rs`）实测：

- `GET 无键` → **200**，body 恰为 `{"n_s":8,"n_m":26,"n_l":60,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":1,"m":3}`，**不含 `th`**；
- `PUT 合法`（5/10/20/1.5/1/1.02/0/5）→ **200** 且回显 == 写入值；`GET` 读回**一致**；
- `PUT 非单调 n` 3 组（26/26/60、8/60/26、20/20/20）→ **400**；
- `PUT 越界/非整数` 8 组（n=1、n_l=251、n_s=8.5、r=0.49、r_l=2.01、smooth=2、m=0、m=61）→ **400**；
- 全部 400 **不落库**（读回仍为上一次合法值）；
- 库中坏 JSON（`{"viewport_days":8}`）/ 越界旧值（60/8/26）→ **200 默认**（不 500）；
- 运行后 `DELETE FROM app_config WHERE key='dcap'`，psql 复核 **0 行**（未污染 dev 库）。
- 输出：`laneB dcap config contract: OK；清理后 app_config key='dcap' 行数 = 0 / test ... ok`

同一 server 下 `GET /api/config/ma` 仍 **200** 且 `windows` 数组形状不变。

### 2.4 不动 `/api/config/ma`

```
$ git diff -U0 -- crates/ | grep -E '^[+-]' | grep -v '^[+-][+-][+-]' | grep -iE 'ma_config|get_ma_config|put_ma_config|validate_ma_windows|K_MA|ma_windows|windows'
(无 MA 相关变更行)
$ git diff -U0 -- design/07-app-plane/00-web-api.md | grep -E '^[+-]' | grep -iE 'config/ma|MaConfig|ma_windows'
(无)
```
`git diff --name-only` 不含任何 MA 文件（`crates/web/src/settings.rs`、`crates/storage/src/ma_config.rs`、`crates/domain/src/ports.rs` 均未改），运行期 MA 端点行为也已实测 200。

---

## 3. P3 反向证据（项 3）

变体前先备份 + 记 sha256：`bd49f3c6…(dcapIndicator.ts)`、`0690b837…(KlineChart.tsx)`、`e3da5f60…(Toolbar.tsx)`。

| 变体 | 改动 | 实测结果（变红） |
|---|---|---|
| N1 | `DCAP_PRECISION 5 → 4` | `dcapIndicator.test.ts`：**1 failed / 14 passed**（`precision 显式 5` 用例红） |
| N2a | 去掉 `registerIndicator(DCAP_INDICATOR_TEMPLATE)` 调用 | `dcapIndicator.test.ts` **1 failed**（幂等注册用例红）+ `dcapWiringP3.test.tsx` **1 failed**（注册面用例红） |
| N2b | `dcap` 从 `KlineChart` 的 `INDICATOR_DEFS` 移除 | `dcapWiringP3.test.tsx` **2 failed**（独立副图 / calcParams 两用例红） |

随后按备份还原：
```
$ sha256sum -c /tmp/dcap_verify/backup/SHA256.txt
web/src/features/indicators/dcapIndicator.ts: OK
web/src/features/dashboard/KlineChart.tsx: OK
web/src/features/dashboard/Toolbar.tsx: OK
```
复跑：`dcapIndicator.test.ts` 15/15、`dcapWiringP3.test.tsx` 13/13、`dcaParamPanel/warmup` 全绿；全量 vitest 558/558。**主树零残留**（见 §8）。

---

## 4. P3 门禁与生成物来源（项 4）

- `./scripts/check-tangle.sh` → `[check-tangle] ✅ design 与生成物一致…`，**exit=0**（验收期间 2 次）。
- **自建沙箱重生成（不依赖门禁脚本）**：把 `entangled.toml` + `design/` + 6 个目标文件副本拷进 `/tmp` 沙箱，`rm -rf .entangled && entangled tangle -f`，再逐字节比对：

```
OK(byte-identical)  crates/web/src/dto.rs
OK(byte-identical)  crates/web/src/rest.rs
OK(byte-identical)  crates/web/src/lib.rs
OK(byte-identical)  web/src/layouts/DashboardGrid.tsx
OK(byte-identical)  web/src/features/indicators/dcap.ts
OK(byte-identical)  crates/strategy-core/reference-plugins/dcap.js
```

⇒ 抽查的 4 个文件（`dto.rs`/`rest.rs`/`lib.rs`/`DashboardGrid.tsx`）**确实来自文档块**，非手改。对应声明块：
`design/07-app-plane/00-web-api.md`（dto/rest/lib）、`design/06-web/01-dashboard.md`（DashboardGrid）、`design/14-dcap-indicator/02-spec.md §10`（dcap.ts / dcap.js）。

---

## 5. P4 文档面（项 5）

### 5.1 `file=` 计数仍为 0
```
design/12-strategy-system/04-strategy-programming-guide.md:0
design/99-decisions-log.md:0
```
两文件**无任何带属性围栏**（`grep -n '^```{'` 无输出）⇒ 不可能被 tangle；编译期内嵌一致性由 `cargo test -p mcp --lib strategy_guide_returns_handbook_full_text` 独立复跑 **1 passed**（内嵌文本 == design 源）。

### 5.2 手册 §12 与 `02-spec.md` 逐条一致性（核对结论）

| spec 条款 | 手册 §12 对应 | 结论 |
|---|---|---|
| §2 九参数表（key/默认/范围/th 只属策略侧） | §12.2 九行表 | **一致**（8/26/60、r=1.0、smooth=1、m=3、th=0.01/0.001–0.5；`n` 下界 2 的解释与 spec 同） |
| §2 跨字段 `n_s<n_m<n_l` + 归一化公式（顺序归一、幂等、仅 init 一次、on_bar 不重复） | §12.5 对照表 + 两条反例 | **一致**（`n_m←max(n_m,n_s+1)`、`n_l←max(n_l,n_m+1)`；「只在 `init` 做一次」） |
| §2 宿主端点严格 400（与插件面有意不同） | §12.5 对照表右列 | **一致**（非单调/越界/非整数 → 400，不写库） |
| §3 窗口含当前 bar / 价格取 close / SMA(m) / 开关关闭逐位相同 | §12.1、§12.3 | **一致**（「`m=1` 或 `smooth=0` 与原始 ROI **逐位相同**」） |
| §3 数据不足：`<n`（开平滑 `<n+m−1`）⇒ 无值；插件侧不入 N；三线全缺 → 50 | §12.4 首两条 | **一致**（含「不打 `ctx.log`」） |
| §3 首值 = 第 `n_i+m−1` 根 bar | §12.3 末条 | **一致**（1 起数） |
| §4 `per_i=clamp(roi_i/th,−1,+1)`、`score=clamp(50−(50/N)Σper_i,0,100)`、N=1..3、全缺→50、三线等权 | §12.4 公式块 + 锚点表 | **一致**（锚点 −th→100 / 0→50 / +th→0；「每条线最多贡献 ±50/N」） |
| §5 on_bar 六步、close≤0 按数据不足不抛错、不按 r 下单、状态进 save/load | §12.1、§12.4、§12.6 | **一致**（示例的 `dcapRoi` 即 CORE 同式；`win` 进 `save()/load()`） |
| §1.3 有效回看趋于 `1/(r−1)`（n=26,r=1.1 → 7.62） | §12.7 | **一致**（数值 7.6 与 spec 表同源） |
| §7 `th` 不进图表/配置接口 | §12.2、§12.5 | **一致** |

**未发现与 spec 冲突的实质不一致。** 非阻塞 nit（均不涉及 spec 数值口径）：
1. §12.2「与 `ma/rsi` 等 `min=1` 的指标不同」——仓内参考插件（`dual_ma`/`ma_rsi`/`macd`/`boll`/`kdj`/`momentum`/`atr_channel`）**全部 `min:2`**，只有手册自己的 §1/§5 示例用 `min:1`。最小修正：改为「与手册 §1/§5 的示例写法（`min:1`）不同；仓内参考插件普遍为 `min:2`」。
2. `design/99-decisions-log.md` ADR-021 末条写「配置端点行**同期待落**（`design/07-app-plane/00-web-api.md`，P3 车道）」——该行已随 P3 落在同一工作树。最小修正：改为「已随 P3 落地（`00-web-api.md` §1.1 两行）」。

### 5.3 示例代码实测数值 == T1 冻结值（位级）

从手册 §12.6 的 ```js 块**原样抽取**（不转写）后执行：

```
r=1.2 → 0.0045787545787547845   bit_equal(true)   （T1 冻结值 0.0045787545787547845）
r=1.0 → 0.0018518518518517713   bit_equal(true)   （T1 冻结值 0.0018518518518517713）
遗留 DCAP (close/HM−1) = 0.0018518518518519933   Δ=2.22e-16 < 1e-12（T1 容差）
对照：若按 k=1→n 前进累加（spec §4 明令禁止的次序）→ 0.0045787545787545625（与手册值不同）
n>len → null；close=0 → null
```
⇒ 示例的**累加顺序与 CORE 钉死的两步法一致**（位级同值），退化/边界行为也一致。

---

## 6. 既有断言未被削弱（项 6）

`git diff -U0` 的**全部 `-` 行**逐条核对（共 21 行）：

| 类别 | 行 | 判定 |
|---|---|---|
| 测试对象字面量 | `indicators: { ma:true, macd:false, kdj:false, boll:false }` ×4（`KlineChart.test.tsx` / `Toolbar.test.tsx`） | 仅**补 `dcap:false`**（类型必需）；无断言增删 |
| 事实源文档 | `01-dashboard.md` 可选指标行 / kline 行；`04-strategy-programming-guide.md` 参考插件 7→8 行；`03-test-plan.md` §3 两行 | 文档同步（P3/P4 + 口径更新），非测试断言 |
| 源码重构 | `feed.ts`（`pageSize`→`initialLimit`、`hasMore` 对齐请求量）、`KlineChart.tsx`（`syncIndicators` 增 dcap 参数）、`DashboardPage.tsx`（feed 构造 + 重读注释） | 实现改动；配套断言由新增用例覆盖 |

- 新增行扫描：**无** `#[ignore]` / `.skip(` / `.only(` / `it.todo` / `toBeCloseTo` / 容差放宽 / `>=` 替代 `==`（grep 全空）。
- 新增测试均为「新增端点/副图/warmup/归一化」断言：`dcapIndicator.test.ts` 15、`DcapParamsPanel.test.tsx` 7、`dcapWarmupP3.test.ts` 5、`dcapWiringP3.test.tsx` 13、`client.test.ts` +2、`mock.test.ts` +2、`dto.rs` +4 单测。
- 基线对账：vitest 514 → **558**（+44）、`cargo test -p web --lib` 45 → **49**（+4），与新增量吻合，无删例。

---

## 7. 工作树与残留（项 7）

1. `git diff --cached --stat` → **空**（本车道未 stage 任何文件）。
2. 越界面核查：`git diff --name-only` 不含 `crates/strategy-core/**`、`crates/application/**`、插件 ABI、`clamp_score`/`aggregate`/`classify`/60-40 阈值/`ExecutionPolicy`（grep 空）——**未越界**。
3. **待确认项**：`design/14-dcap-indicator/03-test-plan.md` **在工作树中处于已修改状态**（+22/−2：新增 §3.1「策略层扫描结论（历史存档，不作产品裁决依据）」与 §3.2「现行验证口径：只验证指标本身」，并删除原「参数空间建议」两行）。mtime = 19:29，晚于 P3（18:58）/P4（18:47）/P5（18:57）三份报告 ⇒ **非 P3/P4（亦非本车道）所为**；P3/P4 报告均声明未触碰该目录。该改动与用户裁决「P5 不采信 + §3.2 现行口径」一致，**判为架构/裁决留痕**，但按 item 7「确认未动 `design/14-dcap-indicator/**`」的字面要求，此处事实是**已被改动**，请架构师确认归属（本车道未改、未回退）。
4. P5 残留：仅 `tester/report/020_dcap_p5_effectiveness_sweep.md` + `tester/evidence/022_dcap_p5/`（报告/证据），**无任何代码或 `design/` 改动**（`git status` 中 P5 相关仅这两条 `??`）。符合「P5 不在主树留代码/文档改动」。
5. 其余未跟踪项（`.claude/`、`AGENTS.md`、`CLAUDE.md`、`backup_symbols.sql`、`prod_tools_schemas_periphery.txt`、`logs/`、`coder/backups/`、`tester/**` 历史报告）mtime 均 ≤ 2026-09-13 13:31，**非本轮产物**。

---

## 8. 本车道产物与零残留声明

- 本报告：`tester/test/038_dcap_p3_p4_laneB_acceptance_execution.md`。
- 临时取证文件（**均已删除**，未进入主树交付）：`web/src/features/dashboard/zz_laneB_p3_scratch.test.tsx`、`crates/web/tests/zz_laneB_dcap_p3_verify.rs`；harness 全在 `/tmp/dcap_verify/`（含 `/tmp` 沙箱，已清理）。
- 变异实验的 3 个文件已按 sha256 还原并逐一 `OK`；`git status` 无 `zz_`/`laneB` 残留。
- 未修改实现/接口/架构/口径；未分析或修复任何失败；未起 8081/8082；DB 的 `app_config` key=`dcap` 已确认 0 行。

---

## 9. 最小修正建议（仅 2 条 nit，均不阻塞）

1. 手册 §12.2 的「与 `ma/rsi` 等 `min=1` 的指标不同」措辞失准（仓内参考插件全为 `min:2`）→ 建议改措辞（不影响 spec 数值口径）。
2. `99-decisions-log.md` ADR-021 末条「配置端点行同期待落（P3 车道）」已过时（P3 已落地同一工作树）→ 建议改为「已随 P3 落地」。

---

## VERDICT

**PASS**（项 1–6 全项通过，含反向证据与门禁复核；项 7 附一项归属待确认的既有改动：`design/14-dcap-indicator/03-test-plan.md` 的 §3.1/§3.2 更新非 P3/P4 来源，本车道未改未回退，建议架构师确认）。两项 nit 见 §9，不影响功能正确性。
