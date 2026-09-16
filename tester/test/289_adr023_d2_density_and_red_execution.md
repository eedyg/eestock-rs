# 289 — ADR-023 D2 阶段一（实测密度比 + D2 红测试）—— **执行报告**

- 本文件位置（绝对路径）：`/home/eestock/workspace/git/eestock/eestock-rs/tester/test/289_adr023_d2_density_and_red_execution.md`
- 类型：**Execution report**（执行本轮**新设计并新编写**的探针与新红测试；设计见 `tester/design/289_adr023_d2_density_and_red_design.md`）
- 证据目录（原始测量 JSON + 逐条命令输出 + 截图）：`/tmp/adr023-d2-red-20260916T152240Z/EVIDENCE.md`
- 仓库/提交：`/home/eestock/workspace/git/eestock/eestock-rs` @ `3094018f352dae25752340d78b5e108c284aeecc`（工作区含 D1 未提交改动；**本轮零实现改动**）
- 运行时间：2026-09-16 23:21 → 24:00（+08:00）≈ **38 分钟总墙钟**（⚠️ **超出 30 分钟时间盒 ~8 分钟**；但**第一步实测在 ~16 分钟处即已完成**并落盘 `probe_result.json`，第二步红测试与回归亦全部跑完 ⇒ 未出现「盒内无法完成实测」的情形，故不报 INCONCLUSIVE；超支来自探针两轮返工：klinecharts 10.0.3 必须 `setSymbol`+`setPeriod({type,span})` 才触发取数、`getVisibleRange().realTo` 越过 `n-1` 需 clamp 计数、以及「同窗」需区分 `D_ceil`/`D_floor` 双口径）
- 环境：只读 `GET http://127.0.0.1:8081/api/kline`（5 次）；探针本地静态页 + Playwright Chromium；**未触达活库写路径**、未重启/未杀 PID 68833、未 `git add/commit/stash`、未改 `design/**` 与任何 `file=` 生成物、探针全部在 `/tmp`（仓库零残留）

---

## 0. 结果总览（Total / Passed / Failed / Skipped）

| 轮次 | 命令 | 结果 | 崩溃/core |
|---|---|---|---|
| 第一步 · 密度实测（真渲染，3 组合 × 15 设置 + 4 重复） | `node run.mjs /tmp/adr023-d2-red-<ts>` | **3/3 组合完成**；`pageErrors=[]`、`externalRequests=[]`、两侧 `getSize().width=520` | 0 / 0 |
| 第二步 · Rust 新红目标 | `cargo test -p web --test period30m_d2_multiperiod_red --no-fail-fast` | **6 total / 2 passed / 4 failed / 0 skipped**；**编译成功** | 0 / 0 |
| 第二步 · 前端新红文件 | `cd web && npx vitest run src/features/dashboard/period30mD2.test.ts` | **14 total / 5 passed / 9 failed** | 0 / 0 |
| 回归 · 前端全量（含新文件） | `cd web && npx vitest run` | `Test Files 1 failed \| 87 passed (88)`；`Tests 9 failed \| 819 passed (828)` | 0 / 0 |
| 回归 · 前端基线（扣除新文件 14 条） | 同上推算 | **814 passed / 0 failed（87 文件全绿）** | 0 / 0 |
| 回归 · Rust lib 全量 | `cargo test --workspace --lib --no-fail-fast` | **15 目标 / 276 passed / 0 failed / 0 ignored**（与 D1 基线一致） | 0 / 0 |
| 回归 · Rust 全目标编译 | `cargo test --workspace --no-run --no-fail-fast` | 全部测试目标（含新增）编译成功，**0 error** | 0 / 0 |
| 只读纪律 · `app_config` | `psql -Atc "select key,value::text,updated_at from app_config order by key"`（浏览器会话**前/后**各一次） | before/after **逐字节相同**（`diff` 空 ⇒ `APPCONFIG-UNCHANGED`）；sha256 前16 = `6174911902688d0e` | — |

---

## 1. 第一步：D(1m→30m) 实测（**完成，非 NOT-DONE**）

### 1.1 结果

