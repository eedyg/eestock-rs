# 执行报告 052 — 「保存 dcap 参数不得重置 pane 布局」阶段 3 · **独立验收**（真实渲染，不引用修复车道自述）

- **本文件位置（self-location）**：`tester/test/052_dcap_save_layout_independent_acceptance_execution.md`
- **证据目录**：`tester/evidence/052/`（自建 harness + 4 份探针原始 JSON + oracle + 16 张截图 + 5 份门禁/收尾日志）
- **上游**：测试设计 `tester/design/016_dcap_save_layout_red_test_design.md`（阶段 1）；阶段 1 诊断 `tester/test/051_dcap_save_layout_reset_diagnosis_execution.md`；修复车道自述 `coder/report/162_dcap_save_layout_fix.md`（**本报告不引用其次级结论，全部断言为自建**）
- **权威口径**：`design/14-dcap-indicator/02-spec.md` §6（图表契约 C「配置保存不得重建 pane」+「取数 warmup · 热更新口径」）；`03-test-plan.md` T8（含跨面板布局项）
- **执行时间**：2026-09-13 23:38 ~ 23:54 (+0800)；`date -u` 15:38 ~ 15:54
- **仓库根 / commit**：`/home/eestock/workspace/git/eestock/eestock-rs`，HEAD = `d74bfb83dfdc8f2d2f0604065d5ce01314f2d27b`（本次为**未提交改动**；本车道**未改任何产品代码/测试代码**，只新增证据与本报告）
- **被测形态（临时构建 + 临时端口，全部在 /tmp）**：
  - 构建 **A**：现工作树（含未提交修复）→ `/tmp/acc3/dist`，`vite preview` `127.0.0.1:18093`
  - 构建 **B**（反向证据 A）：`/tmp/acc3/mut` = web 源码副本，`KlineChart.tsx`/`DashboardPage.tsx`/`feed.ts` 用 `git show HEAD:` 覆盖（退回旧 remove+create churn/feed 身份行为）→ `/tmp/acc3/mut-dist`，preview `127.0.0.1:18094`
  - 反代：两处 preview 的 `/api`、`/ws` → **线上只读** `127.0.0.1:8081`（只发 GET）；Playwright 浏览器侧拦截全部非 GET（`PUT /api/config/dcap|ma` 本地兑现 200+echo，**未发往后端/DB**）
  - 引擎：**真实 `klinecharts@10.0.3`**（未打桩；spy 仅包裹实例方法以取证）
- **纪律**：未 kill/重启/改配置 8081/8082（PID 2102695 全程未动）；未覆盖线上 `web/dist`（md5 前后逐一比对一致）；未 `git add/commit/stash`；未跑 tangle 写操作；未改 `design/14-dcap-indicator` 的 `file=` 块（改动行在 §6 表格、不在围栏内：`awk` 计数第 175 行前围栏数为偶数 8，且 `check-tangle` exit=0）；DB/后端**零写入**（`nonGetOther=[]`）
- **崩溃/现场**：**无崩溃、无 core dump**（4 次探针 `pageErrors` 全空；无 node/Chromium 异常退出）

> **结论速览**：核心需求 ✅（3 次真实保存：高度差逐值 **0.00px**、pane id 不变、无 churn、无 remount、DCAP 线值按新参数更新且与离线 oracle **逐位 0 误差**）／ 回归 17/17 ✅／ 反向证据 A（旧行为）**高度断言按预期变红**（VOL 179→100、DCAP 160→100）✅／ 反向证据 B（不调 override）**参数更新断言按预期变红**（calcParams 停在旧值、与 oracle 失配 288~507 点）✅／ 门禁 4 项全过 ✅／ 卫生 ✅
> 末行 **VERDICT: PASS**

---

## 1. 需求 1（核心）：非默认高度 → 真实保存路径 → 高度保持 + 线值按新参数更新

