# 293 — ADR-023 D2 在线部署（多周期接入 30m）

- **本报告路径**：`coder/report/293_adr023_period30m_d2_deploy.md`
- 日期：2026-09-17（本地 00:00 CST）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（所有命令在此目录执行）
- 任务：把**已离线独立验收 PASS** 的 D2（ADR-023 §2.5 / §5.3(D2)：多周期接入 30m）部署到在线实例，沿用用户已批准的部署窗口（D1 已于本窗口部署成功，在线 PID 68833）
- **VERDICT: PASS**
- 证据目录（绝对路径）：`/tmp/adr023-d2-deploy-20260916-235846/EVIDENCE.md`

---

## 1. 交付结果（What changed）

本任务为**部署**，不新增业务代码；落地的改动面是**在线进程与部署产物**：

| 项 | 旧（D1，已停） | 新（D2，在线） |
|---|---|---|
| PID | `68833`（23:10:21 启动） | **`178558`**（23:59:28 启动） |
| 二进制 sha256 | `9a0586ff…d209c02`（207066920 B） | **`d6fed24e…5f78d0`**（207067000 B） |
| 启动日志 | `logs/app_dev_8081_redeploy_20260916_231022.log` | `logs/app_dev_8081_redeploy_20260916_235929.log` |
| dist 入口 bundle | `index-CB06bOVO.js`（D1 报告记载） | **`index-J50SI06a.js`** sha `980ea937…67b8b9` |

- 部署窗口耗时：2026-09-16 23:58:43 → 2026-09-17 00:00:29 CST（≈1m46s，时间盒 25 min 内）。
- 回滚路径（S3）**未触发**；回滚件完整保留：`/tmp/adr023-d2-deploy-20260916-235846/rollback_eestock-app`（sha256 `9a0586ff…`，与 S0 时刻 `/proc/68833/exe` 逐字节一致）。

## 2. Architecture alignment（各改动属于哪一层）

- `target/debug/eestock-app`（重建/替换）与在线进程 = **应用面（app-plane）** 部署产物，承载 `crates/web` 的 API 契约层（`design/07-app-plane/00-web-api.md → crates/web/src/dto.rs` 的 tangle 产物）。
- `web/dist/**` = **前端展示层** 构建产物（`web/src/features/dashboard/*`、`web/src/api/mock.ts` 的手写前端经 `vite build` 产出），由 app 以 `static_dir=./web/dist` 静态托管。
- 未触碰任何接口签名 / 事件契约 / 层边界 / 依赖方向；未改 `.gitignore`；未新建任何代码模块。

## 3. 解决的问题 / 交付的特性

把 D2（**30m 真正进入多周期同显**：后端白名单 `MULTI_PERIOD_ALLOWED` 7 档 + `multi_period_rank` 在 15m/1h 之间插 30m；前端选择器 7 档 + `chartSyncGroup` 冻结密度值 + `periodOrder` 纳入 30m）**上线到在线实例**，端到端可用：

- 在线 `period=30m` K 线端到端 200 且 bars 非空、`period` 回显 `30m`（D1 已打通的读路径 + 本 D2 二进制）；
- 前端入口 bundle 已含 D2 的 4 条冻结密度键（`1m:30m`/`5m:30m`/`15m:30m`/`30m:1h`），即多周期同显的 30m 组合在浏览器侧生效。

## 4. Implementation approach（在既定架构内的关键决策）

1. **S0 先冻结回滚件**：发现 `/proc/68833/exe → target/debug/eestock-app (deleted)`（D2 实现期于 23:43 已重建二进制覆盖了 D1 的运行映像）。仍按既有运维口径从 `/proc/68833/exe` 抓回滚件（内核仍持有该 inode），sha256 `9a0586ff…` 与 S0 记录一致。
2. **S1 构建按既有运维口径**：`cargo build --bin eestock-app`（debug），**不用 `scripts/deploy.sh`**（该脚本是容器路径，且会因 8081/8082 被 host 二进制占用而中止）。构建结果 `Finished in 0.06s`、**exit 0、零重编译**——即 D2 二进制已由 23:43:17 那次构建完成，且 `cargo` 指纹判定与当前工作区源码一致。据此把「运行映像 ↔ 源码」的可信链钉住：`cargo build -v` 显示 `Fresh web v0.1.0`（承载 `dto.rs` 的 crate 未重编）+ 运行中 `/proc/178558/exe` sha256 == `target/debug/eestock-app` sha256。
3. **前端不重复构建**：`web/dist`（23:55:23）mtime **晚于**最新 `web/src` 改动（`web/src/api/mock.ts` 23:48:54）⇒ D2 前端已在 dist 中，**未跑 `npm run build`**（避免无意义的重建与 bundle 名漂移）。
4. **S2 沿用既有启动方式**：`setsid nohup … < /dev/null >> logs/app_dev_8081_redeploy_<ts>.log 2>&1 &`（与历史 `logs/app_dev_8081_redeploy_*.log` 及 D1 部署一致），保证会话无关脱离。先 `kill -TERM` 旧 PID（身份已核：cmdline / cwd / 8081+8082 属主三者一致），2s 内干净退出、端口释放后再启动。
5. **只读红线严格遵守**：全程仅 `GET`（`/healthz`、`/api/symbols`、`/api/kline`、`/api/config/multi_period` **只读一次**）；**未 PUT/POST 任何配置**，未对活库做任何业务写（未跑迁移、未跑写库测试）。

## 5. Test coverage（测试 / 校验覆盖）

本任务为部署，无新增单元测试（D2 单测与 tester 红测试已在 291/292 阶段完成），以**在线只读断言 + 端到端冒烟**为验收证据：

