# 020 — K1（高）WS quote 契约不匹配致整页崩 + O1 分时盘中不刷新 修复

> **本报告文件位置**：`coder/report/020_k1_ws_contract_fix.md`（eestock-rs 仓库根下同路径）
> 状态：修复完成（TDD 红→绿）；全部改动在 working tree，**仅 stage 未 commit**。
> 依据：tester/report/008_kline_component_matrix.md §9 K1 / §5 O1 / §11 R1；决策见 design/99-decisions-log.md「K1 + O1 + R1 处置」。
> 文学式纪律：ws.rs 改 design/07-app-plane/00-web-api.md 代码块 → `entangled tangle` 生成 src；store/分时改动同步更新 design/06-web/01-dashboard.md 设计说明（该两文件为手写骨架，无 tangle 标记，直接改源）。

---

## 0. 结论摘要

- **K1（高）**：后端 WS `PushMsg::Quote` 载荷字段 `change_pct`（snake）与前端 `DashboardStore` 读取 `changePct`（camel）不匹配 → 实盘 quote 推送 `undefined.toFixed()` TypeError → 整页卸载。
  - **后端修复**：`crates/web/src/ws.rs` Quote 变体 `change_pct` 字段加 `#[serde(rename = "changePct")]`；WS quote 帧现输出 **camelCase `changePct`**（与前端/mock 一致），Rust 字段名不变（仅序列化键变化），不触碰 `window_secs`/`rule_id` 等保持 snake_case 的 health/alert 契约。
  - **前端兜底（双保险）**：`DashboardStore` quote 分支归一化 `msg.change_pct ?? msg.changePct ?? 0`，兼容历史帧/其他源，防空值触发 toFixed 崩溃（与 REST 客户端 `d.latest?.change_pct ?? 0` 一致）。
- **O1**：`TimeshareChart` 复用 `KlineDataFeed`（period `1m`）的 `onChange`/`onRealtime`，订阅 `WS {type:"bar", code, period:"1m"}`；当日价格线 + 均价线随新 1m bar append/update 实时前进，盘中不重挂载也刷新（零额外接口）。
- **R1（记录不修）**：高周期 cagg 仅回填 ~3 交易日、"翻 10-20 交易日"仅 1m 验证 → 记入 decisions-log, 作为后续 backlog。
- **全帧契约核对**：quote=唯一 mismatch（本次修）；bar/health/alert 前后端一致（health 保持 snake `window_secs`，alert 保持 snake `rule_id`/`fire_count` 等，见 web/src/api/types.ts 注「字段名与后端 serde 一致，不做驼峰转换」）。

---

## 1. K1 根因与修复

### 1.1 根因（只读定位，tester §9 复现）
- 后端 `ws.rs` `PushMsg::Quote { code, ts, last, change_pct: Option<f64> }` def serde 输出 **snake_case** `change_pct`。
- 前端 `store.ts` quote 分支读取 `msg.changePct`（camel）；`WsClient` 无归一化 → `msg.changePct` undefined → `SymbolList`/`GridCell` `changePct.toFixed(2)` 抛 TypeError → React 整树卸载（symbol-list 清空/canvas 不可见）。

### 1.2 后端修复（crates/web/src/ws.rs，tangle 自 design/07-app-plane/00-web-api.md）
```rust
Quote { code: String, ts: DateTime<Utc>, last: f64, #[serde(rename = "changePct")] change_pct: Option<f64> },
```
- 仅序列化键改为 `changePct`；Rust 字段名 `change_pct` 不变，`Poller::tick` 构造、`matches` 模式匹配、`ws_poller` 集成测试均不受影响（cargo test 全绿）。
- **为何不用全局 `#[serde(rename_all = "camelCase")]` / `rename_all_fields`**：会连带把 `PushMsg::Health` 的 `window_secs` 也驼峰化为 `windowSecs`，破坏前端 `SourcesHealth.window_secs`（snake）契约（types.ts 明确「不做驼峰转换」）。故按"quote 相关序列化"最小对齐。

