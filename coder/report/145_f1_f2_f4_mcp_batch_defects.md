# 145 · MCP 批验收缺陷 F1/F2/F4 修复报告

> 本文件位置（self-reference）：`eestock-rs/coder/report/145_f1_f2_f4_mcp_batch_defects.md`
> 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`
> 基线：HEAD `cc32496`（工作区**未提交**改动 = 144/010 批次 + 本批；index 无 staged）
> 依据：`tester/report/010_mcp_batch_acceptance.md` §1（F1，含 §2.6 原始证据）、§8（F2/F3/F4）
> 角色：Coder（TDD；**未 git add / 未 commit**；未改任何生成物的手工内容）
> 事实源纪律：`design/07-app-plane/01-mcp.md` → `crates/mcp/src/tools.rs`，经 `entangled tangle` 单向生成。

---

## 0. 结论摘要

| ID | 缺陷 | 处置 | 语义是否变更 | 状态 |
|---|---|---|---|---|
| F1 | `get_kline` `from >= to` 校验先于 date 形式 `to` 的「+1 日展开」→ 同日 date / RFC3339+date 混合被误判 -32602 | 已修：`f >= t` 判定整体移至 `to` 归一化**之后**（事实源=设计文档，生成物由 tangle 产出） | **否**（实现 bug，非语义变更；文档现行语义「from 闭 / to 开 / to 含整日」已蕴含同日 date 合法） | ✅ 修复 + TDD Red→Green |
| F2 | `crates/web/tests/api_workbench.rs` 以 `H1` 作「非法 period」样例（H1 已合法，断言失去覆盖意图） | 已修：样例改 `W1`（MCP 侧同款），并加「错误文案含 period」断言以表达本意 | 否（测试卫生，无生产代码变更） | ✅ |
| F4 | `crates/application/src/strategy.rs` 注释仍写「H1 拒绝」 | 已修：注释更正为 M1/M5/M15/H1/D1，并注明 W1/MO1 为看板读源扩展 | 否（注释） | ✅ |
| F3 | `web/src/layouts/{DashboardGrid,SimLiveGrid}.tsx` 与 design 源漂移 | **未碰**（本批无关；另立项） | — | 仅复核，见 §4 |

**未上报 intercom 的原因**：F1 的正确定义已由事实源文档现行文字明确（`design/07-app-plane/01-mcp.md` 中 `get_kline` 工具描述「from 区间起点（闭）… to 区间终点（开）：YYYY-MM-DD（含 to 整日）」+ 处理注释「from 闭 / to 开；ISO 日期按 Asia/Shanghai 日界（to 含整日）」），
同日 date 形式按该语义 = 「该日整日」，是非空合法区间；旧行为属**实现顺序错误**而非契约需要变更，故按任务书要求直接修复（若语义本身需变更才上报）。

---

## 1. F1 详情

### 1.1 根因（与验收报告 §2.6 完全一致，且已本地复现）

事实源 `design/07-app-plane/01-mcp.md`（生成物 `crates/mcp/src/tools.rs:620-628`）原顺序：

```rust
    if let (Some(f), Some(t)) = (from, to) {
        if f >= t { return result_err(id, INVALID_PARAMS, "from 须早于 to"); }   // ← 先比较
    }
    // to 含整日：ISO 日期形式 → 次日 00:00 CST（开区间上界）。
    let to = match (to_raw, to) {                                                // ← 后展开
        (Some(s), Some(t)) if parse_date_strict(s).is_some() =>
            Some(t + chrono::Duration::days(1)),
        (_, t) => t,
    };
```

date 形式 `to=D` 的真实上界是 `D+1 00:00 CST`，但比较发生在展开之前，于是 `from="D"&to="D"` 被当成 `D >= D` → -32602。

### 1.2 修复（把比较移到归一化之后）

`design/07-app-plane/01-mcp.md`（`crates/mcp/src/tools.rs` 由 tangle 生成，二者 diff 正文逐行相同）：

```diff
@@ -990,15 +990,19 @@
             None => return result_err(id, INVALID_PARAMS, "to 须为 YYYY-MM-DD 或 RFC3339"),
         },
     };
