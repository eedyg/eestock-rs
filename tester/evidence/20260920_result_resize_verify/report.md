# ADR-028 §2.4c（D4.2）结果页视图缩放 + K 线副图指标可选 —— **tester 独立终验报告**

> **本报告自身路径**：`tester/evidence/20260920_result_resize_verify/report.md`
> 原始输出与像素证据：`tester/evidence/20260920_result_resize_verify/raw/`
> 复核对象：`coder/evidence/20260920_result_resize/report.md`（实现方报告，**其读数一律不引用**；本报告所有数字均为本轮独立复跑所得）
> 真身：`http://localhost:8081`（主机进程 `eestock-app`，`static_dir=./web/dist`）；commit `cf3e6e714e5615227d56dbb4d64253c4dc982bde`；时间 2026-09-20 12:19–12:31 CST

---

## 0. 判词（一行，前置）

**指标选择 通过 ｜ 隔离性 通过 ｜ K 线卡拖高与复位 通过 ｜ 副图高度保持 通过 ｜ 曲线卡拖高 通过 ｜ 只做高度 确认 ｜ 表格无把手 通过 ｜ PAD 单源与偏差 0.0 px（≤0.1px 目标）｜ 持久化 通过 ｜ 四规格 全绿（1 次 T4 闪红，2 次复跑全绿）｜ 常量修改 追认 ｜ 变异反证 有牙 ｜ 总判词 = 放行**

> 放行附带 1 条硬风险提示（非本波功能缺陷）：冻结规格 `adr028-features-verify` 的 **T4 存在非确定性**
> （3 次全量运行中 1 次在「跳转后目标笔几何必须可测」前置步骤红、2 次全绿；单独复跑亦绿）⇒ 见 §9-R1。

---

## 1. 复核方式与独立性

| 项 | 事实 |
|---|---|
| 自建终验规格 | `web/e2e/adr028-d5-result-resize-tester-verify.e2e.ts`（**新建**，6 test；**不复用**实现方规格的任何断言/读数） |
| 测量口径 | ① `getBoundingClientRect` 真像素；② klinecharts 真身只读 API `getIndicators() / getPaneOptions() / getSize(paneId)`；③ SVG `viewBox` + `polyline points` + `getScreenCTM()` 反算渲染位置 |
| 隔离性口径 | ① `localStorage` 键**增量**（注入**看板哨兵键**作对照，断言逐字节不变）；② 网络写入监控（非 GET `/api/config/*` 请求数）；③ **跨页对照**（结果页改完切到看板读其真身勾选态） |
| 反假绿 | 两个变异构建（`dist-mut`，**不触碰 `web/dist`**）+ 还原后**逐字节**比对线上 bundle |
| 终验结果 | 自建规格 **6/6 passed**（`raw/tester_verify_run_final.txt`，49.2s）；冻结四规格见 §6 |

页面侧探针**只读**（仅包 `Map.prototype.set` 捕获 klinecharts 实例以调其只读 getter）；未改任何生产代码
（收尾 `git status` 与波前快照逐行一致，见 `raw/resource_discipline.md`）。

---

## 2. 逐条判据与实测读数

### 2.1 指标选择（判据 1）—— **通过**

| 观测 | 读数 | 证据 |
|---|---|---|
| 结果页入口 | `wb-indicator-toggles` 存在，**6 枚**（ma/vol/macd/kdj/boll/dcap），全部在结果页 K 线卡内 | `rv1_indicators_isolation.json` |
| 默认态 | `ma=true, vol=true, macd/kdj/boll/dcap=false`（= `DASHBOARD_DEFAULTS.indicators`） | 同上 |
| **真身**（klinecharts `getIndicators()`） | 默认 `['MA','VOL']` →（关 VOL）`['MA']` →（开 MACD）`['MA','MACD']` →（开 KDJ）`['KDJ','MA','MACD']` | 同上 |
| 副图 pane 集合（按 paneId 去重，排除 `candle_pane`/`x_axis_pane`） | 1（VOL）→ 0 → 1（MACD）→ 2（MACD、KDJ） | 同上 |
| 切换控件态 | `aria-pressed` 与真身**同步翻转**（vol true→false；macd/kdj false→true） | 同上 |

### 2.2 隔离性（判据 1）—— **通过**（三口径独立）

