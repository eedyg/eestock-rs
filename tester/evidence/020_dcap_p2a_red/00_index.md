# 020_dcap_p2a_red —— P2-A（T5a / T6 / T7 / T12）Red 原始输出索引

- 报告：`tester/test/041_dcap_p2a_t5a_t6_t7_t12_red_execution.md`
- 设计：`tester/design/013_dcap_p2a_t5a_t6_t7_t12_red_design.md`
- 时间：2026-09-13 15:36–15:44 CST / 07:36–07:44Z；HEAD `8745fd52de446efc597e37dcd23cc74c27273dcd`

| 文件 | 命令 | 结果 |
|---|---|---|
| `01_dcap_plugin_init.txt` | `cargo test -p strategy-runtime --test dcap_plugin_init -- --nocapture` | 2 passed / 3 failed（exit 101） |
| `02_dcap_plugin_replay.txt` | `cargo test -p strategy-runtime --test dcap_plugin_replay -- --nocapture` | 2 passed / 1 failed（exit 101）——含架构级证据（1 ulp） |
| `03_dcap_cross_runtime.txt` | `cargo test -p strategy-runtime --test dcap_cross_runtime -- --nocapture` | 6 passed（exit 0；含新增 T5a 非单调跨运行时） |
| `04_strategy_core_reference.txt` | `cargo test -p strategy-core --lib reference::` | 1 passed / 2 failed（exit 101） |
| `05_application_seed.txt` | `cargo test -p application --test strategy seed_reference` | 0 passed / 1 failed（exit 101） |
| `06_web_t5a_t6.txt` | `cd web && npx vitest run src/features/indicators/dcapNormalize.test.ts src/features/indicators/dcapInsufficient.test.ts` | 5 passed / 4 failed（2 files / 9 tests，exit 1） |
| `07_strategy_runtime_full_no_fail_fast.txt` | `cargo test -p strategy-runtime --no-fail-fast` | 既有套件全绿；仅新增 3+1 红 |
| `08_web_full.txt` | `cd web && npx vitest run` | 52 files / 514 tests：510 passed / 4 failed（exit 1） |
| `09_strategy_core_full.txt` | `cargo test -p strategy-core --no-fail-fast` | 仅 T12 两例红（exit 101） |
| `10_application_full.txt` | `cargo test -p application --no-fail-fast` | 仅 T12 一例红（exit 101） |
| `11_git_status.txt` | `git status --short` | 仅 2 个已跟踪测试文件被修改；无 staged |
