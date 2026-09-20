# T4 flaky 根因取证 + 规格侧确定性修复（ADR-028 D4.1 冻结规格 `adr028-features-verify.e2e.ts`）

**本报告路径**：`tester/evidence/20260920_t4_flaky_rootcause/report.md`
**原始输出目录**：`tester/evidence/20260920_t4_flaky_rootcause/raw/`

---

## 判词（一行）

**根因 = 产品侧**（K 线 B/S 成交标记在「run 级 `/fills` 先于图表 K 线数据提交」的时序下**永久丢失**；规格侧的 `waitForTimeout(2500)`「等落定」是**次生**缺陷，同一根因下即使再等 11s 也不会恢复——已用注入法确定性复现，失败原文与历史红逐字一致） ｜ **规格侧修复 = 完成**（固定 sleep → 显式就绪判据：图表 `dataList` 非空 + `data-marker-overlays` == 已加载成交笔数；T4 另要求写窗真身回执 rev 到位） ｜ **连续跑 11 次全量（`--workers=1 --retries=0`）11/11 全绿**（+ 收尾复核 1 次 = 12/12；45.1–45.3s/次；T4 每次均为 10.9s，**不再出现 4.1s 级提前失败**） ｜ **产品侧竞态 = 有（待修）** ｜ **是否建议冻结**：**规格侧随机性已消除，可冻结**；但**产品侧竞态须另派车道修复**——命中时套件会在就绪判据处**显式红**（不再随机停在几何断言上，见 §6）。

---

## 0. 一句话结论（供快速判断）

历史那次「T4 4.1s 提前红」**不是**「断言跑在数据就绪之前」的时间不足问题，而是**产品侧静默丢失全部 B/S 标记**：`/fills` 先于图表 K 线数据落定时，
`KlineChart` 的标记重建路径用了**挂载渲染时的 `props.overlays` 快照**（当时为空）+ `Effect M` 在 `feed.bars` 为空时建 0 个标记，
此后**没有任何路径再重建** ⇒ `data-marker-overlays=0`、store 内 `fillDot=0` **永久**（实测 12s 采样全程为 0）。
T4 的第一条依赖标记的断言正是「跳转后目标笔几何必须可测」⇒ 必然死在该行；因为**不依赖任何等待**，
它表现为「极快（4.1s）失败」。

规格侧原实现把「初始装载落定」交给 `waitForTimeout(2500)`，既**不能**修这个根因（永久丢失），又确实是「固定 sleep 充成功」的反模式 ⇒ 一并按纪律改为显式就绪判据（§4）。

---

## 1. 环境与真身锚定（本波起点）

| 项 | 值 | 证据 |
|---|---|---|
| 项目根 | `/home/eestock/workspace/git/eestock/eestock-rs` | — |
| 真身 | 主机进程 `./target/debug/eestock-app --config /tmp/app_dev_8081.toml`（PID 1941108，`static_dir=./web/dist`），`:8081` LISTEN | `ss -ltnp \| grep 8081` |
| 被服务 bundle | `assets/index-xGaRgVd-.js`，sha256 `8d936e11f5d0d448434cf0d6907d8d907f0e544e8bd0a2805d1d06433993a8bc`（== 规格常量） | `curl -s http://localhost:8081/assets/index-xGaRgVd-.js \| sha256sum` |
| `web/dist` | 未改动（`index.html` mtime 12:13，bundle sha 与规格锚点一致） | §8 收尾核验 |
| 冻结规格（起点） | `web/e2e/adr028-features-verify.e2e.ts`；起点 sha256 `6b9eb324196aff6b5660adea9d1446687294ba3d2adab009f182f4c4aa90665e` | 起点备份 `/tmp/adr028_features_verify.spec.prefix.bak` |
| 冻结规格（修后） | sha256 `def97eac0daccd89e54069caddb2d97b9d9733eb20d6858c698274d9c7e58db0`（mtime 12:46:38 —— **早于** §5 的 11 次全量（12:48–12:56），即这 11 次跑的正是本报告所述的最终文件） | `sha256sum web/e2e/adr028-features-verify.e2e.ts` |
| run A（T1–T7 主用） | `sr_1789865219068_000001`（159776 / 1d / 174 根，44 笔成交；第 42/43 笔同 bar） | `GET /api/workbench/runs/…` |
| 真身端点延迟（20 次采样） | `/api/kline`（D1 窗）：min 4.9ms / p50 5.4ms / **max 8.4ms**；`/fills?limit=5000` 0.7–2.4ms；`/round-trips` 0.7–1.0ms | `raw/api_latency_20260920.txt` |

