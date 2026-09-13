# 159 — 重建并重启 8081/8082，让 dcap 在本机生效（运维车道）

- **报告自身路径**：`coder/report/159_app_rebuild_restart_dcap.md`
- **仓库根**：`/home/eestock/workspace/git/eestock/eestock-rs`
- **HEAD**：`024b4e0 chore(git): 忽略运行期 logs/（并说明为何不用 *.log 通配）`
- **执行技能**：`.pi` 项目记忆技能 `rebuild-restart-app-8081`
- **结果**：**GREEN**（无回滚；1 条已知部署缺口仅报告不动手）

---

## What changed

本任务为**运维车道**，未改动任何源码 / 接口 / 配置契约。仅产生以下副作用：

| 产物 | 说明 |
|---|---|
| `/tmp/eestock-app.rollback.20260913_203155` | 停机前从 `/proc/1315848/exe` 复制的回滚件（sha256 `4cd7530bbe92ab5de12e41dbb1f758ddf36b11f7cf3a4501338328f6e6b139e3`） |
| `web/dist/**`（重建） | 被 `web/.gitignore` 忽略，不入库 |
| `target/debug/eestock-app`（重建） | 构建产物，不入库 |
| `logs/app_dev_8081_redeploy_20260913_203223.log` | 运行日志，`logs/` 已被 `.gitignore` 忽略 |
| 本报告 | 未 `git add` |

**git 暂存区为空**（`git diff --cached --name-only` 无输出）；全程未执行 `git add/commit/stash`。

## Architecture alignment

不涉及任何分层/接口改动。仅按既有装配口径重建二进制并从仓库根目录（`static_dir=./web/dist` 相对路径成立）重启。

## Problem solved / feature added

在线二进制（17:33 构建，sha256 `1a2f1b4e…`，其运行中 inode 已被后续构建 unlink，表现为 `/proc/<pid>/exe → (deleted)`）**早于 dcap P3 提交**，导致 `/api/config/dcap` 返回 404、前端 bundle 无 DCAP 指标。本轮重建前端 bundle + 后端 debug 二进制并原口径重启，使 dcap 在本机生效。

## Implementation approach

严格按技能 `rebuild-restart-app-8081` 流程：形态确认 → sim-live 门禁 → 回滚件 → 前端 `npx tsc -b` + `npm run build:prod` → 后端 `cargo build -p app`（debug）→ `kill` + `nohup` 重启 → 冒烟 → dcap 专项验收。

## Test coverage

未新增/修改测试（运维任务）。前端仓库内既有 dcap 测试未被触碰。

## Verification

见下「原始证据」段。全部关键项 PASS：

- `/healthz` 200、启动日志 0 ERROR / 0 WARN
- 静态资源 served sha256 == dist sha256（JS 与 CSS 均一致）
- `/api/config/dcap` 8 参、无 `th`；合法 PUT 200+读回一致；非单调 n → 400；`n_s=1` / `m=61` 越界 → 400；**已回写原值 `8/26/60/1/1/1/1/3` 并读回一致**
- 前端 bundle 含 DCAP 注册与参数面板痕迹；阴性对照无命中
- 行情接口 15m 多标的正常

---

## 已知部署缺口（仅报告，不动手）

**播种门禁为「策略表非空则整体跳过」。**

`crates/application/src/strategy.rs::seed_reference_plugins` 首行：

```rust
if self.store.count_strategies().await? > 0 {
    return Ok(SeedReport { seeded: 0, skipped: 0 });
}
```

- 第 8 条参考插件 `dcap` 确实存在于 `crates/strategy-core/src/reference.rs`（`id: "dcap"`，`code: include_str!("../reference-plugins/dcap.js")`，清单顺序 `dual_ma, ma_rsi, macd, boll, kdj, momentum, atr_channel, dcap`）。
- 但本机 `strategy` 表非空（23 条：11 条种子 + probe-* 挖矿行 + 其它），故整轮播种被跳过 —— 本次启动日志实测 `"strategy registry 启动播种完成","seeded":"0","skipped":"0"`。
- 后果：`/api/strategies/manage` 与 `/api/strategies` 中**不会出现 dcap 条目**（实测 23 条，`has_dcap: False`）。
- **图表指标不受影响**：前端副图走 `GET /api/config/dcap` + 前端自算（`web/src/features/indicators/dcap.ts` / `dcapIndicator.ts`，bundle 内实测有 DCAP 注册痕迹），不依赖策略表。

---

## 原始证据

### 1. 形态确认（停机前）

```
HEAD 024b4e0
ss -lntp | grep -E ':8081|:8082'
LISTEN 0 128 0.0.0.0:8081 ... users:(("eestock-app",pid=1315848,fd=11))
LISTEN 0 128 0.0.0.0:8082 ... users:(("eestock-app",pid=1315848,fd=12))

readlink /proc/1315848/cwd   → /home/eestock/workspace/git/eestock/eestock-rs
tr '\0' ' ' < /proc/1315848/cmdline → ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
readlink /proc/1315848/exe   → /home/eestock/workspace/git/eestock/eestock-rs/target/debug/eestock-app (deleted)
sha256 /proc/1315848/exe     → 4cd7530bbe92ab5de12e41dbb1f758ddf36b11f7cf3a4501338328f6e6b139e3
disk binary sha256           → 1a2f1b4e10cfae01247ed6b537045e9a41920a45376a71ee6983625ef8de84c6 (17:33)
OLD GET /api/config/dcap     → {"error":"not found"} HTTP:404   ← 旧二进制无 dcap
```

### 2. 停机门禁