| 项 | 实测值 | 来源 |
|---|---|---|
| **`D(1m→30m)`（建议入表）** | **24.1** | K=8/K=16 等时窗中位数（**既有 5 条表值同法**）= 24.1；逐整日 `241/10` = 24.1（4 个整日全同） |
| 真渲染同窗取样（day 尺度，窗内 ≥5 根 30m bar） | `D_ceil ∈ [20.17, 26.67]`、day 尺度中位 **24.25**；`bs=1`（480 根基准，2 天量级窗）`D_ceil = 25.2632` / `D_floor = 24.0` ⇒ 24.1 被**夹在中间** | `probe_result.json` |
| 离散度 | day 尺度包络 **[24.0, 25.3]**（±1.2）；全样本包络 [11, 27]（含退化窗，`nSat ∈ {0,1}` 的窗不计入结论） | 同上 |
| 可复现性 | `bs ∈ {1,2,4}` 重复 3/2/2 次 ⇒ **逐位一致**（如 `1m:30m bs=1` = 25.2632 ×3） | 同上 |
| **`D(15m→30m)`（交叉自洽）** | 真渲染同窗 **1.7826…1.8889**（窗内 ≥5 根卫星 bar：**1.7941…1.8056**）；K8/K16 中位 **1.800**（30 个窗） | 同上 |
| 自洽校验 | `D(1m→30m)/D(1m→15m)` = `24.1/13.389` = **1.800** == 直接实测 `D(15m→30m)` = **1.800** | 同上 |
| 旁证（**不入表**） | `241/10 = 24.1`（与实测同值，但仅作自洽，不作依据） | 逐日计数 |
| 名义周期比（**禁入表**） | 30（实测 24.1 ≠ 30 ⇒ 名义比会使卫星 barSpace 高 24%，超出容差） | — |

**逐交易日几何（真实 API 数据）**：1m **241**/日、15m **18**/日、30m **10**/日（含 `03:30`、`07:00` 两个「会话末打印」1 根薄桶；`limit=1000` 首日 2026-09-10 仅 36 根 1m 属截断残段）。

### 1.2 方法与原始证据

- 探针页 `/tmp/adr023-d2-red-<ts>/probe.html`（两个 520px klinecharts 10.0.3 实例）、驱动 `run.mjs`（本地静态服务器 + Playwright）、原始数据 `data/kline_{1m,5m,15m,30m,1h}.json`、结果 `probe_result.json`、截图 `shot_{1m_30m,15m_30m,1m_15m}.png`。
- 逐 barSpace 明细、K8/K16 逐窗明细（含窗口起止、`nB`、`nS`、比值）、`D_ceil`/`D_floor` 双口径表：**全部原样在 `EVIDENCE.md` §1.2/§1.3/§1.4**。
- 同窗对齐：读基准真渲染视窗 → 反查 ts 区间 → 卫星 `barSpace` 迭代收敛到同一日历窗 → 读两侧**实际渲染 bar 数**（`getVisibleRange()` 的 `realTo` 会越过 `n-1`，已按「实际存在的数据索引」clamp 后计数）。

### 1.3 纪律核对

| 项 | 结果 |
|---|---|
| **真渲染**（非静态源码/非算术） | ✅ 两侧 `getSize().width === 520`、`pageErrors=[]`、截图落盘 |
| **未按名义周期比兜底** | ✅ 全流程只读渲染 bar 数；表值 24.1 ≠ 30 |
| **未拿「日根数比」当实测** | ✅ 日根数比仅作**旁证/自洽**（§1.1 单列），建议值由等时窗中位数 + 真渲染同窗双口径支撑 |
| 数据只从只读 API 取 | ✅ 5 次 GET（curl） |
| 探针/脚本零仓库残留 | ✅ 全在 `/tmp`（`git status` 无新增未跟踪探针文件） |
| `app_config` 快照（§6.2） | ✅ 浏览器会话**前/后**均取，逐字节相同 |
| 未点击自发写配置的 UI | ✅ **全程未开任何 app 页面**（探针页只访问本地静态端口，`externalRequests=[]`） |

---

## 2. 第二步：D2 红测试（新增文件 + 逐条红证据）

### 2.1 新增文件清单（**仅手写**；未改既有测试/实现/生成物）

| # | 文件 | 用例数 |
|---|---|---|
| 1 | `crates/web/tests/period30m_d2_multiperiod_red.rs`（Rust 集成，新建） | 6 |
| 2 | `web/src/features/dashboard/period30mD2.test.ts`（vitest，新建） | 14 |

### 2.2 失败用例表（逐条 + crash/core 标志）

**Rust**（`red_rust_newfile.txt`）：**2 passed / 4 failed；编译成功 ⇒ 红因是「实现缺失」而非「测试写错」**

