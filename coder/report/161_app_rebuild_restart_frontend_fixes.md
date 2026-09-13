# 161 — 重建前端并重启 8081/8082，让两处观感修复上线（运维车道）

- **报告自身路径（self-location）**：`coder/report/161_app_rebuild_restart_frontend_fixes.md`
- **仓库根**：`/home/eestock/workspace/git/eestock/eestock-rs`
- **HEAD**：`d74bfb8`（`docs(report): 两处观感问题的诊断/修复/独立验收报告 + 证据`）
- **上线改动**：`fix(web) 181c35a`（副图锚点重复分割线移除 + DCAP 副图常驻 0 参考线）+ 文档 `28046e1`/`d74bfb8`
- **后端**：自上次部署（20:31，HEAD `5a016cd`）以来 **Rust 零改动**（`cargo build -p app` 空跑，0.06s，见 §5）
- **结果**：**GREEN**（无回滚；0 失败项；2 条观察项见 §10）
- **旧 PID → 新 PID**：`2029836` → **`2102695`**（同一进程持有 8081 与 8082）
- **运行日志**：`logs/app_dev_8081_redeploy_20260913_212141.log`（`logs/` 已被 `.gitignore` 忽略）
- **回滚件**：`/tmp/eestock-app.rollback.20260913_212053`（未触发，按预案保留）

---

## 1. What changed（本次产生的副作用；未改任何源码 / 接口 / 配置契约）

| 产物 | 说明 |
|---|---|
| `/tmp/eestock-app.rollback.20260913_212053` | 停机前从 `/proc/2029836/exe` 复制的回滚件，sha256 `8eb98376…`（与在线 exe、磁盘二进制三者一致） |
| `web/dist/**`（重建） | 被 `web/.gitignore`（`dist/`）忽略，不入库；bundle `index-BcRLZ7uk.js` → `index-DGKMabUW.js` |
| `target/debug/eestock-app` | `cargo build -p app` 空跑，**二进制字节未变**（sha256 `8eb98376…`，`target/` 已忽略） |
| `logs/app_dev_8081_redeploy_20260913_212141.log` | 运行日志（`logs/` 已忽略） |
| `web/e2e/artifacts/livecheck/**` | 线上只读渲染取证脚本/截图/JSON（`web/e2e/.gitignore` → `artifacts/` 已忽略） |
| `coder/evidence/161_live_render_frontend_fixes/**` | 上述证据的持久化副本（未 `git add`） |
| 本报告 | 未 `git add` |

**git 暂存区为空**（`git diff --cached --name-only` 无输出）；全程未执行 `git add` / `commit` / `stash`。
**未触碰 8080(data) / 5433(timescaledb)**；未用 `./scripts/deploy.sh` / `compose up app`；除旧 PID `2029836`（= 8081/8082 本体）外未 kill 任何服务。

## 2. Architecture alignment

不涉及任何分层 / 接口 / 依赖方向改动。仅按既有装配口径重建前端 bundle 并从仓库根目录启动（`static_dir=./web/dist` 为相对路径，cwd 必须 = 仓库根，已核）。后端二进制未重建（`cargo build -p app` 空跑）。

## 3. Problem solved / feature added

在线 `web/dist` 此前停留在 HEAD `024b4e0`（20:32 构建），**早于 `181c35a` 两处前端修复**，故用户仍能看到：① K 线与 VOL 之间多一条不随 pane 移动的静线（`[data-region="sub-chart"]` 锚点 `border-t`）；② DCAP 副图缺少常驻 0 参考线。本轮重建前端使其上线。**证据**：修复前 bundle 引用 `index-BcRLZ7uk.js`，重建后 `index-DGKMabUW.js`（§4）；served 字节 == dist 字节（§7）。

## 4. Implementation approach

严格按技能 `rebuild-restart-app-8081`：形态确认 → sim-live 门禁 → 回滚件 → 前端 `npx tsc -b` + `npm run build:prod` → 后端 `cargo build -p app`（空跑）→ `kill` + 仓库根 `nohup` 重启 → 冒烟 → **线上只读渲染取证**（§8）。

## 5. Test coverage

