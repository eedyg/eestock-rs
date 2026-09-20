# ADR-028 D4.1 独立复验报告（闸门 3，tester 车道）

**判词：醒目化 通过 ｜ 精确到笔高亮 通过 ｜ 3 秒回常态 通过 ｜ focus 滚动 通过 ｜ 曲线竖线 通过 ｜ 三态提示 通过 ｜ 无回归 红 ｜ 变异反证 有牙 ｜ 总判词 = 冻结（阻断项：T7 —— L2 跳转后 K 线画布溢出卡片，遮挡并拦截「全览 / 历史回退」按钮的鼠标点击）**

- 本报告路径：`tester/evidence/20260920_adr028_features_verify/report.md`
- 设计报告：`tester/design/304_adr028_d41_features_verify_design.md`
- 新增规格（自有）：`web/e2e/adr028-features-verify.e2e.ts`（10 用例：9 绿 1 红）
- 执行报告（回归部分）：`tester/test/304_adr028_d41_features_verify_execution.md`
- 被复验实现：`coder/evidence/20260920_adr028_features/`（bundle `assets/index-DhgvwmsX.js`，`web/dist` 由 :8081 静态托管）
- 真身：`http://localhost:8081`（`E2E_BASE_URL` 未覆盖时即 playwright 默认 baseURL）；**未起 vite preview 做常规复验**（只在变异反证阶段用临时 outDir + :4175）

---

## 1. 独立性声明（与实现方证据的关系）

- 本报告**不引用实现方的截图、JSON 或结论**做判据；每一条判据都在自建规格内重跑，像素证据在自建截图上重算。
- 口径与实现方规格 `adr028-fill-focus-highlight.e2e.ts` 的**差异（判据更严）**：
  1. focus：实现方只断言「锚点在**滚动容器**内」；本复验**同时**要求「K 线容器整体落在**视口**内」且「平滑滚动已落定（scrollTop 连续两次采样不变）」；
  2. 高亮：实现方以 DOM 属性（`data-highlight-key/-active`）为主；本复验要求 **真图表 store 中高亮 overlay 恰 1 条** + **canvas 白描边簇恰 1 个且质心落在该笔堆叠位置（±3px）**；
  3. 同 bar 多笔：实现方未覆盖；本复验命中现网**真实同 bar 双笔**（run `sr_1789865219068_000001` 的 `rt_seq=1` 第 42/43 笔，bar_index=423、ts=1789660800）；
  4. 反假绿：实现方未做变异反证；本复验做 3 次（M1/M2/M3）并证明「DOM-only 判据在 M2 上会假绿」。

## 2. 复现命令（全部加 `timeout`，单车道，无子代理）

```bash
cd web
npx tsc -b                                                                       # 0
E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/adr028-features-verify.e2e.ts --workers=1 --retries=0
E2E_BASE_URL=http://localhost:8081 ADR028_E2E_OUT=…/raw/spec_out/window-sync \
  npx playwright test e2e/adr028-window-sync.e2e.ts --workers=1 --retries=0      # 6/6
E2E_BASE_URL=http://localhost:8081 ADR027_ALIGN_OUT=…/raw/spec_out/axis-align-probe \
  npx playwright test e2e/adr028-axis-align-probe.e2e.ts --workers=1 --retries=0 # 2/2（v2）
python3 tester/evidence/20260920_adr028_features_verify/raw/pixel_analyze.py       # 离线像素复算
```
（两个既有规格的产物目录被显式改写到本复验证据目录，**未覆盖** `coder/evidence/20260920_adr027_p9c_final/raw` 与 `tester/evidence/20260920_adr027_axis_verify/raw`。）

## 3. 真身锚定（T0，绿）

| 项 | 值 |
|---|---|
| `index.html` 引用 | `/assets/index-DhgvwmsX.js` |
| 被服务 bundle sha256 | `8d6022e1c71cbf1b362396f0d7fde9a07d62bc9832eff621b2df06d6991e44fb` |
| `web/dist/assets/index-DhgvwmsX.js` sha256 | 同上（**逐字节一致**） |

⇒ 复验对象确为实现方构建产物，非本地新构建（`raw/t0_bundle.json`）。

## 4. 逐项判据与实测证据

### 4.1 醒目化（T1 store + T2 像素）—— 通过

**结构（真图表 store，`getOverlays()`；`raw/t1_marker_store.json`）**

