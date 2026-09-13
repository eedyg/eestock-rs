# dcap 指标 —— P2-B 测试文件 TS 类型错修正 + 复跑执行报告

- 报告自身路径：`tester/test/042_dcap_p2b_ts_error_fix_execution.md`
- 执行时间（CST）：2026-09-13 17:30
- 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`
- 仓库提交（HEAD）：`8745fd52de446efc597e37dcd23cc74c27273dcd`
- 权威口径：`design/14-dcap-indicator/{01-adr.md,02-spec.md,03-test-plan.md,04-implementation-plan.md}`
- 原始输出（逐命令）：本报告 §1–§3 内嵌（命令行原文）
- 纪律声明：**只改测试文件 1 个**；**未改实现、未改 CORE、未重跑 tangle**；
  **未 `git add`/`commit`/`stash`**；未起 8081/8082；
  **未以任何形式放宽/削弱断言**（本次修正不触碰任何断言）；**未做失败分析、未尝试任何修复**。

---

## 0. 结论速览

| # | 项 | 命令 | 结果 | 退出码 |
|---|---|---|---|---|
| 1 | 修前复现 | `cd web && npx tsc -b` | 3 × TS2353 | **2** |
| 2 | 修后 | `cd web && npx tsc -b` | 无错误、无输出 | **0** |
| 3 | 受影响用例复跑 | `cd web && npx vitest run src/features/indicators/` | **30 通过 / 0 失败**（4 文件） | **0** |

- 崩溃 / core dump：无（纯 `tsc`/`vitest`，无崩溃信号）。
- 归因：**测试文件写法错**（非实现 / 非 §7/§4 口径问题）⇒ 授权范围内的最小修正。

---

## 1. 报错原文与位置（修前，逐字）

```
$ cd web && npx tsc -b
src/features/indicators/dcapNormalize.test.ts(87,72): error TS2353: Object literal may only specify known properties, and 'th' does not exist in type 'Partial<DcapParams>'.
src/features/indicators/dcapNormalize.test.ts(121,73): error TS2353: Object literal may only specify known properties, and 'th' does not exist in type 'Partial<DcapParams>'.
src/features/indicators/dcapNormalize.test.ts(135,93): error TS2353: Object literal may only specify known properties, and 'th' does not exist in type 'Partial<DcapParams>'.
TSC_EXIT=2
```

三处均在 `params({...})` 辅助函数实参（该函数签名 `params(over: Partial<DcapParams> = {}): DcapParams`）：
- L87 `T5a-a`：`params({ r_s: 1, r_m: 1.2, r_l: 0.8, smooth: 1, m: 3, th: 0.02 })`
- L121 `T5a-c`：`params({ r_s: 1.05, r_m: 1, r_l: 1.2, smooth: 1, m: 4, th: 0.5 })`
- L135 `T5a-d`：`params({ n_s: 5, n_m: 5, n_l: 5, r_s: 1, r_m: 1.2, r_l: 1.5, smooth: 1, m: 3, th: 0.01 })`

---

## 2. 归因（证据链）

判定 = **测试文件写法错**，依据（均取自权威口径与生成物契约，非猜测）：

1. `design/14-dcap-indicator/02-spec.md:57`：`th` = 「评分映射标度（仅策略侧用，图表不用）」。
2. `design/14-dcap-indicator/02-spec.md:203`：「`th` **不在此接口**（它只属策略参数，在 `/strategies` 编辑器的参数表单里）」——即 `GET /api/config/dcap` 只返回 8 个显示参数。
3. `web/src/features/indicators/dcap.ts:15`（由 §10 tangle 生成）：`interface DcapParams` = `n_s/n_m/n_l/r_s/r_m/r_l/smooth/m` 八项，注释明写「`th` 只属策略参数，不进前端模块」。
4. `dcap.ts` 导出契约：`dcapScore(values, th)` —— `th` 是**独立入参**，不属于 `DcapParams`。

⇒ 测试文件把策略侧参数 `th` 塞进了显示参数集 `DcapParams`，与 §7/§4 口径**相反**；错在测试文件，实现与文档口径一致、无需改动。

附加事实（决定修正形态）：`dcapNormalize.test.ts` 内**只调用 `computeDcapSeries`，全文件无 `dcapScore` 调用**；
`computeDcapSeries(closes, p)` 不消费 `th`。故这三处 `th` 对被测行为**零影响（惰性字段）**，
最小且不失强度的修正 = 从实参里删除该字段；**不需要也不应**新增 `dcapScore` 调用（那会新增断言 = 扩大范围）。

---

## 3. 最小修正 diff（唯一改动文件）

文件：`web/src/features/indicators/dcapNormalize.test.ts`（3 行，仅删字段；**断言、测试名、期望值一字未动**）

```diff
@@ -84,7 +84,7 @@
   it('T5a-a 非单调三元组 ≡ 归一后三元组（逐位，smooth=1，r≠1）', () => {
-    const base = params({ r_s: 1, r_m: 1.2, r_l: 0.8, smooth: 1, m: 3, th: 0.02 });
+    const base = params({ r_s: 1, r_m: 1.2, r_l: 0.8, smooth: 1, m: 3 });
@@ -118,7 +118,7 @@
   it('T5a-c 幂等：已归一三元组再进入口 ⇒ 输出不变（逐位）', () => {
-    const base = params({ r_s: 1.05, r_m: 1, r_l: 1.2, smooth: 1, m: 4, th: 0.5 });
+    const base = params({ r_s: 1.05, r_m: 1, r_l: 1.2, smooth: 1, m: 4 });
@@ -132,7 +132,7 @@
   it('T5a-d 确定：同输入重复调用逐位相同（无全局状态）', () => {
-    const p = params({ n_s: 5, n_m: 5, n_l: 5, r_s: 1, r_m: 1.2, r_l: 1.5, smooth: 1, m: 3, th: 0.01 });
+    const p = params({ n_s: 5, n_m: 5, n_l: 5, r_s: 1, r_m: 1.2, r_l: 1.5, smooth: 1, m: 3 });
```

---

## 4. 修后验证

```
$ cd web && npx tsc -b
TSC_EXIT=0
```
（无任何错误输出）

```
$ cd web && npx vitest run src/features/indicators/
 RUN  v3.2.7 /home/eestock/workspace/git/eestock/eestock-rs/web

 ✓ src/features/indicators/dcapInsufficient.test.ts (4 tests) 4ms
 ✓ src/features/indicators/dcapMirror.test.ts (11 tests) 5ms
 ✓ src/features/indicators/dcap.test.ts (10 tests) 8ms
 ✓ src/features/indicators/dcapNormalize.test.ts (5 tests) 9ms

 Test Files  4 passed (4)
      Tests  30 passed (30)
VITEST_EXIT=0
```

失败用例清单：**空**。
崩溃 / core dump：**无**。

---

## 5. 范围与纪律

- 改动文件数：**1**（`web/src/features/indicators/dcapNormalize.test.ts`）。
- 未触碰：实现（`dcap.ts`/CORE/插件产物）、ABI 契约、`clamp_score`/`aggregate`/`classify`/60-40 阈值/`ExecutionPolicy`、`/api/config/*`。
- 未重跑 `entangled tangle`；未 `git add/commit/stash`；未起 8081/8082。
- `git diff --cached --name-only` = 空 ⇒ **无暂存文件**。