### 1.1 场景与操作链
DCAP 开（工具栏 `DCAP` 勾选）→ 面板「保存」把 8 参归一到基准 `[n_s,n_m,n_l,r_s,r_m,r_l,smooth,m]=[8,26,60,1,1,1,1,3]`（记为 P0）→ 鼠标拖两条分隔线（candle↔VOL 上移 150px、VOL↔DCAP 上移 60px）→ 记录**基线** → 依次走**真实 UI 保存路径**（`DCAP 配置` → 逐字段填写 → 「保存」⇒ `DcapParamsPanel.onSave` ⇒ `DashboardPage.saveDcapParams`（乐观更新 + 服务端回显）⇒ `PUT /api/config/dcap`，PUT 由浏览器侧本地兑现）3 次：`r_m 1→1.5`、`m 3→5`、`n_l 60→80`。

**基线（拖拽后）渲染高度**（DOM `getBoundingClientRect().height`，非 `getPaneOptions().height`）：

| pane | 基线渲染高度 | pane id |
|---|---|---|
| candle（MA） | **357.00px**（弹性，默认态 496px） | `candle_pane` |
| VOL | **179.00px**（默认 100px ⇒ 非默认 ✅） | `indicator_pane_1789314634156_3` |
| DCAP | **160.00px**（默认 100px ⇒ 非默认 ✅） | `indicator_pane_1789314638194_2` |

### 1.2 三次保存的逐项实测

| 保存 | 参数变化 | 既有 pane 渲染高度（保存后） | 高度差 | pane id 集合 | churn(remove/create) | init 计数 | `/api/kline` GET | dataLen | DCAP calcParams | 参数敏感度（线值逐点对比，1e-12） |
|---|---|---|---|---|---|---|---|---|---|---|
| **S1** | `r_m 1→1.5`（warmup 不变） | MA 357 / VOL 179 / DCAP 160 | **全 0.00px** | 不变（3/3 同 id） | **0**（burst 仅 `overrideIndicator`） | 1→1 | 0 | 188→188 | `[8,26,60,1,1.5,1,1,3]` ✅ | **m**: 161/188 点变，maxAbs **1.9709e-2**；s/l: 0（符合 r_m 只影响中窗） |
| **S2** | `m 3→5`（warmup 62→64） | MA 357 / VOL 179 / DCAP 160 | **全 0.00px** | 不变 | **0**（仅 `overrideIndicator`） | 1→1 | 0（窗口已够宽 188≥184 ⇒ 按设计不补取） | 188→188 | `[8,26,60,1,1.5,1,1,5]` ✅ | **s** 179 点 / maxAbs **8.6283e-3**；**m** 161 / **5.3885e-3**；**l** 127 / **8.172e-3** |
| **S3** | `n_l 60→80`（warmup 64→84） | MA 357 / VOL 179 / DCAP 160 | **全 0.00px** | 不变 | **0**（burst = `overrideIndicator`,`resetData`） | 1→1 | **1**（向前补取差额） | 188→**204** | `[8,26,80,1,1.5,1,1,5]` ✅ | **s** 177 点 / maxAbs **2.6027e-2**；**m** 159 / **1.5004e-2**；**l** 125 / **2.276e-2** |

- **基线 → 3 次保存后端态**：`{MA:357→357, VOL:179→179, DCAP:160→160}`，逐值 **±0.00px**（判据 ±1px）。
- **无整图 remount**：`init` 计数 1→1→1→1（真实 `klinecharts.init` 只调用一次）。
- **无 pane 销毁重建**：3 次保存的 burst 里 `removeIndicator`/`createIndicator` 次数 = **0**；DCAP 的 `overrideIndicator({name:'DCAP', calcParams:[…]})` 每次各 1 条（参数变化走原地重算）。
- **warmup 热更新路径真的被走到**（不是空转）：S3 触发 1 次 `GET /api/kline`（以最左已加载 bar 为游标补取差额 16 根）、dataLen 188→204 = `viewport_bars(120) + warmup(84)` 的端态口径、随后 `chart.resetData()`（无 `setDataLoader`/`setSymbol` ⇒ 非 remount）。
- **视口未跳**：可见区间 `{from:74,to:188}` → `{from:90,to:204}`，宽度恒 114 根，位移恰等于**前插的 16 根**（同一批 bar 仍可见）⇒ `resetData` 未把视口重置。
- **URL 写防护**：本轮 4 条 PUT（P0 归一 + S1/S2/S3）全部记录为 `fulfilled-locally-200-echo(未发往后端/DB)`；`nonGetOther=[]`（无任何其它非 GET 逃逸）。

