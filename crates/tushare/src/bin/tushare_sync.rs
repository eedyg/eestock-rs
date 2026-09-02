// ~/~ begin <<design/04-storage/02-tushare-sync.md#crates/tushare/src/bin/tushare_sync.rs>>[init]
//! tushare_sync —— ETF 1m 全历史首拉（断点续传）。
//! 用法：DATABASE_URL=... TUSHARE_TOKEN=... tushare_sync [--only 518880,159776] [--interval-ms 1000]

use chrono::{Datelike, Local, NaiveDate};
use domain::provider::ProviderError;
use domain::types::*;
use sqlx::PgPool;
use storage::accurate::{get_checkpoint, set_checkpoint, AccurateWriter};
use tushare::client::{to_ts_code, TushareClient, WINDOW_DAYS_1MIN};
use tushare::sync::{full_history_start, plan_windows, resume_from, CORE_CODES};
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info".into())).init();

    let db_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    let token = std::env::var("TUSHARE_TOKEN").expect("TUSHARE_TOKEN required");
    let args: Vec<String> = std::env::args().collect();
    let only = arg_vals(&args, "--only");
    let interval_ms: i64 = arg_vals(&args, "--interval-ms")
        .and_then(|s| s.parse().ok()).unwrap_or(1000);

    let pool = PgPool::connect(&db_url).await?;
    let client = TushareClient::with_config(
        token, tushare::client::API_URL.into(),
        chrono::Duration::milliseconds(interval_ms));
    let writer = AccurateWriter::new(pool.clone());

    // 标序：核心 4 只优先 → 其余代码序
    let mut codes: Vec<String> = match only {
        Some(csv) => csv.split(',').map(|s| s.trim().to_string()).collect(),
        None => sqlx::query_scalar("SELECT code FROM symbols WHERE enabled ORDER BY code")
            .fetch_all(&pool).await?,
    };
    codes.sort_by_key(|c| (CORE_CODES.contains(&c.as_str()) as u8 ^ 1, c.clone()));

    let today = Local::now().date_naive();
    let mut done = 0usize;
    for code in &codes {
        info!(code, "=== sync start ===");
        match sync_one(&client, &writer, &pool, code, today).await {
            Ok(n) => { done += 1; info!(code, bars = n, "=== sync done ==="); }
            Err(ProviderError::RateLimited) => {
                error!(code, "quota/rate limited —— checkpoint 已落库，退出待续传");
                std::process::exit(2);
            }
            Err(e) => { warn!(code, error = %e, "sync failed, skip to next"); }
        }
    }
    info!(done, total = codes.len(), "all done");
    Ok(())
}

/// 单标的 1m 全历史：首年探测（仅无 checkpoint 时）→ 30 天窗口步进 → 逐窗口落库 + checkpoint。
async fn sync_one(client: &TushareClient, writer: &AccurateWriter, pool: &PgPool,
                  code: &str, today: NaiveDate) -> Result<usize, ProviderError> {
    let cp = get_checkpoint(pool, code, "M1").await
        .map_err(|e| ProviderError::Http(e.to_string()))?;
    let start = match cp {
        Some(_) => resume_from(cp),
        None => match first_data_year(client, code).await? {
            Some(y) => NaiveDate::from_ymd_opt(y, 1, 1).unwrap(),
            None => {
                set_checkpoint(pool, code, "M1", today).await
                    .map_err(|e| ProviderError::Http(e.to_string()))?;
                info!(code, "no data since {}; mark done", full_history_start());
                return Ok(0);
            }
        },
    };
    if start > today { info!(code, "up to date"); return Ok(0); }

    let ts_code = to_ts_code(&Code(code.to_string()))?;
    let mut total = 0usize;
    for (ws, we) in plan_windows(start, today, WINDOW_DAYS_1MIN) {
        let s = ws.and_hms_opt(9, 0, 0).unwrap();
        let e = we.and_hms_opt(15, 0, 0).unwrap();
        // 窗口内满批续传（罕见：30d×241≈7230<8000，防御性保留）
        let mut cursor = s;
        loop {
            let bars = client.fetch_window(&ts_code, "1min", cursor, e).await?;
            let n = bars.len();
            if n > 0 {
                let last_cst = bars[n - 1].ts.with_timezone(&tushare::parse::cst()).naive_local();
                writer.upsert_batch(&bars).await
                    .map_err(|e2| ProviderError::Http(e2.to_string()))?;
                total += n;
                if n >= tushare::client::MAX_ROWS_PER_BATCH && last_cst < e {
                    cursor = last_cst + chrono::Duration::minutes(1);
                    continue;
                }
            }
            break;
        }
        set_checkpoint(pool, code, "M1", we).await
            .map_err(|e2| ProviderError::Http(e2.to_string()))?;
        info!(code, window = %format!("{ws}..{we}"), total, "window synced");
    }
    Ok(total)
}

/// 首年探测：2012 起逐年单窗口，首次非空即停（每次 1 调用，最多 ~15 次）。
async fn first_data_year(client: &TushareClient, code: &str) -> Result<Option<i32>, ProviderError> {
    let ts_code = to_ts_code(&Code(code.to_string()))?;
    let this_year = Local::now().year();
    for y in full_history_start().year()..=this_year {
        let s = NaiveDate::from_ymd_opt(y, 1, 1).unwrap().and_hms_opt(9, 0, 0).unwrap();
        let e = NaiveDate::from_ymd_opt(y, 12, 31).unwrap().and_hms_opt(15, 0, 0).unwrap();
        let bars = client.fetch_window(&ts_code, "1min", s, e).await?;
        if let Some(first) = bars.last() {
            let fy = first.ts.with_timezone(&tushare::parse::cst()).year();
            info!(code, first_year = fy, "first data year found");
            return Ok(Some(fy));
        }
    }
    Ok(None)
}

fn arg_vals(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1)).cloned()
}
// ~/~ end
