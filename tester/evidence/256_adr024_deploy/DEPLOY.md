# ADR-024 上线记录（migrate 0027 + P4 + P6 + P5 + P4b）

- 执行时间：2026-09-18 18:04–18:06 CST（UTC 10:04–10:06）
- 执行人：架构师（按 `design/16-backtest-scalability/05-deploy-runbook.md`）
- 代码基线：`8b1840a`（三笔提交：`f2726da` feat / `0d9092e` test / `8b1840a` fix(ops)）；基线前一提交 `18d1b9a`
- 形态：本机 debug 二进制 + `web/dist`（宿主机进程，非容器）；DB = 容器 `eestock-timescaledb`

## 1. 上线前发现（如实记录）

| 项 | 发现 |
|---|---|
| 8081 实例状态 | **上线前应用已不在运行**：最后日志 `2026-09-18T08:02:52Z`（16:02:52 CST），**无 panic/ERROR**，进程不存在 ⇒ 属**被外部终止**（非崩溃）；嫌疑为某条验收车道的实例操作误杀（该时段有车道在起第二实例做真渲染）。**上线时无需 kill，直接起新实例。** |
| 迁移前状态 | `strategy_run_bars` 不存在、`result_format` 列不存在（A1 输出）；既有 run 374 条 |

## 2. A 阶段：迁移 0027（additive）

```
ALTER TABLE / CREATE TABLE / CREATE INDEX ×2  → 全部 OK
A3 核验：strategy_run_bars 存在；result_format 列 =1；
        CHECK (kind = ANY(ARRAY['per_bar','net_value','drawdown','fills']))；
        strategy_run 既有 374 条不变
```
回滚 SQL（未使用）：`DROP TABLE strategy_run_bars; ALTER TABLE strategy_run_result DROP COLUMN result_format;`

## 3. B 阶段：构建与重启

| 项 | 值 |
|---|---|
| 回滚件 | `<备份目录>/eestock-app.pre-deploy`（212 MB，sha256 记录于 `bin_before.sha256`） |
| 新二进制 | `target/debug/eestock-app` sha256 前缀 **`47b1309dc6acf032`**（构建 EXIT=0） |
| 前端 | `npm run build:prod` OK；`web/dist` bundle **`index-D8n72RAF.js`**（构建前后一致 ⇒ 产物已是最新） |
| 进程 | pid **2043164**，启动 `2026-09-18 18:04:44 CST`；**同一进程持有 8081 + 8082** |
| `web/dist` 不被 git 跟踪 | ⇒ 构建产物在部署时生成（非提交内容） |

## 4. C 阶段：冒烟（12 项，全部 PASS）

| # | 用例 | 结果 |
|---|---|---|
| C1 | 健康检查 | 8081 `/healthz` = **200** |
| C2 | `/api/symbols` 增幅 | `last=9.009`、`change_pct=1.7276%` ⇒ 反推昨收 **8.856** ✓（事故项保持修复） |
| C3 | **M30 真跑**（近 60 天） | **201 → succeeded**，`bars_total=680`，`result_format=chunked_v1` |
| C4 | 负向对照 `period=W1` | **400** `{"error":{"code":"period_invalid","detail":{"period":"W1","supported":[M1,M5,M15,M30,H1,D1]},...}}`（**结构化**） |
| C5 | **用户原场景 M15 × 259 天** | **201**（旧规则必 400）；`estimated_bars=3096`、`clamped:false`、`progress_prescan:"count"`、`requested_*` 回显 |
| C6 | 区间收缩（`from=2005-01-01`） | **`clamped:true` / `clamp_reason:"data_range"`**；`requested_from=2005-01-01` → **`effective_from=2013-07-28`**（D1 数据真起点） |
| C7 | `/fills` | `total=162`、`recorded:true`、分页字段齐备；元素含 `bar_index/side/qty/price/reason/ts`（**精确成交源**） |
| C8 | `/curve?kind=net_value&k=100` | `downsampled:true`、`original_bars=3096`、100 点 |
| C9 | `/bars?kind=per_bar&limit=3` | `has_more:true`、`next_offset:3`、n=3（**显式分页**） |
| C10 | `/result`（chunked） | 返回 `summary + per_bar + net_value + drawdown + trades + metrics + has_more + next_offset`（**显式，不静默截断**） |
| C11 | 前端产物一致性（技能步骤 6） | `GET /` 的 `index-D8n72RAF.js` **== ** `web/dist/index.html`；`/assets/index-D8n72RAF.js` 内容 sha256 **MATCH** |
| C12 | 收尾 | 3 条 `SMOKE-*` run 已删（回读 0）；库清单只剩 `{eestock}`（+系统模板） |

启动日志：除下列 1 条外无 ERROR。

## 5. 唯一 ERROR 的归因（**非产品缺陷**）

```
target=application::workbench  message=结果分块落库失败
run_id=sr_1789725930146_000002
error=insert or update on table "strategy_run_bars" violates foreign key constraint "strategy_run_bars_run_id_fkey"
```
**归因**：该 run 是本次冒烟的 `SMOKE-clamp`，**我在它仍 running 时删除了父行**，后台任务随后写结果分块 ⇒ 外键失败。属**冒烟收尾过快**（执行者失误），不是产品缺陷。
**已修订手册**：冒烟产生的 run **必须先到终态再删**（或先 cancel），见 §7。
**登记的既有观察（低）**：若外部 SQL 删除运行中 run，会得到一条 ERROR 日志而非"run 已消失"的优雅处理；正常运维路径（无删除端点）不可达。

## 6. 上线后登记

- 部署批次：`8b1840a` + 二进制 `47b1309d…` + dist `index-D8n72RAF.js` + 迁移 0027（已应用）
- 待办：① 用仓内 runner 重建 GitNexus 索引（`node .gitnexus/run.cjs analyze`）② ADR-025 四项 ③ 收尾小批（N1-r / N2-r / dev-only dispose / P4b-r 取消终态进度）④ 观察 24h（`strategy_run` 状态分布、`/curve` `/bars` `/fills` 错误率、cagg 作业）
