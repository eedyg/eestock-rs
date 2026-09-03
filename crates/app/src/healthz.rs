// ~/~ begin <<design/03-collector/02-data-plane.md#crates/app/src/healthz.rs>>[init]
//! /healthz 只读存活探测（ADR-017：数据面唯一端口；无 web 框架，最小攻击面）。

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 服务循环：GET /healthz → 200 {"status":"ok"}；其余 → 404。
pub async fn serve(listener: TcpListener) -> anyhow::Result<()> {
    loop {
        let (mut sock, peer) = listener.accept().await?;
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            let n = match sock.read(&mut buf).await {
                Ok(n) => n,
                Err(e) => { tracing::debug!(%peer, error = %e, "healthz read"); return; }
            };
            let req = String::from_utf8_lossy(&buf[..n]);
            let (status, body) = if req.starts_with("GET /healthz") {
                ("200 OK", r#"{"status":"ok"}"#)
            } else {
                ("404 Not Found", r#"{"error":"not found"}"#)
            };
            let resp = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\n\
                 content-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            let _ = sock.write_all(resp.as_bytes()).await;
        });
    }
}

/// 容器 healthcheck（运行时镜像无 curl/wget）：TCP 直连校验 200。同步实现，供 --self-check。
pub fn self_check(port: u16) -> bool {
    use std::io::{Read, Write};
    let Ok(mut s) = std::net::TcpStream::connect(("127.0.0.1", port)) else { return false };
    s.set_read_timeout(Some(std::time::Duration::from_secs(2))).ok();
    s.set_write_timeout(Some(std::time::Duration::from_secs(2))).ok();
    if s.write_all(b"GET /healthz HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    buf.starts_with(b"HTTP/1.1 200")
}
// ~/~ end
