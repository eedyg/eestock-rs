-- ~/~ begin <<design/04-storage/schema.md#migrations/0025_symbol_type_fee_profiles.sql>>[init]
-- 0025_symbol_type_fee_profiles.sql — 由 design/04-storage/schema.md tangle 生成，禁止手改
-- ADR-019（D11）标的类型元数据 + 按类型推断的费率档案：架构裁决 2026-09-12。
-- ① symbols.type（D11-1）：可空 text 枚举；NULL=未知，**刻意不设 NOT NULL 默认值**（裁决 A2：
--    任何具体类型默认都会静默错判另一类标的）；CHECK 限 D11-1 枚举（含 D11-6 保留位）。
-- ② fee_profiles（D11-2）：按 type 主键；单位=百分数（0.025=万2.5 / 0.00341=0.0341‰），
--    与 backtest::FeeModel 同口径；note/source 逐行记口径与来源；bond_etf/money_etf/index
--    保留位本批不播种（D11-6）；不设 symbols.type→fee_profiles.type 外键（缺档案 → 回退旧默认）。
-- ③ 44 只既有标的逐码回填（D11-4 显式清单，架构师 2026-09-12 复核批准 42 etf / 2 lof / 0 stock；
--    依据见 coder/report/147_d11_classification_review.md，无启发式）。
-- 幂等：ADD COLUMN IF NOT EXISTS / 约束 DO 块判存在 / CREATE TABLE IF NOT EXISTS /
--       回填仅填 NULL（不覆盖运营侧人工值）/ 播种 ON CONFLICT DO NOTHING。
-- 应用：psql -f migrations/0025_symbol_type_fee_profiles.sql（重复执行 NOTICE 正常，安全）。
-- 注意：全新库 initdb 阶段 symbols 为空 → 回填 0 行；新标的的 type 经 POST/PATCH /api/symbols 写入。
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS type text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'symbols_type_check') THEN
        ALTER TABLE symbols ADD CONSTRAINT symbols_type_check
            CHECK (type IS NULL OR type IN ('etf','lof','stock','bond_etf','money_etf','index'));
    END IF;
END $$;

-- D11-4：逐码回填（显式清单；仅填 NULL → 重复执行安全、不覆盖人工维护值）
UPDATE symbols s SET type = v.type
FROM (VALUES
    ('159337','etf'),
    ('159577','etf'),
    ('159638','etf'),
    ('159740','etf'),
    ('159742','etf'),
    ('159776','etf'),
    ('159781','etf'),
    ('159825','etf'),
    ('159842','etf'),
    ('159869','etf'),
    ('159870','etf'),
    ('159890','etf'),
    ('159980','etf'),
    ('159981','etf'),
    ('159985','etf'),
    ('160723','lof'),
    ('161226','lof'),
    ('510050','etf'),
    ('510880','etf'),
    ('511130','etf'),
    ('511220','etf'),
    ('511360','etf'),
    ('511380','etf'),
    ('512200','etf'),
    ('512480','etf'),
    ('512670','etf'),
    ('512690','etf'),
    ('512800','etf'),
    ('513050','etf'),
    ('513310','etf'),
    ('513690','etf'),
    ('513750','etf'),
    ('513920','etf'),
    ('513970','etf'),
    ('515070','etf'),
    ('515710','etf'),
    ('515790','etf'),
    ('516380','etf'),
    ('518880','etf'),
    ('551000','etf'),
    ('561910','etf'),
    ('562500','etf'),
    ('562800','etf'),
    ('588000','etf')
) AS v(code, type)
WHERE s.code = v.code AND s.type IS NULL;

