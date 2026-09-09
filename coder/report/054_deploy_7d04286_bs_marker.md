# 054 部署 7d04286：交易明细K线 B/S 标记 + 缩放/平移分页

> 本报告位置：`eestock-rs/coder/report/054_deploy_7d04286_bs_marker.md`

## 结论
提交 `7d04286`（web 前端 B/S 标记 + 分页拉取）部署完成。仅重建 `app` 服务并替换容器；**未改源码 / DB / SQL / Rust，未 commit，未 stage 任何文件**。运行中的容器与服务均验证通过：健康、`/healthz` ok、`/api/backtest/runs` 正常、bundle 含 B/S marker 标记。

## 部署前（旧）
- 运行镜像：`eestock-rs_app` → `sha256:3a509fa4280611ae54267317dee8d85d00b6b26e0926ba217d55583ca611b6bc`（短 `3a509fa42806`），构建于 `2026-09-05T16:01:21Z`（约对应 `45ba711`，早于 `7d04286` 提交时间 `00:29 +0800`）
- 运行容器：`6da34d0d9809`（`eestock-app`），Up healthy
- 旧 SPA bundle：`/assets/index-4Ecl5uIr.js`（sha256 `fd7796468680ae91da3a16707f7948b78e69f961a0ebdca3fca198b7bad699d2`，561880 B）+ `/assets/index-CA9E95tC.css`
- 旧 bundle 校验：**无** `type:"marker"` overlay、**无** `createOverlay({name:"simpleAnnotation"...})` 调用、`30 bar` 计数 = 0、`simpleAnnotation` 字符串仅来自 klinecharts 库内置定义（非本特性）。即 B/S 标记功能未部署。

## 部署后（新）
- 新镜像：`eestock-rs_app` → `sha256:b7465e83caf72c286be4f7d93d3673380827fb229e592eabd662571b1784e507`（短 `b7465e83caf7`），构建于 `2026-09-05T16:31:54Z`
- 新容器：`44d693e3d903`（`eestock-app`），Up healthy，创建于 `2026-09-05T16:32:55Z`
- 新 SPA bundle：`/assets/index-Diecmm3C.js`（sha256 `36cb0787c5e929bb84ff9f4618d636b9b2161506a5c9244fac12cedf8e05bf3f`，562844 B）+ `/assets/index-CA9E95tC.css`（CSS 哈希不变，符合本提交仅改 JS 逻辑）
- 新 bundle 校验：含 `type:"marker"` overlay；含 `createOverlay({name:"simpleAnnotation",paneId:"candle_pane",lock:!0,points:[{timestamp:e.ts,...}],extendData:e.text,...})`；含 `{type:"marker",ts:n.open_ts*1e3,text:"B",price:n.open_price,color:"#ff5c6c"}` 与 `{...,type:"marker",ts:n.close_ts*1e3,text:"S",...,color:"#00e0a4"}`；`30 bar` 计数 ≥1
- 容器 `/app/dist/assets/`仅含新 bundle（`index-Diecmm3C.js` + `index-CA9E95tC.css`），无旧 bundle 遗留

## 冒烟验证
- `docker ps`：`44d693e3d903  eestock-app  Up (healthy)  eestock-rs_app  0.0.0.0:8081-8082->8081-8082/tcp`
- `GET /healthz` → `{"status":"ok"}` HTTP 200
- `GET /api/backtest/runs` → HTTP 200，body 以 `[{"id":84,"code":"518880","period":"D1","strategy_id":"kdj",` 开头
- SPA `GET /` → 引用 `/assets/index-Diecmm3C.js`；`GET /assets/index-Diecmm3C.js` → HTTP 200
- 旧资产路径 `GET /assets/index-4Ecl5uIr.js` → 返回 SPA `index.html` fallback（`Content-Type: text/html`），非陈旧 JS

## Compose 坑（已命中并处置）
- 环境：Docker Engine `29.1.3` + docker-compose `1.29.2`（compose v1）。首次 `docker-compose up -d app` 在 recreate 阶段崩溃：
  `KeyError: 'ContainerConfig'`（栈经 `merge_volume_bindings` → `get_container_data_volumes` → `container.image_config['ContainerConfig'].get('Volumes')`）。
  期间 compose 把运行中 `eestock-app` 改名成孤儿 `6da34d0d9809_eestock-app` 并 kill（Exited(137)），未创建新容器。
- 处置：`docker rm -f 6da34d0d9809_eestock-app`（确认端口 8081 空闲）→ 重跑 `docker-compose up -d app`，因无旧容器可合并卷，走全新创建路径 → 成功。

## 耗时
- `docker-compose build app`：约 4.3s（Rust builder 阶段全命中缓存，仅 frontend dist 层重建）
- 首次 `up -d app`（失败）：约 10.9s
- 孤儿清理 + 重试 `up -d app`：约 3s + 清理
- 从 build 开始到 healthy：`16:31:54` → `16:33:04` UTC，约 70s

## 残留风险
- **compose v1 + Engine 29.x `KeyError: 'ContainerConfig'` bug 仍在环境内**：任何会 recreate 已有容器的 `docker-compose up`（任意服务）都会再次触发；已记录处置法（先删 recreate 孤儿再 `up`）。建议升级 compose v2（`docker compose` 插件）或回退 Engine < 29 根除该问题。
- compose v1 崩溃时改动旧容器名为 `<id>_eestock-app` 再 kill 的簿记怪癖；本次已手动清除。
- B/S 标记的 klinecharts 画布渲染经 bundle 检查 + 冒烟验证，未做像素级目验（与 `053` 一致，需真机目验）。
- 仅重建 `app`；`data`、`timescaledb` 服务未受影响。
- 未改源码 / DB / SQL / Rust；工作区无 tracked 修改，无 staged 文件，未 commit。