| 判据 | 实测 |
|---|---|
| `fillDot` overlay 数 == `/fills` 笔数 | **44 == 44** |
| overlay 名集合（除标记/高亮） | `{}` ⇒ **无连线/区间覆盖层**混入（禁连线要求满足） |
| 同 bar 两笔 `points[0].timestamp` | 相同（`1789660800000`） |
| `stackIndex` | **0 / 1**（同 bar 第 1、2 笔） |
| 渲染 y 差 | `y(1:43)=50 − y(1:42)=39 = `**11px**（标称堆叠间距 12px − 两笔锚点价不同造成的 1px；圆点直径 6.4px ⇒ **不遮盖**） |
| 标签（fmtNum 口径） | `B 1.188×843.9619` / `S 1.195×37,764.7619`（互不相同；文本 `B`/`S`；颜色 `#ff5c6c`/`#00e0a4`） |

**标签真的被画到 canvas（T2，`raw/t2_label_ink.json`）** —— 目标为**居中 bar**（run `sr_1789832477006_000002` 第 1 笔，bar 262），标签有右侧绘制空间：

| 判据 | 实测 |
|---|---|
| 标签 span = 点右侧 `[x+12, x+12+LW]`（LW=4.4px/字符+6=76） | — |
| 「有红墨列数 / LW」覆盖率 | **0.842**（阈值 ≥0.6；移除 label 的变异构建实测 0.276） |
| span 内红墨像素 | **234**（阈值 ≥120；无标签实测 46；左侧同形对照区仅 23） |
| 标签文本（store） | `B 1.075×932.6936` == 期望 |

**跨构建像素 A/B（`raw/pixel_ab_label_diff.json`）**：同 run / 同笔 / 同视口下，真实构建 vs「移除 label」变异构建（`raw/t2_label_off_m3.png`）逐像素差：

- 目标笔标签带（x350–445, y106–119）差异 **910 px**，差异 bbox = `x350..436 × y106..118`（正好在圆点右侧的水平字条带）；
- 同 x 范围、下方 24px 的**对照带差异 0 px**；全图差异 4252 px（= 所有标记的标签）。
⇒ 差异确实来自「价格×股数」文本，而非蜡烛/MA 噪声。

**口径限制（须明示）**：买卖标记色与蜡烛色**完全相同**（`chartCommon.ts`：`upColor/downColor = #ff5c6c/#00e0a4`），因此**圆点本体无法用颜色与蜡烛区分**。本复验对「圆点+描边」的像素证据用的是**跳转高亮的白描边环**（其圆心 == 该笔圆点位置，见 4.2）与**标签 ink**；圆点形态（`circle` + `stroke_fill` + `borderColor`）由真图表 store 的 `extendData`（`label/stackIndex/fillKey`）与注册模板结构佐证，并有截图人工复核。

### 4.2 L2 跳转 focus（T3）—— 通过

`raw/t3_focus_scroll.json`，`t3_before_jump.png` / `t3_after_jump.png`：

| 判据 | 实测 |
|---|---|
| 跳转前锚点在滚动容器可视区之外 | `anchor.y = −2311`（容器 40..720）⇒ 不在可视区（用例有区分力） |
| 跳转后滚动位置变化 | `scrollTop 2391 → 40` |
| 锚点落在滚动容器可视区内 | `anchor.y = 40` == 容器顶（`result.y = 40`） |
| K 线容器整体落在**视口**内（更严） | `host.y = 40`，`40+256 ≤ 720` ✓ |
| 平滑滚动落定 | 990ms（scrollTop 连续两次采样稳定后才判定） |

### 4.3 精确到笔高亮 + 3 秒回常态（T4，像素级）—— 通过

`raw/t4_highlight_pixels.json`；截图 `t4_kline_hl42_a/b.png`、`t4_kline_hl43.png`、`t4_kline_after3s.png`、`t4_page_hl42.png`、`t4_page_after3s.png`。

**① 高亮存在且只高亮被点那一笔（点第 42 笔，键 `1:42`）**

