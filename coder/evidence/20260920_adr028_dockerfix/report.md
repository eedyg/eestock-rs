# ADR-028 镜像构建链修复报告 — 清单漏项（test-support）+ build 路径 `include_str!` 缺 COPY

**报告自身位置**：`coder/evidence/20260920_adr028_dockerfix/report.md`
**日期（UTC）**：2026-09-20 ｜ **仓库**：`/home/eestock/workspace/git/eestock/eestock-rs` ｜ **基线 rev**：`aa5444e`（改动未提交）
**车道**：唯一活跃车道（镜像构建链缺陷，`docker compose build app|data` 恒失败）；未 spawn 子代理。
**范围裁决**：父级 `need_decision` 裁决 = **A 批准**（修缺陷 #2）+ 数据面并入本波 + 批准订正 `test-support` 注释 + 新增 durable guard（include_str! 不变量普查）。目标从「越过缺陷点」上调为「**BUILD_EXIT=0**」。

---

## 判词（前置）

| 项 | 结论 |
|---|---|
| ①「实际 crates 集合 vs 文档 COPY 集合」差集是否为空 | **为空 ×2**：`Dockerfile.app` COPY=16 / loop=16，`Dockerfile` COPY=16 / loop=16，与实际 `ls crates`（16）对称差集均 `[]`；workspace 声明为 `members = ["crates/*"]` glob（无第二处成员清单可漏） |
| ②「build 路径内 `include_str!`/`include_bytes!` 目标 vs COPY 覆盖」差集是否为空 | **为空 ×2**：两镜像编译路径（15 crate）内 src 级 include_* 14 处，crates/ 外目标 1 处（`design/12-strategy-system/04-strategy-programming-guide.md`）↔ 已显式 COPY；未覆盖目标 `[]`。全仓普查 37 处 / 10 文件 / 0 处动态 |
| ③ `./scripts/check-tangle.sh` | **绿**（两轮均绿：清单修复后、缺陷 #2 + 数据面修复后） |
| ④ `docker compose build app` | **`BUILD_EXIT=0`，`app Built`**（builder 24/24 层 `cargo build` DONE 33.6s，零 `failed to read`，零 error） |
| ⑤ `docker compose build data` | **`BUILD_EXIT=0`，`data Built`**（builder 24/24 层通过，零 `failed to read`） |
| ⑥ 同类漏项普查结论 | 已查 **3 类**（清单清单集合 ×2 镜像、`src/lib.rs` loop ×2、`include_*!` 目标 ×2 镜像）+ `Cargo.lock`/`workspace members`/`.dockerignore`/`COPY web`，**无其它漏项**；普查方法与判据见 §7 |
| ⑦ 未做项 | 无镜像级未做项（app/data 均真构建成功）；未跑 `cargo test`（本波无 Rust 语义改动，仅注释）；未 `docker system prune`/清缓存；未 commit（未 stage 任何文件，见 §8） |

---

## 1. 缺陷定性：**三类同源漏项**（构建上下文不全）

镜像构建链共 3 个独立缺陷，根因同源 = **Dockerfile builder 阶段的输入集合 ≠ 实际需要的输入集合**，且都属**文档侧漏项**（`Dockerfile*` 是 `design/` 的 tangle 产物）：

| # | 缺陷 | 位置 | 机制 | 失败信息 |
|---|---|---|---|---|
| ① | 清单漏 `test-support` | `Dockerfile.app` builder「清单先行」层 | `members = ["crates/*"]` + `web`/`storage`/`mcp` 的 `[dev-dependencies] test-support = { path = "../test-support" }` ⇒ `cargo fetch` 必须读到该清单 | `failed to read …/crates/test-support/Cargo.toml` |
| ② | build 路径 `include_str!` 目标未 COPY | `Dockerfile.app`（**且 `Dockerfile` 同病**）builder | `crates/mcp/src/tools.rs:1464` / `crates/web/src/strategies.rs:23` 用 `include_str!("../../../design/12-strategy-system/04-strategy-programming-guide.md")` 把设计文档作**编译期常量**嵌入；builder 只 COPY `Cargo.toml`/`crates/`/`web/`，**从未 COPY `design/`**（`.dockerignore` 未排除 design/） | `couldn't read …/design/12-strategy-system/04-strategy-programming-guide.md` |
| ③ | 清单漏 4 个 crate | `Dockerfile`（数据面）builder | 缺 `application`/`backtest`/`simlive`/`test-support`（历史修补 `2405f5f`/`805ddfa` 只作用于 `Dockerfile.app`） | `failed to read …/crates/application/Cargo.toml`（更早失败点） |