-- D11-2：费率档案表（口径见 note/source 列）
CREATE TABLE IF NOT EXISTS fee_profiles (
    type                text PRIMARY KEY
                        CHECK (type IN ('etf','lof','stock','bond_etf','money_etf','index')),
    commission_rate_pct double precision NOT NULL CHECK (commission_rate_pct >= 0),  -- 佣金%（全佣：已含规费）
    min_fee             double precision NOT NULL CHECK (min_fee >= 0),              -- 单笔最低佣金（元）
    exchange_fee_pct    double precision NOT NULL CHECK (exchange_fee_pct >= 0),     -- 交易经手费%（双边）
    regulatory_fee_pct  double precision NOT NULL CHECK (regulatory_fee_pct >= 0),   -- 证管费/监管费%（双边）
    stamp_duty_pct      double precision NOT NULL CHECK (stamp_duty_pct >= 0),       -- 印花税%（仅卖出）
    transfer_fee_pct    double precision NOT NULL CHECK (transfer_fee_pct >= 0),     -- 过户费%（双边）
    note                text NOT NULL DEFAULT '',   -- 口径说明（D11-2 要求：每行须说明口径）
    source              text NOT NULL DEFAULT '',   -- 来源（ADR-019 §5）
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- D11-2 播种（ADR-019 §1 事实；ON CONFLICT DO NOTHING → 重复执行安全、不覆盖运营侧调参）
INSERT INTO fee_profiles (type, commission_rate_pct, min_fee, exchange_fee_pct,
                          regulatory_fee_pct, stamp_duty_pct, transfer_fee_pct, note, source) VALUES
    ('etf',   0.025, 5.0, 0,       0,     0,    0,     '场内基金二级市场买卖（ADR-019 §1.1）：印花税不征（《印花税法》第三条列举式封闭定义仅含股票/存托凭证）→0；过户费免收（中国结算：ETF/LOF 二级市场买卖免收）→0；经手费事实值 0.04‰（深交所 2026-01，基金双边）按平台全佣口径已含于佣金→列 0（不得叠加，否则重复计费）；证管费交易所收费表仅列 A股/B股/优先股（基金未列）→0；佣金万2.5 双向、单笔最低 5 元（券商公示）', 'ADR-019 §1.1/§5：《印花税法》第三条；深交所收费及代收税费标准（2026-01）；中国结算代收税费一览表；券商费用公示（全佣口径）'),
    ('lof',   0.025, 5.0, 0,       0,     0,    0,     '场内基金二级市场买卖（ADR-019 §1.1）：印花税不征（《印花税法》第三条列举式封闭定义仅含股票/存托凭证）→0；过户费免收（中国结算：ETF/LOF 二级市场买卖免收）→0；经手费事实值 0.04‰（深交所 2026-01，基金双边）按平台全佣口径已含于佣金→列 0（不得叠加，否则重复计费）；证管费交易所收费表仅列 A股/B股/优先股（基金未列）→0；佣金万2.5 双向、单笔最低 5 元（券商公示）；LOF 与 ETF 同为场内基金口径、费率事实相同，独立成行仅为审计可读（D11-2 架构裁决：不接受隐式回退）', 'ADR-019 §1.1/§5（同 ETF 口径）：《印花税法》第三条；深交所收费及代收税费标准（2026-01）；中国结算代收税费一览表；券商费用公示（全佣口径）'),
    ('stock', 0.025, 5.0, 0.00341, 0.002, 0.05, 0.001, 'A股股票（ADR-019 §1.2）：印花税卖出单边 0.5‰（2023-08-28 减半，财税2023年39号公告）→0.05；过户费 0.01‰ 双边（中国结算，沪深北统一）→0.001；经手费 0.0341‰ 双边（深交所 2026-01；2023-08-28 由 0.0487‰ 下调）→0.00341；证管费 0.02‰ 双边→0.002；佣金万2.5 双向、最低 5 元。⚠️ 经手费/证管费/过户费为事实/口径列：本批引擎（FeeModel 4 参数）未建模（D11-follow-up 债务）', 'ADR-019 §1.2/§5：财税2023年39号公告；深交所收费及代收税费标准（2026-01）；中国结算代收税费一览表；券商费用公示（全佣口径）')
ON CONFLICT (type) DO NOTHING;
-- ~/~ end
