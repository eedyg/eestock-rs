# 012 — 看板涨跌幅语义修复：1 分钟涨跌 → 日涨跌幅（vs 昨收）

**报告位置**：`coder/report/012_dashboard_change_pct_prev_day_close.md`（本文件）
**日期**：2026-09-11 · **状态**：完成（已 staging，未 commit）

## 语义修复点

`crates/storage/src/reader.rs` `SYMBOLS_LATEST_SQL`（事实源 `design/07-app-plane/00-web-api.md`，
经 entangled tangle 生成，未手改生成物）：

- **修复前**：`prev_close` = merge 尾部 top-2 中 rn=2，即**上一根 M1 bar 收盘** →
  涨跌幅=(last−prev)/prev 是 1 分钟涨跌（±0.0x%，看板像「卡住」）。
  实证（旧二进制，8081）：518880 change_pct = **−0.1015%**（分钟级）。
- **修复后**：`prev_close` = **最近一个早于当前交易日（Asia/Shanghai 日界）的 D1 收盘（昨收）**。
  实证（新二进制，8081）：518880 change_pct = **−2.4882%**（= (8.857−9.083)/9.083，精确一致）。

## D1 昨收取数口径

新增第二个 `LEFT JOIN LATERAL`：双侧候选各 `(code, ts DESC)` 索引回溯 `DESC LIMIT 1` →
`ORDER BY ts DESC, pri LIMIT 1` 合并：

- **accurate 优先 + raw 兜底**（统一读源口径）：`kline_accurate_1d`(pri=0) + `kline_1d`(pri=1)，
  同 ts accurate 胜（实盘验证：518880 09-10 accurate 9.083 vs raw 兜底 9.084 → 取 9.083）。
- **日界**：`ts < time_bucket('1 day', now(), 'Asia/Shanghai')`——严格早于当前交易日 00:00 CST，
  当日 forming 桶被排除（跨夜：日界后 prev 才切换到今日收盘）。
- **周末/节假日**：无 D1 bar 自然跳过——周一的昨收 = 上周五 D1 收盘（「最近一个早于今日的非空 D1」）。
  集成测试用「仅 4 天前有 D1」种子锁定同型空档跳过语义。
- **无 D1 历史新标的** → prev_close NULL → 前端 `--`（与既有 null 口径一致；测试锁定）。
- M1 侧 last 保持 merge 尾部语义，简化为 top-1（双侧 LIMIT 1 候选 → 最新 ts，同 ts accurate 优先；
  与原 top-2 的 rn=1 等价，少取一根冗余候选）。

## 同一计算路径（WS = REST）

WS quote 推送（`crates/web/src/ws.rs` Poller）与 REST `latest.change_pct`（`crates/web/src/dto.rs`
`From<&SymbolLatestView>`）均消费同一 `symbols_with_latest()` 的 `prev_close` 字段，未分叉。
活体两侧互证：REST −2.4882%（last 8.857）；看板 WS 推送 −2.44%（last 8.861，(8.861−9.083)/9.083
=−2.4437%，截图 `coder/report/dashboard_live_8081_20260911.png`）。

## 变更文件（均已 git add，未 commit）

| 文件 | 层 | 变更 |
|---|---|---|
| `design/07-app-plane/00-web-api.md` | 事实源（L4 应用面） | SYMBOLS_LATEST_SQL 重写+注释；§1.1 端点表 change_pct 口径；dto/fn 注释；storage/web 测试 chunk |
| `design/02-domain/contracts.md` | 事实源（L2 domain） | `SymbolLatestView` prev_close 语义注释 |
| `crates/storage/src/reader.rs` | L4 适配器（tangle） | SQL 实现 |
| `crates/storage/tests/kline_reader.rs` | 测试（tangle） | 适配 2 个 + 新增 1 个测试 + cagg refresh 串行锁 |
| `crates/web/src/dto.rs` | L4（tangle） | LatestDto.change_pct 注释 |
| `crates/web/tests/api_rest.rs` | 测试（tangle） | 快照测试适配新语义 |
| `crates/domain/src/ports.rs` | L2（tangle） | 注释（tangle 自 contracts.md） |

前端显示层零改动（语义修正在数据层；web/src 无「1分钟/前一根」口径注释）。WS 帧文档（§1.2 line 106）
原本即写「相对前一交易日收盘涨跌幅」，本次实现与之对齐。

