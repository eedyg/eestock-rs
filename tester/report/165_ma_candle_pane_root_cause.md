# 165 — klinecharts 10.0.3 「MA 在 candle_pane 不渲染 / 不在 getIndicators()」根因探针（只读）

- 本报告路径：`tester/report/165_ma_candle_pane_root_cause.md`
- 复现脚本（须在 `web/` 下运行以解析 playwright）：`web/tester/probe-165/probe165.mjs`
- 原始证据 JSON（本报告取证副本）：`tester/evidence/165_ma_candle_pane/evidence165.json`
- 复现脚本副本（须在 web/ 运行）：`tester/evidence/165_ma_candle_pane/probe165.mjs`（原地保留 `web/tester/probe-165/probe165.mjs`）
- 被检库：`web/node_modules/klinecharts/dist/index.esm.js`，version=10.0.3；仓库 HEAD = `e2a04ee`
- 取证时间：2026-09-14（本机时钟）`ts` 见 JSON；18 个场景，`console/pageerror = []`（**无任何告警、无异常**）
- 无写请求（仅 127.0.0.1:18165 本地静态文件服务，未访问后端/线上）；未重启 PID 3112540；进程已自收尾（`pgrep -f 'probe16[5]'` 无输出）

## 1. 最小复现（真实 klinecharts，headless chromium，900×520 容器，120 根 bar）

```js
const chart = kc.init(box);
chart.setSymbol({ticker:'T',pricePrecision:2,volumePrecision:0});
chart.setPeriod({span:1,type:'day'});
chart.setDataLoader({getBars:({callback})=>callback(bars,false)});
chart.resetData();
const r1 = chart.createIndicator({name:'MA', calcParams:[5,10,20], paneId:'candle_pane'});  // ⇒ "MA_..._1"（非 null）
const r4 = chart.createIndicator({name:'BOLL', calcParams:[20,2], paneId:'candle_pane'});   // ⇒ "BOLL_..._2"
chart.getIndicators();   // ⇒ 只有 BOLL@candle_pane；MA 已消失
```

画布级渲染证据（`CanvasRenderingContext2D.fillText` 打点，绘制文本序列）：
- 只有 MA 时：`["MA5: ","MA10: ","MA20: "]`（**MA 正常渲染**）
- MA 之后建 BOLL 后：`["BOLL(20,2)"]`（MA 的图例文字**完全消失**）
- 全场景 `createIndicator` 返回值与非空 id 的记录见 `evidence165.json` 的 `steps[].ret`。

> 注：观测必须在创建后 ~250ms 再取（klinecharts 用 rAF 重绘），否则得到空的 `draws`（早期误解来源）。

## 2. 触发条件对照矩阵（`isStack` 省略 = false）

| # | 场景 | 创建顺序/参数 | `createIndicator` 返回 | 最终 `getIndicators()` | 渲染文本 |
|---|---|---|---|---|---|
| A | MA 单独 | MA(candle_pane,false) | id | MA@candle_pane | MA5/MA10/MA20 |
| B | EMA 单独 | EMA(candle_pane,false) | id | EMA@candle_pane | EMA12/EMA26 |
| C | BOLL 单独 | BOLL(candle_pane,false) | id | BOLL@candle_pane | BOLL(20,2) |
| D | **MA→EMA**（同 pane，均 false） | MA 先 | id(id) | **仅 EMA** | 仅 EMA ⇒ **MA 被静默移除** |
| E | **EMA→MA** | MA 后 | id(id) | 仅 MA | 仅 MA（EMA 被移除） |
| F | **MA→BOLL** | MA 先 | id(id) | **仅 BOLL** | 仅 BOLL ⇒ **MA 被静默移除** |
| G | BOLL→MA | MA 后 | id(id) | 仅 MA | 仅 MA |
| H | **应用真实顺序**：MA(candle_pane,false) → VOL/MACD/KDJ/BOLL(**isStack=true**，无 paneId) | MA 先 | 5 个 id | MA@candle_pane + 4 个独立 pane | MA5/MA10/MA20 + VOL/BOLL ✅ |
| I | H 逆序（副图先，MA 最后） | — | 5 个 id | 同上 ✅ | 同上 ✅ |
| J | MA 独立 pane | MA('MA', true) | id | MA@indicator_pane_* | MA5/MA10/MA60 ✅（与 P7c 一致） |
| K | MA 重复两次（同参数，false） | — | 每次都返回**新** id（非 null） | 仅 MA（后者替换前者） | ✅ |
| L | MA(candle_pane, **true**) | — | id | MA@candle_pane | ✅ |
| M | **数据后到**（grid 真实时序：先建 MA，再 resetData） | — | id | MA@candle_pane | ✅（数据到达后正常渲染） |
| N | MA 字符串名（默认 calcParams 5/10/30/60） | — | id | MA@candle_pane | ✅ |
| O | grid 真实代码序列：`removeIndicator({name:'MA'})` + create | — | id | MA@candle_pane | ✅ |
| P | MA(false) → EMA(candle_pane, **true**) | — | 2 个 id | **MA + EMA 共存同 pane** | MA5… + EMA12/26 ✅ |
| Q | MA(false) → EMA(false) → MA(false) | — | 3 个 id | 仅最后的 MA | ✅（最后创建者胜） |
| R | MA(false) → `{name:'EMA',paneId:'candle_pane'}`（isStack 省略） | — | 2 个 id | 仅 EMA | 仅 EMA ⇒ **MA 被静默移除** |

