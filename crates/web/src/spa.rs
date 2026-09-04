// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/web/src/spa.rs>>[init]
//! SPA 静态托管：dist 存在即服务并回退 index.html（history 路由深链）；dist 缺失 → 503 占位。
//! 不引 tower-http（零新增依赖，ADR-017 最小攻击面同口径）。

use axum::{
    body::Body,
    extract::State,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    Json,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::state::AppState;

/// 未知路径兜底：/api/* → 404 JSON（D6：API 路径不回退 index.html，§1.3）；
/// 其余 → 静态文件 → SPA index.html → 503 占位。
pub async fn spa_fallback(State(st): State<Arc<AppState>>, uri: Uri) -> Response {
    if uri.path().starts_with("/api/") {
        return (StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "not found" }))).into_response();
    }
    serve_path(&st.static_dir, uri.path()).await
}

async fn serve_path(dir: &Path, req_path: &str) -> Response {
    match sanitize(req_path) {
        None => (StatusCode::BAD_REQUEST, "bad path").into_response(),
        Some(rel) => {
            let candidate = dir.join(&rel);
            if candidate.is_file() { return file_response(&candidate).await; }
            let index = dir.join("index.html");
            if index.is_file() { return file_response(&index).await; }
            (StatusCode::SERVICE_UNAVAILABLE,
             "SPA 未构建：web/dist 缺失（前端 Wave 1 Phase B 产出）").into_response()
        }
    }
}

/// 防目录穿越：拒绝 .. / 反斜杠 / 空段；空路径 → index.html。
pub fn sanitize(path: &str) -> Option<PathBuf> {
    let p = path.trim_start_matches('/');
    if p.is_empty() { return Some(PathBuf::from("index.html")); }
    let mut out = PathBuf::new();
    for seg in p.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains('\\') { return None; }
        out.push(seg);
    }
    Some(out)
}

pub fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") | Some("map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn file_response(path: &Path) -> Response {
    match tokio::fs::read(path).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, mime_of(path))], Body::from(bytes)).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_traversal() {
        assert!(sanitize("../etc/passwd").is_none());
        assert!(sanitize("/../../x").is_none());
        assert!(sanitize("assets/..\\evil").is_none());
        assert!(sanitize("a//b").is_none(), "空段拒绝（防规范化歧义）");
    }

    #[test]
    fn sanitize_normalizes() {
        assert_eq!(sanitize("/"), Some(PathBuf::from("index.html")));
        assert_eq!(sanitize("/assets/app.js"), Some(PathBuf::from("assets/app.js")));
    }

    #[test]
    fn mime_mapping() {
        assert_eq!(mime_of(Path::new("a.html")), "text/html; charset=utf-8");
        assert_eq!(mime_of(Path::new("a.js")), "text/javascript");
        assert_eq!(mime_of(Path::new("a.woff2")), "font/woff2");
        assert_eq!(mime_of(Path::new("a.bin")), "application/octet-stream");
    }
}
// ~/~ end
