# 071 —— 回测列表性能修复 `080dd55` 部署报告

报告文件：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/071_backtest_list_light_pagination_deploy.md`

## 范围界定
仅部署与性能冒烟，**未改源码 / DB / SQL / Rust，未 commit**。HEAD 仍为 `080dd55`，`git diff --cached` 为空，无任何被追踪源文件被修改（仅新增本报告与构建日志到未追踪区）。

## What changed（本次部署变更）
- 重建并滚动替换应用面镜像/容器，仅 `app` 服务。
- 变更来源：提交 `080dd55 perf(backtest): 加载历史run列表性能修复（列表轻元数据+分页）`。
- 应用面镜像内 bundle 哈希变化（前端 vite 重编）：

| 资源 | 旧（部署前） | 新（部署后） |
|---|---|---|
| JS bundle | `index-CHhXzvJa.js` (570,845 B) | `index-Btueb4Pk.js` (572,158 B) |
| CSS | `index-Cxv8CfRK.css` (18,722 B) | `index-Cxv8CfRK.css` (18,722 B) |

- 无 DB 迁移、无 SQL 变更、无 Rust 源码改动（仅使用已提交的二进制/镜像重编）。

## 部署步骤与耗时
| 命令 | 结果 | 耗时 |
|---|---|---|
| `docker-compose build app` | success, 新镜像 `d7459329a6b5` | 32s |
| `docker-compose up -d app`（直接） | **失败** `KeyError: 'ContainerConfig'`（compose1.29.2 + Docker29.1.3） | 瞬时 |
| `docker rm -f` 孤儿 `26fd1642e0c1_eestock-app`（Exited 137） | 成功 | 瞬时 |
| `docker-compose up -d app`（孤儿清理后） | success, 容器 `a91176e7b1c3` | 0s |
| 健康等待 | `healthy`（poll2） | ~4s |

总计从 build 开始到 healthy ≈ 36s。

### Compose 坑（复现与规避）
- 复现：`docker-compose up -d app` 直接触发
  `compose/service.py get_container_data_volumes` → `container.image_config['ContainerConfig']` → `KeyError: 'ContainerConfig'`。
  根因：compose v1.29.2 与 Docker 29 的 image config 结构不兼容。
- 规避：先 `docker rm -f` 删除由失败 `up` 遗留的孤儿容器（`<oldid>_eestock-app`），再干净 `docker-compose up -d app`。
- 本次仅重建 `app`；`timescaledb`、`data` 服务未动（`timescaledb is up-to-date`）。

## 部署后状态
- 容器：`eestock-app` = `a91176e7b1c3`，`Up (healthy)`，镜像 `eestock-rs_app:latest`。
- 新镜像 ID：`sha256:d7459329a6b59a9b9828415db463a9ce39e1dc449022594043a3cae03b68ed26`。
- 旧镜像（部署前）：`sha256:8563f4bc55e51f6995ec9d22238fe5514c005787903e18ec15f2447d82d2b7c0`。

## 列表轻（无结果键）+ 分页验证
- `GET /api/backtest/runs`（默认）：items 只含元数据键：
  `code, created_at, current_ts, date_from, date_to, error, fee, finished_at, group_id, id, initial_capital, params, period, progress, status, strategy_id`。
- 结果键核对（grep 整个响应，均为 0 次）：`net_value=0, trades=0, metrics=0, equity_curve=0, drawdown=0`。
- `GET /api/backtest/runs?limit=5&offset=0` → 5 条，`ids=[120,84,35,34,33]`，`has_result_keys=False`。
- `GET /api/backtest/runs?limit=5&offset=5` → 0 条（第 2 页空，符合当前库内仅 5 条 run）。
- `GET /api/backtest/runs?limit=1000` → 仅返回 5 条（默认 limit=100 有界生效，不无界拉取）。
- `GET /api/backtest/runs/120` → 完整结果：`net_value{drawdown,series} + trades + metrics` 均含（293,483 B / 4.6ms）。

## 性能对比（`time curl ... /api/backtest/runs`）
| 阶段 | 字节 | 耗时 |
|---|---|---|
| 修复前（部署前基线） | 3,291,851 B | 0.049006 s (~49ms) |
| 修复后（冷首次, 写文件） | 2,209 B | 0.001887 s (~1.9ms) |
| 修复后（/dev/null 5 次热跑） | 2,209 B | 0.000349–0.000735 s (~0.3–0.7ms) |

- 字节减少：3,291,851 → 2,209 = **约 1490 倍更小**（不再搬运全量结果 JSON）。
- 耗时：约 49ms → 亚毫秒/几毫秒，**约 100 倍更快**。
- 结论：列表端点不再携带 `net_value/trades/metrics`，payload 与耗时均大幅下降。

## 既有端点回归
| 端点 | 结果 | 备注 |
|---|---|---|
| `/healthz` | 200 (0.46ms) | ok |
| `/api/kline?code=518880&period=1m&limit=5` | 200 (781 B, 0.68s) | 返回 bars；无参请求 400 属必填 `code` 校验（正常） |
| `/api/symbols` | 200 (9,775 B, 16ms) | ok |
| `/api/backtest/strategies` | 200 (3,643 B) | ok |
| `/api/alerts` | 200 (16,529 B) | ok |

## 残留风险
- **孤儿容器复发**：compose v1.29.2 + Docker29 下，任何再次 `up` 其它含卷服务仍可能 `KeyError: 'ContainerConfig'`；本次通过先删孤儿规避。后续对 app 的 `up` 若再崩，重复「删孤儿再 up」即可。
- **默认 limit 有界的真值**：库内现仅 5 条 run，无法用大 limit 区分「cap=100」与「cap=5」，只验证了上限生效（limit=1000 仍返 5）。当库内 run >100 时建议再确认上限精确为 100。
- **前端 bundle 变大 1.3KB**：`index-Btueb4Pk.js` 略大于旧（frontend 改动所致），可忽略。
- **K线性能未回归测**：`/api/kline` 首次命中 0.68s，属冷数据/未命中缓存表现，非本次改动引入（列表与 kline 为不同存储路径）。
- **仅单机滚动**：`app` 容器重启期间有 ~秒级 404(连接拒绝) 窗口；本次因健康等待极短，未观测到对外中断。

## 验证工具
- `docker inspect --format '{{.Image}}' eestock-app`
- `docker exec eestock-app sh -c 'ls -la /app/dist/assets/'`
- `curl -s -o /dev/null -w 'http_code=%{http_code} bytes=%{size_download} time=%{time_total}s\n'`
- `python3 -c "import json;..."` 解析 list/分页/单项键。
- `git diff --cached --stat`（应空）、`git status --porcelain`（无追踪改动）。