| 口径 | 读数 | 证据 |
|---|---|---|
| ① localStorage 增量 | 操作前 = 仅 2 个注入哨兵键（**惰性写入，进入页面不写**）；操作后增量 **恰 1 个键** = `eestock.wb.result.chartConfig.v1` | `rv1_*.json` |
| ① 看板哨兵键（对照） | `eestock.dashboard.layout.v1` / `eestock.dashboard.indicators.v1` 操作后**逐字节不变**；且结果页默认勾选态**未被**哨兵键里的 `macd/kdj=true` 污染 | 同上 |
| ② 网络写入 | 整个「开/关指标」相位：**非 GET 请求 0 条**；对 `/api/config/*` 的请求（含 GET）**0 条**（看板配置的权威通道是服务端 `PUT /api/config/{ma,kline,dcap,multi_period}`） | 同上 |
| ③ 跨页对照 | 结果页置 macd=开/vol=关 ⇒ 切到看板页：其 6 枚入口仍为默认 `vol=开 / macd=关`，且**未新增任何存储键** | `rv6_dashboard_isolation.json` |

### 2.3 K 线卡拖高 + 双击复位（判据 2）—— **通过**

| 步骤 | 读数（px） | 证据 |
|---|---|---|
| 拖卡片下边缘 **+150** | 卡片 **256 → 406**（+150）；内层 klinecharts 容器 **194 → 344**（+150，全量传导）；inline `height:406px` + `flex-shrink:0` | `rv2_kline_resize_pane.json` |
| 双击标题 `wb-card-title-kline` | 卡片 **→ 256**（inline 高度清空）；内层 **→ 194**（回归默认渲染） | 同上 |
| 把手几何 | 每卡恰 1 个把手：`data-card-resize`、高 **6px**、宽 **666**（卡宽 668 ⇒ `inset-x-0` 内贴）、`cursor: ns-resize`、贴卡片下边缘（bottomGap 1px） | `rv3_curve_resize.json` |

### 2.4 副图 pane 高度在指标切换后保持（判据 2）—— **通过**

| 步骤 | VOL pane 真身高度（`getSize(paneId).height`） |
|---|---|
| 默认 | 100 |
| 真鼠标拖分隔条（+40px，命中点 934,209，`count=1`） | **63**（Δ=37 ⇒ 确认“已拖过”、非默认值） |
| 再拖 K 线卡 **+150**（内层 194→344）后（切换前基线） | **63**（副图高度不被卡片缩放吞掉） |
| **开 MACD 后** | **63**（Δ=0 ⇒ **未被重置**）；MACD 新建独立 pane（paneId 与 VOL 不同，高 100px），副图 pane 数 1→2 |
| **关 MACD + 关 VOL 后** | 副图 pane 集合 = **[空]**；pane 集合 = `[candle_pane, x_axis_pane]`；DOM 分隔条 **0** 条；真身 `['MA']` ⇒ **无残留空 pane** |

### 2.5 曲线卡拖高 + 双击复位（判据 3）—— **通过**（两张独立曲线卡）

| 卡 | 卡片高度 | svg 高度 | svg class | 双击复位 | 证据 |
|---|---|---|---|---|---|
| 聚合分 `wb-aggregate-chart` | 204 → **264**（+60） | 160 → **220**（+60） | `h-40 w-full` → **`h-full w-full`** | 卡 204 / svg 160；class 回 `h-40 w-full`；inline 高度清空 | `rv3_curve_resize.json` |
| 净值+回撤 `wb-equity-chart` | 236 → **296**（+60） | 208 → **268**（+60） | `h-52 w-full` → **`h-full w-full`** | 卡 236 / svg 208；class 回 `h-52 w-full`；inline 高度清空 | 同上 |

⇒ 实现方「svg 由固定 `h-40/h-36/h-52` 改为随容器」的说法**真渲染成立**，且**仅受控态**切换（默认态类名未变）。

### 2.6 只做高度（判据 4）—— **确认**