-    if let (Some(f), Some(t)) = (from, to) {
-        if f >= t { return result_err(id, INVALID_PARAMS, "from 须早于 to"); }
-    }
     // to 含整日：ISO 日期形式 → 次日 00:00 CST（开区间上界）。
+    // F1（010 验收）：**本归一必须先于下面的是否空区间判定**——否则同日 date 形式
+    // （from=to=YYYY-MM-DD，应为「该日整日」）与「RFC3339 from + date to」混合形式会被误判为
+    // from ≥ to；同日 date 在归一后是天然合法区间（展开后 t > f）。
     let to = match (to_raw, to) {
         (Some(s), Some(t)) if parse_date_strict(s).is_some() =>
             Some(t + chrono::Duration::days(1)),
         (_, t) => t,
     };
+    // 归一后 f ≥ t = 空区间（from 闭 / to 开无任何 bar）→ 协议层参数错误；不静默返回空 bars。
+    if let (Some(f), Some(t)) = (from, to) {
+        if f >= t { return result_err(id, INVALID_PARAMS, "from 须早于 to"); }
+    }
```

### 1.3 由「from 闭 / to 开」推导的正确期望（任务书要求写明）

归一化规则（未变）：`from=D` → `D 00:00 CST`（闭）；`to=D` → `D+1 00:00 CST`（开，含 `D` 整日）；RFC3339 原样（归一 UTC）。
合法判据（归一**后**）：`t > f`，否则 -32602 `from 须早于 to`（= 空区间，不静默返回空 bars）。

| 输入 | 归一后 | 期望 | 说明 |
|---|---|---|---|
| `from="D", to="D"`（同日 date） | `D 00:00 CST < D+1 00:00 CST` | **合法**（= `D` 整日） | F1 修复点（旧：误判 -32602） |
| `from=RFC3339(早于 D+1 00:00 CST), to="D"`（混合） | `f < D+1 00:00 CST` | **合法** | F1 修复点（旧：误判 -32602） |
| `from=RFC3339(晚于 D+1 00:00 CST), to="D"` | `f ≥ t` | -32602（空） | 真非法，语义保留 |
| `from="D", to="D-1"`（反向） | `f == t`（`D 00:00 CST`） | -32602（空） | 真非法，语义保留 |
| `from=RFC3339(x), to=RFC3339(x)`（f==t，RFC3339） | `f == t` | -32602（空） | **保留**：from 闭/to 开 下 f==t = 空区间 → 非法（无静默空结果） |
| 仅 `from` 或仅 `to` | — | 校验不触发 | 未变 |

**「既有语义不变」的证明**：比较只被后移，且 date 形式 `to` 的展开使 `t` **严格增大**（+1 天），因此 `f >= t` 只能由 true 变 false（放宽），不可能由 false 变 true（收紧）——
即：**没有任何此前合法输入变为非法；此前非法输入仅 F1 涉及的两种形式变为合法**；超限报错（`f>=t`）、不静默截断（区间根数 > limit → isError）与「to 开」边界（`b.ts < t`）均未动。

### 1.4 TDD 证据

**Red**（先加测试、未改实现，`cargo test -p mcp --lib get_kline_same_day_date_bounds_legal`）：

```
test tools::tests::get_kline_same_day_date_bounds_legal ... FAILED
thread 'tools::tests::get_kline_same_day_date_bounds_legal' panicked at crates/mcp/src/tools.rs:1791:9:
同日 date 区间合法（该 CST 日整日）：{"error":{"code":-32602,"message":"from 须早于 to"},"id":9,"jsonrpc":"2.0"}
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 61 filtered out
```

（失败文案与验收报告 §2.6 的 `EV D2.date_same_from_to {"protocol_error":-32602,...}` 逐字一致 → 缺陷在本地可复现。）

**Green**（实现修复 + tangle 重新生成后）：

```
test tools::tests::get_kline_same_day_date_bounds_legal ... ok
test tools::tests::get_kline_from_to_validation_is_32602 ... ok
test tools::tests::get_kline_from_to_date_bounds_and_range_filter ... ok
test tools::tests::get_kline_from_to_rfc3339_bounds ... ok
test tools::tests::get_kline_range_over_limit_is_tool_error ... ok
test tools::tests::get_kline_without_bounds_keeps_legacy_shape ... ok
... running 14 tests
test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 48 filtered out
```

新增用例 `get_kline_same_day_date_bounds_legal`（工具单测，mock 端口、不依赖 DB）断言：
1. 同日 date：`from="2026-09-03"&to="2026-09-03"` → 无协议错误；回声 `from=2026-09-02T16:00:00Z`（=该日 00:00 CST 闭）、`to=2026-09-03T16:00:00Z`（=次日 00:00 CST 开）；该日内的 2 根样例 bar 全保留；
2. 混合：`from="2026-09-03T01:31:00Z"&to="2026-09-03"` → 无协议错误；`to` 回声同上；from 闭 → 仅 1 根；端口 `before` = 展开后的 to。

被更新的既有用例 `get_kline_from_to_validation_is_32602`（**该用例原本把「同日 date」列为非法，即断言固化了缺陷**）：
删除 `from="2026-09-02",to="2026-09-02"`（移入上面的正向用例），保留反向 date，并**补两条真非法**：`RFC3339 f==t`、`RFC3339 from 晚于 date to 展开日界`。
→ 这是「按事实源更正被误解的契约断言」，非「改测试迁就实现」；每条期望均在 §1.3 表中有推导，且反向/空区间语义逐条保留。

---

## 2. F2 详情（测试卫生）

`crates/web/tests/api_workbench.rs`（**非 tangle 手写**文件，故直接改源码；`design/` 无对应块）：

```diff
-    // period 非法 → 400
+    // period 非法 → 400（W1 为看板读源扩展周期，不在回测白名单 M1/M5/M15/H1/D1 内；
+    // 与 MCP 侧同类样例一致——H1 已合法，不可再作非法样例）
     let mut b = submit_body(&code, &vid);
