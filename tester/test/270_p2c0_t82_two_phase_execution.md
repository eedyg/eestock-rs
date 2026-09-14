# 270 — P2-C-0 执行报告：T8-2 改两段式（只改测试）

- **本文件路径**：`tester/test/270_p2c0_t82_two_phase_execution.md`
- **任务**：P2-C-0 —— 修 T8-2 自相矛盾（架构师裁定为**红测试缺陷**，非实现缺陷）
- **仓库根**：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD = `2632c9e0bb1a7e0fe2013f8e688aca6f5f03a920`；P2 实现存在于工作树、未提交）
- **执行时间**：2026-09-14 21:54（本地）
- **范围**：**仅** `web/src/features/dashboard/multiPeriodSatellite.test.tsx` 的 **T8-2** 单个用例段落；产品代码/接口/架构 **0 改动**
- **无线上影响**：未重启线上实例（PID 3112540 未触碰）；未起临时实例；0 写请求；未 `git add/commit/stash`（暂存区为空）

---

## 1. 基线（修前）红证据

命令：`cd web && ./node_modules/.bin/vitest run src/features/dashboard/multiPeriodSatellite.test.tsx`

```
❯ multiPeriodSatellite.test.tsx (10 tests | 1 failed) 444ms
 × T8-2 每分钟兜底 ≤4、按 (code,period) 各自成 key（不跨周期合并）、并发闸 ≤3
   → 兜底必须覆盖全部 4 个周期（每周期 ≤1 次/分钟）: expected [ '15m', '1m', '5m' ] to deeply equal [ '15m', '1h', '1m', '5m' ]
 ❯ multiPeriodSatellite.test.tsx:654:60
 Tests  1 failed | 9 passed (10)
```

**矛盾定位**：同一 `polls` 数组上
- `:654` 要求 `pollKeys == {15m,1h,1m,5m}`（覆盖 4 周期）；
- `:666`（原文）要求 `polls.length ≤ MAX_CONCURRENT_POLLS(3)`（并发闸）。

实测挂起窗口内恰 3 个在途（`15m/1m/5m`），第 4 个 `1h` 在**排队**（这正是 02-spec §5 批准的「在途 ≤3、超出排队」契约，P1-D-3 已取证）⇒ 两断言不可能同时成立。**判据本身无缺陷，缺陷在把两个时序上的判据压进同一时刻。**

---

## 2. 改动（T8-2 → 两段式）

改动文件（唯一）：`web/src/features/dashboard/multiPeriodSatellite.test.tsx`（T8-2 段落，58 行 → 79 行）

### 2.1 结构
| | 修前 | 修后 |
|---|---|---|
| 时序 | 单段：**同一挂起窗口**内同时断言「覆盖 4 周期」+「在途 ≤3」 | **段 1 = 挂起窗口内**（并发闸）；**段 2 = 只放行 1 个名额后**（排队补发 + 覆盖 4 周期） |
| 放行方式 | `pending.splice(0).forEach(r => r())`（**一次全放**） | `pending.shift()!()`（**只放 1 个名额**，逐槽观察队列补发） |
| 队列判据 | 仅 `≤ 4`（弱：全放/丢弃都通过） | `afterRelease.length > inFlight.length`（**必须增长**，丢请求即红）+ 最终覆盖 4 周期 |

### 2.2 判据清单（三项硬判据全部保留，且全部**加强**）

**段 1（挂起窗口内）**
1. `new Set(polls.map(code:period)).size === polls.length` —— 每周期各自成 key，不跨周期合并；
2. `inFlight.length > 0` —— **新增**：防空断言（挂起窗口内必须确有在途，否则并发闸断言空洞）；
3. `inFlight.length ≤ MAX_CONCURRENT_POLLS(3)` —— 原 `:666` 并发闸判据，位置前移、强度不变；
4. `inFlight.length ≤ 4` —— 原预算上限判据，保留；
5. 已派发 `(code,period)` 互不相同 —— **新增**（同 key 必须合并，不得重复占名额）；
6. 每周期 ≤1 次/分钟 + `limit === REALTIME_POLL_LIMIT` —— 原判据保留。

**段 2（释放 1 个名额后）**
7. `pending.length === inFlight.length` —— **新增**：前置一致性（挂起数 = 在途数）；
8. `afterRelease.length > inFlight.length` —— **新增**：排队请求必须继续发起（不丢请求）；
9. `afterRelease.length ≤ 4` —— 预算上限，保留；
10. 全部已派发 `(code,period)` 仍互不相同 —— **新增**；
11. `[...byPeriod(afterRelease).keys()].sort() === {15m,1h,1m,5m}` —— 原 `:654` 「覆盖 4 周期」意图**原封保留**，只移到释放之后；
12. 每周期 ≤1 次/分钟 + `limit === REALTIME_POLL_LIMIT` —— 原判据保留。

**断言计数（该用例段）**：`expect()` 8 → 15；`toBeLessThanOrEqual` 4 → 5；`toEqual` 1 → 1；`.toBe` 2 → 6。**无一条删除、无一条放宽**（并发闸 / 预算上限 / 周期覆盖三者同时在场）。