| 口径 | 读数 | 证据 |
|---|---|---|
| 静态 | 纵向拖 +60 后：卡片宽 **668→668**、svg 宽 **666→666**、`viewBox` **逐字符不变**（`141.45 0 1070.82 H`）、`polyline` 全部顶点 userX **逐点 JSON 相等**、无 inline 宽度 | `rv3_curve_resize.json` |
| **行为反证** | 在把手**横向拖 +80px**（dy=0）：卡片宽 668→668、svg 宽 666→666、高度 204→204、顶点 userX 逐点不变、无 inline 宽度 ⇒ **不存在宽度缩放通路** | 同上 |
| 把手扫描 | 结果页内**无** `ew/col/w/e-resize` 光标元素（klinecharts **内建** 3 处 y 轴/画布控件另计，均位于 `kline-chart` 引擎内，非本波引入） | 同上 |
| 把手形状 | 4 张曲线卡 + K 线卡把手一律「下边缘 6px 细条 + ns-resize」 | §2.3 |

### 2.7 表格类（判据 5）—— **通过**

| 表格 | 高度把手 | inline 高度 | 祖先 3 层内 inline 高度 / `data-resizable` | 内部 ns-resize | 滚动 |
|---|---|---|---|---|---|
| 交易明细 `wb-round-trips-table` | **0** | null | null / null | 0 | clientHeight == scrollHeight（整页滚动，无内部滚动条） |
| 逐bar评分 `wb-perbar-table` | **0** | null | null / null | 0 | 同上 |
| 事件日志 `wb-event-log` | **0** | null | null / null | 0 | 同上 |

（三个 tab 逐个真挂载后探测；证据 `rv4_tables_pad.json`）

### 2.8 PAD 单一事实源与跨视图偏差（判据 6）—— **单源成立；偏差 0.0 px**

1. **单一事实源（静态）**：四张曲线 `AggregateScoreChart / SlotScoresChart / EquityDrawdownChart / PositionRatioChart`
   均**只剩** `import { CURVE_PAD as PAD, CURVE_W as W } from './curveGeometry'`，各自 `const PAD/const W` **已消失**；
   全 `src` 扫描此四文件外的 `const PAD` 仅存在于**别的**页面（`quality/OverlayChart`、`strategies/ScoreChart`、
   `dashboard/TimeshareChart`、`workbench/ComparePanel`）——均非本波四张结果页曲线卡。
2. **守护单测钉住 == 8**：`src/features/workbench/curveGeometry.test.tsx`（9 tests，单跑绿）——
   G0 断言 `CURVE_PAD === 8 && CURVE_W === 1000`；G1 用**源码扫描**断言四文件不得再有自有 `const PAD/W`
   且必须从 `./curveGeometry` 导入；G2 运行期断言三图 polyline 首末 = `CURVE_PAD / CURVE_W−CURVE_PAD`。
3. **运行期（真渲染，独立口径）**：四张曲线 `polyline` 首顶点 userX = **8.000**、末顶点 = **992.000**（精确），
   顶点数一律 **n=103**（同一窗口 ⇒ 逐顶点可比），顶点序=bar 序的独立校验残差 max **0.047 user unit**
   （坐标 `toFixed(1)` 的解析残差上界 0.06 ⇒ 通过）。
4. **跨视图同一 bar 偏差**：6 个视图两两配对、**103 根 bar 逐根**比对 ⇒ **max|ΔuserX| = 0.000 user unit**
   = **0.0 px**（每视图标度 1 user unit ≈ 0.62px；卡宽 666 / viewBox 1070.82）⇒ 达「≤0.1px」目标，远优于对外判据 ≤2px。
5. **口径交叉验证（不同方法学）**：我本轮跑的冻结探针 `adr028-resize-probe` 输出
   （`tester/evidence/20260920_result_resize_probe/raw/p4_alignment_summary.json`，**本机本次**产物）
   在 `base / klineTall / klineShort / volShrunk / zoom*` 各态给出：配对 103 点、
   `maxAbsRaw = 0.03px`、`maxAbs984 = 0.05px`、四视图 plot 边界 `8 / 992`、`crossViewMaxUserX = 0`
   —— 与 §2.8-4 结论一致（两套独立方法学互证）。

### 2.9 持久化（判据 7）—— **通过（并如实标注通道限制）**

| 观测 | 读数 | 证据 |
|---|---|---|
| 拖高 +150 后再 +MACD | 卡 256 → **376**；key 内容 `{"indicators":{…"macd":true…},"cardHeights":{"kline":376,…}}` | `rv5_persistence.json` |
| **刷新后** | 卡片高度 **376（保持）**；勾选态 `macd=true / vol=true（默认）`；**真身含 MACD**；存储键仍只有「结果页 1 个 + 哨兵 2 个」 | 同上 |

