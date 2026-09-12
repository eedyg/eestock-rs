# 013 — D11 独立验收报告（标的类型元数据 + 按类型推断费率 / ADR-019）

> 本文档自身路径：`eestock-rs/tester/report/013_d11_acceptance.md`
> （绝对路径 `/home/eestock/workspace/git/eestock/eestock-rs/tester/report/013_d11_acceptance.md`；同内容镜像一份到工作区根 `tester/report/013_d11_acceptance.md`）
> 原始证据目录：`eestock-rs/tester/evidence/013_d11/`（31 个 txt + 11 个 JSON + `fixtures/`）
> 验收时间：2026-09-12 21:34–21:45 CST｜被验工作区：`eestock-rs`，**0 staged**（36 tracked 修改 + 28 未跟踪）
> 验收角色：Tester（**只验证不改实现**；未修改任何实现文件、未提交 git、未重启生产服务）

---

## 0. 结论

**可合并（mergeable）** —— 8 项验收全部通过，含 3 项我自行构造的原始实测（`type=NULL` 第三级、
双通道逐字节对拍、隔离探针库全新建库路径）。无 blocker。

伴随以下 **非阻塞** 事项（详见 §10/§11）：2 处文档陈旧/计数不符、1 处费率回显语义可被误读、
1 处既有 tester 夹具的断言漂移、探针库与归档夹具的环境残留。

**关键判据一句话**：ADR-019 §1 的费率事实逐字段落库；三层解析（显式 > profile > 旧默认）在
**application 单点**实现且双通道（MCP/REST）行为逐字节一致；生产（PID 3696673，9/11 启动）仍是旧口径
（ETF 被收印花税 49.79 元），**新行为未生效、需部署**。

---

## 1. 验收方法（独立于 coder 报告）

1. **不采信 coder 报告结论**：所有断言均以「我自己产生的原始输出」为准（存入 `tester/evidence/013_d11/`）。
2. **两套数据面**：
   - **生产库只读**（`127.0.0.1:5433/eestock`）：DB 实况、幂等复跑（**事务内 + ROLLBACK**）、schema/约束、表状态对拍。
   - **隔离探针库 `eestock_d11_probe`（新建，23 MB）**：全部**写入型**验收（三层解析实测、注册端点、
     工作台提交、跨通道对拍）只打探针库，**生产库零写入**（见 §9）。探针库由「按文件名顺序应用
     0001..0025 全量迁移 + 从生产库只读拷入 44 行 symbols / 3 行 fee_profiles / 510050 近 120 天 M1」
     构成，与生产库同构。
3. **既有 tester 夹具模式复用**：真 axum 路由 + 真 HTTP（MCP SSE `server::build_router` /
   web `build_router`），**生产同构装配**（`.with_fee_profiles(PgFeeProfileStore)`）。
   夹具源归档于 `tester/evidence/013_d11/fixtures/`（验收后已从 `crates/*/tests/` 移出，
   避免在非探针库环境误判失败——见 §10.4）。

---

## 2. 验收项 ①：DB 实况、约束、迁移幂等（全部通过）

| 子项 | 期望 | 实测 | 证据 |
|---|---|---|---|
| 类型分布 | 42 etf / 2 lof / 0 NULL | `etf 42｜lof 2`；`total 44 / null 0 / stock 0` | `01_db_type_distribution.txt` |
| `551000` | `etf` | `551000｜name=''｜etf｜60｜T1｜t` | `01_…txt`（name 为空 → §11.2） |
| `fee_profiles` 逐字段 | ADR §1.1/§1.2 | etf/lof `0.025｜5｜0｜0｜0｜0`；stock `0.025｜5｜0.00341｜0.002｜0.05｜0.001` | `31_adr_vs_db_fieldmap.txt` |
| 口径 note/source | 每行须说明口径 | etf/lof：`全佣`/`不得叠加`/`不征`/`免收` 四项全 t，source 含 ADR-019+深交所+中国结算；stock：source 含 ADR-019 | `31_…txt` |
| 保留位不播种（D11-6） | 0 行 | `reserved_rows = 0` | `31_…txt` |
| CHECK 枚举 | 存在且限 6 值 | `symbols_type_check CHECK (type IS NULL OR type = ANY('etf','lof','stock','bond_etf','money_etf','index'))`；`fee_profiles_type_check` 同 6 值；6 个数值列各带 `>= 0` CHECK | `02_db_schema_objects.txt` |
| **type 无默认值（A2）** | `column_default IS NULL` 且可空 | `information_schema` → `is_nullable=YES`、`column_default=NULL`；直接判定查询输出 `true` | `02_…txt`、`11_fresh_db_init.txt` |
| 无外键 | 0 条指向 fee_profiles | `pg_constraint contype='f'` → 0 行；仅 `fee_profiles_pkey` | `02_…txt` |
| 枚举强制 | 非法值被拒 | `INSERT …'foo'` → `ERROR: violates check constraint "symbols_type_check"` | `03_db_check_constraint.txt` |
| 保留位可登记 | 3 值被接受（事务内） | `bond_etf/money_etf/index` 三行 SELECT 可见 → ROLLBACK，残留 `ZZTEST%` = 0 | `03_…txt` |

