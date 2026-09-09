# 设置页 S2 配置持久化 — 部署/应用迁移（`49bcfeb` 部署）

> 本报告路径：`eestock-rs/coder/report/100_settings_s2_config_persist_deploy.md`
> 任务：只部署/应用迁移（app_config 表 + ConfigStore + PATCH /api/config/* + 前端保存启用），不改源码 / 非迁移 DB，不 commit。不修改实现报告 099 已交付的核心功能。

## 0. 结论（TL;DR）

- ✅ **迁移 0021 `app_config` 已在库**（结构与 SQL 一致；重跑报 `relation "app_config" already exists`，幂等成立）。
- ✅ **重编 eestock-app 成功**（新镜像 `859ffee85b55`，旧 `1f96386a1c80`；前端 bundle `index-wDVAcg-x.js` 新产物）。
- ✅ **重部署 eestock-app 成功**（healthy；此前 `docker-compose up` 触发 Docker29+compose v1 `KeyError: 'ContainerConfig'`，删孤儿后 up 成功）。
- ✅ **PATCH→GET 持久化验证通过**（collector/sources/mcp 三块；非法→400；已恢复默认）。
- ✅ **前端「保存」启用 + 乐观更新回显通过**（真实 Chromium/Playwright DOM 验证）。
- ✅ **既有端点回归通过**（/api/symbols、/api/backtest/runs、/api/alerts、/api/sim-live/* 全 200）。
- ⚠️ **两点注记**：① `/api/config/*` 写端点是 **PATCH** 非 PUT（任务中「PUT」应理解为配置写端点）；② **mcp 未知字段→200（忽略）而非 400**（DTO 无 `deny_unknown_fields`，为既有设计，非部署故障）。③ collector/MCP 配置的「运行时应用（数据面接线）」本期未接线（见 §4 残留风险）。

## 1. 应用迁移 0021

```bash
cd eestock-rs && docker exec -i eestock-timescaledb psql -U eestock -d eestock -v ON_ERROR_STOP=1 < migrations/0021_app_config.sql
# 输出：ERROR: relation "app_config" already exists
```

- 迁移 `CREATE TABLE app_config (key text PK, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())` **已在库生效**，表结构与 SQL 完全一致（`\d app_config` 校验：key text PK / value jsonb NOT NULL / updated_at timestamptz DEFAULT now()）。
- SQL 无 `IF NOT EXISTS`，故重跑报 exists（非幂等语法），但**状态已满足**（幂等成立）。`key` 三块（sources/collector/mcp）约定见 web `settings.rs` `K_SOURCES/K_COLLECTOR/K_MCP`。
- app_config 行数在下述冒烟后最终为 3 行（collector=60、sources=全默认、mcp=默认），均恢复默认。

## 2. 构建 & 部署 app（仅 app）

```bash
docker-compose build app      # BUILD_EXIT=0 → 新镜像 eestock-rs_app:latest = 859ffee85b55
docker-compose up -d --no-deps app   # 初次触发 KeyError → 删孤儿再 up → UP_EXIT=0
```

- 构建日志要点：frontend 阶段 `VITE_API_MOCK=0 npm run build` 产出 `dist/index-wDVAcg-x.js / index-BWgp2QN3.css`（新哈希）；builder 阶段 Rust `cargo build --release --bin eestock-app` 重编 21.32s（依赖层命中缓存，仅源码相关 crate 重编）。
- 部署后 `eestock-app` 镜像 ID = `859ffee85b55`（与 `eestock-rs_app:latest` 一致），container `Up (healthy)`，`/healthz` → `{"status":"ok"}` HTTP 200。
- `eestock-data`、`eestock-timescaledb` 未重建、未受影响。

### compose 坑（Docker 29.1.3 + compose v1.29.2）

`docker-compose up -d --no-deps app` 崩溃：

```
ERROR: for eestock-app 'ContainerConfig'
KeyError: 'ContainerConfig'
  ... compose/service.py:1579 get_container_data_volumes
  container.image_config['ContainerConfig'].get('Volumes') or {}
```

- 根因：compose v1 在 recreate 时读取旧容器 image_config 的 `ContainerConfig`，而 Docker 29 返回的 image_config 已无该键。
- 处置：`docker rm -f` 旧/孤儿容器（本次为 `f291eeef1e2b_eestock-app`，因 recreate 中断处于 Exit 137），再 `docker-compose up -d --no-deps app` 全新创建 → 成功。**每次重建 app 均需先用删孤儿步骤**。

## 3. 冒烟验证清单

### 3.1 collector

| 请求 | 结果 |
|---|---|
| `PATCH /api/config/collector {"default_interval_sec":120}` | 200，返回 `{"default_interval_sec":120,"trading_hours":...}` |
| `GET /api/config/collector`（PATCH 后） | 200，`default_interval_sec=120` |
| DB `app_config` key=collector | `{"default_interval_sec": 120}`（持久化落库） |
| `PATCH ... {"default_interval_sec":0}` | 400 `default_interval_sec 须 ≥60，收到 0` |
| `PATCH ... {"default_interval_sec":30}` | 400 `default_interval_sec 须 ≥60，收到 30` |
| `PATCH ... {"default_interval_sec":60}`（恢复默认） | 200，GET 回 60 |

### 3.2 sources

| 请求 | 结果 |
|---|---|
| `GET /api/config/sources` | 200，8 内置源快照，`push2delay`(东财系) 末位且 `rotation_locked=true` |
| `PATCH` 改 `tencent_ifzq` rate_per_sec=2, circuit_fail_count=4 | 200，GET 回 2/4 |
| DB `app_config` key=sources sources[0] | `tencent_ifzq` rate=2 circuit=4（持久化；存储存子集 id/enabled/jitter_ms/rate_per_sec/backoff_steps/circuit_fail_count，label/role/rotation_locked 由 web 派生） |
| `PATCH` 将 `push2delay` 移到非末位 | 400 `轮转序违规：push2delay（东财系）必须为末位（ADR-006）` |
| `PATCH` rate_per_sec=-1 | 400 `源 tencent_ifzq 速率 rate_per_sec 须 ≥0` |
| `PATCH` 恢复默认（全 rate=1,circuit=3） | 200，GET 全默认，push2delay 末位 |

### 3.3 mcp

| 请求 | 结果 |
|---|---|
| `GET /api/config/mcp` | 默认 `{"enabled":true,"trading_tools_enabled":false,"daily_limit_amount":50000,"daily_limit_count":20}` |
| `PATCH {"enabled":false,"trading_tools_enabled":true,"daily_limit_amount":100000,"daily_limit_count":50}` | 200，GET 回同值（持久化） |
| `PATCH daily_limit_amount=-1` | 400 `daily_limit_amount 须 ≥0，收到 -1` |
| `PATCH daily_limit_count=-1` | 400 `daily_limit_count 须 ≥0，收到 -1` |
| `PATCH` 未知字段 `bogus_field` | **200（忽略，未拒绝）** — DTO 无 `deny_unknown_fields`（既有设计） |
| `PATCH` 恢复默认 | 200，GET 回默认 |

> 注：写端点方法为 **PATCH**（`lib.rs` 注册 `get().patch()`；前端 client 亦用 `method:'PATCH'`）。任务中的「PUT /api/config/collector」为「配置写端点」的表述；对该端点发 PUT 会得 405（未注册）。`PATCH/PUT` 应理解为「可写配置端点（PATCH）」。

### 3.4 前端保存启用（真实浏览器 Playwright）

Chromium 无头访问 `http://localhost:8081/settings`：

- `data-testid` 三保存钮：`save-sources`、`save-collector`、`save-mcp` 均 `disabled=false`（**可点击**）。
- collector 编辑→PATCH→乐观更新→回显：输入框 `60` → 改 `90` → 点「保存」→ 回显 `90` + 提示「已保存（新注册标的默认值）」→ `GET /api/config/collector=90`（落库）→ 改回 `60` 保存 → API 回 `60`。
- 页面加载/交互 **0 控制台错误**。

### 3.5 既有端点回归

`/api/symbols`、`/api/backtest/runs`、`/api/alerts` 均 HTTP 200；`/api/sim-live/{state,positions,orders,pnl,strategies,sessions}` 全 200。

## 4. 残留风险

| 风险 | 说明 |
|---|---|
| **collector/MCP 运行时应用未接线（最大）** | 持久化 + PATCH + GET + 前端已交付，但「数据面真正按持久化的 collector 间隔/MCP 开关运行」未在本部署验证（实现报告 099 §4 注记「运行时应用未接线」）。部署不引入，但功能闭环未达成。 |
| **mcp 未知字段→200 而非 400** | 任务冒烟期望「mcp 未知字段→400」，但既有 DTO 无 `deny_unknown_fields`，未知字段被 serde 静默忽略（200）。为既有设计，非部署缺陷；如需严格 400 属源码改动，超出本部署范围。 |
| **PATCH vs PUT 表述** | 任务正文多处写「PUT」，实际端点为 PATCH（`get().patch()`）；对 PUT 得 405。验收时以 PATCH 为准。 |
| **compose v1 + Docker29 每次重建需删孤儿** | 无 buildx/docker compose v2，仅 compose v1；重建 app 必触发 `KeyError: 'ContainerConfig'`，需先 `docker rm -f` 孤儿容器。 |
| **`49bcfeb` 在本 repo git 无法解析** | 该提交标识在当前工作树/branch 不解析（可能为 PR/他分支）；本次实际以工作树源码为准构建（源码即 S2 特性，未 uncommitted 于 eestock-rs）。 |
| 迁移非幂等语法 | SQL 用 `CREATE TABLE`（无 IF NOT EXISTS），库已存在时重跑报错；状态满足即可，不重复执行。 |

## 5. 变更内容 / 层归属（本次部署）

- **无源码/非迁移 DB 改动**：`git status --short eestock-rs/` 为空；`git diff --cached` 为空（未 stage、未 commit）。
- 变更对象为 **运行时产物**：新镜像 `eestock-rs_app:latest=859ffee85b55`、新容器 `eestock-app`（healthy）、运行库 `app_config` 三行默认配置（collector=60 / sources 全默认 / mcp 默认）。
- 层归属：storage(ConfigStore)+domain(ports::ConfigStore)+web(PATCH/GET)+app(运行时接线) 的**代码**在实现报告 099 已落地；本次仅为「部署/应用迁移」。

## 6. 耗时

- 起 12:03:22 CST → 止 12:07:40 CST，约 **4.5 分钟**（含一次 compose KeyError 处置；`docker-compose build` 为主耗时，Rust release 重编 21.32s，前端 vite 1.20s，docker 上下文 127.3MB）。

## 7. 关键验证证据：运行命令

```bash
cd eestock-rs && docker exec -i eestock-timescaledb psql -U eestock -d eestock -v ON_ERROR_STOP=1 < migrations/0021_app_config.sql
#  → ERROR: relation "app_config" already exists

docker-compose build app          # → Successfully built 859ffee85b55 / eestock-rs_app:latest
docker-compose up -d --no-deps app   # 初次 KeyError → rm -f orphan → 重建成功
curl -s http://localhost:8081/healthz   # {"status":"ok"} 200
# PATCH/GET + 非法 400 + 恢复默认（collector/sources/mcp）
# Playwright /settings：save-sources/save-collector/save-mcp disabled=false；collector 60→90→PATCH→回显90→落库90→恢复60
# 回归：symbols / backtest/runs / alerts / sim-live/* 全 200
```