-    b["period"] = json!("H1");
+    b["period"] = json!("W1");
     let r = http.post(format!("{url}/api/workbench/runs")).json(&b).send().await.unwrap();
-    assert_eq!(r.status(), 400);
+    assert_eq!(r.status(), 400, "非法 period 应 400");
+    let body: Value = r.json().await.unwrap();
+    let msg = body["error"].as_str().unwrap_or_default().to_string();
+    assert!(msg.contains("period"), "非法 period 须明确报 period 校验失败: {msg}");
```

- `W1` 确为真非法：`crates/web/src/workbench.rs:149-151` 白名单 `matches!(period, "M1"|"M5"|"M15"|"H1"|"D1")` → 400 `period 须为 M1/M5/M15/H1/D1`（走校验分支，**不再**依赖「合成 symbol 无 1h 数据」凑巧 400）。
- 新增的 `msg.contains("period")` 断言使本意显式：数据通路失败文案（如「区间内无 K 线数据」）不含 `period`，故该断言通过即证明命中的是 period 白名单校验。
- 无生产代码变更，故无 Red 阶段（这是断言意图修正，不是缺陷修复）；用例 `submit_validation_error_matrix` 实测通过（§5）。

---

## 3. F4 详情（注释陈旧）

`crates/application/src/strategy.rs:41`（**非 tangle 手写**）：

```diff
-// 复用回测服务的周期解析口径（M1/M5/M15/D1；H1 拒绝）。
+// 复用回测/试算的周期解析口径（`crate::bar_map::parse_period`：M1/M5/M15/H1/D1；
+// I-6/D3 起 H1 已支持，W1/MO1 为看板读源扩展、不入回测）。
```

口径来源已核对：`crates/application/src/bar_map.rs` 模块头与 `parse_period` 实际接受 `M1/M5/M15/H1/D1`（W1/MO1 仅看板读源扩展）。无行为变更。

---

## 4. F3 现状复核（未碰；结论：与本批无关）

复核方法（全部在 `/tmp` 的独立快照/仓库中进行，未触碰工作区）：

**4.1 现行工作区**

```
$ ./scripts/check-tangle.sh
[check-tangle] entangled tangle ...
[18:46:33] INFO     Nothing to be done.          ← tangle 本身无待写（生成物与 design 现状一致）
[check-tangle] ❌ tangle 产生了差异：生成物与 design/ 文档不一致。
 crates/application/src/bar_map.rs       |  27 +-     ← 144/010 批次遗留（非本批）
 ...（23 个文件，2177 insertions / 188 deletions）
