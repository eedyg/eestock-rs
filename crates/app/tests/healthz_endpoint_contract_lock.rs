//! **健康端点契约锁定（数据面 `eestock-data`）** —— 手写（非 tangle）；无 DB、无网络依赖（手写最小 HTTP，纯 TCP）。
//!
//! 背景（本批项 1 依赖盘点 + ADR-029 §5 R27 登记）：外部/通用探活脚本惯用 `GET /api/health`；
//! 本项目**不存在**该端点（实测 `GET /api/health` → **404**），健康端点**只有** `/healthz`
//! （应用面 `:8081` axum 路由 + 数据面 `:8080` 手写最小 HTTP，两处**同路径**）。
//! 全仓依赖盘点（Rust 代码 / `docker-compose.yml` / `Dockerfile*` / `scripts/deploy.sh` / `web/` 前端 /
//! `crates/mcp` MCP / 迁移 / 配置）为**零依赖** ⇒ 裁决：**不设 `/api/health` 别名**。
//! 理由（写进 `design/16-backtest-scalability/05-deploy-runbook.md` C1 + `design/07-app-plane/00-web-api.md` §1.1）：
//! ①别名会让「探活 200」不再等价于本项目声明的存活契约（ADR-017：数据面**除 `/healthz` 外不开放任何管理端口**，
//! 加别名等于给数据面新增 API 面）；②把 404 改 200 属语义漂移，且**没有**任何消费方需要它。
//!
//! 本文件把该结论**钉死**（任一被违反 ⇒ 红）：
//!  1. `GET /healthz` → `200 OK` + 响应体**逐字节** `{"status":"ok"}` + `content-type: application/json`；
//!  2. `GET /api/health` → **404**（禁出现别名；含 `self_check` 的 200 前提不变）。

use std::io::{Read, Write};
use std::time::Duration;

/// 原始 HTTP/1.1 请求（同步 socket；与容器 healthcheck 的 `--self-check` 同法，不引 HTTP 客户端）。
fn raw_get(port: u16, path: &str) -> String {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect 127.0.0.1");
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    s.write_all(
        format!("GET {path} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").as_bytes(),
    )
    .expect("write request");
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// 响应体（首个 `\r\n\r\n` 之后；healthz 无 body 分块编码）。
fn body_of(resp: &str) -> &str {
    resp.split("\r\n\r\n").nth(1).unwrap_or("")
}

#[tokio::test]
async fn data_plane_healthz_is_200_with_exact_body_and_api_health_is_not_an_alias() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(app::healthz::serve(listener));
    tokio::time::sleep(Duration::from_millis(50)).await;

    // ① 契约本体（compose healthcheck `--self-check` 打的就是这条）
    let ok = tokio::task::spawn_blocking(move || raw_get(port, "/healthz")).await.unwrap();
    assert!(ok.starts_with("HTTP/1.1 200 OK"), "GET /healthz 必须 200：{ok:?}");
    assert_eq!(
        body_of(&ok),
        r#"{"status":"ok"}"#,
        "响应体逐字节锁定（不得增删字段；对外探活语义）"
    );
    assert!(
        ok.to_ascii_lowercase().contains("content-type: application/json"),
        "content-type 必须为 application/json：{ok:?}"
    );

    // ② 禁别名：`/api/health` 必须仍是 404（ADR-017：数据面除 /healthz 外不开放任何管理端口）
    let alias = tokio::task::spawn_blocking(move || raw_get(port, "/api/health")).await.unwrap();
    assert!(
        alias.starts_with("HTTP/1.1 404"),
        "`/api/health` 不得成为 `/healthz` 的别名（本批裁决：依赖盘点为零 ⇒ 不加别名）：{alias:?}"
    );
    assert_ne!(body_of(&alias), r#"{"status":"ok"}"#, "别名响应体不得与健康契约同形");
}