**幂等（在事务内重复执行 → ROLLBACK）**——`05/06/07/08`：

1. **复跑命令标签**：`ALTER TABLE / DO / UPDATE 0 / CREATE TABLE / INSERT 0 0` + 两条 NOTICE *skipping*
   → 回填仅填 NULL、播种 `ON CONFLICT DO NOTHING`（`05_migration_rerun.txt`）。
2. **零变更、零污染（全状态对拍）**：复跑前后分别快照「44 行 symbols（code/name/interval/settlement/
   enabled/created_at/type）+ 3 行 fee_profiles（含 `updated_at` 与 `xmin`）」→ `NO-DIFF`，47 行 vs 47 行逐字节一致
   （`06_idempotent_diff.txt`）。
3. **DDL 主体仍有效（防「无操作假幂等」）**：事务内先 `DROP CONSTRAINT / DROP COLUMN type / DROP TABLE fee_profiles`
   再执行迁移 → `ALTER TABLE / DO / UPDATE 44 / CREATE TABLE / INSERT 0 3`，重建成
   `null_type=0｜etf=42｜lof=2`、`profiles=3`、`551000=etf`、`column_default_is_null=true`、`check_exists=true` → ROLLBACK
   （`07_migration_fresh_rebuild.txt`）。**证明已提交态确由该迁移产生。**
4. **幂等语义**：事务内人工改判 `510050→stock`、清空 `518880→NULL`，复跑迁移 → `510050` 仍 `stock`（不覆盖人工值）、
   `518880` 回补为 `etf`（补 NULL）（`08_migration_idem_semantics.txt`）。
5. **既有 44 行其它字段未被改动**（独立复核 coder 证据，非复述）：
   当前库 `code,name,interval_secs,settlement,enabled,created_at` 导出 **与 coder `symbols_before_migration.tsv` 逐字节一致；
   `before` vs `after` TSV 亦零差异** → 纯加法迁移（`27_independent_tsv_check.txt`）。
6. **全新库（initdb 路径）**：空库上按序应用 `0001..0025` 全 25 个迁移 **全部 OK**；0025 回填 **0 行**（symbols 为空）、
   播种 3 行、`type` 可空无默认、CHECK 存在。**且新库播种的 3 行（含 note/source 全文）与生产库逐字节一致**
   （`11_fresh_db_init.txt`、`12_probe_db_load.txt`）。

---

## 3. 验收项 ②：三层解析语义（全部通过，含自建 `type=NULL` 实测）

探针库真库 + 真 K 线（510050 D1，63 bar），MCP `strategy_test_run`（省略/显式 fee）：

### ① 省略 fee → profile

```json
{"rate_pct":0.025,"min_fee":5.0,"slippage_bp":2.0,"stamp_duty_pct":0.0,
 "source":"profile","symbol_type":"etf",
 "profile":{"type":"etf","commission_rate_pct":0.025,"min_fee":5.0,
            "exchange_fee_pct":0.0,"regulatory_fee_pct":0.0,"stamp_duty_pct":0.0,
            "transfer_fee_pct":0.0,"note":"…全佣…不得叠加…不征…免收…","source":"ADR-019 §1.1/§5…"}}
```
成交侧：`n_trades=1｜stamp_sum=0.0｜pnl=-323.6235｜bar_count=63` → **ETF 印花税=0、过户费=0、规费列 0**
（`mcp_B1_profile_test_run.json`、`14_mcp_channel_run.txt`）。