| 观测 | 值 |
|---|---|
| `kline-chart[data-highlight-key]` | `1:42` |
| `data-highlight-active` | `true` |
| `wb-jump-highlight-note[data-state]` | `ok` |
| **真图表 store `fillDotHighlight` 条数** | **1**（key=`1:42`、stack=0、label=`B 1.188×843.9619`、zLevel=40） |
| **canvas 白描边簇（size≥30）个数** | **1**（size 93；质心 canvas 坐标 `(598.8, 38.3)` vs 目标笔预测 `(604, 39)`：Δy=0.7px ✓；Δx=5.2px 为**末根 bar 被 pane 右边界裁切**造成的质心左偏，判据 ±6px） |
| 白簇 bbox 高度 | 20px（≤24：**单枚圆环**；两枚粘连会显著变高） |
| 离线 PIL 复算（`raw/pixel_analysis.json`） | 同图 1 个簇 size **89**、质心 `(599.9, 87.6)`（截图坐标，clip 原点偏移 (1,49) ⇒ 与页面读数一致；`shape_match=true`） |

**② 脉冲（放大 + 描边）**

| 观测 | 值 |
|---|---|
| DOM 相位 | `pulse 7 → 9`（150ms 步进） |
| 白像素量随相位交替 | 页面侧 150ms 采样序列：`94 ↔ 43` 交替（半径 6.5 ↔ 8.7 + 描边 2.5 ↔ 3.6） |
| 离线两相位 | `t4_kline_hl42_a/b.png` 各 1 簇（size 89） |

**③ 3 秒回常态（无永久选中态）**

| 观测 | 值 |
|---|---|
| 页面侧时间序列（自点击起算） | 最后一条 `active=true` 样本在 **2977ms**；第一条 `active=false` 样本在 **3127ms**（采样步距 150ms）⇒ 回落时刻 ∈ [3.0, 3.1]s |
| 3s 后 DOM | `data-highlight-active=false`、`data-highlight-pulse=0`；`data-highlight-key` 仍为 `1:42`（**键保留、无残影选中态**） |
| 3s 后 store | `fillDotHighlight` **0 条**（高亮 overlay 已清） |
| 3s 后像素 | 白簇 **0 个**（`whiteTotal=5` = 恒定背景噪声 size 4/1；离线复算同样 0 个 big 簇）；回常态样本白像素集合 = {1} |

**④ 同 bar 另一笔（点第 43 笔，键 `1:43`）—— 互斥 + 精确到笔**

| 观测 | 点第 42 笔 | 点第 43 笔 |
|---|---|---|
| store 高亮条数 / key / stack | 1 / `1:42` / 0 | **1** / `1:43` / 1 |
| 白簇个数 | **1**（size 93） | **1**（size 91） |
| 白簇质心（canvas） | `(598.8, 38.3)` | `(598.8, **49.7**)` |
| 期望位置（含堆叠偏移） | `(604, 39)` | `(604, 50)` |
| 离线复算质心（截图） | `(599.9, 87.6)` | `(599.9, **98.6**)` |

⇒ 两次点击质心 y 差 **11.4px ≈ 堆叠间距 12px**：同一根 bar 上的两笔在**像素上可分辨**，且**每次只有被点的那一笔**出现白描边环（另一笔为 0），3s 后归零（`scanAfterB` 0 个 big 簇）。**不存在「按 bar 粗定位」（否则两次点击的白簇位置会相同）**。

### 4.4 曲线竖线（T5）—— 通过

`raw/t5_vlines.json`：

| 判据 | 实测 |
|---|---|
| 跳转前竖线数 | 0 |
| 跳转后 | **4 条**：`aggregate / slots / equity / position` 各 1 |
| 时点唯一且 == 目标笔 ts | `{1789660800}`（唯一），== `/fills` 第 42 笔 `ts` |
| 3s 后（高亮已回常态） | **仍 4 条**（保留） |
| 下一次跳转（第 41 笔）后 | **4 条**，ts 更新为 `1789574400`（唯一） |
| 点「全览」后 | **0 条**；`data-highlight-key=''`、`data-highlight-active=false` |

注：「全览」此处以 **DOM click 事件**驱动（`dispatchEvent('click')`）——因为该按钮的**手势点击被 K 线画布溢出遮挡**（见 §5 阻断项）。`raw/t5_vlines.json.obstruction = {elementAtCenter:'canvas', blocked:true}`。状态机本身（清竖线 + 清高亮）行为正确。

### 4.5 三态提示（T6）—— 通过（loading 分支 UI 不可达，已披露）

