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

/// 未知路径兜底：任何 /api 前缀（含裸 /api）→ 404 JSON（D6：API 路径不回退 index.html，§1.3）；
/// 其余 → 静态文件 → SPA index.html → 503 占位。
pub async fn spa_fallback(State(st): State<Arc<AppState>>, uri: Uri) -> Response {
    if uri.path().starts_with("/api") {
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
            if candidate.is_file() {
                return file_response(&candidate, rel.to_str().unwrap_or("index.html")).await;
            }
            let index = dir.join("index.html");
            if index.is_file() { return file_response(&index, "index.html").await; }
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

async fn file_response(path: &Path, cache_key: &str) -> Response {
    let cache = cache_control_for(cache_key);
    match tokio::fs::read(path).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, mime_of(path)),
                (header::CACHE_CONTROL, cache),
            ],
            Body::from(bytes),
        ).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// 相对 static_dir 路径的 Cache-Control 策略（§1.3 缓存头策略）：
/// 哈希静态资产（`assets/<name>-<hash>.<ext>`）→ 长期不可变缓存；其余（含 index.html）→ no-store。
fn cache_control_for(rel: &str) -> &'static str {
    if is_hashed_asset(rel) {
        "public, max-age=31536000, immutable"
    } else {
        "no-store"
    }
}

/// 判定是否为 Vite 内容寻址哈希资产：路径位于 `assets/` 前缀，且 basename 去扩展名后
/// 形如 `<name>-<hash>`，其中 `<hash>` 为第一个 `-` 之后的部分，长度 >= 8 且均为
/// [A-Za-z0-9_-]（Vite 默认 8+ 位 url-safe hash，可能自带 `-`/`_`，如 index-D4J30-jW.css）。
/// 保守：不满足一律视为非哈希（no-store）。
fn is_hashed_asset(rel: &str) -> bool {
    let p = rel.trim_start_matches('/');
    if !p.starts_with("assets/") { return false; }
    let basename = p.rsplit('/').next().unwrap_or(p);
    let stem = basename.rsplit_once('.').map(|(s, _)| s).unwrap_or(basename);
    match stem.split_once('-') {
        Some((_, hash)) => {
            hash.len() >= 8 && hash.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        }
        None => false,
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

    #[test]
    fn cache_control_index_html_is_no_store() {
        assert_eq!(cache_control_for("index.html"), "no-store");
        assert_eq!(cache_control_for("/"), "no-store");
        assert_eq!(cache_control_for(""), "no-store");
    }

    #[test]
    fn cache_control_non_hashed_static_is_no_store() {
        assert_eq!(cache_control_for("favicon.ico"), "no-store");
        assert_eq!(cache_control_for("assets/vite.svg"), "no-store");
        assert_eq!(cache_control_for("assets/index.js"), "no-store");
        assert_eq!(cache_control_for("assets/foo-123.js"), "no-store");
    }

    #[test]
    fn cache_control_hashed_assets_is_immutable() {
        assert_eq!(
            cache_control_for("assets/index-D3fG4fH1.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            cache_control_for("assets/index-AbCdEf12.css"),
            "public, max-age=31536000, immutable"
        );
    }

    #[test]
    fn is_hashed_asset_detection() {
        assert!(is_hashed_asset("assets/index-12345678.js"));
        assert!(is_hashed_asset("assets/logo-AbCdEfGh.svg"));
        // Vite url-safe hash 可含 '-'（真实样例 index-D4J30-jW.css）：首 '-' 后整段即 hash
        assert!(is_hashed_asset("assets/index-D4J30-jW.css"));
        assert!(!is_hashed_asset("assets/index.js"));
        assert!(!is_hashed_asset("index.html"));
        assert!(!is_hashed_asset("assets/foo-123.js"));
    }
}
// ~/~ end
