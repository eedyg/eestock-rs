# 164 — 重建前端并重启 8081/8082，上线三处前端修复（运维车道）

- **报告自身路径（self-location）**：`coder/report/164_app_rebuild_restart_three_fixes.md`
- **仓库根**：`/home/eestock/workspace/git/eestock/eestock-rs`
- **HEAD**：`6391a4d`（`docs(report): 切 period/stock 布局重置 —— 诊断 + 修复 + 独立验收报告与证据`）
- **上线改动（纯前端）**：`181c35a`（① 分割线+0 线）、`7949c0b`（② 保存参数不重建 pane）、`5d8eff4`（③ 切 period/stock 不重置布局）
- **后端**：`crates/` 自上次部署 `5a016cd` 以来 **零改动**（`git diff --stat 5a016cd..HEAD -- crates/` 为空）⇒ `cargo build -p app` 空跑（0.13s，含 3 处修复的源码 `git status` 干净）
- **PID 迁移**：`2102695`（旧，在线） → **`2948632`**（新，同时持有 8081 与 8082）
- **运行日志**：`logs/app_dev_8081_redeploy_20260914_100042.log`（`logs/` 已被 `.gitignore` 忽略）
- **配置基线**：`kline/dcap/ma` 三份 **部署前 == 部署后 == 架构师基线**（逐字节），**PASS**
- **渲染取证**：线上只读探针 **65/65 passed**；既有 e2e 对线上 8081 **1 passed**
- **回滚**：**未触发**（0 关键项失败）；回滚件 `/tmp/eestock-app.rollback.20260914_100000`（sha256 `8eb98376…`）按预案保留
- **末行结论**：见 §12

---

## 1. What changed（本次产生的副作用；未改任何源码 / 接口 / 配置契约 / 未 git add）

| 产物 | 说明 |
|---|---|
| `/tmp/eestock-app.rollback.20260914_100000` | 停机前从 `/proc/2102695/exe` 复制的回滚件，sha256 `8eb98376daf76381b335183714ecf94e191d256774a0b33b8e0fea00a2e367cf`（与在线 exe、磁盘二进制三者一致） |
| `web/dist/**`（重建） | 被 `web/.gitignore`（`dist/`）忽略，不入库；bundle `index-DGKMabUW.js` → **`index-CzeoM0It.js`**（CSS 未变） |
| `target/debug/eestock-app` | `cargo build -p app` 空跑，**二进制字节未变**（`target/` 已忽略） |
| `logs/app_dev_8081_redeploy_20260914_100042.log` | 运行日志（`logs/` 已忽略） |
| `web/e2e/artifacts/livecheck/{verify_live_deploy.mjs,live-deploy-results.json,live-deploy-*.png}` | 线上只读渲染取证（`web/e2e/.gitignore` → `artifacts/` 已忽略） |
| `coder/evidence/164_live_redeploy_three_fixes/**` | 上述证据的持久化副本（未 `git add`） |
| 本报告 | 未 `git add` |

**git 暂存区为空**（`git diff --cached --name-only` 无输出）；全程未执行 `git add` / `commit` / `stash`；未用 `scripts/deploy.sh`；未碰 8080（data）/ 5433（timescaledb）；除旧 PID `2102695`（= 8081/8082 本体）外未 kill 任何服务。**未向线上发任何写请求**（`PUT /api/config/dcap` ×2 全在浏览器侧本地兑现）。

## 2. Architecture alignment

不涉及分层 / 接口 / 依赖方向改动。仅按既有装配口径重建前端 bundle，并从**仓库根**启动（`static_dir=./web/dist` 为相对路径 ⇒ cwd 必须 = 仓库根，已核 `/proc/2948632/cwd`）。后端二进制未重建（cargo 空跑，sha 未变）。符合 `design/06-web/01-dashboard.md` + ADR-020/021 的既有图表契约（本轮修复已由 162/163 报告落为文档契约）。

## 3. Problem solved / feature added

线上 `web/dist` 此前停留在 `181c35a` 之前的构建（`index-DGKMabUW.js`），用户仍能看到：① K 线与 VOL 之间多一条不随 pane 移动的静线、DCAP 副图缺常驻 0 线；② 保存 dcap 参数后 pane 高度被重置；③ 切 period / 切 stock 后指标视图布局被重置。本轮**重建前端上线三处修复**（后端零改动）。

