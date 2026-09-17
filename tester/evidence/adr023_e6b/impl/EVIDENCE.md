# ADR-023 E6b 第二刀（红→绿）证据

- 本文件：`/tmp/adr023-e6b-impl-20260917T035254Z/EVIDENCE.md`
- 仓库：/home/eestock/workspace/git/eestock/eestock-rs @ HEAD=204cb77a (未变)
- 目标契约：ADR-023 §6.1 第 8 条 / §6.3 第 12 条
- tester 红测试：crates/storage/tests/adr023_e6b_testdb_env_gate_red.rs (R1–R5) + scripts/tests/test_adr023_e6b_testdb_gate.sh (R3)

## V1 红→绿
- 红（改前）：Rust `0 passed; 5 failed` (exit 101)；shell `PASS=0 FAIL=1 VERDICT: RED`
- 绿（改后）：Rust `5 passed; 0 failed`；shell `PASS=7 FAIL=0 VERDICT: GREEN`
  - 原始：`/tmp/adr023-e6b-impl-20260917T035254Z/V1_red_before.log`、`/tmp/adr023-e6b-impl-20260917T035254Z/V1_red_shell_before.log`、`/tmp/adr023-e6b-impl-20260917T035254Z/V1_green_gate_final.log`、`/tmp/adr023-e6b-impl-20260917T035254Z/V1_shell_gate_final.log`

```
--- RED rust ---
test result: FAILED. 0 passed; 5 failed; 0 ignored; 0 measured; 0 filtered out; finished in 30.01s
--- RED shell ---
  FAIL R3-1 scripts/testdb-init.sh 不存在（红：缺幂等初始化入口）
VERDICT: RED (R3-1)  PASS=0 FAIL=1
--- GREEN rust ---
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
--- GREEN shell ---
PASS=7 FAIL=0
VERDICT: GREEN
```

## V2 门禁
- `./scripts/check-tangle.sh` exit 0

```
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
```

## V3 端到端
- 测试库 adr023_e6b_v3_test 由 scripts/testdb-init.sh 创建（17s，播种 44 symbols + 23 strategy + 24 strategy_version + 1,631,088 kline_accurate(M1) → 刷新 kline_accurate_1d=6,768）
- `cargo test --workspace --tests --no-fail-fast` = **732 passed / 0 failed / exit 0**（连跑两轮一致）
- 前端 `npx vitest run` = 88 files / 839 tests 全过；`npm run build` exit 0

```
--- run1 ---
passed=732 failed=0
--- run2 ---
passed=732 failed=0
0
```

## V4 响亮失败
```
### V4a unset EESTOCK_TEST_DATABASE_URL
exit=101
集成测试拒绝运行：环境变量 `EESTOCK_TEST_DATABASE_URL` 未设置（或为空）。
### V4b pointed at LIVE db
exit=101
哨兵表 `_eestock_test_db` 不存在/查询失败：`EESTOCK_TEST_DATABASE_URL` 很可能指向活库 `eestock`（哨兵拦截）。: error returned from database: relation "_eestock_test_db" does not exist
```

## V5 活库零变化
```
--- live snapshot before/after diff ---
IDENTICAL
--- HEAD ---
204cb77a2f345c7163b5a93da4540cd5c66f2d6f
--- staged ---
0
```

## doc-first（13 个 file= 声明文件）
```
=== doc-first: 13 files grep + mtime ===
crates/storage/tests/kline_reader.rs test_support=1 literal=0 mtime=1789617275
crates/web/tests/api_rest.rs test_support=1 literal=0 mtime=1789617275
crates/web/tests/ws_poller.rs test_support=1 literal=0 mtime=1789617275
crates/storage/tests/symbol_admin.rs test_support=1 literal=0 mtime=1789617275
crates/web/tests/api_admin.rs test_support=1 literal=0 mtime=1789617275
crates/web/tests/api_quality.rs test_support=1 literal=0 mtime=1789617275
crates/mcp/tests/mcp_tools_db.rs test_support=1 literal=0 mtime=1789617275
crates/storage/tests/alert_store.rs test_support=1 literal=0 mtime=1789617275
crates/web/tests/api_alerts.rs test_support=1 literal=0 mtime=1789617275
crates/storage/tests/accurate_upsert.rs test_support=2 literal=0 mtime=1789617275
crates/storage/tests/raw_writer.rs test_support=1 literal=0 mtime=1789617275
crates/storage/tests/event_sink.rs test_support=1 literal=0 mtime=1789617275
crates/storage/tests/symbols_registry.rs test_support=1 literal=0 mtime=1789617275
=== tangle wrote exactly 13 ===
13
```

## entangled tangle（非 --force）输出
```
[11:54:35] INFO     Welcome to Entangled v2.4.3!
           INFO     write `crates/storage/tests/accurate_upsert.rs`
           INFO     write `crates/storage/tests/raw_writer.rs`
           INFO     write `crates/storage/tests/event_sink.rs`
           INFO     write `crates/storage/tests/symbols_registry.rs`
           INFO     write `crates/storage/tests/kline_reader.rs`
           INFO     write `crates/web/tests/api_rest.rs`
           INFO     write `crates/web/tests/ws_poller.rs`
           INFO     write `crates/storage/tests/symbol_admin.rs`
           INFO     write `crates/web/tests/api_admin.rs`
           INFO     write `crates/web/tests/api_quality.rs`
           INFO     write `crates/mcp/tests/mcp_tools_db.rs`
           INFO     write `crates/storage/tests/alert_store.rs`
           INFO     write `crates/web/tests/api_alerts.rs`
```
