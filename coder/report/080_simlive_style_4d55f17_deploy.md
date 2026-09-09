# 080 — 部署 sim-live 样式修复 `4d55f17`（页面作用域 simlive.css）

> 本报告文件位置（self-location）：`coder/report/080_simlive_style_4d55f17_deploy.md`
> 任务：部署 `4d55f17`（已是 HEAD），只部署、不改源码/DB/SQL/Rust、不 commit、不 stage。
> 环境：Docker 29.1.3 + 独立 `docker-compose` v1.29.2（`docker compose` v2 子命令不存在）。

## 结论概览

| 项 | 状态 | 说明 |
|---|---|---|
| 镜像重建 | ✅ | 新镜像 `sha256:07f7218b6e9c…`（tag `eestock-rs_app:latest`）；前端阶段 `npm run build` 实跑，**Rust 阶段全缓存**（Step 26/27 `COPY crates`/`cargo build` 均 `Using cache`）→ 印证「前端变→Rust 缓存」 |
| 容器滚动替换 | ✅ | `eestock-app` = `05aa47755e6f`，Up (healthy)，镜像 `07f7218b6e9c`，端口 8081/8082 |
| compose v1 崩 `KeyError` | ✅ 已处置 | `up -d app` 复现 `KeyError: 'ContainerConfig'` → 删孤儿 `09254fb14668_eestock-app` → 再 `up` 成功 |
| `/healthz` | ✅ 200 | `{"status":"ok"}` |
| SPA bundle 变更 | ✅ | `index-DIhzyPXq.js`/`index-BbwmiVpc.css`（旧）→ `index-Cl3CGEO5.js` (591.10 kB)/`index-bGgdzUCM.css` (19.95 kB)（新）；`GET /` 引用新 bundle |
| 页面作用域 css 打进 bundle | ✅ | 新 CSS 含 `.sim-card`(5×)、`.tab-on`(1×)；新 JS 含 `sim-card mb-5`(6×)、`tab-on`(1×)。旧 bundle 中 CSS 两标记均为 0 → 本次真正新增 |
| `/api/sim-live/state`、`/api/sim-live/strategies` | ✅ 正常 | 路由已注册：无会话时返回特定 404 `{"error":"无运行中会话…"}`（**非**通用 `{"error":"not found"}`）；启动会话后返回 200 真实数据 |
| 既有端点回归 | ✅ | `/api/symbols`/`/api/backtest/runs`/`/api/alerts` + `/healthz` 均 200（构建前后一致） |

## 关键背景：修复已在 HEAD，本次纯部署

- 当前 HEAD = `4d55f17`（2026-09-07 19:05:54 +0800，6 文件、+165/−39，仅涉 `web/`）。
- 运行中镜像（`27be8225f215`，容器 `09254fb14668`）构建于 c8544db（**不含** 4d55f17 样式修复）→ 需重建。
- 4d55f17 仅改 `web/src/**`（前端）与新增 `web/src/features/simlive/simlive.css`，**未改任何 Rust crate**，因此 Rust building 层应缓存击穿（如前结论已验证）。

## 部署操作记（命令 + 结果）

```
cd /home/eestock/workspace/git/eestock/eestock-rs
docker-compose build app        # 成功：Successfully built 07f7218b6e9c / tagged eestock-rs_app:latest
                                # Frontend Step7 npm run build 实跑（dist/index-Cl3CGEO5.js 591.10kB / index-bGgdzUCM.css 19.95kB）
                                # Rust builder 步骤 10-27 全 Using cache（crates COPY 与 cargo build 未重编）
docker-compose up -d app        # ✗ 复现 Docker29+compose v1：KeyError: 'ContainerConfig'
docker rm -f 09254fb14668_eestock-app   # 删 recreate 产生的孤儿（Exited 137）
docker-compose up -d app        # 成功：Creating eestock-app ... done → 05aa47755e6f Up (healthy)
```

- 构建日志：`logs/app_simlive_style_build.log`；up 日志：`logs/app_simlive_style_up.log`（KeyError）/ `logs/app_simlive_style_up2.log`（成功）。

## 冒烟 / 验收证据

### SPA bundle 引用（GET /）
```html
<script type="module" crossorigin src="/assets/index-Cl3CGEO5.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-bGgdzUCM.css">
```
新 bundle：`index-Cl3CGEO5.js` 591095 B，`index-bGgdzUCM.css` 19952 B。

### 页面作用域 css 打进 bundle（sim-card / tab-on 标记）
| 标记 | 旧 CSS (`BbwmiVpc.css`) | 新 CSS (`bGgdzUCM.css`) | 旧 JS (`DIhzyPXq.js`) | 新 JS (`Cl3CGEO5.js`) |
|---|---|---|---|---|
| `sim-card` | 0 | 5 | 0 | 6 |
| `tab-on` | 0 | 1 | 2 | 1 |

- 新 CSS 含 `.sim-card`(5)、`.tab-on`(1) 选择器 → **simlive.css 已页面作用域打包进 app bundle**（原全为 0）。
- 新 JS 含 `sim-card mb-5`(6)、`tab-on`(1)。旧 JS `tab-on`=2 因旧代码为两处 `'tab-on'` 字面量；4d55f17 改为 `tabCls()` 助手（`\`tab${... === t ? ' tab-on' : ''}\``）→ 单字面量，符合重构预期。
- 已核对 `index.html`（`GET /`）引用的正是上述新 bundle；用 curl 过滤确认 bundle 内标记存在。