## 4. Implementation approach

严格按项目技能 `rebuild-restart-app-8081`：形态确认 → sim-live 门禁 → 回滚件 → 前端 `npx tsc -b` + `npm run build:prod` → 后端 `cargo build -p app`（空跑）→ `kill` + 仓库根 `nohup` 重启 → 冒烟（逐项）→ **线上只读渲染取证**。

**取证手段的关键决定（不改产品代码的前提下取得线上证据）**：
- 线上 bundle 无 kc-spy（spy 只存在于临时构建），故 chart 实例经 **React fiber** 取得（只读）；
- ③ 的「init 计数不递增」在线上可直接由 klinecharts 自身暴露的 **`chart.id = k_line_chart_<N>`**（模块级 `chartBaseId` 单调递增，`dist/index.esm.js` `init()`）判定是否 remount —— 无需任何注入；
- ② 的「线值按新参数更新」用**离线 oracle**：Node 侧 esbuild 转译**仓库内同一份 CORE**（`web/src/features/indicators/dcap.ts`）重算，与线上 result 逐点比对（浮点全等）；
- ② 的保存路径**只走浏览器侧本地兑现**：Playwright `route` 拦截 `PUT /api/config/dcap`、记录 body 并本地 `fulfill`，且保存后 GET 配置读浏览器侧镜像 ⇒ **零后端写入**（脚本尾部 Node 直连复读配置，仍与基线逐字节一致）。

## 5. Test coverage

- **未新增/修改仓库内测试**（运维任务）：`web/src`、`web/e2e`、`design` 工作树与 HEAD 逐字节一致（`git status --porcelain -- web/src web/e2e design` 为空）。
- **运行了既有 e2e** `web/e2e/dashboard-pane-separator.e2e.ts` 对**线上 8081**：**1 passed / 0 failed**（该用例只发 GET）。
- **新增一次性线上取证脚本**（只落在 gitignored 的 `web/e2e/artifacts/livecheck/`，不入库）：`verify_live_deploy.mjs` 对线上 8081 做 65 条真实渲染断言 —— **65/65 passed**，`nonGetOther=0`、`pageErrors=0`。
- **未运行** `e2e/dashboard-periods-ma.e2e.ts`：其 T5 会对 `/api/config/ma` 发 **PUT** ⇒ 违反「禁任何线上写请求」，故排除（理由已记录）。

## 6. Verification（原始输出，逐步）

### 6.1 形态确认（停机前，10:00 +0800）
```
$ git log --oneline -1
6391a4d docs(report): 切 period/stock 布局重置 —— 诊断 + 修复 + 独立验收报告与证据
$ git status --porcelain -- web/src web/e2e design   → 空（工作树与 HEAD 一致）
$ git diff --stat 5a016cd..HEAD -- crates/           → 空  ← 后端 Rust 零改动

$ ss -lntp | grep -E ':8081|:8082'
LISTEN 0 128 0.0.0.0:8081 ... users:(("eestock-app",pid=2102695,fd=11))
LISTEN 0 128 0.0.0.0:8082 ... users:(("eestock-app",pid=2102695,fd=12))
$ readlink /proc/2102695/cwd        → /home/eestock/workspace/git/eestock/eestock-rs     ✓（= 仓库根）
$ tr '\0' ' ' < /proc/2102695/cmdline → ./target/debug/eestock-app --config /tmp/app_dev_8081.toml  ✓
$ sha256sum /proc/2102695/exe target/debug/eestock-app
8eb98376daf76381b335183714ecf94e191d256774a0b33b8e0fea00a2e367cf  /proc/2102695/exe
8eb98376daf76381b335183714ecf94e191d256774a0b33b8e0fea00a2e367cf  target/debug/eestock-app   ✓
```
`/tmp/app_dev_8081.toml`：`listen=0.0.0.0:8081`、`mcp_listen=0.0.0.0:8082`、`static_dir=./web/dist`、DB=`127.0.0.1:5433/eestock`。**一个进程同时持有 8081 与 8082**。

### 6.2 停机门禁（停手条件：无）
```
$ curl -s http://127.0.0.1:8081/api/sim-live/sessions → HTTP:200
count 12 statuses ['ended'] non_ended []
```
停机前 10:00:42 复检（kill 前最后一次）同样 `count 12 / statuses ['ended'] / non_ended []` ⇒ **无运行态，允许停机**（与架构师前提一致）。

