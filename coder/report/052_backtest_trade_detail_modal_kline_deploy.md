# 052 — 交易明细弹窗增强部署（e6c8965 前端 + 45ba711 补新文件）

> 本报告文件位置：`eestock-rs/coder/report/052_backtest_trade_detail_modal_kline_deploy.md`

## Scope
纯部署任务。仅重建 `app` 服务（前端增强：大尺寸可 resize + 复用看板 KlineChart 交互式 K 线 +
指标切换 + 开平仓价线/区间高亮）。不改源码/DB/SQL/Rust，不 commit。
目标提交（均已在 HEAD，部署前即存在）：
- `e6c8965 feat(web): 交易明细弹窗增强（复用看板K线+resize+指标切换+开平仓区间高亮）`
- `45ba711 feat(web): 补提交回测交易明细弹窗增强的新文件(此前 e6c8965 用 git add -u 漏了 untracked)`

## What changed
- 仅重建 `eestock-rs_app` 镜像 + `eestock-app` 容器。
- **源码零改动**：`git diff --cached --stat` 与 `git diff --stat` 均空；`git status --porcelain` 中出现的均为既有
  untracked（reports/logs/tests）与本部署新增的 build/up 日志，无 tracked 源文件被改（目标提交已在 HEAD）。
- 新增日志（untracked，非源码）：`logs/app_trade_modal_kline_build.log`、`logs/app_trade_modal_kline_up.log`、
  `logs/app_trade_modal_kline_up2.log`。

## 镜像/容器 新旧 ID
- 旧镜像：`sha256:e3353b39c7ddb38b3de8aa19438b0b51c8457e91764bc56ad54ef7f01fbc658d`（短 `e3353b`）
- 新镜像：`sha256:3a509fa4280611ae54267317dee8d85d00b6b26e0926ba217d55583ca611b6bc`（短 `3a509f`，= build 产物 ID）
- 旧容器：`2f25f1697947`（重建后被 compose 重命名成 `2f25f1697947_eestock-app`，Exited(137)，已 `docker rm -f`）
- 新容器：`6da34d0d9809`（`Up (healthy)`，image `eestock-rs_app`）

## Bundle 前后（SPA 哈希）
- 前：`index-BHzYnVG3.js` / `index-BjkrQzlp.css`
- 后：`index-4Ecl5uIr.js` / `index-CA9E95tC.css`（curl SPA 首页提取 + `docker exec eestock-app ls /app/dist/assets` 一致；
  旧 `index-BHzYnVG3.js`/`index-BjkrQzlp.css` 已无残留，dist 仅新两个文件，共 561880B js + 18073B css）

## 冒烟
- `/healthz` → HTTP 200
- `GET /api/backtest/runs` → 正常返回真实数据（`[{"id":84,"code":"518880","period":"D1","strategy_id":"kdj",...`）

## Bundle 内标记确认（关键）
容器 bundle `index-4Ecl5uIr.js` 含以下标志（证明 e6c8965 + 45ba711 的新文件已打入镜像）：
- `tradeRange` = 2（KlineChart 自定义全高背景 overlay 名，新）
- `trade-detail-modal` / `trade-detail-dialog` / `trade-detail-resize` = 各 1（TradeDetailModal 的 className，新）
- `price-line` = 1（开/平仓价线 overlay 类型，新）
- `createOverlay` = 3（overlay 创建调用，新）
- `loadInitial` / `loadBefore` / `applyRealtime` / `onRealtime` = 各 2（ScopedKlineFeed 与看板 feed 均含这些方法；
  属该 feed 接口的标志性方法名）
- 说明：`ScopedKlineFeed` 类名本身在 bundle 中搜索为 0 —— 因生产构建用 terser 将类标识符压缩改名（非字符串字面量），
  但该类的方法标识符 `loadInitial/loadBefore/applyRealtime/onRealtime` 因跨模块按点号访问而被保留，均可命中。
  结合 `tradeRange`/`createOverlay`/`price-line`/`trade-detail-*` 等专属于本次改动的新字符串，足以确证
  `ScopedKlineFeed.ts`、`TradeDetailModal.tsx`、参数化后的 `KlineChart.tsx` 均已进镜像。

## 耗时（近似）
- build：12:01:17 起 → 12:01:21 成功（约 4s）。Rust builder 阶段 Steps 8–34 **全部 `Using cache`**（依赖/源码/编译缓存命中），
  仅前端阶段 Step 5–7 重编（`npm run build` → vite build 1.09s）。
- up：首次 `docker-compose up -d app` 因 `KeyError` 瞬间失败；删孤儿 + 二次 `up -d app`（12:01:47→48）秒级完成；
  健康检查约 5s 后转 `healthy`。整体约 40s。

## compose 坑（Docker Engine 29.1.3 + compose v1.29.2）
- `docker-compose up -d app` 首次触发 `KeyError: 'ContainerConfig'`（compose v1 在 `get_container_data_volumes`
  读旧容器 `image_config['ContainerConfig']`，新 Docker Engine 镜像元数据无该键 → 崩）。复现命中预判。
- 处理：删除 recreate 遗留孤儿容器 `2f25f1697947_eestock-app`（由旧 `eestock-app` 重命名而来、Exited(137)），
  再 `docker-compose up -d app` → 成功 `Creating eestock-app ... done`。
- 仅重建 app；timescaledb / data 保持 `up-to-date`，未受影响。

## 残留风险
- 无旧 bundle 残留（`index-BHzYnVG3.js`/`index-BjkrQzlp.css` 已不在 dist，容器 in-image 检查确认 `no-old-residue`）。
- KeyError 为 compose-v1 + 新 Engine 的已知不兼容；下次 recreate 若再触发，重复「删孤儿 → up -d app」即可。
- 新容器健康检查 `healthy`；后端 REST/WS 未变。
- 前端改动为纯 UI（弹窗增强），后端/DB 未动；`ScopedKlineFeed` 类名被压缩为短标识符，功能行为通过方法名/overlay
  字符串标志确认（见上）。若需更细粒度核验，可对 `index-4Ecl5uIr.js` 人工检索 `tradeRange`/`trade-detail-resize`。

## Verification
- `docker ps`：`6da34d0d9809  eestock-rs_app  Up (healthy)  eestock-app` ✓；新镜像 ID = build 产物 ID ✓
- bundle 前后哈希变化（`index-BHzYnVG3.js`→`index-4Ecl5uIr.js`）✓；healthz（200）/runs 冒烟 ✓；dist 无残留 ✓
- bundle 内标志确认（`tradeRange`/`trade-detail-*`/`price-line`/`createOverlay`/feed 方法名）✓
- 无 staged 文件（`git diff --cached` 空）✓；timescaledb/data 未受影响（Up healthy，旧运行时长）✓
