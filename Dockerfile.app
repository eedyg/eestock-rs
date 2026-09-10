# ~/~ begin <<design/07-app-plane/00-web-api.md#Dockerfile.app>>[init]
# Dockerfile.app — 应用面镜像（由 design/07-app-plane/00-web-api.md tangle 生成，禁止手改）
# 多阶段自包含（Phase A 审查返工）：frontend(node:22 构建 web/dist) → builder(rust) → runtime(非 root)
# dist 由镜像内构建产出，不依赖构建上下文预存（前端 dist 产物不入库，web/.gitignore 已含 dist/）
FROM node:22-bookworm-slim AS frontend
WORKDIR /web
# 锁文件先行：依赖层缓存（npm ci 严格按 lock 安装）
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# 清空历史构建产物：vite build 默认 emptyOutDir，但 COPY 的本地 web/dist 可能遗留旧哈希 bundle，
# 导致 /app/dist 出现多个历史 index-*.js（旧镜像产物残留）。删净避免旧 bundle 被侥幸 COPY 到运行时。
RUN rm -rf dist
# 生产镜像直连真后端（09-frontend §4：mock 开关默认仅开发态；缺省构建会静默出 mock 数据）
RUN VITE_API_MOCK=0 npm run build

FROM rust:1-bookworm AS builder
WORKDIR /build
# 依赖缓存分层：先 COPY 锁文件与 15 个 crate 的清单（层键=清单内容），cargo fetch 仅下载依赖、不碰源码；
# 清单不变 → 本层及 fetch 层命中 Docker 缓存，源码变更只触发 COPY crates 与 cargo build 重编（依赖已 fetch）。
COPY Cargo.toml Cargo.lock ./
COPY crates/alert/Cargo.toml crates/alert/Cargo.toml
COPY crates/app/Cargo.toml crates/app/Cargo.toml
COPY crates/application/Cargo.toml crates/application/Cargo.toml
COPY crates/backtest/Cargo.toml crates/backtest/Cargo.toml
COPY crates/collector/Cargo.toml crates/collector/Cargo.toml
COPY crates/diagnose/Cargo.toml crates/diagnose/Cargo.toml
COPY crates/domain/Cargo.toml crates/domain/Cargo.toml
COPY crates/mcp/Cargo.toml crates/mcp/Cargo.toml
COPY crates/simlive/Cargo.toml crates/simlive/Cargo.toml
COPY crates/providers/Cargo.toml crates/providers/Cargo.toml
COPY crates/storage/Cargo.toml crates/storage/Cargo.toml
COPY crates/strategy-core/Cargo.toml crates/strategy-core/Cargo.toml
COPY crates/strategy-runtime/Cargo.toml crates/strategy-runtime/Cargo.toml
COPY crates/tushare/Cargo.toml crates/tushare/Cargo.toml
COPY crates/web/Cargo.toml crates/web/Cargo.toml
# workspace 特例：crates/* 无显式 [lib]/[[bin]]，cargo 自动发现目标需 src。故先补空 src/lib.rs 使
# 每个 crate 可加载解析依赖图；随后 COPY crates ./crates 以真实源码覆盖（各 crate 均含真实 lib.rs，零残留）。
RUN for c in alert app application backtest collector diagnose domain mcp providers storage strategy-core strategy-runtime tushare web simlive; do mkdir -p "crates/$c/src"; : > "crates/$c/src/lib.rs"; done
RUN cargo fetch
COPY crates ./crates
RUN cargo build --release --bin eestock-app

FROM debian:bookworm-slim
RUN useradd --system --uid 10002 --no-create-home eestock
COPY --from=builder /build/target/release/eestock-app /usr/local/bin/eestock-app
# SPA 静态资源来自 frontend 阶段构建产物
COPY --from=frontend /web/dist /app/dist
USER eestock
EXPOSE 8081 8082
ENTRYPOINT ["/usr/local/bin/eestock-app"]
CMD ["--config", "/etc/eestock/app.toml"]
# ~/~ end