### 6.3 回滚件
```
$ cp /proc/2102695/exe /tmp/eestock-app.rollback.20260914_100000
$ sha256sum → 8eb98376daf76381b335183714ecf94e191d256774a0b33b8e0fea00a2e367cf   OK
-rwxrwxr-x 206210368  /tmp/eestock-app.rollback.20260914_100000
```
（因 crates 零改动，回滚二进制与部署二进制同 sha ⇒ 后端侧无版本差；真正的「前端回滚件」是上一版 bundle：**`/tmp/kl_pre/dist`（index.html `32a33a54…` / `index-DGKMabUW.js` `7a05ea2f…`）与本轮部署前的线上 `web/dist` 逐字节相同**，已核 sha256 —— 见 §11 观察项 O1）

### 6.4 前端重建（bundle 哈希必须变化 —— 实测变化）
```
$ cd web && npx tsc -b ; echo TSC_EXIT=$?
TSC_EXIT=0            （输出空 = 无诊断）
$ cd web && npm run build:prod ; echo BUILD_EXIT=$?
BUILD_EXIT=0
vite v6.4.3 building for production...  ✓ 171 modules transformed
dist/index.html 0.40 kB │ dist/assets/index-Cm6bbPuq.css 22.01 kB │ dist/assets/index-CzeoM0It.js 1,177.81 kB │ gzip 363.05 kB
✓ built in 1.76s      （仅 chunk > 500kB 常规告警，非错误）

BEFORE  index.html → /assets/index-DGKMabUW.js  sha256 32a33a5450514e14b5f39a83e8e1b7a1b71426359febea99081e1afe57655c31（size 397）
        JS  sha256 7a05ea2f56e1f2a3d0266b2164fb01c082ec8b726709ee607a324c0ecb867df0（1,176,429 B）
        CSS sha256 698283dfab325cb2e1ee90c69755fe10bb73280283020d59128f908a2b04e688（22,007 B）
AFTER   index.html → /assets/index-CzeoM0It.js   sha256 58b277ece7fee63deec82bc22f6331b96a8c9a8707540f55e89f05b52f1bcf63（size 397）
        JS  sha256 02e98e1baede4503f218f8ea3f85f6149c1d215c652fbd2581ce21a09c0f38b1（1,177,810 B）
        CSS sha256 698283dfab325cb2e1ee90c69755fe10bb73280283020d59128f908a2b04e688（未变）
```
**JS 哈希变化 ⇒ 三处修复已进入线上 bundle**；dist/assets 下旧 JS 已清除（仅余新 JS + CSS）。

**bundle 内三处修复痕迹（正向取证）**：
```
① data-region":"main-chart",className:"relative min-h-0 flex-1",children:…{"data-region":"sub-chart","className":"pointer-events-none absolute inset-x-0 bottom-0 h-1/5"}
② gm="DCAP",E$=5,M$="zero",A$="0: ",$$={color:"#76808F",style:"dashed",size:1,dashedValue:[4,4],smooth:!1}
   figures:[{key:"s",…},{key:"m",…},{key:"l",…},{key:A$,title:$$,type:"line",styles:()=>Q$}]
③ 源侧 KlineChart.tsx：Effect L（仅 mount 建图）+ Effect W（随 feed 换 setDataLoader → setSymbol → setPeriod，无 dispose/init）
```

### 6.5 后端重建（预期空跑 —— 实测空跑）
```
$ cargo build -p app
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.13s
CARGO_EXIT=0
$ sha256sum target/debug/eestock-app → 8eb98376…（未变）  ✓ 印证「crates 零改动」
```

