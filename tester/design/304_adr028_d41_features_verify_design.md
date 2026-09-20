# ADR-028 D4.1 独立复验设计（tester 车道，闸门 3）

本报告自身路径：`tester/design/304_adr028_d41_features_verify_design.md`
（执行报告：`tester/evidence/20260920_adr028_features_verify/report.md`）

## 0. 背景与范围

- 需求事实源：ADR-028 §2.4b（D4.1）：①主图价格位置实心圆点+描边（买红/卖绿/止损橙）+「价格×股数」标签、同 bar 多笔可分辨、不加连线；②L2 跳转后 scrollIntoView + 只高亮被点击那一笔（按 `rt_seq`+成交序号精确定位）+ 放大描边脉冲 3 秒后回常态、无永久选中态；③各曲线视图同一时点画竖线，保留到下一次跳转或全览；④三态显式提示（loading/unrecorded/unmatched）。
- 被复验实现：`coder/evidence/20260920_adr028_features/`（bundle `assets/index-DhgvwmsX.js`，由 :8081 静态提供）。
- 本车道**不改任何生产代码**；只新增 `web/e2e/adr028-features-verify.e2e.ts`（自有规格）+ 证据目录。
- 独立性：**不复用实现方的截图与结论**；所有断言在自建规格内重跑，像素证据在自建截图上重算。

## 1. 真身与观测口径

| 项 | 取值/口径 |
|---|---|
| 真身 | `http://localhost:8081`（`eestock-app` 静态托管 `web/dist`，`dist/index.html` 引用 `assets/index-DhgvwmsX.js`，sha256 `8d6022e1…44fb`） |
| 目标 run A（同 bar 多笔） | `sr_1789865219068_000001`（159776/D1，rt_seq=1，44 笔；**第 42/43 笔同 bar**：bar_index=423、ts=1789660800，买 `1.188×843.9619` / 卖(ForceClose) `1.195×37,764.7619`） |
| 目标 run B（居中 bar，标签有右侧空间） | `sr_1789832477006_000002`（159776/D1，rt_seq=1，16 笔） |
| 观测 A：DOM | `kline-chart[data-highlight-key/-active/-pulse/-marker-overlays]`、`wb-jump-highlight-note[data-state]`、`wb-vline[data-view/data-vline-ts]`、`wb-window-probe[data-ok]` |
| 观测 B：真图表 store | 页面侧 `Map.prototype.set` 只读捕获 klinecharts 实例 → `getOverlays({name})`（`fillDot` / `fillDotHighlight` 的 `points`/`extendData`/`zLevel`） |
| 观测 C：渲染像素 | ①页面侧读 canvas `getImageData`（多 canvas 合成，白簇连通分量 + 标签 ink run）；②`page.screenshot({clip})` 落盘 PNG，离线 PIL 复算（独立口径交叉验证） |
| 观测 D：几何 | `convertToPixel({timestamp,value},{paneId:'candle_pane'})`（kline 容器相对坐标；**堆叠偏移 `stackIndex×12px` 不在锚点里，须自行加上**） |

## 2. 判据与用例

### T1 醒目化结构（真渲染 store）—— run A
- `fillDot` overlay 数 == `/fills` 笔数；除 `fillDot`/`fillDotHighlight` 外**无其它 overlay**（⇒ 无连线/区间覆盖层混入）。
- 同 bar 两笔（`1:42`/`1:43`）：`points[0].timestamp` 相同、`stackIndex` = 0/1、`label` 互不相同且 == `fmtNum` 口径（`B 1.188×843.9619` / `S 1.195×37,764.7619`）、颜色 `#ff5c6c`/`#00e0a4`。
- 可分辨性（几何）：两点的渲染 y 差 == `stackIndex` 差 × 12px（> 圆点直径 6.4px，禁遮盖）。
- 变异敏感：fillKey 粗化（M1）后 `data-highlight-key` 仍为 `1:42`，但同 bar 两笔同时中键 ⇒ T4 红。