| # | 用例 | 消息（原始，节选） | crash/core |
|---|---|---|---|
| B1 | `d2a_multi_period_allowed_contains_30m_between_15m_and_1h` | `ADR-023 §2.5：D2 必须把 "30m" 加入 MULTI_PERIOD_ALLOWED；实际 = ["1m", "5m", "15m", "1h", "1d", "1w"]` | 否 |
| B2 | `d2b_rank_30m_is_between_15m_and_1h_via_validate` | `基准 15m + 卫星 30m 必须合法（rank(30m) ≥ rank(15m)）；实际 = Err("periods 卫星周期非法（须 ∈ ["1m","5m","15m","1h","1d","1w"]）：30m")` | 否 |
| B3 | `d2c_validate_accepts_config_containing_30m_and_echoes_it` | `PUT/校验路径必须接受含 30m 的配置；实际 = Err(…30m)` | 否 |
| B4 | `d2e_put_multi_period_with_30m_must_not_be_400` | `PUT /api/config/multi_period periods=[15m,30m] 实际状态码 = 400 body = {"error":"periods 卫星周期非法（须 ∈ ["1m","5m","15m","1h","1d","1w"]）：30m"}`（`left: 400 / right: 400`） | 否 |
| B5 | `d2d_pane_count_and_dedup_semantics_unchanged_with_30m` | **ok（绿护栏）** | 否 |
| B6 | `d2f_1mo_still_not_offered_after_30m_lands` | **ok（绿护栏）** | 否 |

**前端**（`red_frontend_newfile.txt`）：**5 passed / 9 failed**

| # | 用例 | 消息（原始，节选） | crash/core |
|---|---|---|---|
| F1 | `选择器清单 > 含 '30m' 且完整顺序` | `实际 = ["1m","5m","15m","1h","1d","1w"]: expected … to deeply equal [ Array(7) ]` | 否 |
| F2 | `选择器清单 > 30m 严格位于 15m 与 1h 之间` | `索引必须满足 15m < 30m < 1h；实际 = 2/-1/3: expected -1 to be greater than 2` | 否 |
| F3 | `选择器清单 > periodBucketMs('30m') == 1800000` | **✓ 绿**（D1 已交付） | 否 |
| F4 | `密度表 > ['1m:30m'] == 24.1` | `表内必须新增实测锚点 '1m:30m'；实际 = undefined: expected undefined to be close to 24.1` | 否 |
| F5 | `密度表 > 值为正/落在包络/≠30` | `密度值必须为正有限数；实际 = undefined` | 否 |
| F6 | `composeDensity > 15m↔30m / 5m↔30m / 30m↔1h 非 null` | `composeDensity('15m','30m') 必须非 null（同 1m 锚点）；实际 = null` | 否 |
| F7 | `composeDensity > 漂移 ≤15%` | `合成 null vs 实测 1.8 ⇒ 漂移 100.0%` | 否 |
| F8 | `跨族护栏 > 拒绝 30m↔1d / 30m↔1w` | **✓ 绿（假绿）**：现因 `periodOrder('30m')===null` 而拒 ⇒ 由 F9 识别 | 否 |
| F9 | `跨族护栏 > 必须给出原因码（禁静默）` | `30m 已进入周期集 ⇒ 原因不得是 'unsupported-period'；实际 = unsupported-period` | 否 |
| F10 | `跨族护栏 > 卫星 < 基准（1h↔30m / 1d↔30m）` | `卫星 30m < 基准 1h: expected 'unsupported-period' to be 'satellite-lower-than-base'` | 否 |
| F11 | `反向护栏 > 既有 5 条逐字不变 + 键数 6` | `实际键 = ["1m:5m","1m:15m","1m:1h","1d:1w","1h:1w"]: expected 5 to be 6` | 否 |
| F12 | `反向护栏 > 1m↔1d/1m↔1w/含 1mo 既有拒绝仍成立` | **✓ 绿护栏** | 否 |
| F13 | `反向护栏 > 1h↔1w 仍拒（口径 10 不放宽）` | **✓ 绿护栏** | 否 |
| F14 | `反向护栏 > 既有放行组合仍放行` | **✓ 绿护栏** | 否 |

**无崩溃、无 core dump**：全部失败为断言失败（`exit 1` / `exit 101`），无信号终止、无 `core.*` 文件产生。

### 2.3 既有测试未破坏（回归）

见 §0：前端失败集合 == 新增文件 9 条（`1 failed | 87 passed`）；Rust `--lib` 276/0 与 D1 基线一致；`--no-run` 全目标编译 0 error。

---

## 3. 遗留 / 风险

