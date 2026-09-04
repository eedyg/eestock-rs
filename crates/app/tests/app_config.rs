// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/app/tests/app_config.rs>>[init]
//! 应用面配置解析测试（TOML 默认值 + env 覆盖）。

use app::app_config;

#[test]
fn parse_minimal_uses_defaults_and_env_overrides() {
    let dir = std::env::temp_dir().join(format!("eestock-app-cfg-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("app.toml");
    std::fs::write(&p, "database_url = \"postgres://u:p@db:5432/eestock\"\n").unwrap();
    // env 覆盖测试与解析测试同进程：先暂存并清除真实 env
    let saved_db = std::env::var("DATABASE_URL").ok();
    let saved_listen = std::env::var("APP_LISTEN").ok();
    let saved_mcp = std::env::var("MCP_LISTEN").ok();
    std::env::remove_var("DATABASE_URL");
    std::env::remove_var("APP_LISTEN");
    std::env::remove_var("MCP_LISTEN");

    let cfg = app_config::load(p.to_str().unwrap()).unwrap();
    assert_eq!(cfg.database_url, "postgres://u:p@db:5432/eestock");
    assert_eq!(cfg.listen, "0.0.0.0:8081");
    assert_eq!(cfg.static_dir, "./web/dist");
    assert_eq!(cfg.health_window_secs, 3600);
    assert_eq!(cfg.ws_poll_ms, 3000);
    assert_eq!(cfg.mcp_listen, "0.0.0.0:8082", "Phase D：MCP 缺省端口 8082（独立端口）");
    assert_eq!(cfg.alert_eval_ms, 60_000, "Wave 2 Phase B：告警评估节拍默认 1min");

    // env 覆盖（容器 secret/地址注入口径）
    std::env::set_var("DATABASE_URL", "postgres://override@h/db");
    std::env::set_var("APP_LISTEN", "127.0.0.1:9999");
    std::env::set_var("MCP_LISTEN", "127.0.0.1:9998");
    let cfg2 = app_config::load(p.to_str().unwrap()).unwrap();
    assert_eq!(cfg2.database_url, "postgres://override@h/db");
    assert_eq!(cfg2.listen, "127.0.0.1:9999");
    assert_eq!(cfg2.mcp_listen, "127.0.0.1:9998", "MCP_LISTEN env 覆盖");

    match saved_db { Some(v) => std::env::set_var("DATABASE_URL", v), None => std::env::remove_var("DATABASE_URL") }
    match saved_listen { Some(v) => std::env::set_var("APP_LISTEN", v), None => std::env::remove_var("APP_LISTEN") }
    match saved_mcp { Some(v) => std::env::set_var("MCP_LISTEN", v), None => std::env::remove_var("MCP_LISTEN") }
    std::fs::remove_dir_all(&dir).ok();
}
// ~/~ end
