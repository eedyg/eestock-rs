// ~/~ begin <<design/03-collector/02-data-plane.md#crates/app/tests/config_healthz.rs>>[init]
//! 配置解析与 healthz 行为测试。

use app::{config, healthz};

#[test]
fn config_parse_and_defaults() {
    let dir = std::env::temp_dir().join(format!("eestock-cfg-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("data.toml");
    std::fs::write(&p, r#"
database_url = "postgres://u:p@db:5432/eestock"
"#).unwrap();
    // env 覆盖测试与解析测试同进程：先暂存并清除真实 env（开发机可能 export 了 TUSHARE_TOKEN）
    let saved_db = std::env::var("DATABASE_URL").ok();
    let saved_tk = std::env::var("TUSHARE_TOKEN").ok();
    std::env::remove_var("DATABASE_URL");
    std::env::remove_var("TUSHARE_TOKEN");
    let cfg = config::load(p.to_str().unwrap()).unwrap();
    assert_eq!(cfg.database_url, "postgres://u:p@db:5432/eestock");
    assert!(cfg.tushare_enabled, "默认开启");
    assert_eq!(cfg.healthz_port, 8080);
    assert_eq!(cfg.tushare_interval_ms, 1000);
    assert!(cfg.tushare_token.is_none());
    // env 覆盖（secret 注入口径）
    std::env::set_var("DATABASE_URL", "postgres://override@h/db");
    std::env::set_var("TUSHARE_TOKEN", "tok123");
    let cfg2 = config::load(p.to_str().unwrap()).unwrap();
    assert_eq!(cfg2.database_url, "postgres://override@h/db");
    assert_eq!(cfg2.tushare_token.as_deref(), Some("tok123"));
    // 恢复真实 env
    match saved_db { Some(v) => std::env::set_var("DATABASE_URL", v), None => std::env::remove_var("DATABASE_URL") }
    match saved_tk { Some(v) => std::env::set_var("TUSHARE_TOKEN", v), None => std::env::remove_var("TUSHARE_TOKEN") }
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn healthz_serves_200_and_404() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(healthz::serve(listener));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    // self_check 为同步阻塞调用：spawn_blocking 避免饿死 current_thread runtime 上的 server 任务
    let ok = tokio::task::spawn_blocking(move || healthz::self_check(port)).await.unwrap();
    assert!(ok, "GET /healthz → 200");
    // 404 路径（同样走 blocking）
    let not_found = tokio::task::spawn_blocking(move || {
        use std::io::{Read, Write};
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(b"GET /admin HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n").unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).unwrap();
        buf.starts_with(b"HTTP/1.1 404")
    }).await.unwrap();
    assert!(not_found, "无管理端点（ADR-017 最小攻击面）");
}

#[test]
fn self_check_false_when_down() {
    // 未监听端口 → false（compose healthcheck 失败语义）
    assert!(!healthz::self_check(59999));
}
// ~/~ end