| 态 | 构造方式（页面注入，**未改生产代码**） | 实测 |
|---|---|---|
| `unmatched` | `page.route` 改写 run 级 `/fills`：`rt_seq += 1000`（标记仍在、键不匹配） | `data-state=unmatched`，文案「未在 K 线标记中找到目标成交 1:42（L2 序号与 /fills 事实源不一致）⇒ 仅跳窗口，无高亮」；标记 44 个仍在；高亮 overlay 0；白簇 0；**窗口跳转仍执行**（`wb-window-probe[data-ok]=true`） |
| `unrecorded` | 同一端点返回 `recorded=false, fills=[]` | `data-state=unrecorded`，文案「该运行未记录成交明细（recorded=false）⇒ 无标记可高亮（窗口跳转仍已执行）」；`wb-fills-note` 同步显式；`data-ok=true` |
| `loading` | 同一端点延迟 14s 放行 | 未到位期间：`wb-fills-note='成交明细加载中…'`、`data-marker-overlays=0`（**显式、不静默**）；但 **L2 表此时不可达**（`l2ReachableDuring=false`：`bars/fills/round-trips` 由 `Promise.allSettled` **同批提交**）⇒ **跳转高亮的 `loading` 分支在 UI 上不可达**（防御性分支）；放行后 L2 可用、跳转高亮恢复正常（`data-state=ok`、白簇恰 1） |

`raw/t6a_unmatched.json`、`raw/t6b_unrecorded.json`、`raw/t6c_loading.json`、`raw/t6c_loading_phase.png`。

### 4.6 无回归（指定项）—— 绿；但本波新增回归 T7 ⇒ 总判「无回归」记 **红**

| 项 | 结果 | 证据 |
|---|---|---|
| `adr028-window-sync.e2e.ts` | **6/6 绿**（23.4s） | `logs/e2e_adr028-window-sync.log` |
| `adr028-axis-align-probe.e2e.ts` v2 | **2/2 绿**（43.4s） | `logs/e2e_adr028-axis-align-probe.log` |
| `npx tsc -b` | **exit 0** | 执行记录（§2 命令） |
| 两个既有规格文件是否被改 | 未改（`git status` 仅显示我方新增规格为 untracked） | — |
| 实现方单测 `adr028FocusHighlight.test.tsx` **独立复跑** | **6/6 绿**（149ms，`--maxWorkers=1` + `NODE_OPTIONS=--max-old-space-size=2048`） | 单文件执行（不以其结论为判据，仅作交叉核对） |

**但**：自建回归用例 **T7 红**（详见 §5）。

## 5. 阻断项 T7：L2 跳转后 K 线画布溢出卡片，遮挡并拦截控制条按钮（**本波引入的回归**）

`raw/t7_bar_clickability.json`、`raw/t7_after_l2_jump.png`、`raw/pixel_analysis.json`。

### 现象（真身，1280×800）

| 状态 | K 线容器相对卡片的溢出 | 「全览」按钮中心命中元素 | 「历史回退」按钮中心命中元素 | 真实 `click()` |
|---|---|---|---|---|
| L2 跳转**前**（无高亮提示） | **−1px**（不溢出） | `button`（自命中） | `button`（自命中） | 成功 |
| L2 跳转**后**（提示存在） | **+27px** | **`canvas`** | **`canvas`** | **TimeoutError（被拦截）** |

按钮上 3 个采样点（中心 / 15% 高 / 85% 高）的命中结果：跳转后中心与 15% 点均落在 `canvas`，只有 85%（按钮底部约 10px 条带）落到按钮自身。

### 因果 A/B（同一会话内，证明是**新增提示文案**造成的）

- L2 跳转 ⇒ 提示条出现（「已高亮目标成交 1:42（放大 + 描边脉冲，3 秒后回常态）」）⇒ 溢出 **+27px**、按钮中心被 canvas 覆盖；
- 随后 L1 跳转（按实现 `setHighlight(null)`，提示消失）⇒ 溢出 **−1px**、按钮中心重新命中 `button`。
- 几何：卡片 `hostBottom=296`（`h-64` 固定 256px），控制条 `barTop=304`；K 线容器底部伸到 **323px**（= 296 + 27），其 canvas（含 x 轴条带，宽 606px、z-index 2、position absolute）正好压在控制条顶行。
- 机制（读实现）：`KlineResultChart` 卡片为**固定高 `h-64`**，头部 `flex flex-wrap` 图例行的高度随文案换行增长；本波新增的高亮提示是长句（~30 字），与原「成交合计 …/K线 …」等 span 同处一行 ⇒ 该行由 1 行（21px）涨到 2 行（49px），图表容器 `h-[calc(100%-1.25rem)]` 不随头部长高而收缩 ⇒ 容器溢出卡片 27px，画布盖住下方控制条。