**结论（触发条件）**：与“MA 这个指标本身”“candle_pane 已有蜡烛”“先 MA 还是先其它”“数据先后”**全部无关**。唯一触发条件 =
> **同一个 pane 上，先建 MA（isStack=false/省略）→ 之后又有任意另一个指标以 isStack=false/省略建在同一 pane** ⇒ 后者的“整 pane 替换”语义把 MA 清掉。

即：**顺序问题 + `isStack` 缺省即替换**。MA 只是“先被创建、后被顶掉”的受害者；把 D/F/R 里的 MA 换成 EMA/BOLL，被移除的就是 EMA/BOLL（E/G 已证）。

## 3. 根因（源码行号，`web/node_modules/klinecharts/dist/index.esm.js`）

1. `ChartImp.prototype.createIndicator` **:15263-15274, :15292** — `isStack ?? false` 交给 store；成功即返回 `indicator.id`。**返回 id 不代表指标留在图中**，只代表“本次 addIndicator 未拒绝”。
2. `StoreImp.prototype.addIndicator` **:14150-14170**，关键 **:14162-14165**：
   ```js
   if (!isStack) {
       this.removeIndicator({ paneId: paneId });   // :14163 —— 清空该 pane 的全部指标
       paneIndicators = [];                        // :14164
   }
   paneIndicators.push(indicator);                 // :14166
   this._indicators.set(paneId, paneIndicators);   // :14167
   ```
   ⇒ `isStack=false` 的语义是 **“替换 pane 内容”（replace），不是“追加”（add）**。这才是“返回 id 但不在 `getIndicators()` 里”的唯一成因。
3. `StoreImp.getIndicatorsByFilter` **:14180-14196** — 仅当传入的 `id` 命中已有指标才去重（:14182-14186）；`createIndicator` 每次在 :15270 生成**新 id**，故去重分支永不命中：重复创建同参数 MA 也会返回**新 id**（矩阵 K），既不报错也不告警。
4. `logWarn('createIndicator', ...)` **:15267** 只在“指标未注册”时触发 ⇒ 本异常**全程零告警**（`console = []`），所以表现为“静默消失”。
5. MA 模板本身无异常：**`MA` 定义 :4135-4153**（`series:'price'`、`calcParams:[5,10,30,60]`、`shouldOhlc:true`），与 EMA/BOLL 同族，无同名冲突守卫、无特殊分支。
6. `_synchronizeIndicatorSeriesPrecision` **:14215-14240**（仅按 `symbol.pricePrecision` 同步精度）与本异常无关。

## 4. 对 P7c 实测异常的归因（原始证据对齐）

