# D11 独立验收夹具（归档副本）

本目录为 tester 独立验收夹具的**归档副本**（原位于 `crates/{mcp,web}/tests/`，验收完成后移出，
以免在非探针库环境执行 `cargo test --workspace` 时误判失败——它们**要求隔离探针库**）。

## 复现步骤
1. 建探针库并应用全部迁移（生产库零写入）：
   ```
   psql "$ADMIN" -c "CREATE DATABASE eestock_d11_probe;"
   for f in migrations/*.sql; do psql -v ON_ERROR_STOP=1 "$PROBE" -f "$f"; done
   ```
2. 从生产库只读拷入 `symbols`(44) / `fee_profiles`(3) / `kline_accurate`（510050 M1 近 120 天 + 同数据复制为 999999）
   并 `CALL refresh_continuous_aggregate('kline_accurate_1d', NULL, NULL);`
3. 贴回夹具并运行：
   ```
   cp fixtures/zz_tester_013_d11_mcp.rs crates/mcp/tests/
   cp fixtures/zz_tester_013_d11_web.rs crates/web/tests/
   DATABASE_URL=postgres://eestock:eestock@127.0.0.1:5433/eestock_d11_probe \
   EV_DIR=$PWD/tester/evidence/013_d11 \
     cargo test -p mcp --test zz_tester_013_d11_mcp -- --nocapture --test-threads=1
   DATABASE_URL=postgres://eestock:eestock@127.0.0.1:5433/eestock_d11_probe \
   EV_DIR=$PWD/tester/evidence/013_d11 \
     cargo test -p web --test zz_tester_013_d11_web -- --nocapture --test-threads=1
   ```
4. 清理探针库：`psql "$ADMIN" -c "DROP DATABASE eestock_d11_probe;"`