### `/api/sim-live/*`（含会话态）
- 新容器启动无会话（内存态清零）→ `GET /api/sim-live/state`、`strategies` 返回特定 404 `{"error":"无运行中会话（请先 start-session 或显式传 session_id）"}`。
- 对照：未知路由 `/api/sim-live/NOPE`、`/api/doesnotexist` 返回 `{"error":"not found"}` → 证明 sim-live 路由已注册、特定 404 为其 handler 语义，非回归。
- 启动会话验证（随后已停止）：
  ```
  POST /api/sim-live/start-session  {"name":"verify_4d55f17","period":"M1","stock_set":["510880"],"strategy_set":["dual_ma","momentum"]}
  → 200 {"session":{"id":"s_1788779280_0","status":"running",...},"started":true}
  GET /api/sim-live/state       → 200 {"active":true,"session":{...},"positions":[],"account":{...},"trading_enabled":false}
  GET /api/sim-live/strategies  → 200 {"stocks":[{"code":"510880","aggregate_score":50.0,"signal":"hold",...}],"strategies":[...]}
  POST /api/sim-live/stop-session → 200 {"session_id":"s_1788779280_0","stopped":true}
  GET /api/sim-live/state       → 404 {"error":"无运行中会话…"}（回到自然驻留态）
  ```
- 说明：sim-live 面板接口在 4d55f17 未变；本部署不变更其契约，仅验证其在新镜像下仍健康。

### 既有端点回归（构建前后一致）
| 端点 | 部署前 | 部署后 |
|---|---|---|
| `/healthz` | 200 ok | 200 ok |
| `/api/symbols` | 200 | 200 |
| `/api/backtest/runs` | 200 | 200 |
| `/api/alerts` | 200 | 200 |
| `/api/sim-live/state` | 200（旧运行会话） | 404「无会话」/ 200（会话中） |
| `/api/sim-live/strategies` | 200（旧运行会话） | 404「无会话」/ 200（会话中） |

## 变更文件清单（本次部署）
- **无源码改动**。仅新增未跟踪日志文件：`logs/app_simlive_style_build.log`、`logs/app_simlive_style_up.log`、`logs/app_simlive_style_up2.log`。
- `git diff --cached` 为空（无 stage）；`git status` 中大量既有未跟踪项（各报告/日志/`crates/web/tests/api_kline_period.rs`/`qq…`）为**既有**未跟踪，与本次部署无关。

## 架构对齐 / layer
- 纯部署于**运行/打包层**：重建应用面镜像并滚动替换容器，未触碰任何 crate 接口、layer 边界、依赖方向、DB schema 或 SQL。
- 4d55f17 修复本身归属 `web/src/features/simlive`（页面作用域 CSS，非 tangle 全局）；本次仅将其交付为运行态。

## 验证方式
- `docker-compose build app` → 前端阶段实跑、Rust 缓存击穿确认；`docker-compose up -d app`（+ KeyError 处置）→ `docker ps` healthy + 新镜像。
- 对 8081 用 curl：`GET /` 取新 bundle 引用并过滤 `sim-card/tab-on`；`/healthz`；`/api/sim-live/*`（会话启动/停止，覆盖 200 与特定 404）；既有 `/api/symbols`、`/api/backtest/runs`、`/api/alerts`。
- `git status` / `git diff --cached` 确认零 stage、零源码改动。

## 耗时
- 核心部署：镜像创建 `2026-09-07T11:06:57Z` → 容器启动 `11:07:21Z` → healthy（约 30–40s 内从镜像产出到健康）。
- 含 build + up（含一次 KeyError 处置）+ 全量冒烟 + 会话验证/清理，全程约 **5 分钟**。

## 残留风险
1. **Compose v1 `KeyError: 'ContainerConfig'`（环境级）**：Docker 29.1.3 + 独立 `docker-compose` v1.29.2 在 `up` 重建容器时必崩。工作区删孤儿再 `up` 已处置；任何后续 `docker-compose up` 重建 `app` 均可能复现。建议迁移至 buildx + `docker compose` v2 插件（非本任务范围）。
2. **旧镜像 tag 被覆盖**：`eestock-rs_app:latest` 由 `27be8225f215`(c8544db) 覆盖为 `07f7218b6e9c`(4d55f17)。若需回滚 c8544db 镜像，旧镜像可能已为 dangling 待 GC（属同 tag 重建常态）。
3. **运行会话为内存态**：重启清空既有 sim-live 会话；面板需重新 `start-session`。本次为验证启动后已 `stop-session` 归位。
4. **既有数据异常（与本次部署无关，预存）**：commit 备注与报告 077 已标注「持仓最新价 0.000 vs 评分 3.389 后端数据异常，单列待查」。本次冒烟 `positions=[]`（无持仓）未复现；`strategies` 返回 `latest_price=3.389` 正常。该单列仍待评估，不属样式部署回归。
5. **SPA chunk >500 kB 警告**：vite 提示 `index-Cl3CGEO5.js`(591 kB) 超阈值（既有行为，非错误，不影响功能）。