### 6.6 重启
```
$ kill 2102695 → kill_rc=0 ; sleep 3
$ ss -lntp | grep -E ':8081|:8082'  → 无输出（8081/8082 已释放）
$ ps -p 2102695 → OLD gone
$ cd /home/eestock/workspace/git/eestock/eestock-rs
$ nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml >> logs/app_dev_8081_redeploy_20260914_100042.log 2>&1 &
新 PID 2948632 同时持有 8081 与 8082
$ readlink /proc/2948632/cwd        → /home/eestock/workspace/git/eestock/eestock-rs   ✓
$ tr '\0' ' ' < /proc/2948632/cmdline → ./target/debug/eestock-app --config /tmp/app_dev_8081.toml  ✓
$ sha256sum /proc/2948632/exe       → 8eb98376…（== 磁盘二进制 == 回滚件）  ✓
$ grep SigIgn /proc/2948632/status  → SigIgn: 0000000000001007（SIGHUP 位已置 ⇒ nohup 生效）
$ ps -o pid,ppid,cmd -p 2948632     → PPID=1（独立于工具 shell）
```
**启动日志全文（0 ERROR / 0 WARN）**：
```
{"…","level":"INFO","fields":{"message":"eestock-app starting","config":"/tmp/app_dev_8081.toml"},"target":"eestock_app"}
{"…","level":"INFO","fields":{"message":"schema self-check ok"},"target":"eestock_app"}
{"…","level":"INFO","fields":{"message":"strategy registry 启动播种完成","seeded":"0","skipped":"0"},"target":"eestock_app"}
{"…","level":"INFO","fields":{"message":"sim-live 启动恢复完成","recovered":"0","degraded":"0"},"target":"eestock_app"}
{"…","level":"INFO","fields":{"message":"eestock-app serving","listen":"0.0.0.0:8081","static_dir":"./web/dist"},"target":"eestock_app"}
{"…","level":"INFO","fields":{"message":"mcp server (HTTP/SSE) serving","listen":"0.0.0.0:8082"},"target":"mcp::server"}
{"…","level":"INFO","fields":{"message":"mcp sse session opened","session":"8dc183b35b3b08f3cd10159e3d4a6f37"},"target":"mcp::server"}
ERROR 计数 = 0；WARN 计数 = 0
```

### 6.7 冒烟（逐项原始输出）
| 项 | 结果 |
|---|---|
| `GET /healthz` | `{"status":"ok"}` **HTTP:200** |
| `GET /api/config/kline` | `{"viewport_bars":120}` **HTTP:200** |
| `GET /api/config/dcap` | `{"n_s":8,"n_m":36,"n_l":66,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":1,"m":3}` **HTTP:200** |
| `GET /api/config/ma` | `{"windows":[5,10,20]}` **HTTP:200** |
| `GET /api/symbols` | **HTTP:200**，`count=44`（首项 `518880 华安黄金易ETF`） |
| `GET /api/kline?code=518880&period=15m&limit=3` | **HTTP:200**，3 根 bar（`2026-09-14T01:30/01:45/02:00`，close 8.913/8.941/8.938） |
| `GET /` 的 bundle | `index-CzeoM0It.js` + `index-Cm6bbPuq.css` **==** `web/dist/index.html` 引用 ✓ |
| served vs dist 字节 | JS `02e98e1b…` == `02e98e1b…` ✓；CSS `698283df…` == `698283df…` ✓；index.html `diff` 无输出 ✓（`HTTP:200 type:text/javascript` / `type:text/css`） |
| 启动日志 ERROR | **0**（§6.6） |

### 6.8 配置基线比对（**逐字节一致 = PASS**）
```
架构师基线：kline={"viewport_bars":120}
            dcap={"n_s":8,"n_m":36,"n_l":66,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":1,"m":3}
            ma={"windows":[5,10,20]}
PRE  /api/config/kline: {"viewport_bars":120}                                     HTTP:200
PRE  /api/config/dcap:  {"n_s":8,"n_m":36,"n_l":66,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":1,"m":3}  HTTP:200
PRE  /api/config/ma:    {"windows":[5,10,20]}                                     HTTP:200
POST /api/config/kline: {"viewport_bars":120}                                     HTTP:200
POST /api/config/dcap:  {"n_s":8,"n_m":36,"n_l":66,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":1,"m":3}  HTTP:200
POST /api/config/ma:    {"windows":[5,10,20]}                                     HTTP:200
机器比对：PRE == POST == 基线（3/3 EXACT，diff 无差异）
渲染取证结束后 Node 直连复读：仍与基线逐字节一致 ⇒ 用户实时编辑中的 dcap 参数未受本轮影响
```

## 7. 三处修复的线上渲染取证（只读）