- **S1**：`cargo build --bin eestock-app` exit 0；`Fresh web v0.1.0`；二进制 sha256/mtime 记录。
- **S4 冒烟（全部实测）**：`/healthz` 200；`/api/symbols` = **44**；`GET /api/kline?code=518880&period=30m&limit=60` → **200、60 bars、`period="30m"`**（首 bar `2026-09-09T01:30:00Z`、末 bar `2026-09-16T07:00:00Z`）；`GET /api/config/multi_period` 只读一次并原样记录；启动日志 **ERROR=0**；`ss` 确认 8081/8082 **均属新 PID 178558**。
- **S4 附加（D2 前端在线性）**：服务端返回的 `/assets/index-J50SI06a.js` 逐字节等于磁盘 dist 文件（sha `980ea937…`），且其中命中 4 条 D2 冻结密度键与 8 处 `"30m"`。

## 6. Verification（如何确认改动生效）

| # | 断言 | 实测 |
|---|---|---|
| 1 | 旧 PID 身份与回滚件 | `68833` cmdline `./target/debug/eestock-app --config /tmp/app_dev_8081.toml`、cwd 正确、8071/8082 属主一致；exe sha `9a0586ff…` 已复制 |
| 2 | 旧进程干净退出 | `kill -TERM` rc=0，2s 内退出，`ss` 无 8081/8082 监听 |
| 3 | 新进程起来 | PID `178558`，23:59:28 启动，`/proc/178558/exe` 指向**真实路径**（非 deleted）sha `d6fed24e…` |
| 4 | 启动自检 | 日志含 `schema self-check ok`、`eestock-app serving 0.0.0.0:8081 static_dir=./web/dist`、`mcp server serving 0.0.0.0:8082` |
| 5 | 冒烟 | 见 §5（全部通过） |
| 6 | 稳定性复检（t+~60s） | `178558` 仍在、`68833` 已不存在、`/healthz` 200、日志 ERROR=0 WARN=0（7 行） |
| 7 | 副作用 | HEAD 未变 `3094018f…`；**staged=0**；`git status --porcelain -uno` = 27（= S0 基线）；`.gitignore` 未改（mtime 09-13，sha `7a25f270…`）；`docker ps` 全部容器 `RunningFor` 与 S0 完全一致（eestock-data 11 days / timescaledb 11 days / scrylink 4 days、15 hours、4 days、4 days）⇒ 无容器重启、其他项目未动 |

## 7. 禁令遵守

- **未** `git add` / `git commit` / `git stash` ⇒ 报告时无 staged（`git diff --cached --name-only | wc -l` = 0）。
- **未**改 `.gitignore`；**未**动其他项目容器；**未** `entangled --force`、**未**全局 stitch、本任务未跑 tangle。
- **未**对活库做任何业务写：未跑迁移、未 PUT 配置、未 POST；仅只读 GET 与只读文件系统/进程检查。
- 唯一新增仓库内文件 = 本报告（未跟踪）；新增日志文件落 `logs/` 已被 `.gitignore:23 /logs/` 忽略。

## 8. 残留风险与未决项

| # | 风险 / 未决 | 处置 / 说明 |
|---|---|---|
| R1 | **`GET /api/config/multi_period` 不能证明后端 D2 白名单** | 该端点返回的是**库中已存配置**：`{"enabled":false,"periods":["1m"],"heights":{"1m":420},"indicators":["dcap"]}`（用户当前单周期配置，本就不含 30m）。白名单/rank 的运行时探针只有 `PUT /api/config/multi_period`（非法值 400 文案含 `MULTI_PERIOD_ALLOWED`）**或** POST 类路径，二者均被任务「不得 PUT 配置 / 只允许只读 GET」明令禁止 ⇒ **刻意未尝试**。后端 D2 已改动的可信链以「`cargo build -v` = `Fresh web v0.1.0`（零重编译）+ 运行中 exe sha == `target/debug/eestock-app` sha + 工作区 `dto.rs` 含 `"30m"`」建立；功能正确性由 291/292 单测与 tester 离线独立验收 PASS 覆盖。**建议**：下一窗口若要在线确证，需一次经批准的 `PUT` 探针（或用非 400 侧的 GET 只读暴露项），否则该项只能维持「静态可信链 + 离线验收」强度。 |
| R2 | dist 早于本次重启已更新（23:55 < 23:59 重启） | 因 `static_dir` 为磁盘直读，D2 前端自 23:55 起即为**在线可见**（在旧 D1 二进制仍在跑期间）。本任务未回退该窗口；如需「前端与后端二进制同刻上线」的严格口径，后续部署应把 `npm run build` 排在 S1 内、S2 之前统一进行。已实测：本任务 S2 之后服务端返回的 bundle == 磁盘 dist，无缓存不一致。 |
| R3 | 无 `index.html` 强缓存头实证 | 已实测服务端返回内容 sha == 磁盘 sha；未检查 `Cache-Control`（不在本任务 S 清单内）。 |
| R4 | 二进制 deploy 后 `target/debug/eestock-app` 若被再次重建 | 现有进程映像已固化为 `/proc/178558/exe`（当前指向真实路径）；若后续再构建会使其变 `(deleted)`——届时回滚件应重新从 `/proc` 抓取。本次已留 S0 回滚件。 |
| R5 | 启动日志当前仅 7 行（无查询流量） | ERROR=0 是「启动期」口径；慢查询 WARN 需有流量后才可能出现（D1 日志即有 WARN，非 ERROR）。不构成本次失败判据。 |

---

## 附：报告文件位置

本报告自身的文件位置：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/293_adr023_period30m_d2_deploy.md`
证据（任务指定留证）：`/tmp/adr023-d2-deploy-20260916-235846/EVIDENCE.md`