### 1.3 端态回归面（同一次真实渲染）

| 判据 | 实测 |
|---|---|
| DCAP 仍为**独立副图 pane** | `paneId=indicator_pane_1789314638194_2 ≠ candle_pane`，该 pane 内指标仅 `[DCAP]` |
| `precision = 5` | `5` ✅（figures = `['s','m','l','zero']`） |
| **0 参考线在标度内** | DCAP 副图 Y 轴 `[-0.0214656461, 0.0200263927]`，`from ≤ 0 ≤ to` ⇒ 0 线始终可见 |
| 0 参考线**值恒 0 / 不参与断线** | result n=204；`zero` 非法值 0 个（全 0）；三条数据线头部 null 数 s/m/l = **11/29/83**（数据不足处仍**断线**） |
| 内置模板指标未被空数组覆盖（修复引入的 `createIndicatorValue` 守卫） | VOL `calcParams=[5,10,20]` = klinecharts 内置默认（`index.esm.js:4869`）⇒ 未传 `calcParams: []` |
| 页面异常 | `pageErrors=[]`（无抛错、无崩溃） |

## 2. 需求 1 的**独立 oracle**（离线、不同运行时、不依赖图表接线层）

方法：把每次保存时 chart 的 `getDataList()`（closes）与期望的**新参数**导出，用 **CORE 源码** `web/src/features/indicators/dcap.ts` 的 `computeDcapSeries`（tangle 生成物，与图表模板同算法）在 `vite-node` 里离线复算，与 chart 上 DCAP 的 `result` 的 `s/m/l` **逐点**对照：

| 构建 | 保存 | 期望参数 | 逐位比较点数 | 失配点 | 最大绝对差 |
|---|---|---|---|---|---|
| 现工作树 | S1 | `[8,26,60,1,1.5,1,1,3]` | 564 | **0** | 0 |
| 现工作树 | S2 | `[8,26,60,1,1.5,1,1,5]` | 564 | **0** | 0 |
| 现工作树 | S3 | `[8,26,80,1,1.5,1,1,5]` | 612 | **0** | 0 |

⇒ 「线值确实按新参数更新」不只是「值变了」，而是**与用新参数离线复算的结果逐位一致**（含 `zero` 恒 0）。原始输出：`evidence/052/json/oracle.json`。

## 3. 需求 2：回归项（真实渲染，17/17 绿）

| 组 | 判据 | 实测 |
|---|---|---|
| R-A 指标勾选 | DCAP 关 → 指标与副图 pane 消失、**无残留空 pane**（内容 pane 2 个：candle+VOL） | ✅ `{}` 空 pane 列表；pane 高度 `{MA:357,VOL:179,DCAP:160}` → `{MA:518,VOL:179}` |
| R-A | 关/开**不牵连既有 pane**：VOL pane id 与高度不变（仅 candle 弹性吸收/释放） | ✅ VOL id 同、179→179px；再开后 VOL id/高度仍不变（179px），新 DCAP pane 取默认 100px |
| R-A | 翻转仍走 `createIndicator`/`removeIndicator`（差分不得吞掉开关语义）、无 `setDataLoader`、init 不变 | ✅ burst=`[removeIndicator, createIndicator]`，init 1/1/1 |
| R-B MA windows | `5,10,20 → 7,20,60` **仍生效**：calcParams 变且线值确实变 | ✅ `ma1` 184 点/maxAbs 0.10166、`ma2` 179/0.1328、`ma3` 169/0.179 |
| R-B | **不重置 pane 高度**（±1px）、pane id 不变、无 churn、无 remount | ✅ `{MA:306→306, VOL:240→240, DCAP:150→150}`，delta 全 0；burst=`[overrideIndicator]`；init 1→1 |
| R-C | DCAP 独立副图 / precision 5 / figures s,m,l,zero / 0 线在 Y 标度内 / 数据不足断线 / 无异常 | ✅ Y 轴 `[-0.0224614572, 0.0301034937]`（含 0）；n=188，null s/m/l = 9/37/67，zero 0 个；`pageErrors=[]` |