### 7.1 既有 e2e 对线上 8081
```
$ cd web && E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/dashboard-pane-separator.e2e.ts
  ✓ 1 [chromium] › e2e/dashboard-pane-separator.e2e.ts:141:3 › 问题① …单图看板：K线 与 VOL 之间只应有 klinecharts 自带的 pane 分隔线（无骨架残留线）
  → 1 passed (5.3s)   E2E_EXIT=0
```

### 7.2 线上只读渲染探针（`verify_live_deploy.mjs`，**65/65 passed**）
```
$ cd web && BASE=http://127.0.0.1:8081 node e2e/artifacts/livecheck/verify_live_deploy.mjs
PASS M1 mount：chart.id == k_line_chart_1（本次页面加载内 init 恰 1 次）
PASS M2 mount：DCAP 默认关（无 DCAP indicator）
PASS M3 mount：分隔线数 == 1（candle|VOL）
PASS ①-1 默认态：分隔线恰 1 条
PASS ①-2 默认态：主图区无残留全宽横线（stray == []）
PASS ①-3 sub-chart 锚点 borderTopWidth == 0px 且无 border-t 类、背景透明
PASS ①-4 DCAP 开：分隔线恰 2 条（candle|VOL|DCAP）
PASS ②-1 DCAP：figKeys == s/m/l/zero 且 precision == 5 且独立副图 pane
PASS ②-2 DCAP：每根 bar zero 恒 0（常驻 0 线）
PASS ①-5 DCAP 开：主图区仍无残留全宽横线（stray == []）
PASS ②-3 DCAP：真实数据三线跨 0（min<0<max）
PASS ②-4 DCAP：副图 Y 轴范围含 0
PASS ②-5 DCAP：0 线 y == pane 内 y(0) 且落在 pane 内
PASS ②-6 DCAP：y(0) 行渲染出 #76808F 虚线像素（细分/虚线交替 => gap 集含 1 与 >1）
PASS ③-0 拖拽生效：成功拖 2 条分隔线
PASS ③-0b 拖拽后高度非默认（至少一个 pane 偏离 DCAP 开态 ≥20px）
PASS ①-6 拖拽后：主图区仍无残留全宽横线（stray == []，无僵线）
PASS ①-7 拖拽后：分隔线仍随 pane 移动（2 条且上分隔线 top 变小）
PASS ③-P[1h] 高度 ±1px 不变 / pane id 不变 / indicator id 不变 / init 计数不递增 / 数据确实换新 / 请求命中新 period=1h
PASS ③-P[5m] 高度 ±1px 不变 / pane id 不变 / indicator id 不变 / init 计数不递增 / 数据确实换新 / 请求命中新 period=5m
PASS ③-S[161226] 切标的成功 / 高度 ±1px 不变 / pane id 不变 / indicator id 不变 / init 计数不递增 / 数据确实换新 / 请求命中 code=161226
PASS ③-S[513310] 切标的成功 / 高度 ±1px 不变 / pane id 不变 / indicator id 不变 / init 计数不递增 / 数据确实换新 / 请求命中 code=513310
PASS ②-S{"r_m":1.5} PUT 被浏览器侧拦截（未回后端）/ 参数已应用 / 高度 ±1px 不变 / pane id 不变 / indicator id 不变 / 分隔线数不变 / init 计数不递增 / 线值按新参数更新 / 离线 oracle 逐点一致（0 失配）
PASS ②-S{"n_m":30}  PUT 被浏览器侧拦截（未回后端）/ 参数已应用 / 高度 ±1px 不变 / pane id 不变 / indicator id 不变 / 分隔线数不变 / init 计数不递增 / 线值按新参数更新 / 离线 oracle 逐点一致（0 失配）
PASS R1 全程无非 GET 其他请求（除被本地兑现的 PUT /api/config/dcap）
PASS R2 PUT 仅命中 /api/config/dcap 且被本地兑现
PASS R3 无页面异常
→ live http://127.0.0.1:8081: 65/65 passed; failed=0; puts=2; nonGetOther=0; pageErrors=0   LIVE_EXIT=0
→ config after (Node 直连): kline/dcap/ma 与基线逐字节一致
```

**① 分割线 / 0 线（DOM 计算样式 + canvas 像素，线上实测）**

