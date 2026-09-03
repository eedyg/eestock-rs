# ~/~ begin <<design/03-collector/02-data-plane.md#Dockerfile>>[init]
# Dockerfile — 数据面镜像（由 design/03-collector/02-data-plane.md tangle 生成，禁止手改）
# 多阶段：builder 编译 eestock-data；运行时 debian-slim 非 root 运行（ADR-017 最小攻击面）
FROM rust:1-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
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