**「仅本机浏览器有效」的限制——核实属实**（本车道**不据此判冻结**）：

- 服务端确实**只有专用键端点**：`crates/web/src/lib.rs:67-77` 注册 `/api/config/{sources,collector,mcp,ma,kline,dcap,multi_period}`
  （GET/PUT|PATCH）；实测 `/api/config`、`/api/config/kv`、`/api/config/ui`、`/api/config/workbench`、
  `/api/config/result_chart` **全部 404** ⇒ **无通用 KV 通道**。本波「禁改 Rust」⇒ 只能落地在客户端。
- 实测佐证：整段交互对服务端**零写请求**、`localStorage` 是唯一增量 ⇒ 换浏览器/设备/清缓存即回默认。
- **评价与建议（不构成冻结理由）**：该限制对「同一浏览器内多视图一致性」可用，但**不满足**「跨设备/跨会话
  跟随用户」的隐含期望，且与看板配置（服务端 `app_config`）形成**不一致的持久化语义**（看板跨设备、结果页不跨）。
  建议后续独立波次在**冻结车道之外**新增一个通用 UI 配置端点（如 `GET/PUT /api/config/ui`，`app_config` 单键
  `ui_workbench`，带 schema 校验与净化，复用本波已实现的 `parseResultChartConfig` 净化逻辑），届时把
  `resultChartConfig.ts` 的存储后端从 `localStorage` 换为「服务端优先 + 本地兜底」，**键与形状不必变**。

---

## 3. 冻结规格常量修改 —— **追认**

| 检查 | 结论 | 证据 |
|---|---|---|
| 是否**仅** 2 行改动 | **是**：`git diff --cached --numstat -- web/e2e/adr028-features-verify.e2e.ts` = **`2 2`**；`git diff --numstat`（工作树 vs 暂存区）**为空** ⇒ 该文件**再无**其它未提交改动（实现方把改动**暂存**了，故裸 `git diff` 看不到；等价结论成立） | `git diff --cached -U3` 全文 |
| 改动内容 | 仅 `EXPECT_BUNDLE_NAME 'index-BY728MHs.js' → 'index-xGaRgVd-.js'`、`EXPECT_BUNDLE_SHA256 'f2504232…' → '8d936e11…93a8bc'`，字面量直写（**非** env 读取） | 同上 |
| 断言形式是否被放宽 | **未放宽**：`expect(url).toContain(EXPECT_BUNDLE_NAME)`（名）+ `expect(localRef).toBe(url)` + `expect(served).toBe(sha256(磁盘文件))`（**逐字节**）+ `expect(served).toBe(EXPECT_BUNDLE_SHA256)`（**精确等值**，sha256 是载荷 ⇒ `toContain` 不构成逃逸）；文件内 **无** `test.skip/only/fixme`、**无** `process.env.EXPECT_*` 旁路（grep 实证） | 源码 + grep |
| T0 真跑 | **passed**（365ms，含在 10/10 全绿运行内） | `raw/frozen_features_verify_run2_green.txt` |
| 新旧锚点事实核对（独立复算） | 线上 `index.html` 引用 `assets/index-xGaRgVd-.js`；该响应体 sha256 = `8d936e11f5d0d448434cf0d6907d8d907f0e544e8bd0a2805d1d06433993a8bc` = `web/dist/assets/index-xGaRgVd-.js` 磁盘文件（`cmp` 逐字节一致）；**由还原后源码重建的产物同名同 hash** | §4 |

**判词：追认**（常量更新是构建产物合法变更的必然结果，断言强度未降，且新值经我独立复算）。

---

## 4. 变异反证（判据 10）—— **有牙**

| 变异 | 内容（临时改源码，构建到 `dist-mut`，**不覆盖 `web/dist`**） | 结果 | 证据 |
|---|---|---|---|
| **M1** | `AggregateScoreChart.tsx` 的 svg 类名改回恒 `h-40 w-full`（去掉 `resize.svgClass(...)`） | **RV-3 红**：`[aggregate] svg 高度必须随容器（实测 160→160）——固定高度即在此变红`；同时 **RV-1/RV-2 仍绿** ⇒ 变异被精确捕获、非泛红 | `raw/mutation_m1_fixed_svg.txt` |
| **M2** | `KlineResultChart.tsx` 给 `<KlineChart>` 加 `key={JSON.stringify(indicators)}`（指标切换即重建实例 ⇒ pane 高度重置） | **RV-2 红**：`指标切换后已拖高度的 VOL pane 必须保持（切换前 63 / 切换后 null）`（原 pane 实例随重建消失）⇒ 「切换不得重置副图高度」有牙 | `raw/mutation_m2_pane_reset.txt` |