关键事实：`eestock-app` 与 `eestock-data` **同为 `app` crate 的 bin**（`crates/app/src/bin/`），且都链接 `app` lib ⇒ 两镜像都会编译 `web`/`mcp` ⇒ 缺陷 ② 对两镜像**同时成立**（实测两镜像编译路径均含 15 个 crate，含 mcp/web）。

### 1.1 复现与验证（沙箱，无需容器）

`raw/07_fetch_repro.txt`（缺陷 ①）：builder 同步骤（锁文件 + 15 清单 + 15 空 `src/lib.rs`）
→ `timeout 180 cargo fetch` **exit=101**，精确复现 `failed to read /tmp/fetchrepro/crates/test-support/Cargo.toml`；
补 `test-support` 清单 + 空 `src/lib.rs` 后 **exit=0**（`cargo metadata` members=16）。

`raw/14_data_plane_fetch_repro.txt`（缺陷 ③）：旧数据面清单集合（12）
→ **exit=101** `failed to read …/crates/application/Cargo.toml`；新集合（16，= `ls crates`）→ **exit=0**。

`raw/06_docker_build_app.out`（缺陷 ②，容器内实测）：修复 ① 后构建推进到 `#37 RUN cargo build` →
`error: couldn't read crates/mcp/src/../../../design/12-strategy-system/04-strategy-programming-guide.md`（mcp/web 两个 crate 同时报）。
`git log -S'COPY design' -- Dockerfile.app` **零提交** + `include_str!` 由 `8d42fd8` 引入 ⇒ ② 为**pre-existing**、与本波改动无关。

## 2. 改动清单（doc-first：先 design/ 再 tangle；生成物从未手改）