`tester/evidence/250_multiperiod_route_probe/p7.js:276-282`：
```js
const r1 = chart.createIndicator({name:'MA',  calcParams:[5,10,30], paneId:'candle_pane'}); // isStack 省略 ⇒ false
const r2 = chart.createIndicator({name:'MACD',...}, true);
const r3 = chart.createIndicator({name:'KDJ', ...}, true);
const r4 = chart.createIndicator({name:'BOLL',calcParams:[20,2], paneId:'candle_pane'});    // isStack 省略 ⇒ false ⇒ 清空 candle_pane
```
`p7_result.json → result.p7c.perInstance[*].indicators` 实测 = `[MACD@indicator_pane, KDJ@indicator_pane, BOLL@candle_pane, P7EXT@indicator_pane]` —— **MA 不在其中，BOLL 在 candle_pane 上**，与矩阵 R/F 预测**逐字段一致**。上一轮“EMA/BOLL 正常、MA 异常”的观感，就是这条顺序（BOLL 用省略 isStack 建在同一 pane 上把 MA 顶掉）。

## 5. 对「路线②（每周期一个独立 klinecharts 实例）」的影响结论

- 该异常**不因多实例而存在，也不会因多实例而消失**：它只由**单个实例内**“同 pane 第二个 `isStack=false` 指标”触发。
- 若路线②的每实例只建“自己的内置 MA（candle_pane,false）+ 其它指标全部独立 pane(isStack=true)”，则矩阵 H/I/M/O 已证 **MA 在每个实例内都正常渲染、正常出现在 `getIndicators()`** ⇒ **路线②下不存在该缺陷**（P7c 的失败纯粹是探针脚本自己的调用序列造成的假阳性）。
- 风险点仅剩：任何一处代码在 candle_pane 上再建一个 `isStack=false` 指标（例如把 BOLL/EMA/DCAP 放回主图、或把主图叠加指标依次 `createIndicator` 时漏写 `true`），MA 就会被静默顶掉，且**零告警**。

## 6. 规避方案与代价

| 方案 | 具体做法 | 代价/副作用 |
|---|---|---|
| **B1（推荐，最小代价）** | candle_pane 上的叠加指标一律显式 `isStack=true`：`KlineChart.tsx:155-158` 的 `false` → `true`；`GridCell.tsx:86` 同改。矩阵 P 已证 MA+EMA 同 pane 共存渲染 | ① 不再隐式替换 pane 内容 ⇒ 重复 create 会**叠加**而非替换，因此“参数变更/重复同步”必须显式 `removeIndicator` 再 create（grid 已有该调用，KlineChart 的 `applied` 差分已保证只建一次）；② 关闭指标时必须 `removeIndicator`（现有代码已按此契约：关态不残留 pane） |
| B2 | 保持 `isStack=false`，但**契约化为“candle_pane 只能有一个叠加指标（MA）”**，并在同步时保证它是该 pane 上最后一个被创建的 | 顺序敏感、极脆弱；任何新叠加指标加入主图就复发（P7c 即此坑），不可作为“通用框架”基础 |
| B3 | MA 不去 candle_pane，改为 `isStack=true` 独立副图（与 DCAP 同构） | 与当前 UI/规格（MA 在主图叠加）冲突，用户可感知的界面变化，代价最高 |
| B4 | 把 MA 换成自研模板（registerIndicator 自建 MA） | 不解决根因（替换语义仍在），且重复造轮子，不建议 |

**统一建议**：把“叠加到共享 pane 的指标”的 `isStack` 语义写进框架契约（B1），并在框架层封装 `addOverlayIndicator(paneId, spec)`：内部先 `removeIndicator({id})`（若已存在同 id）再 `createIndicator(spec, true)`，并断言返回 id 后 `getIndicators({name})` 非空（防“静默消失”回归）。这样才满足“通用框架，支持将来任何指标”。

## 7. 未做/未查（边界声明）

- 未验证“同一实例内 **重名** 指标建在不同 pane”等极端组合（与本异常无关）。
- 未做像素级 diff，渲染证据用 `fillText` 打点 + `getIndicators()` 双证（对本次结论充分）。
- 未改动任何仓库文件、未 git add/commit/stash、未 tangle、零写请求、未碰线上进程。

VERDICT: ROOT-CAUSED(触发条件=同 pane 后续 `isStack=false` 指标触发的“整 pane 替换”语义（`index.esm.js:14162-14167`）静默移除先建的 MA；`createIndicator` 仍返回 id（:15292）。与 MA 指标自身、candle_pane、蜡烛数据、多实例均无关；P7c 假阳性源于 `p7.js:276/279` 的调用序列（MA 与 BOLL 同为 isStack 省略的同 pane 指标）。规避：candle_pane 叠加指标改用 `isStack=true`（B1）＋框架层封装并断言 getIndicators.）