> 关键量化事实：**图表 K 线取数不是慢接口**（max 8.4ms）。因此「跳转时数据还没到（需要 >3.3s）」这种解释在定量上站不住；
> 而「标记在竞态下永久丢失」与观测完全吻合（§3）。

内存全程无压力：`free -h` 在每步前记录，`used 17–18Gi / available 25–28Gi`（§7）。

---

## 2. 历史红的原始证据（上一轮，未修改）

来源：`tester/evidence/20260920_result_resize_verify/raw/frozen_features_verify.txt`（同规格第 1 次全量）

```
  ✘   5 [chromium] › e2e/adr028-features-verify.e2e.ts:558:1 › T4 只高亮被点击那一笔 [@mut]：… (4.1s)
    Error: 跳转后目标笔几何必须可测（按 ts+价格定位）
    expect(received).toBe(expected) // Object.is equality
    Expected: true
    Received: false
      581 |   const gA = geomCells[`${fA.ts}:${fA.price}`];
      582 |   const gB = geomCells[`${fB.ts}:${fB.price}`];
    > 583 |   expect(gA != null && gB != null, '跳转后目标笔几何必须可测（按 ts+价格定位）').toBe(true);
  9 passed (56.7s)
```

* 失败点 = T4 的**第一条依赖「目标笔 fillDot 存在」**的断言（`geomByFill` 读 `getOverlays({name:'fillDot'})`）。
* 用时 4.1s（正常 13.6–13.9s）⇒ 该次运行**在等不到任何东西的情况下**直接死在标记缺失上。
* 无 crash / 无 core dump（`/proc/sys/kernel/core_pattern=core-%t-%p`，仓库内无 `core*`）。

---

## 3. 根因取证

### 3.1 该步依赖的前置条件清单（T4 几何步）

`geomByFill()` 的判据成立需要**同时**满足：

| # | 前置条件 | 读点 |
|---|---|---|
| P1 | 真图表实例被捕获且 **`getDataList().length > 0`**（数据到位） | `window.__wbCharts` |
| P2 | 图表存在 **`fillDot` overlay、且其 `points[0]` 有该笔的 (ts, price)** | `chart.getOverlays({name:'fillDot'})` |
| P3 | 标记 ts 经 `snapTsToBars(feed.bars)` 吸附到已加载 bar（`feed.bars` 非空） | 产品内部 |
| P4 | `convertToPixel` 可测（与窗口写窗无关；只要实例在） | `chart.convertToPixel` |

探针（`raw/probe_source/adr028-t4-flaky-probe.e2e.ts`，**临时取证规格，已删除**）在 geom 读取时刻逐项读回：

* P1 失败 ⇒ `cands=0 / dataLens=[]`；P2 失败 ⇒ `cands=1, dataLen=174, dots=0, matched=false`。

### 3.2 排除法：为什么不是「规格侧断言跑太早」也不是「跳转/高亮本身失效」

1. **跳转/高亮本身正常**：注入复现（§3.3）失败时刻的采样里 `data-highlight-active=true`、
   `data-highlight-key=1:42`、写窗回执 `wb-window-probe data-ok=true rev=3`（K 线数据一旦到位即写窗成功）。
2. **不是时间不足**：注入「K 线取数延迟 1500ms」后，数据在 t=1508ms 就位（`dataLen=174`），
   但标记**在随后 11s 内始终为 0**（`raw/probe_delay_kline1500/t4_timeline.json`，30 条状态变化样本，`dots=0` 全程）。
   ⇒ 任何「多等一会」的写法都救不了历史那次红。
3. **不是慢接口**：`/api/kline` p50 5.4ms / max 8.4ms（n=20）。要「点跳转时数据未到」需要 >3.3s 的响应，无依据。

### 3.3 确定性复现（注入手段 + 原始输出）