### 1.3 前端兜底（web/src/features/dashboard/store.ts）
```ts
const changePct = ((msg.change_pct ?? msg.changePct) ?? 0) as number;
```
- 服务端新契约输出 camelCase；此处兼容**旧服务端 snake_case**（历史帧/其他源再踩不崩），并回退 `0` 防止 `change_pct` 合法 `null`（无前值时 Option=None → JSON null）触发 toFixed 崩溃。与 REST 客户端 `d.latest?.change_pct ?? 0` 归一化一致。

---

## 2. O1 修复（分时盘中自动刷新）

### 2.1 变更（web/src/features/dashboard/TimeshareChart.tsx）
- 组件签名加 `ws: WsClient` prop；`DashboardPage` 传 `ws`。
- 复用 `KlineDataFeed({ api, ws, code, period: '1m' })`（默认 pageSize=2 交易日），注册 `onChange`（初始加载/状态变化）与 `onRealtime`（bar append/update）回调 → `update()` 仅取当日 1m bar 重算 `computeTimeshare`。
- `feed.loadInitial()` 复用既有 REST；WS 由 feed 自动订阅 `bar:<code>:1m`，盘中新 bar 触发 `appendBar`/`updateBar` → 当日价格线+均价线实时前进。卸载时 `feed.dispose()` 释放订阅。
- 跨日/跨周期 bar 通过 `shanghaiDayKey` 日过滤忽略，仅当日线参与；`failed`/无数据三态保持。

### 2.2 组件卸载/换标的
- `useMemo([api, ws, code])` 使 `code` 变化即新建 feed；effect cleanup dispose 旧 feed（unsubscribe），新 feed 重新订阅 → 切标的/切 Tab 无订阅泄漏。

---

## 3. R1 记录（不修，待评审）

- 现象：本容器 cagg（5m/15m/1h/1d）仅回填 ~3 交易日，"翻 10-20 交易日"仅在 1m（merged 深历史）验证通过（tester §11 R1）。
- 处置：**记录为 backlog**（design/99-decisions-log.md），后续考察高周期向前分页是否需扩大 cagg 窗口或改按需聚合；不属于本轮修复范围（需后端回填/数据侧评估，超出前端组件）。
- 本轮不改动相关代码，仅落档。

---

## 4. 全帧契约核对（设计文档为准）

| 帧 | 后端 serde 输出 | 前端读取 | 结论 |
|---|---|---|---|
| bar | `{type,code,period,bar:{ts,open,high,low,close,volume,amount,source?}}`（BarDto 全单字） | `msg.bar`（Bar 全单字） | ✅ 一致（tester G16-G18 服务端同形状注入通过） |
| quote | ~~`change_pct`~~→ **`changePct`** | `msg.change_pct ?? msg.changePct` | ✅ 本次对齐 |
| health | `window_secs`/`sources`（snake） | `SourcesHealth.window_secs` | ✅ 一致（types.ts「不做驼峰转换」） |
| alert | `rule_id`/`fire_count`/`first_fired_at`/`level`/`status`（snake，level/status 小写 string） | `AlertEventItem`（snake） | ✅ 一致（ws.rs push_msg_alert_frame_shape 断言 `level:"critical"`/`status:"triggered"`） |

---

## 5. TDD 证据（红→绿）

| 测试 | red（改动前） | green（改动后） |
|---|---|---|
| 后端 `push_msg_quote_frame_camel_case`（ws.rs） | `v["changePct"]` 为 `Null`（当前输出 snake）→ FAIL | 输出 0.12 → PASS |
| 前端 `store.test.ts` `K1 容错：收到 snake_case change_pct 帧不崩` | `changePct` undefined ≠ 0.5 → FAIL | 0.5/0.6 → PASS |
| 前端 `TimeshareChart.test.tsx`（新增 3 项：mount/追加/同 ts 更新） | mount 通过，WS 追加/更新 2 项 FAIL（无订阅） | 3 项全 PASS |

