# 068（设计）— ④「实时更新补齐」线上验收：临时 harness + Playwright 只读驱动的测试设计

- **本文件自身路径（self-location）**：`tester/design/068_realtime_4_harness_acceptance_design.md`
- 报告层级：**设计报告**（为新写驱动设计；只设计、不实现产品代码、不做失败归因、不做修复）
- 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`；HEAD = `ce87766`（`ce87766513612d919656ec7e6d7f0e93c3cfb801`）
- 被测形态：**线上单进程 PID 3112540**（`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`，cwd=仓库根，同持 8081/8082）+ `static_dir=./web/dist`
- 执行报告（同批次）：`tester/test/068_realtime_4_live_acceptance_execution.md`
- 证据目录：`tester/evidence/068_realtime_4_accept/`（`harness/` `scripts/` `json/` `logs/` `screenshots/`）

---

## 1. 为什么需要「临时 harness」而不是直接在线上页面点

四条约束驱动了设计：

1. **绝对禁止向线上发写请求**（用户 dcap 参数正在实时编辑）。线上看板的**布局/宫格切换会落库**（`PUT /api/config/dashboard-layout` 一类写路径），因此在线上页面里点「2×2 宫格」是不可接受的。
2. **不重启线上、不改仓库文件**（除 `tester/` 下报告与证据）。故不能改 `web/dist`、不能改 `vite.config.ts`、不能加 `window.__H__` 到产品代码。
3. ④ 的判据需要**内部可观测量**：视口坐标（`from/to/realFrom/realTo`）、`feed.realtimeStats`、`feed.onRealtime` 计数、WS 连接数/状态——线上 bundle 没有暴露这些。
4. 当前 12:2x 为**午间休市**（`tradingSession()` ⇒ `lunch`），线上 WS 无推送、无新 bar ⇒ 「有新数据提示」必须用**受控注入**构造，且注入内容要能追溯到线上真实数据。

## 2. 测试策略（分层）

| 层 | 目标 | 手段 | 是否触达线上 |
|---|---|---|---|
| L0 部署一致性 | 部署二进制==HEAD 构建；served bundle==`web/dist` | `cargo build -p app` 空跑 + `cmp`/`sha256sum` | 只读 GET `/`、`/assets/*` |
| L1 契约零污染 | 三端点与基线逐字节一致；本窗口零写请求 | `curl -s GET` + `cmp` 对基线串；请求清单 + 浏览器侧非 GET 一律 `abort` | 只读 GET |
| L2 模块级行为（harness） | ④ 的 (a)(b)(c)(d) | `/tmp` 内 vite 构建**仓库真实模块**（`WsClient`/`KlineDataFeed`/`KlineChart`/`realtimePoll`）+ klinecharts 透传 spy | 只读 GET `/api/kline` + WS 订阅 |
| L3 真实页面（served bundle） | 线上产物可加载、`data-viewport-fit` 存在、无控制台错误、零写 | Playwright 直开 `http://127.0.0.1:8081/`（非 GET 被 abort） | 只读 GET |
| L4 回归 | vitest / tsc / check-tangle / 启动日志 | 仓库自带门禁 | 无 |
| L5 反向证据 | 断言会红 | `/tmp` 内**副本**变异（`WsClient` off-hours 阈值 300s→15s）→ 跑仓库用例 | 无 |

## 3. harness 设计（`harness/` 目录已随证据存档）

- **复用**：`tester/evidence/058_.../harness/{index.html,main.tsx}` 为 058 阶段的自建底座，本次在 `/tmp/acc4x/harness/` 建**独立副本**并加两处改动（不改仓库）：
  1. `WsClient({url: () => 'ws://127.0.0.1:8081/ws'})`（058 版指向 `location.host`；本次静态服务在临时端口 18441，故显式指向线上 WS。**WebSocket 不受 CORS 限制**，无需代理）；
  2. 追加 `__H__.grid2x2()`（4 图同 `(code,period)` 并发兜底）与 `__H__.frames[]`（入站帧记录）观测面。
- **HTTP 同源形状 + Playwright 代理**：harness 内 `createHttpClient('')` 发同源 `/api/*`；Playwright `page.route('**/api/**')` 用 `route.fetch({url: 线上})` + `route.fulfill` 转发到线上 8081 ⇒ ① 无 CORS 问题，② **所有出站请求都在浏览器侧可观测**，③ 非 GET 直接 `abort` 并计数（结构性保证零写）。
- **CSS 闭环**：`KlineChart` 根节点是 `relative h-full w-full`（Tailwind）。首轮 harness 未加载 Tailwind 时容器塌陷、手势打不进 pane（实测 `canvas` 高 27px、拖拽/滚轮无反应）。修正：harness 内 `import '@/index.css'` + `/tmp` 侧 `postcss.config.js`/`tailwind.config.js`（`content` 指仓库 `web/src`），重建后容器 1200×640、手势生效。
- **klinecharts spy**：`/tmp/acc_rec/kc-spy.ts`（058 遗留）透传真身并暴露 `window.__ACC__{charts}`；`charts[0].getVisibleRange()` 是读视口坐标的唯一通道。

## 4. 用例清单（Given-When-Then）

| ID | 名称 | Given / When / Then | 期望 |
|---|---|---|---|
| A-1 | 手动缩放/平移后视口不被强拉 | 真实手势（mousedown 拖拽 + wheel 缩放）使 `follow=false` / 触发一次真实兜底取数 / 视口 `{from,to,realFrom,realTo}` 与手势后**逐字不变**、`follow` 仍 `false` | 绿 |
| B-1 | 新 bar 屏外 ⇒ 出现「有新数据」提示且视口不变 | 缩放到「最新 bar 像素 x > 容器宽」**前置条件成立** / 注入一根 ts=最后+1 周期的新 bar / 提示可见且视口坐标不变 | 绿 |
| B-2 | 点击提示跳最新、提示消失 | 提示可见 / 点击 / 最新 bar 回到视口内（x ≤ 宽）、提示消失 | 绿 |
| C-1 | 真实重复取数幂等 | 连续两次真实 `pollIncrement`（`GET /api/kline?...limit=5` 无 `before`） / 长度、`rtCount`、bars 摘要、canvas 签名不变 | 绿 |
| C-2 | 字段完整帧重放（同 ts 同 OHLCV+amount） | 重放线上真实最后一根 bar / `applyRealtime` ⇒ `ignore`（不写、不 emit） | 绿 |
| C-3 | 同一根新 bar 连发 3 次 | 只 `append` 1 次、只 emit 1 次 | 绿 |
| D-1 | 宫格限流/合并（2×2） | 4 图同 `(code,period)` 并发兜底 / 同 key HTTP 次数 ≤ 4 | 绿 |
| D-2 | 6 图（3 同 key + 3 异 key） | 并发兜底 / HTTP ≤ 6 | 绿 |
| E-1 | 非交易时段不空转 | 午休 70s 空闲观窗（harness + 线上页面） / 兜底取数 0 次、无入站帧 | 绿（**替代**真实交易时段节拍证据） |
| F-1 | 线上 served bundle 只读冒烟 | 直开 `http://127.0.0.1:8081/` / 标题/脚本/CSS/`data-viewport-fit` 存在、无 console/page error、零写 | 绿 |
| R-1 | 反向证据（必须会红） | `/tmp` 副本把 `WS_INBOUND_SILENCE_OFFHOURS_MS` 改回 `15_000` / 跑仓库 `WsClient.watchdog.test.ts` / 至少 1 例失败 | 红（符合预期） |

## 5. 边界与例外（设计侧显式处理）

- **午休无新 bar**：B-1/C-2/C-3 必须注入。注入帧 schema 取自产品自身（`WsClient.ts:5`：`{type:"bar", code, period, bar}`），数值取自**线上真实 GET 的最后一根 bar**（`{...last, ts: last+15m, close: last.close+0.5}`），字段完整（含 `amount`）——避免「缺字段 ⇒ `sameBarValues` 判定为 update」的假信号。
- **视口索引书签**：追加一根 bar 后 klinecharts 的 `from/to` 会随数据长度平移 ±1；因此「视口不变」的**主判据**放在「数据更新但无追加」的场景（A-1）与「提示出现时坐标逐字相同」（B-1，实测 `{27,114,27,114}` 完全不变）。
- **前置条件显式化**：B-1 先断言「最新 bar 像素 x > 容器宽」再注入（实测 1216 > 1200），避免「其实在屏内所以没有提示」的伪结论。
- **时段无关性**：所有断言均不依赖真实时钟；`tradingSession()` 只作为「能否取得真实节拍证据」的门控。
- **写请求防护**：`page.route('**/api/**')` 对非 GET 直接 `abort` 并落 `blockedWrites`；设计上即使应用误发写也到不了线上。

## 6. 覆盖目标与不覆盖项

- 覆盖：④ 的 (a) 视口门控、(b) 可见性提示、(c) 幂等、(d) 宫格限流 + 部署一致性 + 契约零污染 + 回归门禁 + 反向证据。
- **不覆盖（本次设计外）**：真实交易时段的分钟节拍（午休，见执行报告「未完成项」）；线上宫格布局的**保存路径**（写请求禁令）；跨日/节假日日历精度。

## 7. 可复现命令（全部在 /tmp，收尾全拆）

```bash
# 1) 构建 harness（仓库真实模块 + 透传 spy）
ln -s <repo>/web/node_modules /tmp/acc4x/node_modules
<repo>/web/node_modules/.bin/vite build --config /tmp/acc4x/vite.config.ts
# 2) 静态服务（临时端口）
python3 -m http.server 18441 --bind 127.0.0.1 --directory /tmp/acc4x/dist &
# 3) 三个驱动
node /tmp/acc4x/run.mjs        # A/B/C/D + 线上页面冒烟
node /tmp/acc4x/focus_bc.mjs   # (b)(c) 聚焦
node /tmp/acc4x/focus_b2.mjs   # (b) 前置条件 + 点击跳最新
node /tmp/acc4x/idle.mjs       # 70s 空闲观窗（非交易时段不空转）
# 4) 收尾：kill python；确认 18xxx 无监听、pgrep -x eestock-app == 1
```

（`harness/`、`scripts/`、`json/`、`screenshots/` 均已存档于 `tester/evidence/068_realtime_4_accept/`。）