### ② 显式 fee → explicit（缺 stamp 仍 0.05，旧行为完全可复现）

`{"rate_pct":0.025,"min_fee":5.0,"slippage_bp":2.0}` → `source="explicit"`、`stamp_duty_pct=0.05`、
`stamp_sum=49.7896`、`pnl=-373.4130`。另测显式 `stamp_duty_pct=0.0` → 生效 0（`source=explicit`）。
→ **同一 ETF 同配置 Δpnl = +49.79 元**，方向与 ADR-019 背景（旧口径低 50.83 元/3.2%）一致
（`mcp_B2_explicit_test_run.json`）。

### ③ 无档案 → 旧默认 + `source="default"`（**自建 type=NULL 实测**）

| 场景 | 构造方式（探针库，测后清理） | 结果 |
|---|---|---|
| **type 字面 NULL** | `INSERT INTO symbols(code…enabled) VALUES('999999',…)` 不传 type → DB 回读 `type=NULL`（证明无默认值） | `source="default"｜symbol_type=null｜stamp_duty_pct=0.05｜无 profile 键` |
| 类型合法但**无档案行** | `UPDATE symbols SET type='bond_etf'`（D11-6 保留位，无 fee_profiles 行） | 同上（不借用他类型档案） |
| 对照：type=etf | `UPDATE symbols SET type='etf'` | 立刻变 `source="profile"｜stamp_duty_pct=0.0` |
| 清理 | `DELETE FROM symbols WHERE code='999999'` | `left=0` |

证据：`mcp_B3b_type_null_default.json`、`mcp_B3c_no_profile_row_default.json`、`14_mcp_channel_run.txt`。
另：MCP 层注册表门禁（D9）未回归 —— 未注册标的一律 `isError=true`「标的 999999 未注册…」（`B3a`）。

**web 通道补充**：未注册但**有真实 K 线**的标的（`999999`，无 symbols 行）经
`POST /api/strategies/test-run` → `source="default"｜stamp 0.05`（web 试算无注册表门禁，走服务层同一解析点）
（`web_H3_unregistered_default.json`）。

**单测覆盖声明**：coder 的 `fee::tests::missing_fee_and_unknown_type_falls_back_to_legacy_default` 等 7 个
单测存在且在全量运行中通过；但我**未以单测作为第三级证据**，而是按任务要求构造了真库 + 真 K 线的 NULL 用例（上表）。

---

## 4. 验收项 ③：双通道口径一致性（通过）

**结论：MCP 与 web REST 走同一解析点，同一配置两通道结果逐字节一致。**

```
--- ① 试算省略 fee（510050 → profile）---   fee 逐字段一致: True
   MCP/WEB 口径 = {'bar_count':63,'warmup_requested':0,'warmup_effective':0,
                   'n_trades':1,'stamp_sum':0.0,'pnl_sum':-323.623466}
--- ② 试算显式 fee（→ explicit）---        fee 逐字段一致: True
   MCP/WEB 口径 = {'bar_count':63,…,'stamp_sum':49.789572,'pnl_sum':-373.413039}
--- ③ 工作台提交省略 fee ---
   MCP bt_run_ensemble config.fee == WEB POST /api/workbench/runs config.fee == WEB GET /api/workbench/runs/{id} config.fee : True
--- ④ 第三级 default --- MCP(type=NULL) == WEB(未注册) : True
=== 结论：一致（同一解析点，无双份策略） ===
```
（`16_cross_channel_diff.txt`；原始载荷 `mcp_B1/B2/C_*.json`＋`web_H1/H2/H3/I1/I2_*.json`）

**静态佐证（无双份策略）**——`13_single_resolution_point.txt`：
- `resolve_fee` 调用方仅 2 处，都在 application 服务层：`strategy.rs:697`、`workbench.rs:280`；
  执行回填路径 `workbench.rs:692` 从**已钉住**的 `config.fee`（含 stamp）还原，不会二次注入 0.05。
- 传输层硬编码缺省已删除：`mcp::tools::default_fee_json` / `default_test_run_fee` 与
  `web::strategies::default_test_run_fee` **0 命中**；web 工作台只在**显式传入**时做形状校验。
- `PgFeeProfileStore` 装配点 = `crates/app/src/bin/eestock-app.rs` 2 处（StrategyService + WorkbenchService）
  ——MCP 与 web **共享同一服务实例**。

---