### T2 标签渲染像素（ink run）—— run B（居中 bar）
- 标签区（点右侧 8~98px、点 y±5 行）：统计「红墨」列（列内存在 `r>80 && r−g>40 && r−b>25` 像素）的**最长连续列数** `maxRun`。
  - 依据：9px 文本是**水平连续**的字形条带（实测 24 列）；蜡烛体宽仅 ~4 列且被 bar 间隔打断；MA 线在 ±5 行带内不连续。
- 判据：`maxRun ≥ 15`（阈值取自实测真实构建 24，变异构建（移除 label）实测值见执行报告；含取舍披露）。
- 变异敏感：移除 `label`（M3）⇒ `maxRun` 塌缩 ⇒ 红。

### T3 focus 滚动 —— run A
- 跳转前 `wb-result.scrollTop` 基线、锚点不可见；
- 跳转后：锚点落在滚动容器可视区内**且** K 线容器整体落在视口内（`rect.y ≥ 0 && rect.y+h ≤ viewport.h`）——比实现方规格（只看滚动容器）更严；
- `scrollTop` 必须变化。

### T4 只高亮被点击那一笔 + 3 秒回常态（像素簇唯一性）—— run A 同 bar 两笔
- 点第 42 笔：store 中 `fillDotHighlight` **恰 1** 条且 `fillKey='1:42'`、`stackIndex=0`；
- 像素：K 线区**白簇（≥240 三通道，连通分量，size ≥ 30）恰 1 个**，质心 ≈ 该笔位置（±3px）；簇 bbox 高 ≤ 24px；
- 采样相位（≥2 次）：`data-highlight-pulse` 递增、白像素总量随相位变化（脉冲）；
- **3 秒后**：`data-highlight-active=false`、`pulse=0`、store 中 `fillDotHighlight` 0 条、白簇 0 个；`data-highlight-key` 仍指向该笔（无永久选中态但无静默丢失）；页面侧 150ms 采样时间序列（0~4.2s）作为回落证据；
- 再点第 43 笔：白簇**仍恰 1 个**，质心 y ≈ 第 42 笔位置 **+12px**（⇒ 精确到笔、且与同 bar 另一笔互斥，不是「按 bar 粗定位」）；
- 变异敏感：M1（fillKey 按 bar 粗化）⇒ 两个叠点同时中键 ⇒ 白簇 ≥2 或质心偏离 >3px ⇒ 红；M2（高亮 overlay 名未注册，静默丢弃）⇒ 白簇 0 ⇒ 红（**DOM 属性仍为 true，DOM-only 判据会假绿**）。

### T5 曲线竖线 —— run A
- 跳转后 `wb-vline` ≥ 4 条（四视图 aggregate/slots/equity/position），`data-vline-ts` **唯一**且 == 目标笔 `ts`；
- 3 秒后仍在（保留）；
- 下一次跳转（第 41 笔，ts 不同）⇒ ts 更新为新值、仍唯一；
- 点「全览」`wb-window-reset` ⇒ 竖线 0 条、`data-highlight-key=''`、`data-highlight-active=false`。

### T6 三态显式提示（注入构造，非改生产代码）
- `unmatched`：拦截 run 级 `/api/workbench/runs/*/fills`，把 `rt_seq` 整体 +1000（标记仍在、键不匹配）⇒ 点 L2 跳转后 `wb-jump-highlight-note[data-state=unmatched]` 文案非空、白簇 0、`wb-window-probe[data-ok=true]`（窗口仍跳）。
- `unrecorded`：拦截同一端点返回 `recorded=false, fills=[]`（L2 行来自 `/round-trips/{rt}/fills`，不受影响）⇒ `data-state=unrecorded`。
- `loading`：同一端点延迟 9s 放行 ⇒ 跳转瞬间 `data-state=loading`；放行后状态迁移（记录迁移后 `data-state` 与是否真的出现高亮，用于判「文案是否与事实一致」）。