- **未新增/修改仓库内测试**（运维任务；`web/src`、`design`、`web/e2e/dashboard-pane-separator.e2e.ts` 工作树与 `181c35a` 逐字节一致，`git status` 无输出）。
- **运行了既有 e2e** `web/e2e/dashboard-pane-separator.e2e.ts` 对**线上 8081**：**1 passed / 0 failed**（§8.1）。
- **新增一次性线上取证脚本**（仅落在 gitignored 的 `web/e2e/artifacts/livecheck/`，不入库）：`verify_live.mjs` 对线上 8081 做 24 条真实渲染断言，**24/24 passed**（§8.2）。

## 6. Verification（原始输出，逐步）

### 6.1 形态确认（停机前）

```
HEAD d74bfb8   （工作树与 181c35a 对 web/src、web/e2e、design 一致）
ss -lntp | grep -E ':8081|:8082'
LISTEN 0 128 0.0.0.0:8081 ... users:(("eestock-app",pid=2029836,fd=11))
LISTEN 0 128 0.0.0.0:8082 ... users:(("eestock-app",pid=2029836,fd=12))

readlink /proc/2029836/cwd        → /home/eestock/workspace/git/eestock/eestock-rs   ✓（= 仓库根）
tr '\0' ' ' < /proc/2029836/cmdline → ./target/debug/eestock-app --config /tmp/app_dev_8081.toml   ✓
readlink /proc/2029836/exe        → .../target/debug/eestock-app（未 unlink）
sha256 /proc/2029836/exe          → 8eb98376daf76381b335183714ecf94e191d256774a0b33b8e0fea00a2e367cf
sha256 target/debug/eestock-app   → 8eb98376daf76381b335183714ecf94e191d256774a0b33b8e0fea00a2e367cf（== 在线）
```
配置 `/tmp/app_dev_8081.toml`：`listen=0.0.0.0:8081`、`mcp_listen=0.0.0.0:8082`、`static_dir=./web/dist`、DB=`127.0.0.1:5433/eestock`。**一个进程同时持有 8081 与 8082**。

### 6.2 停机门禁（停手条件：无）

`GET http://127.0.0.1:8081/api/sim-live/sessions` → 12 条，`statuses=['ended']`，`non_ended=[]` ⇒ **无运行态，允许停机**（与任务前提一致）。

### 6.3 回滚件

```
cp /proc/2029836/exe /tmp/eestock-app.rollback.20260913_212053
sha256 → 8eb98376daf76381b335183714ecf94e191d256774a0b33b8e0fea00a2e367cf   OK
-rwxrwxr-x 1 eestock eestock 206210368  /tmp/eestock-app.rollback.20260913_212053
```

### 6.4 前端重建（bundle 哈希必须变化 —— 实测变化）

```
cd web && npx tsc -b           → TSC_EXIT=0
cd web && npm run build:prod   → BUILD_EXIT=0
     vite v6.4.3, 171 modules transformed, built in 1.70s
     dist/assets/index-DGKMabUW.js   1,176.43 kB │ gzip: 362.67 kB
     dist/assets/index-Cm6bbPuq.css     22.01 kB │ gzip:   5.58 kB
     （仅提示 chunk > 500kB 的常规告警，非错误）

BEFORE  index.html → /assets/index-BcRLZ7uk.js   index.html sha256 db5320b4…
        JS  sha256 119484839a89d0be6e4ce39f9b53dd340d127e9d3b572a03112e7ca8c7d29cb0
AFTER   index.html → /assets/index-DGKMabUW.js   index.html sha256 32a33a54…
        JS  sha256 7a05ea2f56e1f2a3d0266b2164fb01c082ec8b726709ee607a324c0ecb867df0
        CSS sha256 698283dfab325cb2e1ee90c69755fe10bb73280283020d59128f908a2b04e688（未变）
JS 哈希变化 → ✓（前端确有修复上线）；dist/assets 下旧 JS 已被清除，仅余新 JS + CSS。
```

**bundle 内两处修复痕迹（正向取证）**：

```
① sub-chart 锚点（无 border-t）：
   data-region="main-chart",className:"relative min-h-0 flex-1",
   children: div{"data-region":"sub-chart","className":"pointer-events-none absolute inset-x-0 bottom-0 h-1/5"}

② DCAP 第 4 figure（常驻 0 线，细灰虚线 #76808F）：
   gm="DCAP",M$=5,A$="zero",$$="0: ",
   Q$={color:"#76808F",style:"dashed",size:1,dashedValue:[4,4],smooth:!1}
   figures:[{key:"s",…},{key:"m",…},{key:"l",…},{key:A$,title:$$,type:"line",styles:()=>Q$}]
```

