# coder/report/016 — O1：告警事件未通过 WS 推送到客户端（结论：无需改码，O1 为部署态/瞬态 + 探针缺陷）

> 报告文件位置：`coder/report/016_o1_alert_ws_push.md`（本文件）。
> 任务来源：tester/report/007_wave2_acceptance.md §11 O1（Wave2 验收 #4 部分 PASS 未闭环项）。
> 处置结论（父级裁决 2026-09-04）：**采纳方案 A——代码正确，无需改码**；O1 从「产品缺陷」降级为
> 「部署态/瞬态 + 探针缺陷」，须出具证据链 + 正确探针写法，避免复验重蹈。

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 根因 | **非 repo 代码缺陷**：HEAD 已正确接线 alert WS 推送，实盘容器（同镜像）可靠送达 alert 帧 |
| 现象降级 | O1（0 帧）由「部署态/瞬态 + 探针脚本 bug」叠加所致，代码无需改动 |
| 处置 | 不改码；确保部署运行当前镜像（app 容器 09:51/09:54Z 重启后已生效）；出具证据 |
| 未动项 | 无代码/配置改动；DB 探针测试残留已清理，规则恢复种子值；O3（event 219 外部 ack）交父级对账 |

## 1. O1 现象回顾

tester 在 06:25–06:40Z 用 Node WS 客户端订阅 `topic:"alert"` 三轮探测（probeA/B/C，各 5–7min），
**0 帧**；同期 alert engine DB 侧 refire 持续落库（fire_count 2→3→…→41）。对照 `health` topic 同脚本
20s 收 6 帧 → WS 通道本身通。故 O1 判定为「alert 推送路径未达订阅者」。

## 2. 证据链：HEAD 已正确接线 alert WS 推送

### 2.1 推送链路（源码）

1. `crates/app/src/bin/eestock-app.rs`：`tokio::spawn(web::alerts::AlertEvaluator::new(state.clone(), Duration::from_millis(cfg.alert_eval_ms)).run());`。
2. `crates/web/src/alerts.rs` `AlertEvaluator::tick()`：`self.state.alerts.evaluate()` → 对
   `outcome.fired.iter().chain(outcome.resolved.iter())` 逐一 `self.state.hub.publish(PushMsg::Alert(AlertEventDto::from(ev)))`。
3. `crates/web/src/ws.rs` `handle_socket`：`tokio::select!` 的 `rx.recv()` 分支，`mine.iter().any(|s| matches(s, &m))`；
   `matches` 中 `(Topic::Alert, PushMsg::Alert(_)) => true`（订阅即全量）。命中后 `serde_json::to_string` → `sock.send`。
4. `Topic::Alert` 订阅：客户端 `{type:"subscribe","topic":"alert"}` → `ClientMsg::Subscribe{topic:Alert}` →
   `Subscription{topic:Alert, code:None, period:None}`。

### 2.2 载荷对齐（后端 ↔ 前端）

- 后端 `AlertEventDto`（web/src/alerts.rs）：`id, rule_id, level, source, message, status, fire_count,
  first_fired_at, last_fired_at, acked_at, resolved_at`。
- 前端 `AlertEventItem`（api/types.ts:110）：`id, rule_id, level, source, message, status, fire_count,
  first_fired_at, last_fired_at, acked_at, resolved_at` —— 同字段。
- 前端 `WsClient.ts`：`OUT_TOPIC_ALIAS = { source_health: 'health' }`（**无 alert 映射**），
  订阅 `'alert'` → 出站帧 `{type:"subscribe", topic:"alert"}`；入站 `{type:"alert",...}` 经
  `messageTopic` → `'alert'`，分发到 `ws.subscribe('alert', ...)`。
- 前端 `parseWsAlert`：`m.type !== 'alert' || typeof m.id !== 'number'` → 坏帧忽略；`handleWsAlert` 并入列表
  （同 id 替换 / 新事件过过滤入顶）。

### 2.3 双端测试已存在且绿

- 后端 `crates/web/tests/api_alerts.rs::evaluator_fires_incident_and_publishes_ws`：断言 evaluator tick 后
  事件落库（triggered）+ hub 收到 `PushMsg::Alert`（`type:"alert"`/`level:"warning"`/`source`），静默期不重复推。
- 前端 `web/src/features/alerts/store.test.ts`「WS alert 推送：新事件入列表头部；同 id 替换（续触发计数/状态翻转）」。
- 门禁（007 §1）：cargo test **194 passed**，vitest **168 passed**（含上述用例）。

## 3. 实盘 WS 帧证据（当前部署容器，同 06:11Z 镜像）

在运行中的 `eestock-app`（Up since 09:54Z）向 `ws://127.0.0.1:8081/ws` 注入一条 breach 源
（source_health_events 造 1 ok + 3 timeout → source_success_rate 25% < 95%）触发 alert，
多 topic 订阅（alert + health control）稳定收帧：

```
injected + silence=1
[run 0] connected+subscribed
[run 0] ALERT id=246 fire_count=1
[run 0] ALERT id=246 fire_count=2
[run 0] health frames=1 alert frames=2
[run 1] connected+subscribed
[run 1] ALERT id=247 fire_count=1
[run 1] ALERT id=247 fire_count=2
[run 1] health frames=1 alert frames=2
```