EXIT=1
```

原因：`scripts/check-tangle.sh` 用 `git diff --quiet`，比较的是**工作区 vs index**；144/010 批次与本批改动**全部未 staged**（index 为空），故必然红。
其中 19 个文件（bar_map/fee/simlive/workbench/engine/backtest/types… + design 8/12 章）**与本批无关**；本批只贡献 4 个文件（见 §6）。
即：这条红是「工作区未提交」的产物，与 tangle 漂移无关（`entangled tangle` 侧为 "Nothing to be done"）。

**4.2 干净 HEAD 快照（`git archive HEAD` → `git init`+commit，非工作区）**

```
$ entangled tangle            # 纯净状态，无 .entangled 本地缓存
           WARNING  `web/src/layouts/DashboardGrid.tsx` not managed by Entangled
           WARNING  `web/src/layouts/SimLiveGrid.tsx` not managed by Entangled
           ERROR    conflicts found, breaking off (use `--force` to run anyway)
ENTANGLED_EXIT=0              ← entangled 2.4.3 在 break-off 时仍以 0 退出、且未写任何文件
$ ./scripts/check-tangle.sh
[check-tangle] ✅ tangle 后无 diff，design 与生成物一致。
SCRIPT_EXIT=0
```

→ **现状与验收报告 F3 的描述有出入**：在**干净 HEAD + 本机 entangled 2.4.3** 下，`check-tangle.sh` **不是红而是「假绿」**——entangled 先 `ERROR conflicts found, breaking off`（未写文件）却返回 0，脚本随后看到无 diff → 打印 ✅。
而漂移本身**实测存在且与 F3 描述一致**：

```
design/06-web/01-dashboard.md 的 {.tsx file=web/src/layouts/DashboardGrid.tsx} 块（75 行）
  vs  web/src/layouts/DashboardGrid.tsx（90 行，去掉 ~/~ 标记）→ 实质差异：
     period 注释/类型：design 只到 '1d'；文件含 '1w' | '1mo'
     SymbolSnapshot：文件含 D2 enabled/last=null 与 Wave3 favorite/favoriteSort 字段
design/06-web/10-simlive.md 的 SimLiveGrid.tsx 块 亦不同（tabCls、min-h-0/overflow-y-auto、border-line…）

$ entangled tangle --force     # 纯净 HEAD 快照
EXIT=0
$ git status --short
 M web/src/layouts/DashboardGrid.tsx      ← 仅这 2 个文件被「强制生成」覆盖（= 把前端手写较新实现回退为陈旧文档内容）
 M web/src/layouts/SimLiveGrid.tsx