### 6.5 后端重建（预期空跑 —— 实测空跑）

```
cd 仓库根 && cargo build -p app
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.06s
CARGO_EXIT=0
sha256 target/debug/eestock-app → 8eb98376daf76381b335183714ecf94e191d256774a0b33b8e0fea00a2e367cf（未变）
```
⇒ 印证「Rust 自 `5a016cd` 零改动」；本次上线**仅前端**。

### 6.6 重启

```
kill 2029836 → kill_rc=0; sleep 3
   ss -lntp | grep ':8081|:8082' → 无监听
   PID 2029836 gone
cd /home/eestock/workspace/git/eestock/eestock-rs
nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml >> logs/app_dev_8081_redeploy_20260913_212141.log 2>&1 &
新 PID 2102695 同时持有 8081 与 8082
readlink /proc/2102695/cwd     → /home/eestock/workspace/git/eestock/eestock-rs   ✓
tr '\0' ' ' < /proc/2102695/cmdline → ./target/debug/eestock-app --config /tmp/app_dev_8081.toml   ✓
sha256 /proc/2102695/exe       → 8eb98376…（== 磁盘二进制）   ✓
SigIgn: 0x1001（bit1 = SIGHUP 已忽略，nohup 生效）
```

**启动日志全文（0 ERROR / 0 WARN）**：

```
{"…","level":"INFO","fields":{"message":"eestock-app starting","config":"/tmp/app_dev_8081.toml"},"target":"eestock_app"}
{"…","level":"INFO","fields":{"message":"schema self-check ok"},"target":"eestock_app"}
{"…","level":"INFO","fields":{"message":"strategy registry 启动播种完成","seeded":"0","skipped":"0"},"target":"eestock_app"}
{"…","level":"INFO","fields":{"message":"sim-live 启动恢复完成","recovered":"0","degraded":"0"},"target":"eestock_app"}
{"…","level":"INFO","fields":{"message":"eestock-app serving","listen":"0.0.0.0:8081","static_dir":"./web/dist"},"target":"eestock_app"}
{"…","level":"INFO","fields":{"message":"mcp server (HTTP/SSE) serving","listen":"0.0.0.0:8082"},"target":"mcp::server"}
{"…","level":"INFO","fields":{"message":"mcp sse session opened","session":"…"},"target":"mcp::server"}
ERROR 计数 = 0；WARN 计数 = 0
```

### 6.7 冒烟（逐项原始输出）

| 项 | 结果 |
|---|---|
| `GET /healthz` | `{"status":"ok"}` **HTTP:200** |
| `GET /api/config/kline` | `{"viewport_bars":120}` **HTTP:200** |
| `GET /api/config/dcap` | `{"n_s":8,"n_m":26,"n_l":60,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":0,"m":3}` **HTTP:200** —— keys 计数 **8**、**无 `th`** ✓（注：`smooth=0`，见 §10 观察项 O1） |
| `GET /api/symbols` | **HTTP:200**，`count=44`（首项 `518880 华安黄金易ETF`） |
| `GET /api/kline?code=518880&period=15m&limit=3` | **HTTP:200**，3 根 `source:"tushare"` bar（`2026-09-11T06:30/06:45/07:00`，close 8.938/8.942/8.943） |
| `GET /` 的 bundle | `index-DGKMabUW.js` + `index-Cm6bbPuq.css` **==** `web/dist/index.html` 引用 ✓ |
| served vs dist 字节 | JS `7a05ea2f…` == `7a05ea2f…` ✓；CSS `698283df…` == `698283df…` ✓；index.html `32a33a54…` == `32a33a54…` ✓（`HTTP:200 type:text/javascript` / `type:text/css`） |
| 启动日志 ERROR | **0**（§6.6） |

## 7. 线上两处修复的渲染级取证（本轮核心）

> 说明：tester 048 的 18/18 脚本依赖 `window.__CHARTS__`（由 klinecharts 模块 spy 注入），该 spy 只存在于**临时 vite 构建**（`/tmp/accept/dist`），线上真实 bundle 无此 spy ⇒ 原脚本**不能直接指向线上实例**。故本轮采用两条互证的线上路径，均为**真实 served bundle + 真实 klinecharts 10.0.3 渲染**、**只读**（拦截并 abort 任何非 GET，末尾断言 0 条）。