## 5. 验收项 ④：回显（通过）

- 生效 fee **明细 + `source`（三值）**：试算响应与工作台钉住快照均含
  `rate_pct/min_fee/slippage_bp/stamp_duty_pct/source/symbol_type`，解析到档案时附
  `profile{type,commission_rate_pct,min_fee,exchange_fee_pct,regulatory_fee_pct,stamp_duty_pct,transfer_fee_pct,note,source}`。
- `list_symbols`（MCP）：44 行全部含 `type` 字段（42 etf / 2 lof / 0 null），`510050.type="etf"`
  （`mcp_A_list_symbols.json`）。
- `GET /api/symbols`：44 行全部含 `type`（42/2/0），`510050.type="etf"`（`web_E_api_symbols.json`）。
- 二者与库一致（与 §2 DB 分布同值）。

---

## 6. 验收项 ⑤：注册端点 `type` 可选 + 枚举校验（通过）

| 用例 | 结果 | 证据 |
|---|---|---|
| `POST /api/symbols` **不传 type**（既有调用形态） | `201`；响应 `type=null`；DB 回读 `type IS NULL`；`interval_secs=60 / settlement=T1 / enabled=true` 语义不变 | `15_web_channel_run.txt` F1 |
| 非法枚举 `"foo"/"ETF"/"stockx"` | 均 `400`，报文 `type 须为 etf/lof/stock/bond_etf/money_etf/index 之一，got …` | F2（4 次，含逐个「被拒请求 DB 未落库」校验） |
| 空串 `""` | `400`，专用报文「type 不可为空串（省略该字段 = 保持/未知；本批不支持经 API 清空 type）」 | F2 |
| 合法枚举 `"etf"` / 保留位 `"index"` | `201`，DB 落库 `etf` / `index` | F3 |
| `PATCH /api/symbols/{code}` `type="stock"` | `200`，回读 `type=stock` | G1 |
| PATCH 只传 `enabled`（不给 type） | `type` **保留**（`COALESCE`），`enabled=false` 生效 | G2 |
| PATCH `type="bogus"` / `""` | `400`，且 DB 未被改动（仍 `stock`） | G3 |

---

## 7. 验收项 ⑥：回归（全部通过）

| 检查 | 命令 | 结果 |
|---|---|---|
| Rust 全量 | `cargo test --workspace` | **641 passed / 0 failed / 1 ignored**，94 个 test result 目标，rc=0 —— **与报告声称的 641 完全一致**（`24_cargo_test_workspace.txt`、`25_workspace_test_summary.txt`） |
| D11 相关目标 | — | `d11_fee_profile_e2e 1 passed`、`fee_profile_store 1 passed`、`symbol_type_fee_migration 1 passed`、`api_admin 3 passed`；既有夹具 `zz_tester_010_acceptance / zz_tester_010_web / zz_tester_011_f2_path` 均 ok（`28_existing_fixture_status.txt`） |
| 前端类型检查 | `cd web && npx tsc -b --force` | rc=0，0 error（`22_fe_tsc.txt`） |
| 前端单测 | `cd web && npx vitest run` | **47 files / 457 passed**，rc=0（`23_fe_vitest.txt`） |
| tangle 门禁 | `./scripts/check-tangle.sh` | rc=0「✅ 沙箱重新生成 + 逐字节比对通过；工作区未被修改」；跑前/跑后 `git status` 完全一致（`21_tangle_gate.txt`） |
| **0 staged** | `git diff --cached --name-only` | 输出为空（`26_churn_and_debt_scope.txt`） |
| 无关格式 churn | `git diff --stat` vs `--ignore-all-space` | 1338/167 vs 1343/172：**唯一**空白差异集中在 `crates/web/src/workbench.rs` 的 5 行 **重缩进**（新增 `if let Some(fee)` 包裹导致），属改动本身的必然结果，**非无关 churn**（`20_whitespace_churn.txt`） |
| 小改动文件逐个人工核 | `git diff` | `crates/alert/*`、`mcp/mocks.rs`、`mcp/tests/*`、`application/tests/simlive.rs` 等仅为 `SymbolLatestView` 新增字段 `type_` 的**夹具补字段**；`design/*` 为 tangle 源块同步；无夹带（`10_small_diffs.txt`） |
| 验收过程零实现改动 | 前后 tracked 修改集合对拍 | 36 个文件集合**完全一致** |