| 状态 | klinecharts 分隔线 | 残留全宽线 stray | `sub-chart` 锚点 |
|---|---|---|---|
| 默认态 | 1 条 @top=697（`rgb(221,221,221)`，宽 1299） | **[]** | `pointer-events-none absolute inset-x-0 bottom-0 h-1/5`（无 `border-t`）、`borderTopWidth=0px`、背景 `rgba(0,0,0,0)` |
| DCAP 开 | 2 条 | **[]** | 同上 |
| 拖拽后（candle\|VOL 上移 160、VOL\|DCAP 上移 50） | 2 条 @top=**447** / 647（随 pane 移动 250px） | **[]**（无僵线） | 同上 |

DCAP 副图常驻 0 线：`figKeys=['s','m','l','zero']`、`precision=5`、独立副图 pane；每根 bar `zero===0`；真实数据三线跨 0（min −0.02207 / max +0.02537，Y 轴 range 含 0）；**0 线 y = 53 == pane 内 y(0) = 53**（paneH 100）；y(0) 行渲染 **439** 个 `#76808F` 像素，x 间距集 {1,2,4,5,6,7}（`dashedValue:[4,4]` 的线段+间隙）。截图：`live-deploy-dcap-zero-crop.png` / `live-deploy-after-drag.png`。

**③ 切 period / 切 stock（拖到非默认高度后）**

拖拽前（默认）MA 596 / VOL 100 / DCAP 100 → 拖拽后 **MA 447 / VOL 199 / DCAP 150**（`chartId=k_line_chart_1`）

| 动作 | 高度 Δ(MA/VOL/DCAP) | pane id | indicator id | `chart.id`（init 计数） | 分隔线 | 数据确实换新 |
|---|---|---|---|---|---|---|
| 切 period 15m→1h | 0 / 0 / 0 | 全不变 | 全不变 | **1 → 1** | 2→2 | 首根 `1787896800000`(close 9.415) → `1785459600000`(8.45)，188 根；命中 `/api/kline?…period=1h&limit=188` |
| 切 period 1h→5m | 0 / 0 / 0 | 全不变 | 全不变 | **1 → 1** | 2→2 | 首根 → `1788836700000`(9.095)；命中 `period=5m` |
| 切 stock 518880→161226 | 0 / 0 / 0 | 全不变 | 全不变 | **1 → 1** | 2→2 | close 9.095 → **1.955**；命中 `code=161226&period=5m&limit=188` |
| 切 stock 161226→513310 | 0 / 0 / 0 | 全不变 | 全不变 | **1 → 1** | 2→2 | close 1.955 → **4.993**；命中 `code=513310` |
| 切回 518880 | 仍 MA 447 / VOL 199 / DCAP 150 | — | — | 1 | — | — |

pane id 全程不变：`candle_pane` / `indicator_pane_1789351435873_3`(VOL) / `indicator_pane_1789351438939_2`(DCAP)。对照 163 报告的**修复前**行为（pane id 全换、VOL 199→100、inits 1→2）⇒ ③ 在线上生效。

**② 保存 dcap 参数（**仅浏览器侧本地兑现**，零后端写入）**

| 保存 | PUT body（本地兑现） | 应用后 `calcParams` | 高度 Δ | pane id | indicator id | `chart.id` | 分隔线 | m 线尾值 | 离线 oracle |
|---|---|---|---|---|---|---|---|---|---|
| ① | `{"n_s":8,"n_m":36,"n_l":66,"r_s":1,"r_m":1.5,"r_l":1,"smooth":1,"m":3}` | `[8,36,66,1,1.5,1,1,3]` | 0/0/0 | 全不变 | 全不变 | 1 → 1 | 2→2 | `[-0.0004354658,…]` → **`[-0.0014945885,…]`** | 451 点比对 **0 失配**，maxAbs 0 |
| ② | `{"n_s":8,"n_m":30,"n_l":66,"r_s":1,"r_m":1.5,"r_l":1,"smooth":1,"m":3}` | `[8,30,66,1,1.5,1,1,3]` | 0/0/0 | 全不变 | 全不变 | 1 → 1 | 2→2 | `[-0.0014945885,…]` → **`[-0.0014946133,…]`** | 457 点比对 **0 失配**，maxAbs 0 |

离线 oracle = Node 侧 esbuild 转译**仓库内同一份 CORE**（`web/src/features/indicators/dcap.ts`），用 chart 的 dataList closes + 实际 `calcParams` 重算 `s/m/l` 并与线上 result 逐点比对（浮点全等）。