`GET http://127.0.0.1:8081/api/sim-live/sessions` → 12 条，`statuses: ['ended']`，`non_ended: []`。无运行态，允许停机。

### 3. 回滚件

```
cp /proc/1315848/exe /tmp/eestock-app.rollback.20260913_203155
sha256 → 4cd7530bbe92ab5de12e41dbb1f758ddf36b11f7cf3a4501338328f6e6b139e3  （与在线 exe 一致）
```

### 4. 前端重建

```
npx tsc -b            → TSC_EXIT=0
npm run build:prod    → BUILD_EXIT=0  （vite v6.4.3, 171 modules, built in 1.86s）

index.html bundle BEFORE: /assets/index-D6ir823G.js   (index.html sha256 94b0d1a3…)
index.html bundle AFTER : /assets/index-BcRLZ7uk.js   (index.html sha256 db5320b4…)
JS  sha256 → 119484839a89d0be6e4ce39f9b53dd340d127e9d3b572a03112e7ca8c7d29cb0
CSS sha256 → 698283dfab325cb2e1ee90c69755fe10bb73280283020d59128f908a2b04e688
```

### 5. 后端重建

```
cargo build -p app → CARGO_EXIT=0（Compiling mcp/web/app, Finished dev in 2.81s）
新二进制 sha256 8eb98376daf76381b335183714ecf94e191d256774a0b33b8e0fea00a2e367cf  (20:32)
```

### 6. 重启

```
kill 1315848 → rc=0; sleep 3 → ss 无监听
nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml >> logs/app_dev_8081_redeploy_20260913_203223.log 2>&1 &
新 PID 2029836 同时持有 8081 与 8082
readlink /proc/2029836/cwd → /home/eestock/workspace/git/eestock/eestock-rs  ✓
cmdline → ./target/debug/eestock-app --config /tmp/app_dev_8081.toml  ✓
/proc/2029836/exe sha256 → 8eb98376… （== 磁盘二进制）
```

### 7. 冒烟

| 项 | 结果 |
|---|---|
| `GET /healthz` | `{"status":"ok"}` HTTP:200 |
| 启动日志 ERROR/WARN | `0` / `0` |
| `GET /api/config/kline` | `{"viewport_bars":120}` HTTP:200 |
| `PUT kline {240}` | `{"viewport_bars":240}` HTTP:200，读回一致 |
| `PUT kline {0}` | `{"error":"viewport_bars 须为 30..=600 整数，收到 0"}` HTTP:400 |
| `PUT kline {99999}` | `{"error":"viewport_bars 须为 30..=600 整数，收到 99999"}` HTTP:400 |
| 回写 `{120}` | HTTP:200，读回 `120` |
| served bundle == dist | `BUNDLE_MATCH=YES` (`/assets/index-BcRLZ7uk.js`) |
| served JS sha256 == dist | `11948483…` == `11948483…` ✓ |
| served CSS sha256 == dist | `698283df…` == `698283df…` ✓ |

### 8. dcap 专项

```
8a GET /api/config/dcap（原值，改动前记录）
   {"n_s":8,"n_m":26,"n_l":60,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":1,"m":3}
   keys: [m, n_l, n_m, n_s, r_l, r_m, r_s, smooth]  count=8  has_th=False  ✓

8b-i  PUT {10,30,80,1.2,1.5,1.8,smooth=0,m=5} → 200，读回逐字段一致  ✓
      （附：先试 smooth=2 被正确拒绝 400「smooth 须为 0 或 1，收到 2」）
8b-ii PUT 非单调 n {26,26,8,…} → 400 {"error":"须满足 n_s < n_m < n_l，收到 26/26/8"}
8b-iii PUT n_s=1（越界）     → 400 {"error":"n_s 须为 2..=250 整数，收到 1"}
8b-iv  PUT m=61（越界）      → 400 {"error":"m 须为 1..=60 整数，收到 61"}
8b-v 读回（拒绝后不受污染）  → 原值不变
8b-final PUT 回原值 → 200；读回 {"n_s":8,"n_m":26,"n_l":60,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":1,"m":3}
      RESTORE_OK=YES  ✓

8c 前端生效证据（web/dist/assets/index-BcRLZ7uk.js）
   POSITIVE grep 'DCAP' → 13 命中，片段：
     const gm="DCAP",M$=5,vm=2,Om=250,xm=.5,ym=2,bm=1,wm=60,Jr={n_s:8,n_m:26,…
     K$=[{key:"n_s",label:"DCAP 短窗口 n_s"},{key:"n_m",label:"DCAP 中窗口 n_m"},…
     J$=[{key:"r_s",label:"DCAP 短窗增长比 r_s"},{key:"r_m",…},{key:"m",…}]
     aria-label:"DCAP 参数" / aria-label:"DCAP 配置"  （面板 + 工具栏入口）
   NEGATIVE CONTROL grep 'ZZQ_NOT_A_REAL_NAME' → 0 命中（grep_exit=1）  ✓

8d 行情接口
   GET /api/kline?code=518880&period=15m&limit=3 → 200，3 根 tushare bars
   （另 510880/510050/159985 均 200 且有 bars）
```

### 9. 回滚

未触发（第 7、8 步全部 PASS）。回滚件按预案保留在 `/tmp/eestock-app.rollback.20260913_203155`。

### 10. 收尾状态

```
ss -lntp | grep ':8081|:8082' → pid=2029836 持有两端口
ps | grep eestock-app → 仅 2029836（无残留包装 shell / 无额外常驻服务）
git diff --cached --name-only → 空（无暂存文件）
sim-live 会话 → 12 条全 ended
```
