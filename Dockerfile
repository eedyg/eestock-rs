# ~/~ begin <<design/03-collector/02-data-plane.md#Dockerfile>>[init]
# Dockerfile — 数据面镜像（由 design/03-collector/02-data-plane.md tangle 生成，禁止手改）
# 多阶段：builder 编译 eestock-data；运行时 debian-slim 非 root 运行（ADR-017 最小攻击面）
FROM rust:1-bookworm AS builder
WORKDIR /build
# 依赖缓存分层：先 COPY 锁文件与 12 个 crate 的清单（层键=清单内容），cargo fetch 仅下载依赖、不碰源码；
# 清单不变 → 本层及 fetch 层命中 Docker 缓存，源码变更只触发 COPY crates 与 cargo build 重编（依赖已 fetch）。
COPY Cargo.toml Cargo.lock ./
COPY crates/alert/Cargo.toml crates/alert/Cargo.toml
COPY crates/app/Cargo.toml crates/app/Cargo.toml
COPY crates/collector/Cargo.toml crates/collector/Cargo.toml
COPY crates/diagnose/Cargo.toml crates/diagnose/Cargo.toml
COPY crates/domain/Cargo.toml crates/domain/Cargo.toml
COPY crates/mcp/Cargo.toml crates/mcp/Cargo.toml
COPY crates/providers/Cargo.toml crates/providers/Cargo.toml
COPY crates/storage/Cargo.toml crates/storage/Cargo.toml
COPY crates/strategy-core/Cargo.toml crates/strategy-core/Cargo.toml
COPY crates/strategy-runtime/Cargo.toml crates/strategy-runtime/Cargo.toml
COPY crates/tushare/Cargo.toml crates/tushare/Cargo.toml
COPY crates/web/Cargo.toml crates/web/Cargo.toml
# workspace 特例：crates/* 无显式 [lib]/[[bin]]，cargo 自动发现目标需 src。故先补空 src/lib.rs 使
# 每个 crate 可加载解析依赖图；随后 COPY crates ./crates 以真实源码覆盖（各 crate 均含真实 lib.rs，零残留）。
RUN for c in alert app collector diagnose domain mcp providers storage strategy-core strategy-runtime tushare web; do mkdir -p "crates/$c/src"; : > "crates/$c/src/lib.rs"; done
RUN cargo fetch
COPY crates ./crates
RUN cargo build --release --bin eestock-data

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --no-create-home eestock
COPY --from=builder /build/target/release/eestock-data /usr/local/bin/eestock-data
USER eestock
# 唯一端口：/healthz（ADR-017）
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/eestock-data"]
CMD ["--config", "/etc/eestock/data.toml"]
# ~/~ end