**还原逐字节验证**：两处变异回滚后（`git diff` 对该两文件 = 0 行）重建 ⇒ 产物名 `index-xGaRgVd-.js`、
sha256 `8d936e11…93a8bc`，与**线上被服务响应体**及 `web/dist` 磁盘文件 **`cmp` 逐字节一致**；
`dist-mut` / `dist-restore` 已删除（不留污染）。

---

## 5. 四规格复跑（判据 8）—— **全绿**（附 1 次闪红披露）

| 规格 | 结果 | 输出 |
|---|---|---|
| `adr028-resize-probe.e2e.ts` | **1 passed**（36.2s） | `raw/frozen_resize_probe.txt` |
| `adr028-window-sync.e2e.ts` | **6 passed**（23.6s） | `raw/frozen_window_sync.txt` |
| `adr028-axis-align-probe.e2e.ts` | **2 passed**（43.4s） | `raw/frozen_axis_align.txt` |
| `adr028-features-verify.e2e.ts` | **10 passed**（1.1m）｜第 1 次全量运行 **9 passed / 1 failed（T4）** | `raw/frozen_features_verify_run2_green.txt`（10/10）· `raw/frozen_features_verify.txt`（含 T4 失败原文）· `raw/frozen_features_verify_T4_isolated_rerun.txt`（T4 单跑 passed 13.9s） |

**T4 闪红事实（如实记录，按要求不做根因分析）**：失败断言为 `跳转后目标笔几何必须可测（按 ts+价格定位）`，
该次用时至 4.1s（正常为 13.6–13.9s）；后续两次运行（全量 10/10、T4 单跑）均绿。**未观察到崩溃 / core dump / OOM**。
四规格中 `features-verify` 的 T0 锚点在每次运行均绿。

---

## 6. 其它复核（未在判词内但影响放行）

| 项 | 事实 |
|---|---|
| 单测（本波新增 5 文件） | 逐文件单跑、`--maxWorkers=1`、`NODE_OPTIONS=--max-old-space-size=2048`：`curveGeometry`(9) / `resultChartConfig`(11) / `cardResize`(10) / `resultResizeIndicators`(7) / `IndicatorToggles`(5) = **42 passed / 0 failed** |
| 看板侧零回归（DOM 契约） | 看板工具条仍渲染 **6** 枚 `[data-indicator]` 且均在工具条内；默认 `ma/vol=开`、其余关 | `rv6_dashboard_isolation.json` |
| 真身完整性 | `GET /` → 200；`/assets/index-xGaRgVd-.js` 与 `web/dist` 逐字节一致 |

---

## 7. 未做项 / 残余风险

| # | 风险 | 级别 | 建议 |
|---|---|---|---|
| R1 | **`adr028-features-verify` T4 非确定性**（3 次全量运行 1 红 2 绿；红点在「跳转后目标笔几何可测」前置定位）⇒ 该门**不是可靠闸门**，未来可能造成误红并阻塞无关变更 | 中 | 由实现方/规格维护者在**独立波次**加固该前置（等待跳转落定 + 重试定位），**不得**以放宽判据方式修 |
| R2 | **持久化仅本机浏览器**（`localStorage`）⇒ 跨设备/跨会话不一致，且与看板服务端 `app_config` 语义不一致 | 中（本波已授权接受） | 见 §2.9 末尾建议（新增通用 UI 配置端点 + 服务端优先/本地兜底），需新波次与 Rust 车道 |
| R3 | **`ComparePanel.tsx` 仍有自有 `PAD = 10`**（页面⑤ 对比区，非本波四张曲线卡）⇒ 对比区与结果页四曲线仍有 2 user unit（≈1.24px @666px）系统差 | 低 | 若对比区也要求跨视图一致，需先确认其对齐判据锚点后并入 `curveGeometry` |
| R4 | **曲线卡新增 14px 标题行** ⇒ 默认卡高变化（聚合 186→204、净值 218→236 量级）、页面总高增加；**视觉基线类规格（`visual.e2e.ts`）本轮未跑** | 低 | 若后续跑视觉回归，需重新基线化 |
| R5 | **K 线绘图区由 234px 变 194px**（卡高仍 256，新增指标入口占头部行）⇒ 观感变化；冻结探针记录的 VOL pane 上限 177→137px（本就是卡高函数，非判据） | 低 | 已知并披露；如不接受可把指标入口移入卡片标题行右侧 |
| R6 | 卡片高度上下限 **120–1200px** 为实现的呈现层常数（ADR 未规定）；双击复位清空 inline 高度 | 低 | 无阻塞 |
| R7 | 副图 pane 高度**不跨刷新**持久化（本波未要求；切换指标不重置已验证） | 低 | 若用户期望刷新保持 pane 高度，需新波次（与 R2 同通道） |
| R8 | 复跑冻结探针**覆盖了未入库的** `tester/evidence/20260920_result_resize_probe/raw/` 30 个历史 json/png（不可还原；tracked 的 66 个证据文件已逐一 `git checkout` 还原） | 低 | 后续波次跑冻结证据类规格前，先 `cp -a` 备份未入库目录 |