（截图：`shots/regress_A0_dcap_on_dragged.png`、`A1_dcap_off.png`、`A2_dcap_on_again.png`、`B1_after_ma_save.png`）

## 4. 需求 3：反向证据（两类断言**各自**都会变红）

### 4.1 反向证据 A —— 把实现退回旧行为（`/tmp/acc3/mut` 副本恢复 remove+create churn / warmup 进 feed 身份）

同一核心探针、同一操作链、同一判据，只换构建：**31 条断言 → 21 绿 / 10 红**（`evidence/052/json/probe_core_mutant.json`）。

| 变红的断言 | 实测（旧行为） |
|---|---|
| S1-H1 高度保持 ±1px | MA 357→**496**(+139)、VOL 179→**100**(−79)、DCAP 160→**100**(−60) |
| S1-H2 pane id 不变 | VOL/DCAP pane id 均更换（销毁重建） |
| S1-H4 无 remove/create churn | churn = **18** 次（2 个 React commit × 9） |
| S2-H2 / S3-H2 | pane id 更换 |
| S2-H3 / S3-H3 无 remount | init **3→4**（`m` 变 ⇒ 整图 remount）、**4→5**（`n_l` 变） |
| S2-H4 / S3-H4 | burst 含 `setDataLoader,setSymbol,setPeriod`（mount 特征）+ 27 次 churn |
| **P4 基线→端态高度一致** | `{MA:357,VOL:179,DCAP:160}` → `{MA:496,VOL:100,DCAP:100}` |
| 端态高度 | 拖拽成果全部回默认 ⇒ 缺陷复现 |

**关键**：同一份旧行为里 **H5/H6/H7（参数生效/线值更新/zero 恒 0）仍为绿** ⇒ 「高度/生命周期」断言族与「参数更新」断言族彼此**独立**，红色不是连带效应。另：仓库常驻红测试 `web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx` 在该副本下 **4 failed | 3 passed（7）**，原始断言：
- `AssertionError: expected 240 to be less than or equal to 1`（pane 高度差 240px）
- `AssertionError: expected [ …(6) ] to deeply equal []`（保存期间出现 remove/create）
- `AssertionError: expected [ …(4) ] to deeply equal []`
- `AssertionError: expected "spy" to be called with arguments: [ 124 ] / Number of calls: 0`（warmup 未热更新）
（日志：`evidence/052/logs/mutant_regression_test.log`）

### 4.2 反向证据 B —— 「不调用 override」时参数更新断言变红

在**现工作树构建**上打开变异开关（spy 把 `overrideIndicator` 变 no-op，其余不变），同一探针：**31 → 25 绿 / 6 红**。

| 变红的断言 | 实测 |
|---|---|
| P1 基准参数归一未生效 | 面板保存后 chart `calcParams` 仍为线上配置 `[8,36,66,1,1,1,1,3]` |
| S1-H5 / S2-H5 / S3-H5 calcParams 按新参数 | 三次保存后 `calcParams` 都停在 `[8,36,66,1,1,1,1,3]`（期望分别 `[8,26,60,1,1.5,1,1,3]`/`[…,m:5]`/`[n_l:80,…,m:5]`） |
| S1-H6 / S2-H6 线值按新参数更新 | 逐点差异 **0**（值完全没动） |
| 离线 oracle（用期望新参数复算 vs chart） | 失配点 **288 / 463 / 507**，maxAbs **0.021866 / 0.021621 / 0.021621**（对照：现工作树 0 失配） |