---

## 6. 测试覆盖

- 后端新增：`ws.rs::tests::push_msg_quote_frame_camel_case`（断言 `changePct` 存在且 `change_pct` 不再输出）。
- 前端新增：
  - `store.test.ts`：`K1 容错：收到 snake_case change_pct 帧不崩、仍取到数值`（+camelCase 路径回归）。
  - `TimeshareChart.test.tsx`（新文件，3 用例）：mount 快照渲染/W S 新 bar 追加末值+均价前进/同 ts 当根替换（复用 `KlineDataFeed` 语义）。

---

## 7. 验证（命令运行）

| 命令 | 结果 |
|---|---|
| `entangled tangle` | 通过（ws.rs ↔ design/07-app-plane/00-web-api.md 一致；二次 run "Nothing to be done"） |
| `cargo test --workspace` | 通过（14 test binary，全部 ok；web lib 23 passed） |
| `cargo clippy --workspace --all-targets` | 通过（无 error/warning） |
| `npx tsc --noEmit`（web） | 通过（类型一致） |
| `npx vitest run`（web 全量） | 通过（22 files / 175 tests） |

> ⚠️ **e2e / 真实浏览器注入验证：未运行**——见 §8 残余风险。原因：运行容器 :8081 服务的是**旧打包资源**（`index-BeNyneSO.js`，与我本地 web/dist 哈希一致的旧版本），我的前端改动尚未重新构建/部署；重建 `web/dist` 会改写线上部署资产（超出 coder 本轮范围，且约束「其他项目 docker 禁碰」+ 不部署），故留给父级在合入部署后复测。本轮采用「单元+组件+类型+rust 全量」验证修复正确性；后端 serde 契约已由 Rust 单测直接锁定。

---

## 8. 残余风险

1. **真浏览器验证待部署后复测**（R2 收敛）：需重新构建前端并部署后，注入服务端同形状 snake_case quote 帧应**不崩**（前端兜底），注入 camelCase 帧正常更新；分时盘中推送 bar 帧末值/均价前进。本轮未做（未部署）。
2. **后端 serde camelCase 契约**：已由 `push_msg_quote_frame_camel_case` 单测锁定；但若未来改动 `PushMsg` 全局 serde 属性需复核 health/alert 不被动摇。
3. **quote `last` 字段**：默认为 `f64`（非 Option），服务端恒有值，未做空值兜底；本修复聚焦 K1 的 `change_pct`，未扩散改动。
4. **O1 盘中联动未实测**：基于 `KlineDataFeed`/`klinecharts` 现有实时链路（tester G16-G18 已验证 bar append/update 稳定），组件级测试覆盖；真盘需下一交易时段复核「停留分时页不切换」时价格线随新 1m bar 前进（R4 验收窗口）。
5. **分时 REST 由 `limit:480` 改为 feed 默认 `limit:482`**：功能等价（2 交易日），非行为回归；无测试断言 480。

---

## 9. 改动文件清单

- `design/07-app-plane/00-web-api.md`（事实源：ws.rs 代码块 + quote 帧形状 prose）
- `design/06-web/01-dashboard.md`（§3/§5 设计说明补充 K1/O1）
- `design/99-decisions-log.md`（K1/O1/R1 裁决记录）
- `crates/web/src/ws.rs`（tangle 生成）
- `web/src/features/dashboard/store.ts`
- `web/src/features/dashboard/store.test.ts`
- `web/src/features/dashboard/TimeshareChart.tsx`
- `web/src/features/dashboard/DashboardPage.tsx`
- `web/src/features/dashboard/TimeshareChart.test.tsx`（新增）

**未 stage**：无。本轮仅 `git add` 上列文件，未 commit。