---

## 8. 验收项 ⑦：生产未受影响（通过）+ 新行为需部署（已确认）

| 检查 | 实测 | 证据 |
|---|---|---|
| PID 未变 / 未重启 | `eestock-app` **PID 3696673**，启动 **Fri Sep 11 11:24:16**（早于 9/12 的 D11 改动）；`eestock-data` PID 515249 未变 | `17_prod_unaffected.txt`、`29_prod_final_recheck.txt` |
| `:8081` healthz | `{"status":"ok"}` http=200 | 同上 |
| `:8080`（数据面 healthz） | `{"status":"ok"}` http=200 | `29_…txt` |
| `:8082` 行为未变 | 工具数 **33**（同验收开始时）；`bt_run_ensemble.fee` 描述仍为旧文案「缺省 {0.025, 5.0, 2.0}（ADR bt-1 默认）…」，**不含 "ADR-019"** | `18_prod_8082_old_behaviour.txt`、`29_…txt` |
| **生产仍是旧口径** | 生产 `strategy_test_run(510050, 省略 fee)`：响应**无 `fee` 键**（该运行映像更早，连 I-3 的 fee 回显都未部署），`stamp_sum=49.7896`、`pnl_sum=-373.4130`；D11 profile 口径应为 `stamp 0`、`pnl -323.6235` | `18_…txt` |
| 部署必要性取证 | 磁盘二进制 `target/debug/eestock-app` mtime = `2026-09-12 21:26:33`（已被重建），但**运行映像是 9/11 启动的进程** → 新行为**必须重新部署/切换进程才生效** | `17_…txt` |
| DB 已就绪、运行时未生效 | `symbols.type`（42/2/0）与 `fee_profiles`（3）已在生产库；旧二进制忽略二者 | §2 + `29_…txt` |
| 残留测试标的 | `symbols LIKE '99%'/'t13%'/'ZZTEST%'` = **0** | `29_…txt` |
| 测试套件对 D11 表零写入 | 套件前后 `44 symbols / 3 profiles / 0 null` 对拍 NO-DIFF | `25_workspace_test_summary.txt` |

---

## 9. 验收项 ①-⑧ 的「生产库零写入」自证

- 我**未**向生产库写入任何 D11 / symbols / fee_profiles 数据：幂等与保留位用例全部包在 `BEGIN … ROLLBACK`；
  失败 INSERT 被 CHECK 拒绝（无行）；其余全为 SELECT。
- 全部写入型验收在独立探针库 `eestock_d11_probe`（23 MB，由迁移 + 只读拷数构成）执行。
- 唯一在生产库产生写行为的动作是 `cargo test --workspace`（与 coder 及历次 tester 同口径）；
  我已对拍 D11 关键表证明其**未改动** `symbols`/`fee_profiles`。
- 探针库与归档夹具为环境残留，清理方式：`DROP DATABASE eestock_d11_probe;` 与删除 `tester/evidence/013_d11/fixtures/`（二者均不影响生产）。

---

## 10. 验收项 ⑧：未覆盖 / 未验证声明（**显式列出**）

1. **`backtest::FeeModel` 未扩展（D11-follow-up 债务）**：`crates/backtest` **零修改**，`FeeModel` 仍是
   `commission_rate_pct / min_commission / stamp_duty_pct / slippage_bp` 4 字段；
   `fee_model_from_profile` 只消费佣金/最低/印花税，`exchange_fee_pct`/`regulatory_fee_pct`/`transfer_fee_pct`
   **入库但未建模、未参与撮合**。→ 已独立确认债务真实存在（`26_churn_and_debt_scope.txt`）。
2. **`551000` 的 `name` 仍为空串**（`name=''`）；不影响 `type=etf` 与费率。
3. **股票标的实际未注册**：`type='stock'` 计数 = 0；stock 档案已按 ADR §1.2 播种但**无真实标的验证**，
   仅以 D11-6 保留位与探针库构造验证三级回退。
4. **债券/货币 ETF 经手费豁免（D11-6）未建模**：保留位 `bond_etf/money_etf/index` 在 `fee_profiles` **0 行**；
   对应标的一律回退旧默认（我已实测该回退路径）。