### 2.3 diff 摘要（T8-2 段，`+47 / -26`）
```diff
-  it('T8-2 每分钟兜底 ≤4、…、并发闸 ≤3', async () => {
+  it('T8-2 …【两段式：段 1 挂起窗口内 ≤3 / 段 2 释放名额后补发至覆盖 4 周期】', async () => {
-    const polls = pollQueries(getKline);
-    const pollKeys = [...byPeriod(polls).keys()].sort();
+    // ── 段 1（挂起窗口内）：并发闸 ≤ MAX_CONCURRENT_POLLS + 预算上限 ≤4 + 已派发 key 互不相同 ──
+    const inFlight = pollQueries(getKline);
+    expect(inFlight.length, '…必须确有兜底请求在途（否则并发闸断言空洞）').toBeGreaterThan(0);
+    expect(inFlight.length, `段 1…≤ MAX_CONCURRENT_POLLS(${MAX_CONCURRENT_POLLS})…`).toBeLessThanOrEqual(MAX_CONCURRENT_POLLS);
+    expect(new Set(inFlight.map(q => `${q.code}:${q.period}`)).size, '段 1：已派发的 (code,period) 必须互不相同…').toBe(inFlight.length);
-    expect(pollKeys.sort(), '兜底必须覆盖全部 4 个周期…').toEqual(['15m','1h','1m','5m']);   // ← 移到段 2
-    // 并发闸：未 resolve 时最多放行 3 个在途兜底请求
-    expect(polls.length, …).toBeLessThanOrEqual(MAX_CONCURRENT_POLLS);                        // ← 提前到段 1
+    // ── 段 2（释放一个名额后）：排队请求必须继续发起（不丢请求）⇒ 最终覆盖 4 周期 ──
+    expect(pending.length, '段 1 前置：挂起中的请求数必须 = 观测到的在途数').toBe(inFlight.length);
-      pending.splice(0).forEach((r) => r());        // 一次全放
+      pending.shift()!();                            // 只放行一个名额：排队中的必须由闸门接续派发
+    const afterRelease = pollQueries(getKline);
+    expect(afterRelease.length, '段 2：释放 1 个名额后排队中的兜底必须继续发起（不丢请求）').toBeGreaterThan(inFlight.length);
+    expect(afterRelease.length, '每分钟兜底请求数 ≤ 4（4 周期 × 1 标的）').toBeLessThanOrEqual(4);
+    expect(new Set(afterRelease.map(q => `${q.code}:${q.period}`)).size, '段 2：全部已派发 (code,period) 仍必须互不相同').toBe(afterRelease.length);
+    expect([...byPeriod(afterRelease).keys()].sort(), '段 2：释放名额后兜底最终必须覆盖全部 4 个周期').toEqual(['15m','1h','1m','5m']);
+    for (const [period, qs] of byPeriod(afterRelease)) { …每周期 ≤1 次/分钟 + limit=REALTIME_POLL_LIMIT… }
-    expect(pollQueries(getKline).length, '释放名额后…（≤4）').toBeLessThanOrEqual(4);          // ← 由「增长」断言强化
```

**改的是时序/分段，不是判据强度**：所有阈值（`≤3`、`≤4`、`≤1/周期`、`limit===REALTIME_POLL_LIMIT`、key 唯一）逐字保留，只把「覆盖 4 周期」从**挂起窗口内**搬到了**释放名额后**。

---

## 3. 转绿证据

### 3.1 目标文件
```
cd web && ./node_modules/.bin/vitest run src/features/dashboard/multiPeriodSatellite.test.tsx
 ✓ src/features/dashboard/multiPeriodSatellite.test.tsx (10 tests) 417ms
 Test Files  1 passed (1)
      Tests  10 passed (10)
 Duration  997ms
```
（T2-1/2/3、T5-1/2/3、T8-1/2/3/4 全绿；原红点 `:654` 已在其新位置段 2 通过）

### 3.2 全量
```
cd web && ./node_modules/.bin/vitest run
 Test Files  72 passed (72)
      Tests  672 passed (672)
 Duration  5.48s
```

### 3.3 门禁
```
cd web && ./node_modules/.bin/tsc -b        → tsc exit=0
cd <repo> && ./scripts/check-tangle.sh      → [check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。 tangle exit=0
```

### 3.4 崩溃 / core dump
**无**。各次运行无 unhandled rejection、无进程崩溃、无 core 文件产生；仅 React Router v7 future-flag 警告（既有、非本用例引入）。

---

## 4. 边界与残留风险

- **何以此非放宽（一句话）**：并发闸、预算上限、周期覆盖三条判据一条未删、阈值一字未改，只是把「覆盖 4 周期」从**同一挂起窗口**移到**释放名额之后**——而且额外加了「释放 1 个名额后必须发生**新派发**（`> inFlight`）」的排队补发判据与「在途 > 0」防空断言，判据数量 8→15、覆盖面只增不减。
- **残留风险 R1（低）**：段 2 依赖闸门在 `pending.shift()` 后于微任务内接续派发（`release()` → `queue.shift()` 同步调用 `fn()`）。当前实现满足；若未来闸门改为「定时器/宏任务」放行，段 2 需给一次额外 `advanceTimersByTimeAsync(0)`。当前 `advanceTimersByTimeAsync(0)` 已足够。
- **残留风险 R2（低）**：未做变异测试（不允许改产品代码）。对「丢请求」的判别力由「增长 + 覆盖 4 周期」两条同时保证；对「放宽并发闸」的判别力由段 1 `≤3` 保证。
- **未做**：无任何修复/调试产品代码的尝试；未新增永久插桩。

---

## 5. 交付物
- 改动：`web/src/features/dashboard/multiPeriodSatellite.test.tsx`（T8-2，+47/−26，仅此一处）
- 本执行报告：`tester/test/270_p2c0_t82_two_phase_execution.md`
- 暂存区：**空**（`git diff --cached --name-only` 无输出；未 add/commit/stash）

VERDICT: GREEN