**注入手段**：把图表 K 线取数推迟到 run 级 `/fills` 之后（不改生产代码，全部在浏览器侧；也不触碰冻结规格本身）：

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs/web
# 由冻结规格逐字节复制一份，只在 test.beforeEach(addInitScript) 之后插入下面 12 行
# （副本源码留档：tester/evidence/20260920_t4_flaky_rootcause/raw/probe_source/adr028-t4-inject.e2e.ts）
cp e2e/adr028-features-verify.e2e.ts e2e/adr028-t4-inject.e2e.ts
```

插入片段（与冻结规格的**唯一**差异）：

```ts
const INJ_KLINE_MS = Number(process.env.ADR028INJ_KLINE_MS ?? '0');
if (INJ_KLINE_MS > 0) {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/kline*', async (route) => {
      await new Promise((r) => setTimeout(r, INJ_KLINE_MS));
      await route.continue();
    });
  });
}
```

**复现命令与判词**（原始输出：`raw/inject_t4/run_t4_delay_kline1500.txt`）

```bash
cd web && timeout 300 env E2E_BASE_URL=http://localhost:8081 ADR028INJ_KLINE_MS=1500 \
  ADR028V_OUT=$PWD/../tester/evidence/20260920_t4_flaky_rootcause/raw/inject_t4 \
  npx playwright test e2e/adr028-t4-inject.e2e.ts -g "T4 " --workers=1 --retries=0 --reporter=list
```

```
  ✘  1 … T4 只高亮被点击那一笔 [@mut]：白描边簇恰 1 个且质心落在该笔堆叠位置；3 秒后回落为 0 (4.4s)

    Error: 跳转后目标笔几何必须可测（按 ts+价格定位）
    expect(received).toBe(expected) // Object.is equality
    Expected: true
    Received: false
    > 594 |   expect(gA != null && gB != null, '跳转后目标笔几何必须可测（按 ts+价格定位）').toBe(true);

  1 failed