**诚实标注**：变异下 **S3-H6 仍为绿**——`n_l` 变化会经 warmup 补取把 dataList 从 188 拉到 204，**数据窗口本身**就改变了线值，故单纯「值变了」对 `n_l` 不具备区分力；区分力由 `expectCalcParams` 的 oracle 对照（507 点失配）与 H5 提供。已在 §9 给出最小加固建议。
同时反向证据 B 下 H1/H2（高度/id 保持）**仍为绿** ⇒ 两类断言互不掩盖。

## 5. 需求 4：门禁与改动面

| 门禁 | 命令 | 结果 |
|---|---|---|
| tangle 一致性 | `./scripts/check-tangle.sh` | **exit=0**（“design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）”） |
| 前端全量测试 | `npx vitest run`（`web/`） | **57 files / 574 tests 全绿**（0 failed / 0 skipped） |
| 类型检查 | `npx tsc -b`（`web/`） | **exit=0**（`noEmit:true`，不写 `web/dist`） |
| 暂存区 | `git diff --cached --name-only` | **空**（无 staged 文件） |

**本轮 tracked 改动（`git diff --name-only`，共 8 个文件）**：
```
design/14-dcap-indicator/02-spec.md              （§6 表格补「配置保存不得重建 pane」+ warmup 热更新口径；不在 file= 围栏内）
web/src/features/dashboard/DashboardPage.tsx     （warmup 移出 feed 身份 deps；传 warmupBars prop）
web/src/features/dashboard/feed.ts               （warmupBars 可变 + setWarmupBars 差额前插补取）
web/src/features/dashboard/KlineChart.tsx        （syncIndicators 状态差分 + overrideIndicator + warmup 热更新 effect + fitBarSpace 手动视口守卫）
web/src/features/dashboard/DashboardPage.test.tsx   （MA 保存断言改用 overrideIndicator，并断言 MA 只 create 一次）
web/src/features/dashboard/KlineChart.test.tsx      （同上；并断言不再有 removeIndicator）
web/src/features/dashboard/dcapWiringP3.test.tsx    （新增：保存 n_l 不重建 feed/图表 + warmup 差额补取）
web/src/features/dashboard/dcapWarmupP3.test.ts     （新增：feed 窗口口径 + setWarmupBars 10 条）
```
另有无入库暂存的新增测试文件（阶段 1 产出，untracked）：`web/src/features/dashboard/KlineChartDcapSaveLayout.test.tsx`（7 条，常驻防回归；见 §4.1 反向证据）。

**未触碰面（逐条核验）**：`git status --porcelain -- crates/` **空** ⇒ 未动 ABI/引擎/`ExecutionPolicy`（`crates/strategy-core/src/{engine,policy}.rs` 等）；`api-config`、`web/src/features/indicators/dcap.ts`（tangle 生成物 CORE）、`crates/strategy-core/reference-plugins/dcap.js` 均 **clean**；`git diff --stat -- crates/` 空。测试桩/断言的改动是**适配新契约并加强**（新增 `overrideIndicator`/`resetData` 桩 + “create 仅一次/不得 remove”断言），未发现被削弱的既有断言。

**范围观察（供架构裁决，非缺陷）**：`KlineChart` 的 DataLoader init 回调新增 `if (!manualAdjusted.current)` 守卫，是 `resetData` 热更新路径的**必要配套**（否则原地重载会把用户手动缩放/平移的视口重置回配置视口，违反 ADR-020 §2.6）。已核验其不破坏「换标的/周期/视口配置 ⇒ 重新铺满」既有路径：`[feed]` effect 内在 `setDataLoader` 之前 `manualAdjusted.current = false`（`KlineChart.tsx:354`），故 feed 身份变化时守卫必放行。

## 6. 需求 5：环境卫生

