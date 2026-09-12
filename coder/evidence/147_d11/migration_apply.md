# D11 执行证据（迁移 0025 应用 + 实测）

- 时间：2026-09-12（架构师批准后执行，D11-4 分类清单已复核）
- 库：postgres://eestock@127.0.0.1:5433/eestock（TimescaleDB 2.29.2-pg16）

## 1. 迁移前（before）
```
 symbols_rows 
--------------
           44
(1 row)

 fee_profiles 
--------------
 fee_profiles
(1 row)

 symbols_type_col 
------------------
                1
(1 row)

```
## 2. 应用迁移（psql -f，ON_ERROR_STOP=1）
```
ALTER TABLE
DO
UPDATE 0
psql:migrations/0025_symbol_type_fee_profiles.sql:88: NOTICE:  relation "fee_profiles" already exists, skipping
CREATE TABLE
INSERT 0 0
```
（注：上为**重复执行**输出——首次执行为 ALTER TABLE / DO / UPDATE 44 / CREATE TABLE / INSERT 0 3，见下方幂等小节）

## 3. 迁移后（after）
```
 type | count 
------+-------
 etf  |    42
 lof  |     2
(2 rows)

 type  | commission_rate_pct | min_fee | exchange_fee_pct | regulatory_fee_pct | stamp_duty_pct | transfer_fee_pct 
-------+---------------------+---------+------------------+--------------------+----------------+------------------
 etf   |               0.025 |       5 |                0 |                  0 |              0 |                0
 lof   |               0.025 |       5 |                0 |                  0 |              0 |                0
 stock |               0.025 |       5 |          0.00341 |              0.002 |           0.05 |            0.001
(3 rows)

 symbols_rows 
--------------
           44
(1 row)

```

## 4. 幂等实测（重复执行）

```
$ psql -f migrations/0025_symbol_type_fee_profiles.sql（第 2 次）
NOTICE:  column "type" of relation "symbols" already exists, skipping
ALTER TABLE
DO
UPDATE 0                       ← 回填仅填 NULL：二次执行 0 行
NOTICE:  relation "fee_profiles" already exists, skipping
CREATE TABLE
INSERT 0 0                     ← ON CONFLICT (type) DO NOTHING：不覆盖运营侧调参
```
状态不变复核：`profiles=3 / etf=42 / lof=2 / null=0 / symbols=44`（第 3、4 次执行同样 0 行变更，见
`crates/storage/tests/symbol_type_fee_migration.rs` 事务内用例）。

## 5. 既有数据完整性（迁移为纯加法）

```
$ diff symbols_before_migration.tsv symbols_after_migration.tsv   → 无差异（44 行 code/name/interval/settlement/enabled/created_at 逐字节一致）
```

## 6. 端到端实测（真实库 + 真实 K 线；`cargo test -p mcp --test d11_fee_profile_e2e -- --nocapture`）

```
[D11 实测] symbol=510050 bars=129 trades=1 | profile: fee.source=profile stamp_duty_pct=0.0
           profile.transfer_fee_pct=0.0 profile.exchange_fee_pct=0.0 profile.regulatory_fee_pct=0.0
           stamp_sum=0 pnl=-551.5901
         | explicit(旧口径): source=explicit stamp_duty_pct=0.05 stamp_sum=49.7366 pnl=-601.3267
         | Δpnl=+49.74 元（旧口径系统性多收印花税 → 修复方向与 ADR-019 背景一致：量级 3.2%）
```