## 测试覆盖（TDD：Red → Green 实证）

**Red**（旧 SQL 跑新测试，全挂且失败值恰为旧分钟级语义）：
- `symbols_with_latest_snapshot`: prev_close Some(4.0)（旧 M1 rn=2）≠ 期望 5.0（D1）
- `symbols_latest_d3_merge_tail_semantics`: Some(9.99) ≠ 期望 8.88（D1 accurate 优先）
- `symbols_latest_prev_close_is_prev_trading_day_d1`: None ≠ 期望 6.66

**Green**：改 SQL 后全绿；连跑 6 次 kline_reader 全绿。

新增/适配：
- `symbols_latest_prev_close_is_prev_trading_day_d1`（新）：相对 now() 动态种子——
  昨日 D1 收 7.77 + 今日 accurate 8.88（日界排除 forming 桶，prev=7.77）；空档跳过（4 天前 6.66）；
  无 D1 历史 → NULL。显式窗口 refresh 自愈 cagg 残留，重跑确定。
- `symbols_with_latest_snapshot`（适配）：昨收专用码 997771 raw-only → prev=kline_1d 兜底 5.0；
  无数据码全 NULL 不变。
- `symbols_latest_d3_merge_tail_semantics`（适配）：last 语义不变；prev=D1 accurate 8.88
  优先于 raw 兜底 2.0。
- web `symbols_latest_healthz_spa_and_sources_health`（适配）：change_pct 100→0.0
  （last=2.0, 昨收=2.0；接线验证，日界口径由 storage 测试锁定）。

**副产物修复**：新增 refresh 与既有测试并发撞 TimescaleDB 55P03「concurrent refresh」
（复现率 >50%）→ 测试内 `cagg_refresh_lock()` 全局互斥串行化所有 cagg refresh 调用点（5 处），
修复后 6/6 稳定。

## 验证

- `cargo test -p storage -p web -p application`：**261 passed / 0 failed**
- `cargo test --workspace --no-fail-fast`：**588 passed / 0 failed**
- `cargo clippy --workspace --all-targets`：**0 warning**（修掉 3 个 doc_lazy_continuation）
- `entangled tangle`：**Nothing to be done**（无 diff）
- `cd web && npm test`：**47 文件 457 全绿**

## 性能 timing 对比（同库 :5433，EXPLAIN ANALYZE）

| 口径 | 旧（top-2 M1） | 新（top-1 M1 + D1 昨收） |
|---|---|---|
| Execution Time | 13.2 ms | 16.0 ms |
| Planning Time | 468 ms | 455 ms |

Planning 开销系 `kline_accurate` hypertable 70+ chunk 的**既有**规划成本（新旧一致），应用侧
sqlx prepared 复用摊销。活体 app 端 `/api/symbols` 稳态 **14–18ms**（旧报告基线 13.5ms 量级，
不劣化；冷连接首次 planning ~460ms 为既有行为）。D1 两侧均走 `(code, ts DESC)` 索引回溯
LIMIT 1，无全表扫描回归。

## 部署与活体对账（8081）

kill（pid 2985816）→ `cargo build -p app --bin eestock-app` → 同配置
（`/tmp/app_dev_8081.toml`，debug 二进制，nohup + logs/）重启（pid 3696673），healthz=200。

| code | last | 昨收（accurate_1d，09-10） | API change_pct | 手工 (last−昨收)/昨收 | 误差 |
|---|---|---|---|---|---|
| 518880 | 8.857 | 9.083 | −2.4882% | −2.4882% | 0 |
| 513310 | 4.688 | 4.836 | −3.0604% | −3.0604% | 0 |
| 159337 | 1.715 | 1.772 | −3.2167% | −3.2167% | 0 |

修复前 518880 显示 −0.10%（分钟级）；修复后 −2.49%（日级，与昨收对账精确一致，<0.1pp 达标）。
看板 Playwright 截图：`coder/report/dashboard_live_8081_20260911.png`（518880 −2.44%，WS 推送实时值）。

## 残余风险

- 适配测试（snapshot/D3/web api_rest）假定运行日晚于 2026-09-03（固定种子日）；该日已过，注释标明。
- cagg 自动策略（近 3 天）会物化测试码当日桶，但日界条件恒排除当日桶，不影响断言。
- 冷连接首次查询 ~460ms planning 为既有行为（新旧相同），未扩大。
