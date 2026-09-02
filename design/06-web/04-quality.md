# 06-web / 04 — 数据质量（页面④）

> Grill P4 定稿（2026-09-02，全按推荐）。回答核心问题：「自抓数据有多靠谱？」

## 1. 主视图：raw vs accurate 分歧表

- 筛选：标的 + 日期范围
- 列：时刻、raw 收盘价、accurate 收盘价、偏差%、raw 来源（SourceId）
- 默认按偏差降序；汇总行：比对 bar 总数 / 一致率（偏差 ≤0.5% 计一致）/ 最大偏差
- 点行 → 跳行情看板对应标的对应时刻（定位上下文）
- 次要视图：双线叠加图（raw vs accurate 收盘线，偏小区间肉眼难辨时用缩放）

## 2. 源一致率排行卡片

- 每源（TencentIfzq / SinaJsonp）在比对窗口内的一致率、平均偏差、样本数
- 用途：源权重/轮转序调整的数据依据

## 3. tushare 同步状态区

- 最近同步：时刻、覆盖标的、新增行数、耗时、**剩余积分**（quota 硬约束，醒目展示）
- **手动同步触发**：选标的 + 日期范围 → 补拉 accurate（异步任务，完成后刷新状态区）

## 4. 历史缺口报告

- 选标的 + 日期范围 → 缺口日期列表：哪天、缺哪些分钟段（起止时刻、缺 bar 数）
- 与页面②「今日缺口率」互补：②看实时，④看复盘

## 5. 页面纪律

- **纯只读 + 同步触发；不提供任何修改数据的入口**（ADR-003：raw 层永不被修改，准确性由 merge 视图 accurate 优先保证）

## 6. API 依赖

| 用途 | 接口 |
|---|---|
| 分歧表 | `GET /api/quality/divergence?code=&from=&to=` |
| 源一致率排行 | `GET /api/quality/source-accuracy?from=&to=` |
| 同步状态 | `GET /api/tushare/status` |
| 手动同步 | `POST /api/tushare/sync {codes, from, to}` |
| 缺口报告 | `GET /api/quality/gaps?code=&from=&to=` |

## 7. 验收（Wave 2）

- [ ] tushare 同步后，已知偏差 bar 在分歧表可见且数值与手工 SQL 对账一致
- [ ] 一致率排行随比对窗口变化正确重算
- [ ] 手动触发补拉后 accurate 行数增加、merge 视图对应时点切换为准确层值