### 7.1 既有 e2e 对线上 8081

```
cd web && E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/dashboard-pane-separator.e2e.ts
  ✓ 1 [chromium] › e2e/dashboard-pane-separator.e2e.ts:141:3 › 问题①…
  → 1 passed (5.3s)   E2E_EXIT=0
```
覆盖 ①（`sub-chart` 锚点 `borderTopWidth==0px` 且 stray 线 == []）、③（拖高 VOL 后分隔线随 pane 移动、无僵线）、DCAP 开/关分隔线 1↔2、以及「全程 0 条非 GET」。

### 7.2 线上只读渲染取证脚本（`verify_live.mjs`，24/24）

Chart 实例经 **React fiber**（`[k-line-chart-id]` 宿主元素的 `__reactFiber$`，祖先 `KLineChart` 组件 hook#1.current）取得（只读），断言语义对齐 tester 048 的 18 条：

```
cd web && BASE=http://127.0.0.1:8081 node e2e/artifacts/livecheck/verify_live.mjs
  PASS ①-1 默认态：klinecharts 分隔线恰 1 条
  PASS ①-2 默认态：主图区无残留全宽横线（stray == []）
  PASS ①-3 sub-chart 锚点 borderTopWidth == 0px（不再画线）
  PASS ①-4 sub-chart 锚点：border 宽 0 且背景透明、无 border-t 类（不画线）
  PASS ②-0 DCAP 关闭态：无 DCAP 指标/pane
  PASS ②-1 figKeys == s/m/l/zero 且 precision == 5
  PASS ②-2 每根 bar zero 恒 = 0
  PASS ②-3 真实数据：三线跨越 0（min<0<max）
  PASS ②-4 真实数据：副图 Y 轴范围含 0
  PASS ②-5 真实数据：0 线 y == pane 内 y(0)，且落在 pane 内
  PASS ②-6 真实数据：y(0) 行渲染出 #76808F 虚线像素
  PASS ①-5 DCAP 开：分隔线恰 2 条（candle|VOL|DCAP）
  PASS ①-6 DCAP 开：主图区仍无残留全宽横线
  PASS ③-1 拖高 VOL 后分隔线条数不变（2）
  PASS ③-2 拖高 VOL 后分隔线随 pane 上移（top 减少 >50px）
  PASS ③-3 拖高 VOL 后无僵线（stray == []）
  PASS ②-7 形态①(全正)：三线全为正（min>0）
  PASS ②-8 形态①(全正)：Y 轴范围仍含 0（range.from ≤ 0 < dataMin）
  PASS ②-9 形态①(全正)：0 线 y == y(0) 且在 pane 内
  PASS ②-10 形态①(全正)：y(0) 行渲染出 #76808F 虚线像素
  PASS ②-11 数据不足：三条数据线全 null（断线）
  PASS ②-12 数据不足：zero 仍每根 bar 返回 0
  PASS ②-13 数据不足：Y 轴含 0 且 0 线渲染在 y(0)
  PASS 只读保证：全程 0 条非 GET 请求
  → live 8081: 24/24 passed; failed=0; nonGet=0   LIVE_EXIT=0
```

**关键量化数字（`live-results.json`）**：

| 形态 | dataMin / dataMax | Y 轴 range | y0 | yAxis y(0) | paneH | `#76808F` 像素 | 虚线 x 间距集 |
|---|---|---|---|---|---|---|---|
| 真实数据（182 bars，m/l 负、s 正，跨 0） | −0.03002 / +0.01916 | [−0.02245, +0.02525]（含 0） | **53** | **53** | 100 | **443** | {1,4,5,6,7} |
| 全正数据（200 bars） | +0.00888 / +0.13503 | [−0.01163, +0.13960]（含 0） | **92** | **92** | 100 | **435** | {1,6} |
| 数据不足（5 bars，三线全 null） | 无（dataNonNull=0） | [−4.8e−5, +5.6e−5]（含 0） | **54** | **54** | 100 | **18** | {1,6} |

⇒ **② 三线常驻 0 线在线上可见**：`y0 == yAxis y(0)`（三形态均相等）、`zero` 每根 bar 恒 0、Y 轴自动标度恒含 0、y(0) 行渲染出 `#76808F` 虚线像素（间距 {1,4,5,6,7} 体现 `dashedValue:[4,4]` 的虚线段+间隙）。

