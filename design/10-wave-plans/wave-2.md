# Wave 2 任务书 — 质量与告警

> 愿景定稿范围（00-vision §6）：数据质量对照 + 告警引擎（页面④⑦）+ MCP④。tushare 同步已由 Wave 0 提前交付。
> 前置：Wave 0/1 已收官。四层布局文档（04-quality.md / 07-alerts.md）已定稿，布局以此为准。
> 全程 TDD + 文学式单向 tangle；数据面只许纯加法（改既有逻辑须架构师批准）。

## 范围

### 1. 数据质量（QualityService + 页面④）
- **raw vs accurate 对照**：tushare 准确层与 kline_raw 逐日逐标的比对（分歧率=|Δclose|>阈值 的 bar 占比；量纲注意 amount 单位差异，见 backlog D4）
- **缺口报告**：按交易日 × 标的统计缺口分钟（交易日历驱动），区分「源故障时段」与「系统缺口」
- REST：`GET /api/quality/daily?date=` / `GET /api/quality/gaps?code=`（以 04-quality.md API 依赖节为准）
- 页面④前端（QualityGrid.tsx 骨架为基座，深色终端风）
- MCP 工具④：`get_data_quality(code, date)`（ADR-009 范围④）

### 2. 告警引擎（AlertService + 页面⑦）
- 规则模型：阈值/变化率/持续时长/静默期；评估节拍 1min（读库聚合，ADR-017 应用面只读库）
- 内置规则首批：源成功率低于阈值、标的缺口率超阈、采集停摆（D5 事件空窗联动）、tushare 日增量失败
- 告警生命周期：触发→确认→恢复（状态机）；通知渠道 = **仅页面⑦展示 + WS 推送**（用户定稿 2026-09-04；webhook 按需后续单开）
- REST + WS 推送 + 页面⑦（AlertsGrid.tsx 基座）

### 3. 交易日历节假日表（backlog 清零）
- holidays 表 + 年度导入（手工 SQL 或 tushare trade_cal 接口，评估后定）；scheduler/gapfill/质量报告全部改走日历

### 4. backlog 修复包（Wave 1 验收遗留，全部带上）
- D3 慢查询优化（health 聚合窗口索引/物化）
- D4 amount 量纲统一（raw 元 vs accurate 千元口径对齐，含迁移修正）
- D5 事件空窗（非交易时段健康事件口径）
- D6 SPA 回退过宽（/api/* 未匹配应 404，仅前端路由回退 index.html）
- 13:00 标签伪缺口（upstream 午后起点标签错位口径修正）
- 粘源无陈旧检测（executor StaleData 分类）

### 5. MCP Streamable HTTP 评估（spike，2025-03-26 spec）
- 产出评估报告 + 决策建议（并存/迁移/不动），**不直接实施**（架构师裁决后另行）

## 验收标准
- [ ] 门禁三件套全绿（tangle/test/clippy）+ 前端 vitest/build
- [ ] 页面④：任选一日能看到 raw vs accurate 对照与缺口报告（含 09-03/09-04 真实数据）
- [ ] 页面⑦：模拟规则触发（如临时阈值）→ 告警出现→确认→恢复全生命周期；WS 实时推送
- [ ] 节假日表：周末/法定假日不采集、不计缺口（用 2026 年已知假日验证）
- [ ] backlog 各项各有关闭证据（测试或实盘数据）
- [ ] MCP④ 客户端可查数据质量

## 明确不做（边界）
筹码分布（用户定稿留 Wave 3，ADR-011）、回测（Wave 3）、交易（Wave 4）、告警外部通知渠道（webhook 按需单开）、认证/响应式、**POST /api/tushare/sync 手动触发（父级裁决 2026-09-04：留后续 Phase 单开工单——手动轮与三时点轮的 checkpoint/退避幂等交互需单独评审；过渡态已定稿：页面④ sync-panel 手动触发按钮置灰，GET /api/tushare/status 可用）**