```

**结论**：F3 = HEAD 的 `design/06-web/{01-dashboard,10-simlive}.md` 与 HEAD 的 TSX 既存漂移（干净 HEAD 可复现，早于本批），
本批（F1/F2/F4）触碰的 5 个路径不含这两个 TSX，**与本批无关**；本次按任务书**未修 F3**。
补充给立项方的事实：门禁当前既不红也不真正生效（break-off 退出码 0 + 这 2 个文件被 entangled 判为 "not managed" 而不参与比对），修复时需一并校正退出码/例外清单。

---

## 5. 验证命令与结果（全绿）

| 命令 | 结果 | 摘要 |
|---|---|---|
| `cargo test -p mcp -p web -p application` | **EXIT=0** | 25 个测试二进制，**272 passed / 0 failed**；含 `mcp` 单测 62（含新增 F1 用例）、`mcp_tools_db` 8（DB e2e 未回归）、`api_workbench` 6（含 F2 用例） |
| `cargo check --workspace --all-targets` | **EXIT=0** | 0 error / 0 warning（`Finished dev profile`） |
| `./scripts/check-tangle.sh` | EXIT=1（**既存/未提交导致**，见 §4.1） | `entangled tangle` 侧 `Nothing to be done`（无生成漂移）；红来自 `git diff` 看到 144/010 批次未 staged |
| 干净 HEAD 快照 `./scripts/check-tangle.sh` | EXIT=0（假绿） | F3 复核证据，见 §4.2 |

关键片段：

```
     Running tests/mcp_tools_db.rs (target/debug/deps/mcp_tools_db-...)
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.62s
     Running tests/api_workbench.rs (target/debug/deps/api_workbench-...)
running 6 tests
test submit_validation_error_matrix ... ok
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.16s
   Doc-tests application / mcp / web → ok（0 失败）
```

---

## 6. 变更清单（本批精确量；均为 **worktree 改动，未 staged**）

| 文件 | 本批改动 | 说明 |
|---|---|---|
| `design/07-app-plane/01-mcp.md`（事实源） | **+41 / −4**（3 处 hunk） | (1) F1 实现顺序修正 + 注释（净 +4 行）；(2) 新增 `get_kline_same_day_date_bounds_legal`（+33）；(3) 更新 `get_kline_from_to_validation_is_32602` 样例与注释 |
| `crates/mcp/src/tools.rs`（tangle 生成物） | **+41 / −4**（同上 3 处 hunk，正文与文档 diff **逐行相同**） | 由 `entangled tangle` 写出；**未手改生成物** |
| `crates/web/tests/api_workbench.rs` | **+7 / −3** | F2：`H1`→`W1` + period 文案断言（手写文件，非 tangle） |
| `crates/application/src/strategy.rs` | **+2 / −1** | F4：注释更正（手写文件，非 tangle） |

> 注：`git diff --stat` 对 `tools.rs`/`strategy.rs` 显示的行数（595/160）**包含 144/010 批次既存未提交改动**；上表为本批隔离量，隔离方法=把本批 3 处编辑反向施加到 `/tmp` 副本后 `diff -u`（该 diff 的正文在两文件间逐行相同，可证 `tools.rs` 变更为文档变动的纯 tangle 镜像）。

`entangled tangle` 幂等性：仅写出 `crates/mcp/src/tools.rs`；复跑显示 `Nothing to be done`（其余生成物逐字节不变）。

**未 staged / 未 commit**：`git diff --cached --name-only` 为空；未执行 `git add`。未新增/删除任何文件（仅 `/tmp` 下临时快照）。

---

## 7. 残余风险 / 备注

1. **F1 属放宽**：仅 `f>=t` 判据放宽（date to 展开后比较），历史「-32602」调用方若依赖旧误判（同日 date 报错）会看到行为变化，但该行为本就与文档契约不符，且放宽不产生静默截断/静默空结果（区间超限仍 isError）。
2. **web 侧同类顺序问题未波及**：`crates/web/src/workbench.rs` / `crates/application/src/strategy.rs` 的 `from >= to` 校验作用于**已是 DateTime 的入参**（web/MCP 均要求 RFC3339），无 date 展开步骤，故不存在同类边界缺陷——本次**未改**（不改无关语义）。
3. **F3 未修**（任务书要求）：门禁在干净 HEAD 为「假绿」而非红，且 `--force` 会把两个 TSX 回退为陈旧文档内容；建议立项时同时决定「回归 design 源」还是「手写例外 + 门禁校验退出码」。
4. **未运行**：未跑 `gitnexus_*`（本环境无该工具集）、未跑前后端 e2e/生产部署；未重启任何生产进程。
5. 验收夹具（`crates/mcp/tests/zz_tester_*.rs`、`crates/web/tests/zz_tester_*.rs`）为 tester 既有未跟踪文件，本批未改未删。
