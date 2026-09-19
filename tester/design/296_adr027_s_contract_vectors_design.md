# 296 — ADR-027 S 段「跨侧共享向量」验收测试设计

- 本文件位置：`tester/design/296_adr027_s_contract_vectors_design.md`
- 类型：**新增测试设计**（tester 自有资产，非生产改动）
- 契约事实源：`design/17-trade-detail-layering/02-spec.md` §1/§2/§3；判据：`03-test-plan.md` §4（S 段）
- 交付物：
  1. `design/17-trade-detail-layering/contract-vectors.json`（7 组向量，≥6 要求）
  2. `crates/application/tests/adr027_contract_vectors_parity.rs`（判据载体，2 个用例）
  3. `tester/evidence/20260920_adr027_accept/gen_contract_vectors.py`（独立 oracle 生成器）
- 执行结论（本次验收）：**通过** —— `raw/30_s_contract_vectors_parity.txt`

## 1. 测试策略
| 层 | 手段 | 目的 |
|---|---|---|
| 向量层 | `contract-vectors.json`：每组的输入 `FillFact`、逐笔期望 `rt_seq`、期望 `RoundTrip[]`、期望逐笔 L2 | 把「同一输入的应有输出」冻结成**可执行**判据，供两侧实现共同对齐 |
| 期望值来源 | Python 独立 oracle（按 02-spec §2 公式的 op 顺序计算，**不读 Rust 实现**） | 防止「实现 → 期望」的自证循环（假绿） |
| 回测侧 | `backtest::assign_rt_seq` + `backtest::aggregate_round_trips`（strategy-core 引擎所用同一对函数） | 逐笔打号 + 逐回合逐字段 |
| sim-live 侧 | `SimLiveService::round_trips` 真实读路径（mock `SimSessionStore` → `sim_trades` 行 → `SimTrade` → `FillFact` → 唯一聚合实现） | 端到端重建（含 `session_bar_index` 相对会话起点折算）与回测侧比对 |
| 空跑防护 | 对向量期望值做 1e-17 级突变 ⇒ 判据必红（已实测，见验收报告 §6） | 证明判据非空洞 |

## 2. 分层覆盖计划
- **跨侧一致（核心）**：`adr027_contract_vectors_cross_side_parity` —— 4 条硬断言：逐笔 `rt_seq`、回合逐字段（数值逐位）、**两侧序列化 JSON 逐字节相等**、逐笔 L2 字段。
- **sim-live 单侧独立（防只验一侧）**：`adr027_contract_vectors_sim_live_l2_matches_vector` —— `round_trip_fills` 逐回合切片逐字段 == 向量，且未知 `rt_seq` ⇒ `None`（禁空数组冒充，D8）。
- 不覆盖（显式边界）：引擎**在线**打号路径与聚合打号的等价性（由 P1b ledger 单测 + R/U 段覆盖）；HTTP/MCP 形状（C 段）。

## 3. 用例清单（Given–When–Then）
| ID | Given（向量） | When | Then |
|---|---|---|---|
| S1-V1 单笔开平 | 买 100@10 / 卖 100@12（rt 1） | 两侧聚合 | 逐字段 == 期望（`pnl = 188.79999999999995` 等） |
| S1-V2 多批加仓 | 买 100@10 + 买 200@11 / 卖 300@13 | 同上 | 同一 `rt_seq`，`shares = 300`，`open_price = 10.666…` |
| S1-V3 部分卖出 | 买 100 / 卖 40 / 卖 60 | 同上 | 单回合全回合口径 `pnl`（无成本分摊），`close_price = 11.4` |
| S1-V4 DCA 多批 | 6 笔定投买入 + 足额卖出 | 同上 | 单回合，7 笔 L2，`l2_count = 7` |
| S1-V5 零长回合 | 同 bar 买 + 卖 | 同上 | `open_bar == close_bar == 4`、`hold_bars == 0`、归属同一 `rt_seq` |
| S1-V6 Open 未平仓 | 买 100 + 部分卖 40 | 同上 | `status = Open`、`pnl = null`、`close_ts/close_bar/hold_bars/reason = null`、`close_price = 12.0` |
| S1-V7 清仓后重开 | 买/卖 + 买/卖 | 同上 | `rt_seq = 1, 1, 2, 2`；两回合均 `Closed` |
| S2 L2 单侧 | 全部向量 | `round_trip_fills` 逐回合 | 逐笔字段 == `expected_l2`；`rt_seq=9999` ⇒ `None` |

## 4. Mock / Stub 依赖
- `VectorStore`：仅实现 `get_session` / `list_trades`（其余 `unimplemented!()`）——保证被验路径**只**读会话元数据 + 成交行，不触 DB/网络。
- `FixedClock`：固定时刻，无时间依赖。
- sim-live 侧 `source` 映射：`Policy → "strategy"`、`Manual → "manual"`；向量**不得**含 `ForceClose`/`StopTrigger`（sim-live 无该语义，测试内 panic 拦下）。

## 5. 边界与异常用例
1. 向量数 < 6 ⇒ 断言失败（防止后续被删到不达标）。
2. 期望值与实现 1 ulp 级差异 ⇒ 失败（**逐位**，非容差）。
3. 未知 `rt_seq` ⇒ 必须 `None`（404 语义的可测替身）。
4. side 文本大写（`Buy`/`Sell`，面向 HTTP/serde 形状）↔ `sim_trades.side` 小写（DB 形状）的映射在测试内显式转换，避免「形状不同被误判为聚合不同」。

## 6. 覆盖目标
- L1 字段覆盖：`rt_seq/code/status/open_ts/close_ts/open_bar/close_bar/open_price/close_price/shares/gross_value/commission/stamp_duty/pnl/hold_bars/reason/l2_count/buy_count/sell_count` = **20/20**（每组全字段比对）。
- L2 字段覆盖：`rt_seq/code/bar_index/ts/side/qty/price/trade_value/commission/stamp_duty/reason` = **11/11**。
- 形态覆盖：单笔开平 / 多批加仓 / 部分卖出 / DCA 多批 / 零长回合 / Open 未平仓 / 清仓重开 = **7/7**。

## 7. 复现命令
```bash
python3 tester/evidence/20260920_adr027_accept/gen_contract_vectors.py \
  > design/17-trade-detail-layering/contract-vectors.json
cargo test -p application --test adr027_contract_vectors_parity
```