| 项 | 实测 |
|---|---|
| 临时实例收尾 | `kill` 18093/18094 两个 `vite preview`（PID 2279827 / 2283811）→ `ss` 无 1808x/1809x 监听、`ps` 无本车道残留进程 ✅ |
| 线上实例 | `PID 2102695` 存活且 `STARTED Sun Sep 13 21:21:46 2026`（全程序未动）；8081/8082 仍由它监听 ✅ |
| 线上 `web/dist` | `find web/dist -type f -exec md5sum` 前后逐一比对**完全一致**，mtime 仍为 `2026-09-13 21:21:03`（本车道构建全部落在 `/tmp/acc3/**`）✅ |
| 用户配置 | 未改：本轮 13 条 PUT（`/api/config/dcap` ×12 + `/api/config/ma` ×1）全部浏览器侧本地兑现（未落后端/DB）；`nonGetOther` 4 次探针均为 `[]`；DB 未执行任何语句 ✅ |
| 现场 | 无崩溃、无 core dump ✅ |

（旁证事实，供参考不判定：探针期间线上 `GET /api/config/dcap` 返回 `n_s=8,n_m=36,n_l=66,r=1,smooth=1,m=3`，即线上配置非默认；本车道只读，未改。）

## 7. 失败用例表（本轮，现工作树构建）

| 套件 | 总数 | 通过 | 失败 | 跳过 |
|---|---|---|---|---|
| `probe_core.mjs`（现工作树） | 31 | **31** | **0** | 0 |
| `probe_regress.mjs`（现工作树） | 17 | **17** | **0** | 0 |
| `oracle.mts`（现工作树 3 次保存逐位对照） | 3（1740 点） | **3** | **0** | 0 |
| `npx vitest run` | 574 | **574** | **0** | 0 |
| `npx tsc -b` | — | exit 0 | — | — |
| `./scripts/check-tangle.sh` | — | exit 0 | — | — |

**本轮无失败用例、无崩溃、无 core dump。** 反向对照组（非被测形态）的预期红见 §4.1 / §4.2，其失败名、错误信息、栈摘录与 crash 标志如下：

| 对照组 | 失败用例 | 错误信息 / 实测 | crash/core |
|---|---|---|---|
| A 旧行为副本 | `S1-H1`,`S1-H2`,`S1-H4`,`S2-H2`,`S2-H3`,`S2-H4`,`S3-H2`,`S3-H3`,`S3-H4`,`P4` | 高度差 +139/−79/−60px；churn 18/27；init +1；pane id 更换 | 无 |
| A（仓库常驻测试） | `KlineChartDcapSaveLayout.test.tsx` 4 条 | `expected 240 to be less than or equal to 1`；`expected [ …(6) ] to deeply equal []`；`expected [ …(4) ] to deeply equal []`；`expected "spy" to be called with arguments: [ 124 ] / Number of calls: 0` | 无 |
| B override no-op | `P1`,`S1-H5`,`S1-H6`,`S2-H5`,`S2-H6`,`S3-H5` | calcParams 停在 `[8,36,66,1,1,1,1,3]`；线值逐点差异 0；oracle 失配 288/463/507 | 无 |

## 8. 覆盖率小结（本阶段自建判据）

