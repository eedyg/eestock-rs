# 006 — Web 文档 7 页布局节重构（四层法）

> 报告位置：`coder/report/006_web_layouts.md`（本文件）
> 任务：按 00-shell.md「布局表达规范（四层法）」为 02-08 共 7 页补全布局节（L1 ASCII 线框 / L1.5 静态 HTML 样机 / L2 六列区域规格表 / L3 带接线 TSX 骨架），样板对齐 01-dashboard.md。纯文档任务，未改任何 Rust 实现代码。
> 中途风格变更（用户拍板，父会话传达）：L1.5 样机从灰白朴素风改为深色交易终端风（#0b0e17 底、霓虹涨红跌绿 #ff5c6c/#00e0a4、玻璃拟态卡片、#38bdf8→#a78bfa 渐变强调、等宽数字、呼吸灯状态点）。已完成旧风的 02 页已返工，全部 7 页均以重做后的 01-dashboard.html 为 CSS 基线。

## What changed（已 git add，未 commit）

| 文件 | 变更 |
|---|---|
| design/06-web/02-sources.md | +布局节（四层），原 §1-8 顺延为 §2-9，内容原样保留 |
| design/06-web/03-symbols.md | 同上，原 §1-6 → §2-7 |
| design/06-web/04-quality.md | 同上，原 §1-7 → §2-8 |
| design/06-web/05-backtest.md | 同上，原 §1-7 → §2-8 |
| design/06-web/06-trading.md | 同上，原 §1-7 → §2-8 |
| design/06-web/07-alerts.md | 同上，原 §1-6 → §2-7 |
| design/06-web/08-settings.md | 同上，原 §1-6 → §2-7 |
| design/06-web/preview/0{2..8}-*.html | 新增 ×7（entangled tangle 生成） |
| web/src/layouts/{Sources,Symbols,Quality,Backtest,Trading,Alerts,Settings}Grid.tsx | 新增 ×7（tangle 生成） |

行数：7 个 md 共 +2013/−47（git diff --stat，tangle 门禁输出）。

## Architecture alignment

- 所有变更在 `design/06-web/`（文档事实源层）与其 tangle 生成物（`preview/*.html`、`web/src/layouts/*.tsx`）内；不改接口、不改层边界、不新增依赖。
- L3 骨架遵守 00-shell 规范：Props 契约 + 区域→组件映射 + 数据源/三态内联注释 + 定稿默认值常量；视觉样式与数据获取实现明确留给组件手写。

## 每页区域清单（L1/L1.5 标签/L2/L3 四层 id 一一对应，kebab-case）

| 页 | 区域 id |
|---|---|
| 02 数据源诊断 | `summary-bar` `source-cards` `detail-panel` `gap-cards` `alert-preview` |
| 03 标的管理 | `table-toolbar` `symbol-table` `form-dialog`（注册/编辑共用模态） |
| 04 数据质量 | `filter-bar` `divergence-table` `overlay-chart` `accuracy-cards` `sync-panel` `gap-report` |
| 05 回测工作台 | `strategy-form` `task-list` `result-overview` `metric-cards` `trade-table` `period-heatmap` `compare-view` `grid-rank` |
| 06 交易面板 | `account-card` `position-table` `order-form` `order-list` `trade-list` `confirm-dialog` |
| 07 告警中心 | `alert-filter` `alert-list` `rule-panel` |
| 08 系统设置 | `settings-nav` `source-config` `collector-config` `mcp-config` `system-info` `log-viewer` `danger-zone` |

多视图/多模式各画一幅：02=默认/详情展开；03=列表/表单模态；04=分歧表/叠加图；05=单次结果/对比/网格排行；06=默认/确认弹窗；07、08 单视图（无多模式定稿）。

## Test coverage / Verification

- 纯文档任务，无代码测试；验收方式 = tangle 一致性门禁：
  - `entangled tangle` → 生成 14 个新文件（7 preview + 7 layouts），输出见上方 ls
  - `./scripts/check-tangle.sh` → ✅「tangle 后无 diff，design 与生成物一致」（先 stage 再跑，`git diff` 工作区干净）
- 未触碰 docker / cargo / design/06-web 以外的文档（00-shell.md 未动；tester 并行复验不受扰）。

## 待架构师裁决清单（未自行编造，布局层先按最保守口径落稿）

1. **02 alert-preview 数据源**：§7 告警预览定稿了「页底内嵌最近 10 条告警」，但 §8 API 依赖节未列告警端点。L2/L3 暂写 `GET /api/alerts?limit=10`（复用页面⑦接口），需确认端点与 limit 参数形态。
2. **02 alert-preview 交互**：点击条目是否跳页面⑦未定义，L2 暂标「只读；点击跳转待裁决」。
3. **05 手续费/滑点默认值**：定稿 §5「默认值与旧系统口径一致」但具体数值（费率%/最低费用/滑点 bp）未在文档给出，`BACKTEST_DEFAULTS` 只注释未硬编码，需补数值（样机占位 0.01%/5元/2bp 仅为示意，非定稿）。
4. **05 回测默认周期**：定稿给周期集合 1m/5m/15m/日，未给默认值（dashboard 有默认 15m 先例，未擅自沿用）。
5. **06 position-table 现价端点**：定稿「现价用本系统行情源」，但 §7 API 依赖节未列行情端点；暂写复用 `GET /api/symbols` latest 快照 / WS quote。
6. **06 市价五档数据来源**：下单表单「市价五档」为定稿，但五档行情由券商通道还是本系统提供未定稿，L2 未写死数据源。
7. **03 form-dialog 形态**：注册/编辑采用模态弹窗（遮罩点击不关闭防误触）为布局层自决，Grill 未定交互形态；如规范另有约定（抽屉/内联）可低成本调整。
8. **04 sync-panel / gap-report 50/50 并排**、**06 order-form 右栏 W=320**、**08 settings-nav 锚点导航**：均为布局层自决的空间划分，无产品行为含义。

## 建议 commit 切分（按波次 3 笔，或按页 7 笔均可）

1. `docs(web): 布局节四层表达 — W1 页（02-sources, 03-symbols）`（4 md 对应 preview+layouts 共 2 页）
2. `docs(web): 布局节四层表达 — W2 页（04-quality, 07-alerts）`
3. `docs(web): 布局节四层表达 — W3/W4/通用页（05-backtest, 06-trading, 08-settings）`

每笔内含该页 md + preview html + Grid.tsx 三件套，均可独立过 check-tangle。
