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
RUN npm run build

FROM rust:1-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
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