| 契约点（02-spec §6 / T8） | 覆盖 | 判据 |
|---|---|---|
| 参数保存后 pane 高度 ±1px | ✅ 真实渲染 | DOM 渲染高度逐值 0.00px 差（3 次保存 + 基线对照） |
| 参数变更只走 `overrideIndicator`（无 remove/create） | ✅ | spy burst：`removeIndicator/createIndicator` = 0 |
| 配置保存不重建 pane/图 | ✅ | pane id 集合不变 + `init` 计数不变（1→1） |
| warmup（`n_l`/`m`）不得进 feed 身份、差额热更新 + 原地 `resetData` | ✅ | S3：1 次差额取数、dataLen 188→204、`resetData`、无 `setDataLoader`/无 init |
| pane 高度保持 | ✅ | 同上 |
| 参数无变化幂等（乐观更新 + 服务端回显两次 commit） | ✅ 间接 | S1~S3 每次 burst 仅 1 条 override 且无 churn（两次 commit 未产生重复动作）；高度/线值无抖动 |
| 启用状态翻转仍 create/remove | ✅ | R-A burst + 无空 pane |
| MA windows 变更生效且不重置高度 | ✅ | R-B |
| DCAP 独立副图 / precision 5 / figures s,m,l,zero | ✅ | 端态指标对象（`paneId`/`precision`/`figKeys`） |
| 0 参考线常驻且参与 Y 标度 | ✅ | Y 轴 `from ≤ 0 ≤ to`（两组不同时段场景均成立）+ `zero` 全 0 |
| 数据不足断线、不抛错 | ✅ | 头部 null s/m/l = 11/29/83 与 9/37/67；`pageErrors=[]` |
| 指标开关/参数热切换不触发整图 remount | ✅ | init 计数全程 1（构建 A） |

## 9. 残留风险与**最小修正建议**（不落地，交架构裁决）

1. **【低·建议加固】`n_l` 单独变化的「值更新」判据区分力不足**：变异 B 下 `S3-H6` 仍绿（warmup 补取改变了数据窗口）。最小修正：在常驻测试 `KlineChartDcapSaveLayout.test.tsx` 的 warmup 用例里补一条 `overrideIndicator({name:'DCAP', calcParams: dcapCalcParams(P2)})` 断言（与已断言的 `setWarmupBars`/`resetData`/高度不变同处一条 burst），使「warmup 路径不得丢参数应用」可被单测钉死 —— 现真实渲染已绿（`[overrideIndicator, resetData]`），只是常驻测试未覆盖该点。
2. **【低】`setWarmupBars` 的 `loadingBefore` 竞态**：若一次补取在途时又发生「增大 warmup」的保存，该次会只改字段不补取（返回 false），窗口在**下一次增大**时才自愈；`n_l` 先减后增的场景**不受影响**（字段已更新，need 按当前目标窗口计算）。建议：若要消除瞬态，把 `loadingBefore` 跳过的请求登记为 pending，加载完成后补一次——非阻塞。
3. **【低·代码核验】`fitBarSpace` 守卫的作用面**：已按代码路径核验（`[feed]` effect 在建 DataLoader 前置 `manualAdjusted=false`）换标的/周期/视口配置仍会重新铺满；本阶段未做「手动缩放后换标的」的真实渲染专项复现（不在任务清单内），如需可加 1 条 e2e。
4. **【信息】线上 `GET /api/config/dcap` 返回 `8/36/66/…`（非默认）**：本车道只读未改；若后续验收期望默认值，请以线上配置为准（阶段 1 证据 `051` 亦记录过外部写入事实）。
5. **【信息】截图未做逐像素目视比对**：本模型不具备读图能力，16 张截图仅作真实渲染留证（观感类判据如「副图是否肉眼可见保持」以 DOM 渲染高度数值为准，数值证据强于目视）；阶段 1/修复车道已有观感截图，可交叉参考。

## 10. 明确不做（按任务边界）

- 未评价 dcap 指标的信息量/信号质量；
- 未 kill/重启/改配置线上 8081/8082（PID 2102695 未动），未覆盖线上 `web/dist`；
- 未修改任何实现代码/接口/架构，未调试或修复任何失败，未做任何“顺手改”；
- 未在仓库内执行 tangle 写操作、未 `git add/commit/stash`、未改 `design/14-dcap-indicator` 的 `file=` 块。

---

**VERDICT: PASS**

（逐项：1 核心 ✅ / 2 回归 ✅ / 3 反向证据 a+b ✅ / 4 门禁与改动面 ✅ / 5 卫生 ✅ / 6 边界遵守 ✅；残留风险 1~5 均为低风险/建议项，不构成阻塞。）