5. **`symbols.type` 无 MCP 写入通道**：MCP 仅 `list_symbols` 读；type 只能经 web `POST/PATCH /api/symbols` 或 SQL 设置。
6. **未验证**：港股通/恒生系 ETF 的 `settlement`（T0/T1）历史存疑（coder 报告 §8 残留风险 2）——与 D11 无关，本次未核。
7. **未验证**：`fee_profiles` 的 `note/source` 中引用的外部事实来源（《印花税法》第三条、深交所 2026-01 收费表、
   中国结算代收税费表、券商公示）**内容真实性未独立复核**——本次只核「与 ADR-019 §1 一致、字段齐备、口径说明存在」。
8. **未验证**：`profile` 内三项规费在**未来**建模后的叠加口径（属 D11-follow-up 范围）。
9. **未做端到端 UI 验证**：`SymbolsGrid.tsx` 新增可选 `type` 仅以 `tsc` + `vitest` 通过为据，
   未跑 Playwright/浏览器实测（本任务未要求）。

---

## 11. 发现（非阻塞，供架构师裁量）

1. **[文档陈旧]** `coder/report/147_d11_classification_review.md` 头部仍写「状态：⏳ 待架构师复核」「**未写入数据库**…
   执行前须经复核批准」，而迁移**已应用**、主报告 §1/§7 记为「已复核批准并执行」。→ 建议同步头部状态，避免后续误判。
2. **[计数不符]** 任务书称「18 个 design 事实源文档」；实测 **10 个 modified + 1 个新增 ADR-019 = 11**，
   与 coder 报告自述「10 个 design/ 事实源文档」一致。→ 任务书数字疑为笔误，非实现问题。
3. **[回显语义可被误读]** 响应 `fee.profile` 同时回显 `exchange_fee_pct/regulatory_fee_pct/transfer_fee_pct`
   （stock 档案为 0.00341/0.002/0.001），但**引擎未应用**这三项。虽有 note/ADR 说明，字段本身**无
   `applied/not_modeled` 标记**，调用方可能误读为「已计入成本」。→ 建议 D11-follow-up 或加显式标记。
4. **[口径字段偏离字面事实]** `fee_profiles.etf/lof.exchange_fee_pct = 0`，而 ADR §1.1 列出事实值 0.04‰；
   这是 ADR §1.1「全佣口径警示」下的**有意约定**（note 已写明「不得叠加」），但严格按 §1 数值表逐字段核对时会表现为不一致。
   → 建议在 ADR §1.1 表内直接标注「入库存 0」以消歧。
5. **[既有 tester 夹具断言漂移]** `crates/mcp/tests/zz_tester_010_acceptance.rs:566` 断言
   `fee.stamp_duty_pct == 0.05`（针对真实 ETF `518880`）。该夹具**未装配** `fee_profiles`，故今日仍通过（本次全量已证）；
   但若按生产装配复验，缺省应为 `0.0 + source=profile`。→ 需同步断言（coder 待办 §7-3 已登记）。
6. **[环境残留]** 探针库 `eestock_d11_probe`（23 MB）与 `tester/evidence/013_d11/fixtures/`（2 个归档夹具）保留以便复现；
   两夹具已从 `crates/*/tests/` 移出，**不会**影响任何环境下的 `cargo test --workspace`（否则它们会因要求探针库而失败）。
   归档唯一日志文件 `14_mcp_channel_run_summary.txt` 为中间态截断版，权威日志为 `14_mcp_channel_run.txt`。

---

## 12. 原始证据清单（`tester/evidence/013_d11/`）