### 影响

- 用户在**任意 L2 跳转之后**（提示在 `highlight` 状态被清掉前长期存在，只有「全览」或 L1 跳转才会清）**无法用鼠标正常点击「全览」**——即**无法用既有 UI 手段退出高亮提示态**（只能用按钮底部 ~10px 边缘或键盘 Tab+Enter）；「历史回退」同样受影响。
- 与需求「④三态显式提示」直接相关：提示的**视觉/交互副作用**构成了新的可用性回归。

### 复现

```bash
cd web && E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/adr028-features-verify.e2e.ts -g "回归" --workers=1 --retries=0   # T7 必红
# 手工：打开 /backtest-workbench → 选 sr_1789865219068_000001 → 展开 rt 1 → 点第 43 行「跳转」→ 尝试点击控制条「全览」
```

（修复方向属实现方/架构裁决范围，本车道不改生产代码、不给补丁。）

## 6. 反假绿：三次变异反证（**有牙**）

方法：临时 `npx vite build --outDir dist-mut` + `vite preview --outDir dist-mut --port 4175`（代理 :8081），**全程未触碰 :8081 的 `web/dist`**；三次变异后恢复并重建，产物 sha256 与实现方 bundle **逐字节一致**。

| 变异 | 改动 | 结果 | 关键读数 |
|---|---|---|---|
| **M1** 键粗化（按 bar） | `KlineResultChart.buildMarkers` 与 `ResultView.handleJump` 的 `makeFillKey` 第二参由「回合成交序号」改为 `bar_index` | **红** | `data-highlight-key` = **`1:423`**（≠ `1:42`）；点第 43 笔后白簇质心仍在**第 42 笔位置**（canvas cy **38.3**，真实构建为 **49.7**）⇒「按 bar 粗定位」被像素判据抓出（`raw/mut_m1_t4_highlight_pixels.json`） |
| **M2** 高亮 overlay 名未注册（复现实现方曾发生的静默丢弃） | `ensureFillDotOverlayRegistered` 只 `register('fillDot')`，Effect G 仍建 `fillDotHighlight` | **红** | DOM 仍 `data-highlight-active=true`、`pulse` 正常跳动、提示 `data-state=ok`（**DOM-only 判据会假绿**）；而 store `fillDotHighlight` **0 条**、canvas 白簇 **0 个**（`whiteTotal=5` 仅噪声）⇒ 什么都没画（`raw/mut_m2/t4_highlight_pixels.json`） |
| **M3** 移除价格×股数标签 | `buildMarkers` 不再给 `label` | **红** | 纯像素判据先红：标签 span 覆盖率 **0.276**（<0.6；真实构建 0.842）、红墨 **46**（<120；真实 234）（`raw/mut_m3/t2_label_ink.json`） |

**恢复核验**：三处源码复原后（`git diff` 工作区 0 行差异）`npx vite build --outDir dist-mut` ⇒ `dist-mut/assets/index-DhgvwmsX.js` sha256 = **`8d6022e1…44fb`** == `web/dist/assets/index-DhgvwmsX.js`（实现方 bundle）⇒ 变异已完全回退，且构建确定性成立。

## 7. 限制 / 残留风险（不构成阻断，但须登记）