### 回归与反假绿（见执行报告）
- 回归：`adr028-window-sync.e2e.ts`（6 用例）、`adr028-axis-align-probe.e2e.ts` v2（2 用例）、`npx tsc -b`。
- 反假绿：M1/M2/M3 三次变异（独立临时 outDir `dist-mut` + preview 4175，**不触碰 8081 的 dist**），每次必须红；恢复后重建 bundle 与实现方 bundle 逐字节（sha256）比对。

## 3. Mock/Stub 策略
- 不做任何业务 mock；仅 T6 用 `page.route` 注入**数据面**（后端契约允许的 recorded 语义与序号错配），并显式披露。
- 图表实例捕获为**只读**（仅存引用 + 调只读 getter/`getImageData`）。

## 4. 覆盖目标
| 层 | 覆盖 |
|---|---|
| DOM/状态机 | T1/T3/T4/T5/T6 |
| 真图表 store | T1/T4 |
| 渲染像素 | T2/T4（自建截图 + 离线 PIL 双口径） |
| 回归 | window-sync + 探针 v2 + tsc |
| 反假绿 | M1/M2/M3 |

---

# 复验二轮（2026-09-20，解除冻结）——R1/R2/R3 与 T0/T7 维护（追加章节）

- 追加时间：2026-09-20（Asia/Shanghai）；触发：闸门 3 冻结（阻断项 T7）修复完成，进入复验。
- 交付：新增规格 `web/e2e/adr028-features-verify2.e2e.ts`（用例 V1/V2/V3）+ 维护既有规格
  `web/e2e/adr028-features-verify.e2e.ts`（T0 锚点更新、T7 加固）。**不改生产代码**。
- 报告：`tester/evidence/20260920_adr028_features_verify2/report.md`；
  执行：`tester/test/305_adr028_d41_features_verify2_execution.md`。

## A. 真身与仪表（相对 §1 的变化）

| 项 | 变化 |
|---|---|
| 真身身份 | bundle `assets/index-BY728MHs.js`，sha256 `f2504232…`（§T0 锚点常量随之更新） |
| 送达方式 | **主机进程** `./target/debug/eestock-app --config /tmp/app_dev_8081.toml`（`static_dir=./web/dist`）**按请求读盘**；**非**容器层 `docker cp`（`eestock-app` 容器 9 天前已 Exited） |
| 观测 E（新增仪表） | init script 记录渲染器自身的 `ctx.font` / `ctx.textAlign` / `fillText(text,x,y)`（按文本去重）⇒ 「期望文本宽度」= 页面内 `ctx.measureText(标签, 渲染器真实 font)`；klinecharts 会把 figure `align` **归一化**（`ctx.textAlign` 恒 `'left'`，右对齐=锚点前移一个文本宽度）⇒ 左右侧判据一律用**有效锚点** |
| 观测 C′（改口径） | 像素读法改为「同容器内各 canvas **按 DOM 偏移/缩放合成** → 屏幕真实可见位图」，与修复方的「逐图层 getImageData」不同；离线 PIL 复算继续保留（交叉核对） |

## B. 新增用例设计

### V1（R1）末根 bar 标签完整性 —— `[@mut]`
- 前置：run `sr_1789865219068_000001` 末根 bar（`bar_index=423`）的两笔（`1:42` Buy / `1:43` Sell）；L2 跳转把该 bar 推到 pane 右缘；等高亮脉冲散去（3.7s）后测像素。
- 观测：渲染器自报锚点 `fillText.x` + `measureText` 宽 ⇒ 文本盒；紧盒内**同色系墨量**统计（总墨量 / 跨度 / 墨列覆盖率）。
- 判据：① 文本盒完整落在 pane 内（左缘 ≥1、右缘 ≤ `pane.cw-1`）；② 末根 bar 文本右缘 < 圆点 x 且间距 ≤10px（翻转）；③ ink 跨度/期望宽 ∈ [0.85,1.3]、覆盖率 ≥0.5、墨量 ≥60；④ ink 右缘不得侵入圆点区；⑤ **对照**（run B 中部 bar）保持右侧绘制且同指标达标（阈值可达、非恒绿）。
- 区分力：修复前行为（恒右侧）下文本右缘 > pane 右缘且紧盒墨量 = 0 ⇒ 必红（M-R1 已证）。

