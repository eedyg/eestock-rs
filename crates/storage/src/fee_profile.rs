//! 费率档案只读端口实现（ADR-019 / D11-2/D11-3；`fee_profiles` 表 + `symbols.type`，迁移 0025）。
//! 非 tangle 手写（模块注册见 design/04-storage/02-tushare-sync.md，契约见 design/04-storage/schema.md §4.3.16）。
//!
//! 解析语义（fail-soft）：code 未注册 / `symbols.type IS NULL` / 该 type 无档案行 → `Ok(None)`，
//! 由 application 层回退旧 ADR bt-1 默认（`source="default"`），**不静默借用他类型档案**。

use anyhow::Result;
use async_trait::async_trait;
use domain::ports::{FeeProfileRow, FeeProfileStore};
use sqlx::PgPool;

/// 费率档案读（`symbols.type` JOIN `fee_profiles`）。
pub struct PgFeeProfileStore {
    pool: PgPool,
}

impl PgFeeProfileStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl FeeProfileStore for PgFeeProfileStore {
    /// `SELECT p.* FROM symbols s JOIN fee_profiles p ON p.type = s.type WHERE s.code = $1`；
    /// 查不到（未注册 / type NULL / 无档案行）→ `Ok(None)`。
    async fn for_symbol(&self, code: &str) -> Result<Option<FeeProfileRow>> {
        type Row = (String, f64, f64, f64, f64, f64, f64, String, String);
        let row: Option<Row> = sqlx::query_as(
            "SELECT p.type, p.commission_rate_pct, p.min_fee, p.exchange_fee_pct, \
                    p.regulatory_fee_pct, p.stamp_duty_pct, p.transfer_fee_pct, p.note, p.source \
             FROM symbols s JOIN fee_profiles p ON p.type = s.type \
             WHERE s.code = $1",
        )
        .bind(code)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(
            |(type_, commission_rate_pct, min_fee, exchange_fee_pct, regulatory_fee_pct,
              stamp_duty_pct, transfer_fee_pct, note, source)| FeeProfileRow {
                type_,
                commission_rate_pct,
                min_fee,
                exchange_fee_pct,
                regulatory_fee_pct,
                stamp_duty_pct,
                transfer_fee_pct,
                note,
                source,
            },
        ))
    }
}