| # | 项 | 说明 |
|---|---|---|
| R1 | **D1 越界护栏将被 D2 打破（预期）** | `crates/web/tests/period30m_scope_guard.rs`（`j9_*`：白名单不含 30m）与 `web/src/features/dashboard/period30m.test.tsx`（`J9`：选择器不含 30m）在 D2 落地后**必红**，须由父级在 D2 实现阶段授权改写/删除（本轮未动既有测试） |
| R2 | 密度表的**窗口相关性** | 真渲染取样在半天窗上给 20.2–26.7；表值取「整日/等时窗中位数」口径 24.1（与既有 5 条同口径）。备选 24.25（真渲染中位）亦可接受；**30 不可接受** |
| R3 | 合成 `15m↔30m` 漂移 **+9.7%** | `24.1/12.2 = 1.9754` vs 真渲染实测 `1.80`；根因是既有 `1m:15m=12.2` 取自老覆盖窗（当前数据同法实测 13.389，`24.1/13.389=1.800` 恰好吻合）。本轮**不改**既有条目（禁令），登记待裁决（建议后续单独立项校准既有 5 条） |
| R4 | Rust **集成**测试未跑全量 | 既有 `api_multi_period_config.rs` 等会**写**活库 `app_config` ⇒ 与本轮「零写」纪律冲突；故只跑 `--lib` + 全目标 `--no-run`。若需集成全量绿，须在隔离库/授权写库后另跑 |
| R5 | 探针只用单一标的 `518880` | 30m 桶几何（10/日）已由 ADR-023 §5.2 的独立 DB 实测佐证；未跨标的抽样 |
| R6 | 30m 的 **UI 可见化**与**真渲染同步闭环**未测 | 本轮只覆盖「数据/表值/守门/原因码」；`30m↔1d`、`30m↔1w` 的角标可见化与 30m 作基准的同步闭环属 D2 实现后验收 |
| R7 | Rust 集成测试装配随 `AppState` 字段变化需同步 | 新增目标复制了 `period30m_api_contract.rs` 的装配（既有惯例）；`AppState` 加字段时会编译失败（**红因可辨**） |

---

## 4. 红线遵守声明

未修改任何实现/接口/架构/设计文档；未改任何 `file=` 声明的 entangled 生成物；未改任何既有测试；未 `git add/commit/stash`；未 tangle/stitch/reset；未改 `.gitignore`；未连接/写入活库（Rust 用例 pool 指向不可达 `127.0.0.1:59999`，探针只读 API）；未重启/未杀线上 app（PID 68833）；未点击任何会自发写配置的 UI 入口（全程未开 app 页面）；**未做任何失败分析后的修复动作**（只观察与报告）。

**本报告位置**：`tester/test/289_adr023_d2_density_and_red_execution.md`

---

## 5. D2 第二阶段追加执行（2026-09-16 23:34 → 23:56；父级裁决 R3 升级 / R4 修复 / R1 授权）

### 5.1 追加实测（同一 P0.3 口径；证据 `EVIDENCE.md` §B1）
| 组合 | 真渲染同窗取样（day 尺度） | K8 / K16 中位 | 重复性 | **建议入表** | 名义比（禁） |
|---|---|---|---|---|---|
| `D(5m→30m)` | `D_ceil` 中位 5.0417（min 5.0 / max 5.6667）；包络 [4.84, 5.08] | **5** / **5** | bs=1/2/4 各 3/2/2 次**逐位一致** | **5.0** | 6 |
| `D(30m→1h)` | `D_ceil` 中位 1.6667（min 1.5714 / max 1.7）；包络 [1.63, 1.69] | **1.6667** / **1.6667** | bs=1/2/4 各 3/2/2 次**逐位一致** | **1.67** | 2 |

- 逐整日硬底：5m=50/日、30m=10/日、1h=6/日 ⇒ 5.000 / 1.667。
- 直接实测 vs 既有表值合成：`5m:30m` 5.0 vs 5.128（+2.6%）；`15m:30m` 1.8 vs 1.9754（**+9.7%**）；`30m:1h` 1.67 vs 1.5684（−5.9%）⇒ 印证父级判断，四条目直接化是 `effectiveDensity` 顺序缺陷的对症修法。
- 只读纪律：探针仍只访问本地静态端口（`externalRequests=[]`）、`pageErrors=[]`、pane 520px；`app_config` 会话前后 + 全部测试后终态**逐字节相同**。