### V2（R2）不可达分支与承诺文案的处置
- 源码侧（去注释后）：联合类型不含 `'loading'`；字符串字面量不含「自动补齐 / 标记就绪后 / 标记不可得」；`fills.loading && rows===0` 守卫不存在；三态 `ok/unrecorded/unmatched` 保留。
- 产物侧：被服务 bundle 三段承诺文案 0 命中，且三条**对照串必须命中**（证明检索路径有效）。
- 运行期：`ok` 态提示文案不含承诺；注入 12s 延迟期间 `wb-fills-note` 显式「加载中」、标记 0、**L2 行 count=0**、`wb-jump-highlight-note` count=0 ⇒ 分支在 UI 上不可达（删分支的依据）。
- 口径说明：源码中「原句」以**注释**形式作为删除理由存在（`commentOnlyMentions=2`），故判据以「去注释后的代码/字符串字面量」为准并显式记录。

### V3（R3）圆点颜色身份
- 观测：合成位图逐圆点读**圆心 + 3×3**；期望色**由 `/fills` 事实源推导**（`reason='StopTrigger'`⇒`#fb923c`；否则 Buy⇒`#ff5c6c` / Sell⇒`#00e0a4`），与 store 自报色、像素三方交叉。
- 四档判定（每条必须落档）：`exact`（圆心 Δ≤10）｜`near`（圆心 Δ≤25）｜`store-exact/dominant`（3×3 主导色与 store 色 Δ≤10/≤25）｜`blend`（`px ≈ α·C + (1-α)·期望色`，C ∈ {标签底色, 面板底色, 白}，残差 ≤12）。
- 聚合：`exact` 条数 ≥ 0.75·样本；`store 色 == /fills 侧别色` 逐条一致；买/卖样本各 ≥5/≥1（防空绿/单侧假绿）；**止损橙**有样本则逐条达标，无样本则记录「不可测」并给出补测口径（判据已内置，自动开测）。
- 交叉：离线 PIL 读同一 PNG 复算（读图路径独立），要求与页面侧读数一致。

## C. 既有规格维护（不改判据强度）

| 用例 | 维护内容 | 强度变化 |
|---|---|---|
| T0 真身锚定 | 旧硬编码 sha256（`8d6022e1…`）→ 新常量 `EXPECT_BUNDLE_NAME/EXPECT_BUNDLE_SHA256`（`f2504232…`）；追加「被服务 URL 含该名」「`web/dist/index.html` 引用同一 URL」「被服务字节 == `web/dist` 同名文件 sha256」三段断言 | **不变/加强**（仍是逐字节真身锚定；注释写明「不得放宽为任意 bundle、不得加 env 旁路」，合法产物变更须由规格维护者显式更新常量） |
| T7 控制条可点击性 | ① 采样点：`全览` 中心 1 点 → **两按钮 × 3 点（中心/15%/85%）** 且判 `selfOrChild`；② 新增**真实 `click({timeout:3000})`** 两个按钮；③ 新增触发条件守卫（点击前提示必须在位）；④ 新增「点全览后提示被清除」= 点击确实生效；⑤ 布局不变量（溢出 ≤1px、卡片底 ≤ 控制条顶+1、图表区 >100px）；⑥ 打 `[@mut]` 标记 | **加强** |

## D. 覆盖目标（二轮）

| 层 | 覆盖 |
|---|---|
| DOM/交互 | T7（3 采样点×2 按钮 + 真实点击）、V2（提示态/加载期） |
| 真图表 store | T1/V3（`getOverlays`） |
| 渲染像素（合成位图 + 离线 PNG 双口径） | V1（ink 完整性）、V3（逐圆点颜色） |
| 源码/产物双侧 | V2（去注释源码字面量 + 被服务 bundle 文本搜索 + 对照串） |
| 回归 | window-sync 6 / axis-align-probe v2 2 / `tsc -b` / 单测子集 99 |
| 反假绿 | M-LAYOUT（T7 必红）、M-R1（V1 必红），恢复后重建与线上 bundle 逐字节一致 |