**① 锚点与残留线（DOM 计算样式，线上实测）**：

| 状态 | klinecharts 分隔线 | 残留全宽线 | `sub-chart` 锚点 |
|---|---|---|---|
| DCAP 关 | 1 条 @ top=597 `rgb(221,221,221)` | **[] 空** | class `pointer-events-none absolute inset-x-0 bottom-0 h-1/5`（**无 border-t**）、`borderTopWidth=0px`、`background=rgba(0,0,0,0)` |
| DCAP 开 | 2 条 @ 496 / 597 | **[] 空** | 同上 |
| 拖高 VOL（−120px）后 | 2 条 @ **386** / 597（上分隔线随 pane 上移 110px） | **[] 空** | 同上 |

⇒ **①「多出来的那条不随 pane 移动的静线」已消失**；candle↔VOL 边界由 klinecharts 自身分隔线提供（可拖动、随 pane 走）；**③ 把 VOL 拉高后无僵线**。

**证据文件**：`coder/evidence/161_live_render_frontend_fixes/`（`live-results.json`、`verify_live.mjs`、`live-issue2-*.png`、`live-issue1-after-drag.png`、`crop-live-issue2-*.png`）。运行副本（gitignored）在 `web/e2e/artifacts/livecheck/`。
**注意**：证据目录中的 `live-*.png` 为整页截图，`crop-live-issue2-*.png` 为 DCAP 副图裁图（含 0 线）。

### 7.3 与 tester 048「临时实例 18/18」结论的关系（限制说明）

- 本轮线上取证为 **24 条真实渲染断言全绿**，断言口径覆盖 tester 048 的 18 条（含 ②-5/②-9/②-13 的 `y==y(0)` 与 ②-6/②-10/②-14 的 `#76808F` 像素计数），且 served bundle 与 dist **逐字节一致**（§6.7）⇒ 线上渲染所用字节 == 已通过 18/18 的同一构建字节。
- 差异仅在取证手段：tester 048 用 klinecharts 模块 spy 注入 `window.__CHARTS__`；本轮线上无 spy，改用 **React fiber 取真实 chart 实例**（同一 klinecharts 10.0.3 公共 API：`getIndicators`/`getYAxes`/`convertToPixel`/`getSize`/`getDom`），对产品的只读性更强（未向页面注入任何产品代码）。

## 8. 失败即回滚

未触发（§6.7、§7 全部关键项 PASS）。回滚件 `/tmp/eestock-app.rollback.20260913_212053` 按预案保留。

## 9. 收尾状态

```
ss -lntp | grep ':8081|:8082' → pid=2102695 持有 8081 与 8082
readlink /proc/2102695/cwd → /home/eestock/workspace/git/eestock/eestock-rs
sim-live 会话 → 12 条全 ended（non_ended=[]）
git diff --cached --name-only → 空（无暂存文件）
git status --porcelain web/src design web/e2e/dashboard-pane-separator.e2e.ts → 空（前端并未被本次改动：dist 走 .gitignore）
```

## 10. 观察项（仅报告，未动手）

- **O1（配置现状）**：`GET /api/config/dcap` 现为 `smooth=0`（其余为默认值）。默认应为 `smooth=1`（bundle 内 `Jr={…,smooth:1,…}`）。本轮**未发任何 PUT**（冒烟只用 GET；渲染取证脚本已断言 0 条非 GET）⇒ 该值是本轮之前既已持久化的状态，**非本轮改动所致**；重启不重置已存配置（其余字段一读即为非默认组合，说明未被写回默认）。如需回到 `smooth=1`，请在下一轮显式决定。
- **O2（残留包装 shell）**：启动命令的包装 `/bin/bash`（PID `2102692`，已 reparent 到 init，无监听端口）仍在，为工具侧执行壳残留；**应用进程 2102695 已 nohup 独立**（`SigIgn` 含 SIGHUP）。按纪律「除 8081/8082 外不 kill」，本轮**未清理**该壳；不影响服务。
- **O3（沿用）**：`strategy registry 启动播种完成 seeded=0/skipped=0`（策略表非空则整轮跳过播种）——与上一轮 159 报告一致，非本轮范围；图表指标不依赖策略表。
