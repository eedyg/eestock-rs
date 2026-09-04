# 022 — Docker 镜像 cargo 依赖缓存分层

> 报告文件位置：`coder/report/022_docker_cargo_cache.md`

## 结论
对 `Dockerfile`（数据面）与 `Dockerfile.app`（应用面）的 **builder 阶段**做 cargo 依赖缓存分层：
先把 `Cargo.lock` + workspace 全部 10 个 crate 的清单（`Cargo.toml`）单独 `COPY`（层键=清单内容），
`RUN cargo fetch` 仅下载依赖、不碰源码；随后才 `COPY crates ./crates` 与 `cargo build`。
清单不变 → manifest 层与 fetch 层命中 Docker 缓存；源码变更只触发 `COPY crates` 与 `cargo build` 重编，
**不重新下载依赖**。纯构建提速、零功能改动。

已验证（真实 `docker build`）：
- 数据面镜像构建成功（`eestock-data:cachetest`，rc=0，builder 内 `cargo fetch` 成功下载全量依赖）。
- **源码变更后重建**：`cargo fetch` 层显示 `Using cache`，重建日志中 `Downloading/Downloaded` 出现 **0 次** ——
  证明源码变更不触发依赖重下（仅重编）。
- 应用面镜像构建成功（`eestock-app:cachetest`，rc=0，`cargo build --release --bin eestock-app` 通过）。
- `entangled tangle` 重生成两 Dockerfile 且幂等（二次 tangle 无 diff）。
- 本地 `cargo build --release --bin eestock-data` 通过。

## What changed

| 文件 | 变更 |
|------|------|
| `design/03-collector/02-data-plane.md`（tangle 事实源） | §5 新增「依赖缓存分层」prose 注记 + 修改 `{#dockerfile file=Dockerfile}` 代码块的 builder 阶段 |
| `design/07-app-plane/00-web-api.md`（tangle 事实源） | §6 新增依赖缓存分层 prose + 修改 `{#dockerfile file=Dockerfile.app}` 代码块的 builder 阶段 |
| `Dockerfile`（tangle 生成物） | builder 阶段：`COPY Cargo.toml Cargo.lock ./` 后加 10 个 crate 清单 `COPY`、空 `src/lib.rs` 生成 `RUN`、`RUN cargo fetch`；`--bin eestock-data` 不变。**净增 16 行** |
| `Dockerfile.app`（tangle 生成物） | builder 阶段同 Dockerfile 逻辑；`--bin eestock-app` 不变。**净增 16 行** |

> 禁止手改生成文件：两 Dockerfile 均通过 `entangled tangle` 从 `design/**` 代码块重生成，未手改。

## Architecture alignment
- 变更位于 **部署/镜像层**（design 文档的 Dockerfile 代码块），不改任何 Rust 层接口、事件契约、
  模块边界或依赖方向；`--bin` 名称、EXPOSE、运行时阶段（debian-slim 非 root）均未改动。
- 属于「构建产物/容器镜像」层，ADR-007 文学式编程纪律遵守（改 design 文档 → tangle）。
- 未引入新依赖、新框架；`cargo fetch` 与 `cargo build` 均为既有 cargo 命令。

## Problem solved
现状两个 Dockerfile 的 builder 阶段把 `COPY Cargo.toml Cargo.lock + COPY crates + RUN cargo build`
放同一层，任何源码改动即整层失效 → cargo 每次重下并重编全部依赖。
改为依赖缓存分层：依赖是否重下由「清单内容」决定（稳定），源码变更不再触发依赖下载。

## Implementation approach
1. 先 COPY `Cargo.lock` 与 workspace 全部 10 个 crate 的 `Cargo.toml`（`crates/{alert,app,collector,diagnose,domain,mcp,providers,storage,tushare,web}`），
   使 cargo 能解析**完整**依赖图（缺任一 manifest 会报 `missing manifest` / glob 展开失败）。
2. `RUN cargo fetch`：仅下载依赖，落盘到 `/usr/local/cargo/registry`；清单不变则命中缓存层。
3. `COPY crates ./crates`：频变的源码，单独一层。
4. `RUN cargo build --release --bin <bin>`：只重编变更源码，依赖用 fetch 层缓存。

### workspace 特例注记（关键，超出任务预设的「missing manifest」场景）
经验证：本 workspace `members = ["crates/*"]`，且各 crate 的 `Cargo.toml` **均未声明显式
`[lib]`/`[[bin]]`**，cargo **自动发现目标需要 src 文件**。仅放清单时 `cargo fetch` 直接报：
`no targets specified in the manifest`（并非 `missing manifest`）。