单帧展开（`{"type":"alert","id":244,...}`，Repro3 捕获）：

```json
{"type":"alert","id":244,"rule_id":"source_success_rate","level":"warning","source":"wsprobe_src",
 "message":"wsprobe_src 成功率 25.0% < 95%（10min 窗口，1/4）","status":"triggered","fire_count":1,
 "first_fired_at":"2026-09-04T10:07:57.957118Z","last_fired_at":"2026-09-04T10:07:57.957118Z",
 "acked_at":null,"resolved_at":null}
```

> 说明：`fire_count:1`（新建触发）与 `fire_count:2`（续触发/refire）前后到达，证明「新建/续触发」
> 与「恢复」事件均经 hub 实时推送，非仅一次尝试。DB 侧同步确认 `alert_events` 新 incident 落库
> （repro3 观测 `id 241 … triggered fire_count=1`；refire 观测 `fire_count 1→2→3` 每 ~1min 推进）。

**结论**：alert 引擎（DB 落库）与 WS 推送（`PushMsg::Alert` → hub → socket）在当前部署镜像中
**一致且可靠**。O1 的「DB refire 与 0 帧并存」在当前代码/镜像上不可复现。

## 4. O1 的「0 帧」误判根因：探针脚本缺陷（关键）

### 4.1 缺陷

初版探针（`/tmp/ws_probe.py` 系）在收帧循环中 `break` 时机错误：

```python
while time.time() < deadline:
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=max(0.5, deadline-time.time()))
        ...
    except asyncio.TimeoutError:
        break            # ← 缺陷：首个 0.5s 内无帧即提前结束监听
```

当订阅 `alert` **仅自己**（无其他 topic 触发即时帧）时，连接后 0.5s 内无任何帧 → `recv()` 超时 →
`break` → 探针实际只监听 0.5s 就退出，后续（最长 60s 后的 evaluator 节拍、或首次 refire）到达的 alert
帧**未被监听** → 误报「0 帧」。这解释了为何「alert-only 探测 0 帧」而「alert+health（health 帧即时到达
维持监听）稳定收帧」。

### 4.2 正确探针写法（复验用）

要点：`wait_for` 的 `timeout` 设为**剩余 deadline**（而非固定 0.5s），从而「无帧时等到 deadline，
有帧即处理并继续」，仅当 deadline 到达才 break。附 `alert + health` 双订阅作正控（证明通道/订阅存活）。

```python
import asyncio, json, time, websockets

async def probe(topics, duration):
    seen = []
    async with websockets.connect("ws://127.0.0.1:8081/ws", open_timeout=5) as ws:
        for t in topics:
            await ws.send(json.dumps({"type":"subscribe","topic":t}))
        deadline = time.time() + duration
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=remaining)  # 等满剩余时间或收到帧
            except asyncio.TimeoutError:
                break                                  # 仅 deadline 到才 break
            except websockets.ConnectionClosed:
                break
            seen.append(json.loads(raw))
    return seen

asyncio.run(probe(["alert", "health"], 90))            # top health 作正控；alert 单独亦可（时长拉长至覆盖节拍）
```

## 5. 处置与未动项

- **不改码**：alert WS 推送路径 HEAD 已正确实现并实盘验证通过。
- **部署状态**：app 容器 09:51/09:54Z 重启回当前镜像后，alert 推送已生效；若复验仍 0 帧应先核对
  容器镜像是否为新构建（`docker inspect --format '{{.Created}}' eestock-rs_app`）。
- 无代码/设计/配置改动；无 `git add`/提交。
- 探针测试残留已清理：`source_health_events`/`alert_events` 的 `wsprobe%`/`wsverify%` 全删；
  `source_success_rate` 阈值 0.95 / silence 10 恢复种子值；四规则 `enabled=t`（SQL 复核 0 残留行）。

## 6. 残余风险

1. **部署镜像陈旧**：若任何环境仍跑旧镜像（未含 AlertEvaluator→hub 接线），会再现「0 帧」；应重构建
   `Dockerfile.app` 并重启 app 容器。本项目当前运行镜像已探明为正确（06:11Z 构建，含接线）。
2. **订阅竞态（低频）**：客户端 connect 后**立即**订阅 alert 且恰逢同微秒级 evaluator 发布，首帧可能在
   subscribe 被处理前广播 → 该帧丢弃。前端另有 REST `loadList()` 兜底 + `handleWsAlert` 同 id 替换，
   影响可忽略；不作为本轮修复项（父级裁决 B 暂不做、不引双推送源）。
3. **tester 复验 0 帧**：若用 Node 探针复验，请确认其监听不因「无帧超时」提前退出（见 §4.2 正确写法），
   并接入 `health` 正控。

## 7. 关联文件

- 现象来源：`tester/report/007_wave2_acceptance.md` §8 O1 / §11 O1。
- 推送契约：`design/07-app-plane/00-web-api.md` §1.2（WS /ws；alert 帧「推送源 = AlertEvaluator」）。
- 实现：`crates/web/src/{ws,alerts}.rs`、`crates/app/src/bin/eestock-app.rs`、`crates/alert/src/engine.rs`。
- 既有测试：`crates/web/tests/api_alerts.rs`、`web/src/features/alerts/store.test.ts`。