**证据文件**：`coder/evidence/164_live_redeploy_three_fixes/`（`01_form_gate_rollback.txt`、`04_config_baseline.txt`、`05_frontend_build.txt`、`06_backend_build.txt`、`07_restart.txt`、`08_smoke.txt`、`09_closing_state.txt`、`live-render/**`）。运行副本（gitignored）在 `web/e2e/artifacts/livecheck/`。

## 8. 失败即回滚

**未触发**。第 7 步（冒烟）与第 8 步（三处修复取证）全部关键项 PASS ⇒ 未 kill 新进程、未用回滚件。回滚件 `/tmp/eestock-app.rollback.20260914_100000` 按预案保留。

## 9. 收尾状态

```
ss -lntp | grep ':8081|:8082' → pid=2948632 持有 8081 与 8082
readlink /proc/2948632/cwd → /home/eestock/workspace/git/eestock/eestock-rs
sha256 /proc/2948632/exe == target/debug/eestock-app == 回滚件（8eb98376…）
sim-live 会话 → 12 条全 ended
git diff --cached --name-only → 空（无暂存文件）
git status --porcelain -- web/src web/e2e design → 空
临时实例：本轮未新建任何临时端口服务（取证直接对线上 8081 只读）⇒ 无临时实例需拆除；
  临时产物仅 gitignored 的 web/e2e/artifacts/livecheck/** 与 coder/evidence/164_...（均未 git add）
```

## 10. 与既有报告的关系

- `161`（上一轮运维）本轮之前线上 dist 为 `index-DGKMabUW.js`（181c35a 构建，**不含** 7949c0b/5d8eff4）⇒ 本轮必须重建；本轮上线后 bundle = `index-CzeoM0It.js`（含三处修复）。
- 修复本体的实现与独立验收见 `162`（dcap 保存布局）/ `163`（period/stock 切换布局）；本轮职责为**装配上线 + 线上取证**，未改任何源码。

## 11. 观察项（仅报告，未动手）

- **O1（前端回滚件非仓库资产）**：`web/dist` 走 `.gitignore`，且 `vite build` 会清空 `dist/`，故本轮部署**覆盖了上一版 bundle**。所幸 `/tmp/kl_pre/dist`（index.html `32a33a54…` / JS `7a05ea2f…`）与部署前的线上 dist **逐字节相同**，可作为前端回滚件；如需更稳的回滚基线，建议下轮把「部署前 dist 快照」列为例行步骤（本轮已记录哈希，可从 `/tmp/kl_pre/dist` 复原）。
- **O2（策略播种）**：`strategy registry 启动播种完成 seeded=0/skipped=0`（策略表非空则整轮跳过播种）——与 159/161 报告一致，非本轮范围。
- **O3（未跑的 e2e）**：`e2e/dashboard-periods-ma.e2e.ts` 的 T5 会对 `/api/config/ma` 发 PUT，违反「禁线上写请求」，本轮**未运行**（16 分钟级深翻页用例亦非本任务范围）；③ 的行为级覆盖由 §7.2 的线上 65 条断言承担。
- **O4（init 计数口径差异）**：线上取证用 klinecharts 自身 `chart.id = k_line_chart_<N>` 作 init 计数（无 spy），与 163 临时构建的 `__ACC__.inits` 语义等价（同一 `init()` 入口）；两者在本轮均未观察到递增。

## 12. VERDICT

- 形态确认 ✓、停机门禁（sim-live 12/12 ended）✓、回滚件 ✓、前端 `tsc -b` exit 0 / `build:prod` exit 0（bundle 哈希变化）✓、后端 cargo 空跑（二进制 sha 未变）✓、重启（新 PID **2948632**，cwd=仓库根，cmdline 正确，启动日志 0 ERROR / 0 WARN）✓、冒烟 9/9 ✓、**配置基线 3/3 逐字节一致** ✓、三处修复线上只读取证 **65/65 + e2e 1/1** ✓、**全程 0 条线上写请求** ✓、无回滚 ✓。

**VERDICT: GREEN(带观察项 O1/O2/O3/O4)**

（O1 仅为「前端回滚件留存方式」的流程建议，已可用 `/tmp/kl_pre/dist` 复原；O2–O4 为既有/范围外观察，均不影响本次上线正确性。）