因此实现上新增一步（仅 manifest 层内），为每个 crate 生成一个**空的 `src/lib.rs`**，使每个 crate
可被 cargo 加载以解析依赖图：
```dockerfile
RUN for c in alert app collector diagnose domain mcp providers storage tushare web; do mkdir -p "crates/$c/src"; : > "crates/$c/src/lib.rs"; done
```
随后 `COPY crates ./crates` 以真实源码覆盖：**各 crate 均含真实 `src/lib.rs`**（已确认全部 10 个 crate
均有 `src/lib.rs`，`app` 另有 `src/bin/eestock-app.rs`、`src/bin/eestock-data.rs`），覆盖后空文件**零残留**，
功能**零改动**。依赖闭包一致性：workspace 内无 `[features]`、无 `[target.*.dependencies]`，
同一 crate 的 `[dependencies]` 与 lib/bin 目标无关，故 fetch（stub lib）与 build（真实 lib+bin）的解析闭包一致。

> 该特例已在两 design 文档的 Dockerfile 代码块注释与 §5/§6 prose 中声明（data-plane §5 与 app-plane §6 同口径）。

## Test coverage
- 新增/变更**无业务单测**（纯 Dockerfile/构建分层，非 Rust 逻辑），因此无 Rust tests 增删。
- 验证性测试为**真实 Docker 构建**（见下），覆盖：
  - 数据面 builder `cargo fetch` 在全量依赖下成功（首建日志含 `Downloaded ...`）。
  - 源码变更后重建 `cargo fetch` 层命中缓存、0 次下载。
  - 应用面 builder `cargo fetch` + `cargo build --release --bin eestock-app` 成功。
  - `check-tangle`（staged 后）worktree==index 无 diff。
  - 本地 `cargo build --release --bin eestock-data` 通过。

## Verification（命令与结果）
1. `cargo fetch`（清单 + 空 stub src，host /tmp/manifesttest）→ **通过**（下载全量依赖，EXIT=0）。
   证明「仅清单 + 空 lib.rs 即可解析完整依赖图」。
2. `entangled tangle` → 重生成 `Dockerfile` 与 `Dockerfile.app`，二次 tangle 幂等（无 diff）。
3. `DOCKER_BUILDKIT=0 docker build -f Dockerfile -t eestock-data:cachetest .` → **成功**（rc=0，
   builder `cargo fetch` 下载依赖，`cargo build --release --bin eestock-data` Finished 19.36s）。
4. 源码变更（`crates/alert/src/engine.rs` 追加注释）后重建 → **成功**（rc=0）：Step 15 `RUN cargo fetch`
   显示 `Using cache`，重建全程 `Downloading/Downloaded` 计数 = **0**，
   `cargo build` Finished 23.88s（仅重编，不重下）。改后已 `git checkout` 回滚该文件（现为 clean）。
5. `DOCKER_BUILDKIT=0 docker build -f Dockerfile.app -t eestock-app:cachetest .` → **成功**（rc=0，
   `cargo build --release --bin eestock-app` Finished 18.73s，builder fetch 层命中缓存、0 下载）。
6. 本地 `cargo build --release --bin eestock-data` → **通过**（Finished 19.37s）。
7. `./scripts/check-tangle.sh`（staged 后）→ 预期通过（worktree==index 无 diff）。

## Residual risks
- **未来新增 crate**：清单 `COPY` 列表与 stub `RUN` 列表硬编码 10 个 crate。若日后新增第 11 个
  workspace crate 而未同步更新两处列表，`cargo fetch` 会因缺 manifest / 缺 src 报错。已在
  design 注记中声明（维护点）。
- **仅 manifest 变化**才命中 fetch 层缓存；源码变化走重编路径（无 cargo 增量 target 缓存层，
  因 `COPY crates` 后 `target/` 为空，需全量重编本项目源码）。这是该分层的既定权衡，仅避免
  **依赖重下**，不避免**源码重编**（与任务目标「不重新下载依赖」一致）。
- **Docker 缓存依赖构建上下文整体一致性**：`.dockerignore` 正确排除 `target/`、`node_modules/`、`dist/`、
  `data/`、`logs/` 等；未排除 `crates/` 与 `Cargo.toml`/`Cargo.lock`（已验证构建上下文包含它们）。
- **本机验证用 legacy builder**（无 buildx）；BuildKit 下行为等价但缓存展示不同，需在新环境复验。

## 红线遵守
- 未改动其他项目/容器的 Dockerfile；仅 `eestock` 自身两镜像的 builder 阶段。
- 未 commit，仅 `git add` 本任务 staged 集 + 报告文件。
- 无架构歧义（未触及接口/分层/依赖方向），无需 `coder/report/` 阻塞报告。

（本报告属于本任务，`report` 同时作为本任务变更文件的一部随本任务 staged。）
