# ADR-024 冻结批 index 快照（非 commit，可复原）
captured_at_utc: 2026-09-18T06:31:40Z
HEAD: 18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f
index_tree: ecbd6483516fec901441167b9992e4c75088ddb9
archive: coder/backups/adr024_frozen_index_20260918T063137Z.tar.gz
sha256(archive): 299045b06dd8dcd134e036434a8c624d8740423bee8f48343b58256c03466d83
files: 4527 (tracked) / staged: 165
P0/P2/P2b/P2c/P4b 关键文件 index 哈希：
100644 7fa3e2a0452c2486600bc5fa9f3157329dbd7f17 0	crates/application/src/strategy.rs
100644 aeb49a894fdc5e7420b4d02e08b1ab1224c2ca4e 0	crates/application/src/workbench.rs
100644 87c8718e174038be96883cdb16cde7e480e065b2 0	crates/backtest/src/indicators.rs
100644 dc0b1ba09746c1386a4c86692c05b9730fa3db35 0	crates/simlive/src/plugin_orchestrator.rs
100644 e97736e09f98f9053a05b8f214cd2f446e55e466 0	crates/strategy-core/src/engine.rs
100644 ca802aad319152b850541024ba7490612f8f5905 0	crates/strategy-runtime/src/quickjs.rs

## 冻结对象纯度核验（架构师，2026-09-18T06:35Z）
本 index tree 已核实**不含并发 P4 车道的半成品**（P4 仅在工作区改，未入库）：
- `git show :crates/domain/src/ports.rs | grep -c "append_result_chunk|result_chunk_count"` = **0**
- `git show :crates/web/src/workbench.rs | grep -c "brief|/bars|curve"` = **0**（该文件 staged 版为 P0 的白名单删除版）
- `git diff --cached --name-only | grep -c 0027` = **0**；`git show :design/04-storage/schema.md | grep -c strategy_run_bars` = **0**
⇒ 冻结范围 = **P0 + P2 + P2b + P2c + P4b（仪表）**，与 tester `tester/evidence/250_adr024_p2c_p4b_verify/delivered_index_state/` 的 5 文件交付态一致。
**用途**：若后续车道（P4/P4b 修复）破坏这批交付，可用 `coder/backups/adr024_frozen_index_20260918T063137Z.tar.gz`（sha256 `299045b0…`）或 `git read-tree ecbd6483516fec901441167b9992e4c75088ddb9` 复原。