---

## 8. 原始证据索引

| 文件 | 内容 |
|---|---|
| `raw/tester_verify_run_final.txt` | 自建终验规格最终运行（**6 passed**，49.2s） |
| `raw/rv1_indicators_isolation.json` | 指标入口/真身/pane/存储增量/哨兵键/网络写入全量读数 |
| `raw/rv2_kline_resize_pane.json` | K 线卡 256→406 / 内层 194→344 / 复位 / pane 100→63→63 / MACD 新 pane / 无残留 pane |
| `raw/rv3_curve_resize.json` | 聚合 204→264（svg 160→220）、净值 236→296（svg 208→268）、复位、宽度/viewBox/顶点不变、横向拖反证、把手几何 |
| `raw/rv4_tables_pad.json` | 三表格无把手/无 inline 高度；四曲线 n=103、首末 8/992；跨视图 6 对逐 bar 偏差 = 0.0 |
| `raw/rv5_persistence.json` | 拖高 256→376、刷新后 376 保持、勾选态保持、键集不变 |
| `raw/rv6_dashboard_isolation.json` | 结果页改完切看板：看板仍默认、无新增键 |
| `raw/mutation_m1_fixed_svg.txt` / `raw/mutation_m2_pane_reset.txt` | 两个变异反证的红色原文（含失败断言与实测值） |
| `raw/frozen_*.txt` | 四个冻结规格复跑 stdout（含 T4 闪红原文与两次复跑绿） |
| `raw/resource_discipline.md` | 单车道/内存/残留/副作用还原全部记录 |

---

## 9. 命令清单（可复现）

```bash
# 自建终验规格（真身 8081；不起 vite preview）
cd web && E2E_BASE_URL=http://localhost:8081 timeout 1200 \
  npx playwright test e2e/adr028-d5-result-resize-tester-verify.e2e.ts --reporter=list --retries=0 --workers=1

# 单测（新 5 文件，逐文件单跑）
cd web && for f in src/features/workbench/{curveGeometry,resultChartConfig,cardResize,resultResizeIndicators}.test.tsx \
                       src/features/dashboard/IndicatorToggles.test.tsx; do
  NODE_OPTIONS=--max-old-space-size=2048 timeout 300 npx vitest run "$f" --maxWorkers=1; done

# 冻结四规格
cd web && for s in adr028-resize-probe adr028-window-sync adr028-axis-align-probe adr028-features-verify; do
  E2E_BASE_URL=http://localhost:8081 timeout 1200 npx playwright test e2e/$s.e2e.ts --reporter=list --retries=0 --workers=1; done

# 变异反证（改源码 → 构建到 dist-mut → 临时 preview → 规格必红 → 还原 → 重建逐字节比对）
cd web && npx vite build --outDir dist-mut
VITE_PROXY_TARGET=http://localhost:8081 npx vite preview --outDir dist-mut --port 4175 --strictPort &
E2E_BASE_URL=http://localhost:4175 timeout 1200 npx playwright test e2e/adr028-d5-result-resize-tester-verify.e2e.ts --retries=0 --workers=1

# 还原核对（逐字节）
curl -s http://localhost:8081/assets/index-xGaRgVd-.js -o /tmp/served_bundle.js
cmp /tmp/served_bundle.js web/dist-restore/assets/index-xGaRgVd-.js   # 0 = 一致
```