| 文件 | 类型 | 改动 |
|---|---|---|
| `design/07-app-plane/00-web-api.md` | 事实源（手改） | ① Dockerfile.app 块补 `COPY crates/test-support/Cargo.toml …`（字母序，插 `strategy-runtime`↔`tushare`）、loop 补 `test-support`、3 处「15 个」→16 + 成因注记；② 块内 `cargo fetch` 之后补 `COPY design/12-strategy-system/04-strategy-programming-guide.md …` + 不变量注记；正文 §6 补「清单集合 == workspace 全量（差集为空）」与「include_str! 不变量 + 普查口径」两段 |
| `design/03-collector/02-data-plane.md` | 事实源（手改） | 清单补 4 个 crate（`application`/`backtest`/`simlive`/`test-support`，字母序）+ loop 同步 + 3 处「12 个」→16 + 块内设计文档 COPY 行 + 两段注记（dev-only 清单为何必需 / include_str! 不变量） |
| `Dockerfile.app` | **生成物**（`entangled tangle`） | +4 行注记 / +1 清单 COPY / loop +1 名 / +1 design COPY；`app builder` 层数 23→24 |
| `Dockerfile` | **生成物**（`entangled tangle`） | +4 清单 COPY / loop +4 名 / +2 行注记 / +1 design COPY；层数 20→24 |
| `crates/test-support/Cargo.toml` | Rust 侧**注释**（父级批准） | 「不进 Dockerfile」错误断言 → 订正为「源码不进镜像，但清单必须被 builder COPY（workspace/dev-dependency 解析必需）」 |
| `coder/evidence/20260920_adr028_dockerfix/**` | 证据 | 报告 + raw/*（见 §9） |

**注释-only 证明（raw/09）**：`git diff -U0 -- crates/test-support/Cargo.toml` 的新增/删除行**全部**以 `#` 开头
（过滤 `^[+-]\s*#` 后剩余 = 0）⇒ 无 `[package]`/`[dependencies]`/版本/feature 变化，清单语义零改动。
sha256：`6deaa4e…→742d21e5…`（仅注释变）。

tangle（`raw/01`、`raw/10`）：`entangled tangle`（**仓库内，未用 `--force`**，未走沙箱回退路径）
→ `INFO write 'Dockerfile'` / `write 'Dockerfile.app'`，exit=0。

## 3. 差集证明 #1：清单集合（raw/04、raw/05、raw/15）

```
actual crates (ls crates) = 16
Dockerfile.app: COPY=16 loop=16 | DIFF(copy)=[] (EMPTY) | DIFF(loop)=[] (EMPTY)
Dockerfile    : COPY=16 loop=16 | DIFF(copy)=[] (EMPTY) | DIFF(loop)=[] (EMPTY)
```
prose 计数同步核对：`00-web-api.md` 三处均为 16；`02-data-plane.md` 三处均为 16。

## 4. 差集证明 #2（durable guard）：`include_str!`/`include_bytes!` ⊆ COPY 覆盖（raw/08、raw/15）

**普查口径**：`crates/**/*.rs` 全量正则 `include_(str|bytes)!\s*\(\s*"…"`，目标按**所在文件目录**解析为仓库相对路径；
目标是否在编译路径内 = 取**真实构建日志**的 `Compiling <crate> v0.1.0 (/build/crates/<crate>)` 集合（非推断）。

```
census: 37 usages in 10 files; dynamic(unresolved)=0   （无 concat!/env! 拼接，全部静态可判定）

[Dockerfile.app] compiled path crates (15) = alert app application backtest collector diagnose domain mcp
                  providers simlive storage strategy-core strategy-runtime tushare web
   src include_* in build path: 14 usages | in-crate=12（由 COPY crates ./crates 覆盖）
   external targets needing explicit COPY = ['design/12-strategy-system/04-strategy-programming-guide.md']
   INVARIANT: uncovered targets = [] (EMPTY => invariant holds)

[Dockerfile]     compiled path crates (15) = 同上（data bin 亦链接 app lib）
   external targets needing explicit COPY = ['design/12-strategy-system/04-strategy-programming-guide.md']
   INVARIANT: uncovered targets = [] (EMPTY => invariant holds)
```

**差集为空的组成**：`crates/**` 目标由 `COPY crates ./crates` 覆盖（两镜像同款）；`crates/` 之外仅 1 个目标
（上述设计文档，被 mcp/web 的 **src** 编译期嵌入）↔ 两镜像已各加 1 行精确单文件 COPY。
**不在 build 路径内的外部目标（已显式排除，非漏项）**：`web/src/api/errorMessages.ts`、
`web/src/features/workbench/store.ts`、`web/src/features/strategies/TestRunPanel.tsx` —— 三处均出自
`crates/web/tests/tester_p5rect_verify.rs`（**test target**，`cargo build --release --bin` 不编译测试；
且 `COPY web/` 已在 frontend 阶段存在）。已在设计文档块内注释固化「新增引用仓库内文件的 include_*! 必须同步本行」的成因注记。

## 5. 门禁（raw/03、raw/11）

```
$ timeout 600 ./scripts/check-tangle.sh     # 第 1 轮（清单修复后）→ exit=0
$ timeout 600 ./scripts/check-tangle.sh     # 第 2 轮（缺陷 ② + 数据面 + 注释订正后，含两次 tangle 产物）→ exit=0
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
```

## 6. 镜像级验证（真构建，原始输出全量落盘）

| 服务 | 命令 | 结果 | 关键层证据 |
|---|---|---|---|
| app | `timeout 1500 docker compose build app` | **`BUILD_EXIT=0`** ／ `app Built` ／ `naming to docker.io/library/eestock-rs-app` | `#31 builder 17/24 COPY crates/test-support/Cargo.toml` → `#35 builder 21/24 RUN cargo fetch`（**0 处 `failed to read`**）→ `#37 builder 23/24 COPY design/12-strategy-system/04-strategy-programming-guide.md` → `#38 builder 24/24 RUN cargo build --release --bin eestock-app` **DONE 33.6s** → `#42 exporting to image … done` |
| data | `timeout 1500 docker compose build data` | **`BUILD_EXIT=0`** ／ `data Built` | `#23 builder 17/24 COPY crates/test-support/Cargo.toml`、`#28 builder 6/24 COPY crates/application/Cargo.toml` → `#26 builder 21/24 RUN cargo fetch`（**0 处 `failed to read`**）→ `#29 builder 23/24 COPY design/…` → `#31 builder 24/24 RUN cargo build --release --bin eestock-data` → `data Built` |

- 两镜像 `grep -c 'failed to read'` = **0**；两镜像均无 `error:`（② 修复后 `include_str!` 在本容器内被成功解析，
  即 builder 阶段真的读到了设计文档）。
- 层序设计意图保持：设计文档 COPY 放在 `RUN cargo fetch` **之后** ⇒ 文档内容变更**不会**击穿 manifest/fetch 层缓存，
  只触发 `cargo build` 重编（符合原「缓存分层」注记）。
- 未使用任何清理命令（无 `docker system prune` / `docker builder prune` / 删缓存）。
- **`raw/06_docker_build_app.out` 为修复前（缺陷 ② 暴露）的构建记录**，保留作为「① 已消除、报错点推进」的对照证据。

## 7. 同类漏项普查结论（已查 N 处，有无其它漏项）

| 检查维度 | 对象 | 结果 |
|---|---|---|
| 清单 COPY 集合 vs `ls crates` | `Dockerfile.app`、`Dockerfile` | 差集 **[] 为空**（各 16/16） |
| 空 `src/lib.rs` loop 集合 vs `ls crates` | 同上 | 差集 **[] 为空**（各 16/16） |
| prose 计数（「N 个 crate」） | `00-web-api.md`、`02-data-plane.md` | 各 3 处，均 = 16（与实际一致） |
| workspace 成员声明 | `Cargo.toml` | `members = ["crates/*"]` **glob**，无枚举 ⇒ 无漏项面 |
| `include_*!` 目标 vs COPY 覆盖 | 两镜像 build 路径 | 差集 **[] 为空**（§4） |
| `design/` 内其它 dockerfile 代码块 | `grep '{\.dockerfile' design/` | **仅 2 处**（即上表两镜像），无第三处镜像定义 |
| `src/**/src` 逐个 COPY | 两 Dockerfile | 均用 `COPY crates ./crates` 整树覆盖 ⇒ 无逐个清单可漏 |
| `.dockerignore` 是否排除所用构建上下文路径 | `.dockerignore` | 仅排除 `.git`/`target/`/`node_modules`/`dist/`/`data`/`logs`/`.entangled`/`*.log` ⇒ `crates/`、`design/…` 可用（实测构建成功佐证） |
| `docker-compose.yml` 引用 | compose app/data 服务 | `dockerfile: Dockerfile.app` / 默认 `Dockerfile`，与本次修复对象一致 |
| `crates/*/bin` 路径 | `cargo metadata` | 3 个 bin（`eestock-app`/`eestock-data`/`tushare_sync`）；前两者同属 `app` crate ⇒ 两镜像编译路径一致（普查按实测编译集而非推断） |

**结论：除已修的 3 处漏项外，未发现其它同类漏项。** 复发台账：`2405f5f`（backtest/application）、`805ddfa`（simlive）、
本波（test-support ×2 镜像、数据面 4 crate、include_str! ×2 镜像）——建议把 §3/§4 两条差集断言落成门禁脚本（§8-3）。

## 8. 未做项 / 残留风险

1. **无镜像级未做项**：app 与 data 均已真构建成功（`BUILD_EXIT=0`）。
2. 未跑 `cargo test` / 未改任何 Rust 语义：本波 Rust 侧仅 `crates/test-support/Cargo.toml` **注释**（§2 已给逐字节证明）。
3. **建议（未做）**：把两条差集断言做成可执行门禁（新增 `scripts/check-dockerfile-inputs.sh`：比对 `Dockerfile*` 的
   `COPY crates/*/Cargo.toml` 集合与 `crates/` 实际目录集合、以及 `include_*!` 外部目标 ⊆ COPY 集合），
   并入 `check-tangle.sh` 或 pre-commit，从机制上止复发（本波已把判据写进设计文档注释，但尚无自动断言）。
4. 未 stage、未 commit：为免与其它车道**已在索引中**的既有 staged 条目（如 `coder/evidence/20260920_adr027_*`）混淆，
   本波改动**全部留在工作区**（`git status` 侧栏可见），供审查用 `git diff` 独立核对；索引未被我触碰。
5. 残留（低风险，未改）：`crates/web/tests/tester_p5rect_verify.rs` 的三处 `include_str!` 指向 `web/`（仓库内、
   不在任一镜像 build 路径）——若将来在容器内跑 `cargo test` 会失败（非镜像构建路径，见 §4 注记）。
6. 时间盒：实际用约 21 分钟（文档→tangle→门禁→两次真构建），未触发 1500s/1200s 上限。

## 9. 原始证据索引（`coder/evidence/20260920_adr028_dockerfix/raw/`）

| 文件 | 内容 |
|---|---|
| `pre_state.txt` | 改动前 sha256 + rev `aa5444e` |
| `01_tangle.out` / `10_tangle2.out` | `entangled tangle` 两轮原始输出（无 `--force`） |
| `02_diff_Dockerfile.app.patch` | 第 1 阶段生成物 diff |
| `03_check_tangle.out` / `11_check_tangle_2.out` | 门禁两轮原始输出（均绿） |
| `04_crate_set_proof.txt` / `05_loop_set_proof.txt` | 差集证明 #1（清单 / loop 集合） |
| `06_docker_build_app.out` | **修复前** app 构建（对照：① 已越过、② 暴露）：`BUILD_EXIT=1` |
| `07_fetch_repro.txt` | 沙箱复现缺陷 ①（PRE-FIX exit=101 ／ POST-FIX exit=0） |
| `08_include_target_census.txt` | `include_*!` 全量普查（37 处 / 10 文件 / 0 动态） |
| `09_test_support_manifest_diff.patch` | 注释-only 逐字节 diff 证明 |
| `12_build_app.out` | **修复后** `docker compose build app`：**BUILD_EXIT=0** |
| `13_build_data.out` | **修复后** `docker compose build data`：**BUILD_EXIT=0** |
| `14_data_plane_fetch_repro.txt` | 沙箱复现缺陷 ③（12 清单 exit=101 ／ 16 清单 exit=0） |
| `15_final_proofs.txt` | 最终两条差集断言（#1 清单集合、#2 include_str! 不变量） |
| `16_post_state.txt` | 改动后 sha256 + `git diff --stat` |