1. **末根 bar 的标签被裁切**：run `sr_1789865219068_000001` 的第 42/43 笔所在 bar 423 是该 run **最后一根**，圆点落在 candle pane 右边界（canvas 宽 606）⇒ 右侧「价格×股数」文本被 pane 裁掉（实测该笔标签 span 红墨仅 55px，居中 bar 为 234px）。即**同一根末根 bar 上的成交看不到可读标签**（圆点与高亮仍正常）。属本波需求的边缘缺口。
2. **高亮环在末根 bar 被裁切** ⇒ 白簇质心 x 左偏 ~4px（判据用 ±6px 并已在离线 PNG 复核 bbox `x595..606` = pane 右边界）。
3. **圆点本体与蜡烛同色**（见 §4.1 口径限制）：圆点/描边的「形状」证据依赖真图表 store + 注册模板结构 + 人工截图复核，非纯颜色像素判据。
4. **`loading` 分支 UI 不可达**（§4.5）：若后续把 `bars/fills/round-trips` 改为分片提交，该分支文案「标记就绪后自动补高亮」需复核——按现实现，高亮窗口（3s）从**点击时刻**起算，数据晚到不会补画高亮，而提示会显示「已高亮…」，存在**文案与事实不符**的风险（当前不可达，故不判红）。
5. **同 bar 多笔样本有限**：现网 10 个 run 中仅 1 个 run 存在同 bar 双笔（且都在末根 bar）；「同 bar 多笔可分辨」的样本覆盖较窄（单 run 双笔 + 变异反证交叉验证）。
6. **未运行实现方规格** `adr028-fill-focus-highlight.e2e.ts`（其结论不能作为我方证据；资源纪律限定只跑相关规格）⇒ 若需与实现方规格互证，请另行授权。
7. 白簇判据依赖「高亮描边为 `#ffffff`」这一实现细节；若后续改成非白描边，本判据需同步改口径（当前与实现一致）。
8. 本复验的「三态」中 `loading` 的**注入**为数据面构造（`page.route` 延迟/改写），已显式披露；`unrecorded` 亦为注入（现网 10 个 run 全部 `recorded=true`，无真实 `recorded=false` 样本可用）。

## 8. 产物清单

| 路径 | 内容 |
|---|---|
| `report.md` | 本报告 |
| `raw/t0_bundle.json` | 真身 bundle sha256 锚定 |
| `raw/t1_marker_store.json` | 44 个 fillDot / 同 bar 双笔 stack+标签+颜色+几何 |
| `raw/t2_label_ink.json`、`raw/t2_label_on.png`、`raw/t2_label_off_m3.png`、`raw/pixel_ab_label_diff.json` | 标签 ink（页面侧 + 变异 A/B 差分） |
| `raw/t3_focus_scroll.json`、`raw/t3_before_jump.png`、`raw/t3_after_jump.png` | focus 滚动 |
| `raw/t4_highlight_pixels.json`、`t4_kline_hl42_a/b.png`、`t4_kline_hl43.png`、`t4_kline_after3s.png`、`t4_page_hl42.png`、`t4_page_after3s.png` | 精确到笔高亮 / 脉冲 / 3s 回落（DOM + store + canvas 像素 + 时间序列 + 截图） |
| `raw/t5_vlines.json` | 曲线竖线（含遮挡事实） |
| `raw/t6a_unmatched.json`、`t6b_unrecorded.json`、`t6c_loading.json`、`t6c_loading_phase.png` | 三态提示 |
| `raw/t7_bar_clickability.json`、`t7_after_l2_jump.png` | **阻断项**证据（含 A/B） |
| `raw/mut_m1_t4_highlight_pixels.json`、`raw/mut_m2/t4_highlight_pixels.json`、`raw/mut_m3/t2_label_ink.json` | 三次变异读数 |
| `raw/pixel_analysis.py`、`raw/pixel_analysis.json` | 离线像素复算（白簇 + ink）与页面读数交叉核对 |
| `logs/e2e_adr028-features-verify.log`、`logs/e2e_adr028-window-sync.log`、`logs/e2e_adr028-axis-align-probe.log` | 三次执行的完整输出 |
| `raw/spec_out/window-sync/`、`raw/spec_out/axis-align-probe/` | 两个既有规格的产物（改写目录，未覆盖原件） |

## 9. 资源纪律记录

- 单车道，**未 spawn 子代理**；playwright `--workers=1`，只跑：自建复验规格、`adr028-window-sync.e2e.ts`、`adr028-axis-align-probe.e2e.ts`（v2）。
- 未起常驻 `vite preview`（仅变异阶段临时 :4175，用后即杀）；结束核验：`pgrep -f '[v]ite preview'` = 空、`chromium` 进程 = 0。
- 每步记录 `free -h`（各步 19Gi used / 27Gi available，Swap 5.2Gi/8Gi，无压力）；所有命令加 `timeout`；`web/dist-mut` 临时产物已删除。
- **未修改任何生产代码/接口/架构**：三个被变异文件均已逐字节复原（`git diff` 工作区 0 行差异）；未 `git add`/`commit` 任何东西。