| 编号 | 文件 | 内容 |
|---|---|---|
| 01–03 | `01_db_type_distribution.txt` / `02_db_schema_objects.txt` / `03_db_check_constraint.txt` | DB 分布、schema/约束/默认值、CHECK 强制与保留位 |
| 04–08 | `04_state_{before,after,post}.txt` / `05_migration_rerun.txt` / `06_idempotent_diff.txt` / `07_migration_fresh_rebuild.txt` / `08_migration_idem_semantics.txt` | 幂等（全状态对拍 / 命令标签 / 事务内重建 / 语义） |
| 09–10 | `09_git_diff_stat.txt` / `10_small_diffs.txt` | 改动面 36 文件 + 小改动逐个人工核 |
| 11–12 | `11_fresh_db_init.txt` / `12_probe_db_load.txt` | 全新库 initdb 路径 + 探针库装载与逐字节对拍 |
| 13 | `13_single_resolution_point.txt` | 单点解析静态佐证（无双份策略） |
| 14–15 | `14_mcp_channel_run.txt` / `15_web_channel_run.txt` | MCP / web 通道原始运行日志（`EV …` 行） |
| 16 | `16_cross_channel_diff.txt` | 双通道逐字段对拍结论 |
| 17–19 | `17_prod_unaffected.txt` / `18_prod_8082_old_behaviour.txt` / `19_prod_db_binding.txt` | 生产未受影响 + 生产旧口径取证 |
| 20–29 | `20_whitespace_churn.txt` … `29_prod_final_recheck.txt` | 空白 churn / tangle / tsc / vitest / 全量测试 / 债务范围 / TSV 复核 / 既有夹具 / 生产终检 |
| 30–31 | `30_prod_db_residue_scan.txt` / `31_adr_vs_db_fieldmap.txt` | 生产库残留扫描 / ADR §1 逐字段对拍 |
| JSON | `mcp_A_list_symbols.json`、`mcp_B1|B2|B3b|B3c_*.json`、`mcp_C_bt_run_ensemble.json`、`web_E/H1/H2/H3/I1/I2_*.json` | 双通道原始响应载荷 |
| fixtures | `fixtures/zz_tester_013_d11_{mcp,web}.rs` + `README.md` | 本次独立验收夹具（归档 + 复现步骤） |

---

## 13. 复现命令（reviewer 快速核对）

```bash
cd eestock-rs
# 只读 DB 实况
PGPASSWORD=eestock psql -X -q postgres://eestock:eestock@127.0.0.1:5433/eestock \
  -c "SELECT coalesce(type,'(NULL)'),count(*) FROM symbols GROUP BY 1;" -c "TABLE fee_profiles;"
# 幂等（事务内复跑 + 回滚；零污染）
psql -X -v ON_ERROR_STOP=1 postgres://eestock:eestock@127.0.0.1:5433/eestock \
  -c "BEGIN" -f migrations/0025_symbol_type_fee_profiles.sql -c "ROLLBACK"
# 门禁 / 回归 / 前端
./scripts/check-tangle.sh
cargo test --workspace
(cd web && npx tsc -b --force && npx vitest run)
# 生产（只读）
curl -sS http://127.0.0.1:8081/healthz
ps -o pid,lstart,cmd -p 3696673
# 探针库夹具（写入型验收；见 tester/evidence/013_d11/fixtures/README.md）
```

---

## 14. 残留风险（合并后需知）

| # | 风险 | 等级 | 说明 / 缓解 |
|---|---|---|---|
| R1 | 生产仍跑旧口径（DB 已就绪、运行时未生效） | **中** | 新旧行为并存期：同一 ETF 同配置 pnl 相差 3.2%；部署顺序必须「先迁移（已完成）→ 再部署」。部署前 `strategy_test_run` 对 ETF 仍多收印花税。 |
| R2 | 三项规费（经手费/证管费/过户费）入库未建模，但回显在 `fee.profile` 内 | 低 | 可能被调用方误读为「已计入」；ADR + note 有说明，但无机器可读标记（§11.3）。 |
| R3 | `symbols.type` 为 NULL 的标的（含 `551000` 之外的未来新标的）永远回退股票口径 | 低 | 已按 A2 显式回显 `source="default"`，不静默错判；但需运营侧补录 type。当前 44 只已全部回填、0 NULL。 |
| R4 | `type` 缺失时 ETF 仍按股票口径计费（回退路径） | 低 | 设计意图（A2），不是缺陷；但**新注册标的若忘传 type 会得到错误口径**——注册端点表单/文档已提示，建议运营 SOP 强制填。 |
| R5 | 既有 tester 夹具断言与生产装配口径漂移（§11.5） | 低 | 今日不影响 CI；切换装配后须同步，否则会误判回归。 |
| R6 | 全量测试跑在共享库（与生产 app 同库），会写应用面测试夹具 | 低 | 与 coder/历次批次同口径；本次已证 `symbols`/`fee_profiles` 零改动。长期建议独立测试库。 |
| R7 | 外部费率事实（§10.7）未独立复核 | 低 | 结论依赖 ADR-019 §1 与 note/source 引用；若法规变化需重核。 |
| R8 | 文档陈旧/计数不符（§11.1、§11.2） | 极低 | 纯文档，不阻塞合并。 |
