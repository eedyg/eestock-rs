# 108 — 部署 ab470b2（1m 读性能优化：MERGED_1M_SQL 索引 DESC LIMIT 合并）

> 本文件位置：`eestock-rs/coder/report/108_merged_1m_perf_deploy.md`
> 范围：**仅部署** HEAD `ab470b2`（storage reader 1m 读优化）。不改源码 / DB / SQL / Rust，不 commit。
> 前置：`107_merged_1m_sql_index_limit_descent.md` 已完成源码变更 + 集成测试（已 commit 至 `ab470b2`）。

## 发生了什么（部署产物）

- 执行 `docker-compose build app` → **exit 0**，`Successfully built b7e038bdc16b`（旧镜像 `638837267c1a`）。
- `docker-compose up -d app`(1) → **崩溃** `KeyError: 'ContainerConfig'`（compose v1.29.2 + Docker 29.1.3），
  旧容器被改名孤儿 `ac3f0bdc68cb_eestock-app`。
- `docker rm -f ac3f0bdc68cb_eestock-app` → removed（清孤儿）。
- `docker-compose up -d app`(2) → **exit 0**，`Creating eestock-app ... done`（全新创建路径，绕过卷合并 inspect）。

## 部署结果确认

| 项 | 结果 |
|---|---|
| 容器 | `eestock-app` Up（healthy），restart_count=0，启动无报错（schema self-check ok / sim-live 恢复 / serving 8081/8082） |
| 新镜像 | `eestock-rs_app:latest` = `sha256:b7e038bdc16b`（created 2026-09-09T03:02:43Z） |
| 旧镜像 | `sha256:638837267c1a` 仍在（可回滚） |
| 数据面 | `eestock-data` Up 4 days（未重建）、`eestock-timescaledb` Up 3 days（未重建）—— 仅重建 app |
| /healthz | `{"status":"ok"}` http=200 |

## 复验（1m 显著变快）

| 场景 | 前（旧镜像 638837267c1a） | 后（新镜像 b7e038bdc16b） | 结论 |
|---|---|---|---|
| 1m 初始加载（limit=500，暖缓存） | ~1.10s（3 次平均） | ~0.29–0.32s（3 次平均 0.292s） | 期望 <1s ✅ |
| 1m 初始加载（冷首查） | —（旧冷 ~2.5s 文档值） | 首查 0.71s（含规划/编译），后续 0.31s | 显著改善 ✅ |
| 1m 深翻（before=2024-06-01T00:00:00Z，limit=500） | ~0.28s | ~0.22s | ~0.5s 或更快 ✅ |
| 1m 深翻（before=2026-09-01T00:00:00Z） | — | 0.255s | ✅ |

> 注：旧镜像初始加载实测 ~1.10s（暖），与报告 107 文档值「旧 ~1.05s 暖 / ~2.5s 冷」一致。新暖 0.29s → 约 3.8x 加速。

## 数据口径（语义等价）

在 timescaledb 内直接对比新 `MERGED_1M_SQL` 与旧 `kline_merged` 视图（code=518880, M1, limit=500）：

- **LATEST（无 before）**：`new EXCEPT old = 0`；`old EXCEPT new = 0`
- **BEFORE（before=2024-06-01T00:00:00Z）**：`new EXCEPT old = 0`；`old EXCEPT new = 0`

→ 双向 0 行差，数据口径一致（准确层优先 + raw 兜底 + source 保留 raw 实际来源 契约保持）。

## 其它周期 + 既有回归

| 端点 | http |
|---|---|
| /api/kline period=5m | 200 |
| /api/kline period=15m | 200 |
| /api/kline period=1h | 200 |
| /api/kline period=1d | 200 |
| /api/kline period=1w | 200 |
| /api/kline period=1mo | 200 |
| /api/symbols | 200 |
| /api/backtest/runs | 200 |
| /api/alerts | 200 |
| /api/sim-live/state | 200 |
| /api/sim-live/positions | 200 |
| /api/sim-live/orders | 200 |
| /api/sim-live/pnl | 200 |
| /api/sim-live/strategies | 200 |
| /api/sim-live/sessions | 200 |
| /api/sim-live/sessions/{id}（GET by session） | 路由存在（未逐一请求历史 id） |

（`/api/sim-live/runs`、`/api/sim-live/sessions/{id}` 路径为误测；正确 sim-live GET 路由如 /state 等全部 200。）

## Compose 坑（复现 + 处置）

- 触发：compose **v1.29.2**（Python 旧二进制）+ Docker **29.1.3**（无 v2 plugin）。up 对运行中 app 做 recreate 时
  走 `merge_volume_bindings` → `container.image_config['ContainerConfig']`，Docker 29 image inspect 移除顶层
  `ContainerConfig` → compose v1 读不到即 `KeyError: 'ContainerConfig'`。
- 处置：`docker rm -f <orphan>`（`ac3f0bdc68cb_eestock-app`）→ 再 `up -d app`，走 **Creating（全新）** 分支绕过。
  本次成功。

## 耗时（部署操作）

| 步骤 | 耗时 |
|---|---|
| build app（Rust 重编，全命中缓存） | ~2.5 min（含 Docker 层） |
| up(1) 崩溃 | 秒级 |
| rm 孤儿 | 秒级 |
| up(2) 全新创建 | ~5s |
| 等待 healthy | ~6s |

## 残留风险

1. **compose v1 + Docker 29 不兼容未根治**：仅靠「rm 孤儿 → 全新创建」规避本次 `KeyError: 'ContainerConfig'`。
   未来对运行中 app 触发 recreate 的变更仍可能崩。长期建议迁 `docker compose`(v2)。
2. **冷首查 ~0.7s**：首次 query 含 hypertable 上千 chunk 的规划/编译成本（新旧皆存在，非本次优化点），
   长连接 prepared statement / generic plan 后稳态 ~0.29s。如需进一步降冷查可考虑 `plan_cache_mode` / 减 chunk（超出范围）。
3. **本机时间/缓存方差**：基准为同库暖缓存测得，冷启动/负载下执行耗时会升高（数量级仍远低于旧全量 Append）。
4. **旧镜像保留**：`638837267c1a` 仍在本地，若回滚可用 `docker tag`/重建复用（未删除）。
5. **`alert_store::list_events_filters` 既有测试失败**（报告 107 记录）：与本改动无关，归为待办，不阻塞本任务验收。

## 暂存/commit 状态

- 未修改任何源码 / DB / SQL / Rust。
- `git diff --stat`（tracked）为空；`git diff --cached --stat`（staged）为空。
- HEAD 仍为 `ab470b2`，未产生新的 commit。