### 5.2 追加红测试落地
| 内容 | 位置 |
|---|---|
| 四条直接条目 + 包络 + 非名义比 + 「齐备」 | `web/src/features/dashboard/period30mD2.test.ts`（`D30_DIRECT_ENTRIES` + describe） |
| 表键总数 5 → 9（既有 5 条逐字不动） | 同上（反向护栏 describe） |
| **不变量**：四个 30m 配对的 `densityByFollower[...].source === 'static'` 且 `ratio == 直接实测值` | 同上（「不变量」describe，4 条；真身 `ChartSyncGroup` + 忠实桩） |
| R4 自隔离 PUT（不可达 pool + 非 2xx + 活库只读前后快照 + 不一致先恢复再 panic） | `crates/web/tests/period30m_d2_multiperiod_red.rs::d2e` |

### 5.3 R4 自证（实跑原文）
```
[R4 守卫] 活库快照（只读）：value=Some("{\"enabled\": true, \"heights\": {\"1m\": 420}, \"periods\": [\"1m\"], \"indicators\": [\"dcap\"]}") updated_at=Some("2026-09-16 15:18:09.178116+00")
[证据] PUT /api/config/multi_period periods=[15m,30m] 实际状态码 = 400 body = {"error":"periods 卫星周期非法（须 ∈ [...]）：30m"}
[R4 守卫] 活库 app_config.multi_period 逐字节未变（value/updated_at 均相同）✔
```
（守卫 ③④ 已上移到契约断言之前 —— 首轮实跑发现红阶段 panic 会跳过守卫，已修正。）

### 5.4 R1 护栏改写（契约演进）前后 diff
| 文件 | 原件（before） | diff |
|---|---|---|
| `crates/web/tests/period30m_scope_guard.rs` | `EVIDENCE` 目录 `diff_scope_guard.before.rs` | `diff_scope_guard.diff`（84 行）：`j9_*`「不含 30m ×2 + 1mo 排除」→ `d2_*`「必须含 30m 且顺序 15m→30m→1h；1mo 仍排除；既有 6 档一档不少/恰 7 档」 |
| `web/src/features/dashboard/period30m.test.tsx` | `diff_period30m_tsx.before.tsx` | `diff_period30m_tsx.diff`（48 行）：J9 由「不含 30m」→「必须含 30m 且顺序 15m→30m→1h；既有 6 档一档不少；1mo 仍不提供」 |
两者均**无**任何护栏删除；被改写的只是「30m 应在/不应在多周期内」这一方向性契约，其余（`1mo`、跨族拒绝、原因码、既有档位完整性）**保留或加强**。

### 5.5 最终红/绿计数（本阶段实跑）
| 套件 | 结果 |
|---|---|
| Rust D2 新目标 `period30m_d2_multiperiod_red` | **2 passed / 4 failed**（`d2a`/`d2b`/`d2c`/`d2e` 红；`d2d`/`d2f` 绿护栏）；0 崩溃 |
| Rust 改写护栏 `period30m_scope_guard` | **1 passed / 2 failed**（新契约红；`1mo` 排除绿） |
| 前端新文件 `period30mD2.test.ts` | **5 passed / 16 failed（21）** |
| 前端 `period30m.test.tsx` J9 | **2 failed**（新契约） |
| 前端**全量** `npx vitest run` | `Test Files 2 failed \| 86 passed (88)`；`Tests 18 failed \| 818 passed (836)`；失败集合 = 16 + 2，**无其它文件** |
| Rust lib 基线 | 15 目标 **276 passed / 0 failed**（与 D1 基线一致） |
| Rust 全目标编译 | `--no-run` 全部成功，**0 error** |
计数守恒：`836 = 828 + 7（新文件新增）+ 1（tsx J9 1→2）`；`818 = 819 − 1`。

### 5.6 本阶段残留风险
S1 活库快照守卫在活库不可达时降级（打印 SKIP，靠结构性证明兜底）；S2 `restore_live_multi_period()` 为死代码分支（不制造该场景，未端到端验证）；S3 不变量用忠实桩而非真身渲染（解析序为纯逻辑；真身 30m 同步闭环属实现后验收）；S4 四条目取值容差 ±0.01；S5 既有 `1m:15m=12.2`（当前实测 13.389）仍按父级裁决**不改**，其对 30m 配对的危害已由直接条目消除，其它组合（如 `5m↔15m` 合成）仍受影响；S6 本阶段墙钟 ≈22 分钟（含一次 cargo 误入上层工作区重试、一次 R4 守卫顺序修正），未超 30 分钟盒。