```

> **与历史红逐字同因**：同一断言、同一文案，用时 **4.4s ≈ 历史 4.1s**（都表现为「不等任何东西、直接死在标记缺失」）。

### 3.4 剂量-反应（区分「K 线慢」与「fills 先到」）

| 注入 | 采样（geom 时刻起 12s） | 判词 |
|---|---|---|
| `ADR028PROBE_DELAY_KLINE_MS=1500`（**K 线晚于 fills**） | t=51ms `dots=0`；t=1508ms `dataLen=174, dots=0, matched=false`；**直到 t=11400ms 仍 `dots=0`**；全程 `hlAct=true`、`marker=0` | **永久丢失**（复现红） |
| `ADR028PROBE_DELAY_FILLS_MS=1500`（**fills 晚于 K 线**，对照） | t=51ms `dots=0`（fills 未到）；**t=1500ms `dots=44, matched=true`**；`hlAct` 在 t=3951ms 起 true | 自愈（`settleJump` 因「高亮 active」需 `props.overlays` 非空 ⇒ 本会等到 fills 到位） |

原始输出：`raw/probe_delay_kline1500/t4_timeline.json`、`raw/probe_delay_fills1500/t4_timeline.json`。

### 3.5 机制定位（产品侧，代码级）

`web/src/features/dashboard/KlineChart.tsx`：

```
845:    void feed.loadInitial().then(() => {          // Effect W 的取数回调（闭包 = Effect W 运行的那次渲染的 props）
853:        setMarkerCount(createMarkerOverlays(chart, props.overlays ?? [], feed.bars));
869-874: useEffect(... [props.overlays, feed] ...)   // Effect M：removeOverlay({name:'fillDot'}) + createMarkerOverlays(..., feed.bars)
```

时序（= 注入复现的时序，`/fills` 先到）：

1. 挂载渲染时 `fills.rows=[]` ⇒ Effect W 的闭包持有的 `props.overlays` **为空数组**；
   `ScopedKlineFeed.bars=[]`（K 线 HTTP 未回）。
2. `/fills` 先落定 ⇒ React 提交 ⇒ **Effect M**：`createMarkerOverlays(chart, overlays(44), feed.bars=[])`
   ⇒ `snapTsToBars([]) === null` ⇒ **建 0 个标记**，并把 `data-marker-overlays` 置 0。
3. K 线数据随后落定 ⇒ **Effect W 的 `loadInitial().then` 回调**：`removeOverlay({name:'fillDot'})` +
   `createMarkerOverlays(chart, props.overlays /* 第 1 步的**陈旧空快照** */, feed.bars(174))` ⇒ 仍 **0 个**。
4. 此后**无任何重建路径**（Effect M 的依赖 `[props.overlays, feed]` 不再变化；无 Re-render 触发的重建）
   ⇒ **永久 0**。

**证据链（闭环）**：注入复现里 `data-highlight-active=true`（该属性 = `findMarkerByFillKey(props.overlays, key) != null`，
即**最新渲染**的 `props.overlays` **确实含**该笔）+ 图表 `getOverlays()` 里 `fillDot` **恰为 0** ⇒
最后一次标记创建必然用的是**与最新 props 不一致的陈旧快照**（否则会建出 44 个）。这正是 `KlineChart.tsx:853`。

> 影响面（产品侧）：只要 `/fills` 提交早于图表 K 线数据提交，**B/S 标记全丢**，而页面同时仍显示
> 「成交合计 44 笔（精确源 /fills，已加载 44 / 共 44）」⇒ **静默不一致**（ADR-028 D4.1「每笔成交一个标记」被违反）。

### 3.6 「为何难以自然复现」的定量依据（顺序统计）

`/fills` 与 `/api/kline` 谁先落定是**毫秒级赛跑**，没有任何结构性次序保证：

| 条件 | n | `t_kline − t_fills`（响应到达差，ms） | 标记丢失次数 | 证据 |
|---|---|---|---|---|
| **冷上下文**（每次全新 browser context，等同套件条件） | 20 | 0,0,0,0,0,0,2,2,2,2,2,2,2,3,3,3,3,3,4,5（min 0 / mean +2.0 / **max +5**） | **0/20** | `raw/probe_mimic_cold2/mimic_stats.json` |
| 冷上下文 + 10 个忙循环（16 核） | 8 | 0×7, −2（min −2 / max 0） | **0/8** | `raw/probe_mimic_loaded/mimic_stats.json` |
| **热上下文**（同一 page 连续 12 次装载 ⇒ JS/JIT/DB 全热，赛跑贴得更近） | 12 | −27,2,2,3,4,5,6,9,10,**12**,14,**19** | **2/12（发生在 +12 / +19 两次）** | `raw/probe_order/order_stats.json` |
| 冻结规格 T1 复跑（冷上下文，n=12） | 12 | — | 0/12（12 passed，4.5–4.6s/次） | `raw/natural_T1_x12/run.txt` |
| 冻结规格 T4 仿跑（冷上下文，n=20，**含 2500ms 固定等待**） | 20 | — | 0/20（`dots=44`、`matchedA/B=true`、`klineRequests=1` 全部一致） | `raw/probe_mimic/mimic_stats.json` |

判读：**丢失需要 `/fills` 领先一个可观余量（这批数据里 ≥ ~10ms）**；冷上下文里两者基本同拍（0–5ms，均值 +2ms）
⇒ 自然丢失率低（历史观测 ≈ 1/12 次全量），但**确实存在**且判据完全由毫秒级调度决定 ⇒ 属**真 flaky 根因**，不是环境噪声：
一旦命中，判定 100% 是「标记缺失」。

附加排除：`/api/kline` 请求数在 20 次仿跑中恒为 1（`klineRequests=1`）、`dataLens` 无中途清空
⇒ 排除「WS/`run` 身份变化触发图表重载」这条路（`store.onProgress` 只对 queued/running 行重捞）。

---

## 4. 规格侧确定性修复（仅改 `web/e2e/adr028-features-verify.e2e.ts`）

**改动 3 处 + 1 处取证留痕**（`git diff` 全文见 §8）：

1. `openRunSettled()`：删除 `await page.waitForTimeout(2500)`，改为**显式就绪判据**（新函数 `chartReadyState()` / `expectedMarkerCount()`）：
   * ① 图表 K 线数据到位：`expect.poll(maxDataLen).toBeGreaterThan(0)`（真图表实例 `dataList` 非空）；
   * ② 成交明细到位 + **每笔成交一个 `fillDot`**：`data-marker-overlays === 已加载成交笔数`（期望值**读页面自身**的
     `wb-fills-note` 文案导出：`成交合计 N 笔（… 已加载 L / 共 N）` ⇒ 期望 L；`加载中…`/`未记录…` ⇒ 期望 0；
     文案无法解析 ⇒ **显式抛错**，禁止静默放宽）。
   超时即红并打印 `MISMATCH data-marker-overlays=… want=… note=…`（不再是「三无失败」）。
2. `settleJump()`：新增可选 `requireReceipt`（默认 false，**仅 T4 打开**）——要求**写窗真身回执**到位
   （`wb-window-probe` `data-ok=true` 且 `data-rev === data-cmd-rev`，即 ADR-028 §3.4 的回读口径）。
   T3/T5/T7 等保持原语义（不扩大它们的失败面）。
3. T4 内：删除跳转前的 `await page.waitForTimeout(250)`（`scrollIntoViewIfNeeded` 默认瞬时返回；
   跳转前**无任何**判据依赖该滚动位置 ⇒ 属无依据固定等待）。
4. T4 内新增 `writeJson('t4_geom_state', …)`：几何步失败时自带状态画像（`geomCells` + `chartState` + `wb-window-probe`）。

**判据未做任何放宽**：T4 的 `expect(gA != null && gB != null, '跳转后目标笔几何必须可测')`、
白簇恰 1 个 / 质心 ±3px / 3s 回落 / 同 bar 另一笔互斥等**全部逐字保留**；未加 retry，未加 sleep 护栏，未改阈值。

---

## 5. 确定性证明：连续 11 次全量（`--workers=1 --retries=0`）

命令（每次一条，`timeout 600` 前缀；本波共执行 **11** 次全量 + 1 次注入对照）：

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs/web
timeout 600 env E2E_BASE_URL=http://localhost:8081 \
  ADR028V_OUT=$PWD/../tester/evidence/20260920_t4_flaky_rootcause/raw/postfix_full_runs/rNN \
  npx playwright test e2e/adr028-features-verify.e2e.ts --workers=1 --retries=0 --reporter=list
```

| # | 命令产物（原始输出） | 判词 | 套件用时 |
|---|---|---|---|
| 修前基线 | `raw/prefix_full_run/run.txt` | **10 passed** | ≈66s（reporter `1.1m`） |
| r00 | `raw/postfix_full_runs/r00.txt` | **10 passed** | 45.2s |
| r01 | `raw/postfix_full_runs/r01.txt` | **10 passed** | 45.1s |
| r02 | `raw/postfix_full_runs/r02.txt` | **10 passed** | 45.2s |
| r03 | `raw/postfix_full_runs/r03.txt` | **10 passed** | 45.2s |
| r04 | `raw/postfix_full_runs/r04.txt` | **10 passed** | 45.1s |
| r05 | `raw/postfix_full_runs/r05.txt` | **10 passed** | 45.2s |
| r06 | `raw/postfix_full_runs/r06.txt` | **10 passed** | 45.2s |
| r07 | `raw/postfix_full_runs/r07.txt` | **10 passed** | 45.1s |
| r08 | `raw/postfix_full_runs/r08.txt` | **10 passed** | 45.1s |
| r09 | `raw/postfix_full_runs/r09.txt` | **10 passed** | 45.3s |
| r10 | `raw/postfix_full_runs/r10.txt` | **10 passed** | 45.2s |
| r_final（收尾复核，所有文件操作完成后） | `raw/postfix_full_runs/r_final.txt` | **10 passed**（T4 10.9s，套件 45.2s） | 45.2s |

**11/11 全绿**（r00–r10 = 连续 11 次；`--retries=0`，无重试；另有收尾复核 1 次 = 12/12）。修后套件更快（45.1–45.3s vs 修前 ≈66s）——因为去掉了 9 处 2.5s 固定等待。

### 5.1 每次运行的分用例耗时分布（证明不再出现 4.1s 级提前失败）

| 用例 | r00 | r01 | r02 | r03 | r04 | r05 | r06 | r07 | r08 | r09 | r10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T0 | 0.4 | 0.4 | 0.4 | 0.4 | 0.4 | 0.4 | 0.4 | 0.4 | 0.4 | 0.4 | 0.4 |
| T1 | 1.4 | 1.4 | 1.4 | 1.4 | 1.4 | 1.4 | 1.4 | 1.4 | 1.4 | 1.4 | 1.4 |
| T2 | 1.3 | 1.3 | 1.3 | 1.3 | 1.3 | 1.3 | 1.3 | 1.3 | 1.3 | 1.3 | 1.3 |
| T3 | 1.7 | 1.7 | 1.7 | 1.8 | 1.8 | 1.8 | 1.7 | 1.7 | 1.8 | 1.8 | 1.8 |
| **T4** | **10.9** | **10.9** | **10.9** | **10.9** | **10.9** | **10.9** | **10.9** | **10.9** | **10.9** | **10.9** | **10.9** |
| T5 | 6.9 | 6.9 | 6.9 | 6.9 | 6.9 | 6.9 | 6.9 | 6.9 | 6.9 | 6.9 | 6.9 |
| T6a | 1.6 | 1.6 | 1.6 | 1.6 | 1.6 | 1.6 | 1.6 | 1.6 | 1.6 | 1.6 | 1.6 |
| T6b | 1.6 | 1.7 | 1.6 | 1.6 | 1.6 | 1.6 | 1.6 | 1.6 | 1.6 | 1.6 | 1.6 |
| T6c | 15.8 | 15.8 | 15.8 | 15.8 | 15.8 | 15.8 | 15.8 | 15.8 | 15.8 | 15.9 | 15.9 |
| T7 | 3.1 | 3.1 | 3.1 | 3.1 | 3.1 | 3.1 | 3.1 | 3.1 | 3.1 | 3.1 | 3.1 |

* **T4：11 次全部 10.9s（min=max）**。历史异常档 **4.1s** 在 11 次中**零出现**；修前正常档 13.6–13.9s/修后 10.9s（去掉了 2.5s + 0.25s 固定等待，并新增回执就绪判据）。
* 全表机器可读：`raw/postfix_full_runs/timings.json`（由各 `rNN.txt` 的 `✓` 行解析）。

### 5.2 修复对注入复现的作用（同一注入、同一断言口径）

| 运行 | 命令 | 判词 | 原始输出 |
|---|---|---|---|
| 修**前** + 注入 K 线延迟 1500ms | `ADR028INJ_KLINE_MS=1500 npx playwright test … -g "T4 "` | **红**：`Error: 跳转后目标笔几何必须可测（按 ts+价格定位）`（4.4s，**静默**：只报「几何不可测」） | `raw/inject_t4/run_t4_delay_kline1500.txt` |
| 修**后** + 同一注入 | 同上 | **红（确定性、可自解释）**：`MISMATCH data-marker-overlays=0 want=44 note=成交合计 44 笔（精确源 /fills，已加载 44 / 共 44）`，位于 `openRunSettled` 就绪判据 | `raw/inject_t4/run_t4_delay_kline1500_AFTER_FIX.txt` |
| 修**后** + 注入=0（对照） | `ADR028INJ_KLINE_MS=0 … -g "T4 "` | **passed（11.2s）**（对照证明注入副本本身不引入差异） | `raw/inject_t4/run_t4_control_AFTER_FIX.txt` |

**这两条对比就是本波的定性结论**：T4 的 flaky **不是**判据缺陷，而是产品侧状态缺陷；规格侧能做的是
（a）把它从「随机停在无关断言上」变成「确定性、指名道姓地红」，（b）把「等落定」从固定 sleep 改为显式条件。
**变异防线未削弱**：注入造成的可观测（`fillDot` 全丢）与「丢标记」类变异等价，规格在该状态下**变红**（不是变绿）。

---

## 6. 产品侧残留竞态（**交架构师，另派实现车道**）

**状态：存在（未修，未打补丁——本车道不触碰生产代码）。**

* **现象**：`/fills` 提交早于图表 K 线数据提交时，**全部 B/S 成交标记永久丢失**（`data-marker-overlays=0`、
  图表 `getOverlays()` 无 `fillDot`），页面同时仍显示「成交合计 44 笔（已加载 44 / 共 44）」⇒ 静默不一致。
* **最小复现（可执行）**：
  1. `cp web/e2e/adr028-features-verify.e2e.ts web/e2e/adr028-t4-inject.e2e.ts`（源码留档：`raw/probe_source/adr028-t4-inject.e2e.ts`）；
  2. 在 `test.beforeEach(...)`（`addInitScript(PAGE_CAPTURE)` 那条）**之后**插入 §3.3 的 12 行 `page.route('**/api/kline*')` 延迟片段；
  3. 跑：
     ```bash
     cd web && timeout 300 env E2E_BASE_URL=http://localhost:8081 ADR028INJ_KLINE_MS=1500 \
       ADR028V_OUT=/tmp/inj npx playwright test e2e/adr028-t4-inject.e2e.ts -g "T4 " --workers=1 --retries=0 --reporter=list
     ```
     或直接用探针（更精简、不带断言）：
     ```bash
     cd web && timeout 300 env E2E_BASE_URL=http://localhost:8081 ADR028PROBE_DELAY_KLINE_MS=1500 \
       ADR028PROBE_OUT=/tmp/probe npx playwright test <探针规格> -g "时序"
     ```
  4. 原始输出：`raw/inject_t4/run_t4_delay_kline1500.txt`（修前）、`raw/probe_delay_kline1500/t4_timeline.json`（12s 状态序列）。
* **修复方向（供实现车道参考，非本车道改动）**：`web/src/features/dashboard/KlineChart.tsx`
  * `:845-853`（`feed.loadInitial().then(...)` 里的 `createMarkerOverlays(chart, props.overlays ?? [], feed.bars)`）
    读的是 **Effect W 那次渲染的陈旧 `props.overlays`** ⇒ 应改为读**最新值**（`useRef` 同步 / 依赖 `props.overlays` 的重建路径），
    或把「标记重建」统一收敛到 `Effect M`（并让 `Effect M` 在 `feed.bars` 就绪后有明确触发点，而不是仅在 `feed` 身份变化时）。
  * 建议同时补一条产品侧护栏：`fills.rows` 非空 + `feed.bars` 非空 ⇒ 标记数必须 == `fills.rows.length`（可为单测/组件测试固化该时序）。
* **对套件的影响（重要）**：该竞态命中时，修后规格会在**就绪判据处显式红**（含 `MISMATCH … want=… note=…`），
  不再随机停在 T4 几何断言。即：**判定不再 flaky，但该时段的套件结果仍是红**（红得确定、可自解释）。

---

## 7. 纪律证据

* **单车道**：未 spawn 任何子代理；playwright 只跑本规格（`--workers=1 --retries=0`，**禁用 retries**）；
  每次均 `timeout` 前缀（探针/注入 300s、全量 600s）。
* **资源**：`free -h` 每步记录：`used 17–18Gi / available 25–28Gi`，无内存压力（全文见各步输出）。
* **收尾进程卫生**（复核时间 12:56–13:0x；`pgrep`/`ps` 的自匹配已用括号写法与快照法排除）：
  * `pgrep -af 'ms[-]playwright'` ⇒ **空**（无 playwright 浏览器残留）；
  * `ps -eo pid,cmd > /tmp/ps_snapshot.txt` 快照法统计：`ms-playwright` / `vite preview` / `headless_shell` 各命中 **1 条 = 该复核命令自身的 bash 行**（不是浏览器/预览进程）；
  * 快照中另有 17 条 `snap/chromium`、Steam `steamwebhelper` 等**他人桌面进程**（`/home/eedy/...`，启动早于本波）⇒ 非本波产生；
  * `ls core*` ⇒ 无；`/proc/sys/kernel/core_pattern = core-%t-%p`；
  * 无 `node`/playwright 残留进程。
* **真身未动**：`:8081` 仍为 PID 1941108；`web/dist/index.html` mtime 12:13 未变；bundle sha256 未变（== 规格锚点）。
* **未改生产代码**：本波改动只有 ` M web/e2e/adr028-features-verify.e2e.ts`（外加本报告目录 `tester/evidence/20260920_t4_flaky_rootcause/` 为新增未跟踪文件）；
  `git status --porcelain` 里另有一条 ` M design/01-architecture/adr/ADR-023-period-set-extension-30m.md`，**起点即已存在**（本波开始时就在），非本波产生；
  `git diff --cached` **空**（无 staged 文件）。
* **临时探针已删除**：`web/e2e/adr028-t4-flaky-probe.e2e.ts`、`web/e2e/adr028-t4-inject.e2e.ts` 已 `rm`
  （`ls web/e2e/ | grep -E "inject|flaky-probe"` ⇒ 空；收尾 `git status --porcelain web/` ⇒ 仅 ` M web/e2e/adr028-features-verify.e2e.ts`）；
  源码留档 `raw/probe_source/`（可复跑，不作为永久规格）。
* 全部 `grep/find` 带 `--exclude-dir target --exclude-dir node_modules --exclude-dir .git`（或等价限定路径）。

---

## 8. 复现命令（单车道、全程 `timeout`）

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs

# 0) 真身与锚点
ss -ltnp | grep 8081
curl -s http://localhost:8081/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
curl -s http://localhost:8081/assets/index-xGaRgVd-.js | sha256sum     # 8d936e11…

# 1) 规格侧改动（唯一变更文件）
git diff web/e2e/adr028-features-verify.e2e.ts
timeout 600 npx tsc -b                                              # web/ 下执行，exit 0

# 2) 确定性证明：连续 11 次全量
cd web
for i in $(seq -w 1 10); do
  timeout 600 env E2E_BASE_URL=http://localhost:8081 \
    ADR028V_OUT=$PWD/../tester/evidence/20260920_t4_flaky_rootcause/raw/postfix_full_runs/r$i \
    npx playwright test e2e/adr028-features-verify.e2e.ts --workers=1 --retries=0 --reporter=list
done

# 3) 注入复现（产品侧竞态）；探针/注入源码见 raw/probe_source/
cp ../tester/evidence/20260920_t4_flaky_rootcause/raw/probe_source/adr028-t4-inject.e2e.ts e2e/adr028-t4-inject.e2e.ts
timeout 300 env E2E_BASE_URL=http://localhost:8081 ADR028INJ_KLINE_MS=1500 ADR028V_OUT=/tmp/inj \
  npx playwright test e2e/adr028-t4-inject.e2e.ts -g "T4 " --workers=1 --retries=0 --reporter=list   # 期望：红（MISMATCH …）
cp ../tester/evidence/20260920_t4_flaky_rootcause/raw/probe_source/adr028-t4-flaky-probe.e2e.ts e2e/adr028-t4-flaky-probe.e2e.ts
timeout 300 env E2E_BASE_URL=http://localhost:8081 ADR028PROBE_DELAY_KLINE_MS=1500 ADR028PROBE_OUT=/tmp/probe \
  npx playwright test e2e/adr028-t4-flaky-probe.e2e.ts --workers=1 --retries=0 --reporter=list        # 12s 状态序列 ⇒ dots=0 全程
rm -f e2e/adr028-t4-inject.e2e.ts e2e/adr028-t4-flaky-probe.e2e.ts

# 4) 收尾
pgrep -af '[v]ite preview' ; pgrep -af 'ms-playwright' | wc -l ; ls core* 2>/dev/null ; free -h
```

---

## 9. 残留风险与建议

| # | 风险 | 级别 | 处置建议 |
|---|---|---|---|
| 1 | **产品侧竞态未修**：`/fills` 先于图表 K 线数据提交 ⇒ B/S 标记永久丢失（§6） | **高**（功能正确性 + 静默不一致） | 另派实现车道按 §6 修复方向处理；修复后复跑 §5 命令（预期该注入下 T4 全绿 = 竞态消失的判定口径） |
| 2 | 自然命中时套件在该就绪判据处**红**（15s 后超时）——不是 flaky，但是 red | 中 | 属**期望**行为（宁可红得明确）；修复 #1 后自然消失 |
| 3 | 就绪判据的期望值来自 `wb-fills-note` 文案 | 低 | 文案若变更，`expectedMarkerCount()` 会**显式抛错**（不静默放行）；须在同一次改动中更新规格（已注释说明） |
| 4 | T4 新增「写窗回执 rev 到位」前置（`requireReceipt`，仅 T4） | 低 | 已在注释中标注口径（ADR-028 §3.4 / F18）；T3/T5/T7 语义未变 |
| 5 | 本波**未**重跑变异构建反证（`--outDir dist-mut` + `:4175`） | 低 | 本波判据未放宽、只加等待；且「丢标记」类变异已由 §5.2 的注入运行证明**仍变红**。如需完整反证，由下一波（或实现车道修复后）统一跑一次 |
| 6 | 新增测试留痕产物 `t4_geom_state.json` | 无 | 仅测试侧 JSON（无生产仪表），便于下次几何步失败自解释 |

**是否建议冻结**：**规格侧可冻结**（随机性已消除：11 次全量 11/11 全绿，T4 恒 10.9s，无 4.1s 档）；
**但请勿把「产品侧竞态已修」写入放行结论**——它仍需实现车道修复；在该修复前，一旦命中，套件会以本报告 §5.2 的确定性红暴露（15s 就绪判据超时 + `MISMATCH … want=…`）。
