# 049 — 上线独立验收（前端修复 181c35a + 文档 28046e1/d74bfb8）执行报告

- **本文件位置（self-location）**：`tester/test/049_frontend_deploy_independent_acceptance_execution.md`
- 证据目录：`tester/evidence/049/`（harness 脚本 + 原始 JSON/日志/截图）
- 报告时间：2026-09-13 21:26–21:50 +0800（在线观测窗口）
- 被测形态：8081/8082 在线 `eestock-app`；`HEAD = d74bfb8`；仓库根 `/home/eestock/workspace/git/eestock/eestock-rs`
- 被测改动：`181c35a`（fix(web)：副图锚点重复分割线移除 + DCAP 副图常驻 0 参考线）+ 文档 `28046e1`/`d74bfb8`；后端 Rust 相对上次部署（20:32，`5a016cd`）零改动
- 纪律：只读取证；未 `git add/commit/stash`；未动 8080/5433；未用 `deploy.sh`/compose；未 kill/重启任何服务；未改任何仓库既有文件（仅新增本报告与 `tester/evidence/049/`）

> 结论速览：1 形态 ✅ / 2 部署一致性 ✅ / 3 ①✅ ②✅（含反向对照） / **4 ❌（`/api/config/dcap` 的 `smooth` 值与本窗口前基线不一致，非本次运维所致但无法证明发生时刻）** / 5 卫生 ✅
> 末行 **VERDICT: FAIL(4)**

---

## 1) 形态（同 PID 持 8081+8082；cwd=仓库根；cmdline）

**观测到在线 PID = `2102695`，派单前提里的 `2029836` 已不存在**（运维 21:21 停机窗口内 kill 旧 PID 后重启，见其自述 §「旧 PID → 新 PID 2029836 → 2102695」；`/proc/2029836` 不存在已实测确认）。

```text
$ ss -lntp | grep -E ':8081|:8082'
LISTEN 0 128 0.0.0.0:8081 0.0.0.0:* users:(("eestock-app",pid=2102695,fd=11))
LISTEN 0 128 0.0.0.0:8082 0.0.0.0:* users:(("eestock-app",pid=2102695,fd=12))
$ readlink /proc/2102695/cwd → /home/eestock/workspace/git/eestock/eestock-rs
$ stat -c %i .  → 94635068 ;  stat -L -c %i /proc/2102695/cwd → 94635068   （inode 相等 ⇒ cwd 确为仓库根）
$ tr '\0' ' ' < /proc/2102695/cmdline → ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
$ readlink /proc/2102695/exe → <repo>/target/debug/eestock-app
$ ls -d /proc/2029836 → No such file or directory
$ ps -eo pid,ppid,lstart,cmd | grep eestock-app
2102695 2102692 Sun Sep 13 21:21:46 2026  ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
```

- 端口与 PID 关系：**同一 PID（2102695）同时持有 8081 与 8082** ✅
- cwd = 仓库根（inode 相等）✅；cmdline 含 `--config /tmp/app_dev_8081.toml` ✅
- 与派单前提的差异：前提 PID `2029836` 是**停机前的旧 PID**，已被本窗口内的重启替换。**派单前提供的 PID 已过期**（不影响其余形态结论，但说明「不许信运维自述」是对的：自述里的旧/新 PID 需自行核验）。
- 8202? 不涉及。`GET http://127.0.0.1:8082/` → **404**（8082 是 MCP HTTP/SSE 端点，非 SPA，符合预期）。

**结论：PASS**（形态三要素均满足；派单前提 PID 过期需勘误）

---

## 2) 部署一致性（后端空跑 + 前端 served bundle 字节一致）

```text
$ cargo build -p app
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.06s      # 无 Compiling ⇒ 未重编译
$ sha256sum /proc/2102695/exe target/debug/eestock-app
8eb98376daf76381b335183714ecf94e191d256774a0b33b8e0fea00a2e367cf  /proc/2102695/exe
8eb98376daf76381b335183714ecf94e191d256774a0b33b8e0fea00a2e367cf  target/debug/eestock-app
```

- 后端：`cargo build -p app` 空跑（0.06s）⇒ 已部署二进制 == HEAD 源码构建；在线 exe == 磁盘二进制（sha256 三者一致：exe/磁盘/自述值）✅

**前端 served bundle（本次真正的上线物）——字节级对照：**

```text
$ curl -sS -D- http://127.0.0.1:8081/            # 200, content-length: 397
<!DOCTYPE html>… <script type="module" crossorigin src="/assets/index-DGKMabUW.js"></script>
                  <link rel="stylesheet" crossorigin href="/assets/index-Cm6bbPuq.css">
$ sha256sum /tmp/root.html web/dist/index.html
32a33a5450514e14b5f39a83e8e1b7a1b71426359febea99081e1afe57655c31  /tmp/root.html
32a33a5450514e14b5f39a83e8e1b7a1b71426359febea99081e1afe57655c31  web/dist/index.html
$ cmp /tmp/root.html web/dist/index.html → IDENTICAL
$ curl /assets/index-DGKMabUW.js → sha256 7a05ea2f56e1f2a3d0266b2164fb01c082ec8b726709ee607a324c0ecb867df0
     web/dist/assets/index-DGKMabUW.js → 同值 ; cmp → IDENTICAL (1,176,429 B)
$ curl /assets/index-Cm6bbPuq.css → sha256 698283dfab325cb2e1ee90c69755fe10bb73280283020d59128f908a2b04e688
     web/dist/assets/index-Cm6bbPuq.css → 同值 ; cmp → IDENTICAL (22,007 B)
```

- 三个静态资源 **逐一 cmp 字节一致**，且 served `index.html` 引用的 `index-DGKMabUW.js` 与 `web/dist` 内的文件名一致 ⇒ **线上 SPA == 重建后的 `web/dist`** ✅
- **额外反空跑证据（证明"前端确实上线了"）**：窗口前（20:51，tester 047 证据 `live-8081-probe.json`）线上 JS 名为 **`index-BcRLZ7uk.js`**；现在为 **`index-DGKMabUW.js`** ⇒ bundle 确实被替换（exe 未变而 bundle 变了，与"仅前端上线"一致）✅
- `web/dist` 被 `web/.gitignore:dist/` 忽略，重建不弄脏仓库（实测 git 干净，见 §5）

**结论：PASS**

---

## 3) 两处修复的独立渲染取证（真实浏览器 / 只读 / 未改用户配置）

harness：自建 Playwright（`web/node_modules/playwright`，headless chromium，**独立临时 profile**，未连用户 Chrome:9222），对 `http://127.0.0.1:8081` 真实渲染取证；**全程仅 GET**（见每段 requests 计数）。
脚本：`tester/evidence/049/probe2.mjs`（问题①+反向注入）、`probe6.mjs`（②多形态+像素）、`probe7.mjs`（②反向对照）、`pass7.mjs`/`pass8.mjs`（y(0) 独立计算）。

### 3-① 分割线（骨架 `sub-chart` 锚点 border-t）

实时 DOM 事实（默认态）：

```text
[data-region="sub-chart"] class  = "pointer-events-none absolute inset-x-0 bottom-0 h-1/5"
                           computed borderTopWidth = 0px   （窗口前 20:51 该值 = 1px solid rgb(229,231,235)）
主图 pane 列表 = [candle 697px] , [VOL 100px] ; klinecharts 分隔线 = 1 条（y=773, 1px #DDD, 含 ns-resize 拖拽层）
主图区内「非 klinecharts 全宽水平线（stray）」= 0
```

| 状态 | 内容 pane | klinecharts 分隔线 | stray（非引擎全宽线） | 锚点 borderTopWidth |
|---|---|---|---|---|
| 默认（DCAP 关） | 2（697/100） | 1 条 @y=773 | **0** | **0px** |
| 拖高 VOL（分隔线上拖 150px） | 2（559/238） | 1 条 @y=635（**随 pane 移动**） | **0** | 0px |
| DCAP 开 | 3（596/100/100） | 2 条 | **0** | 0px |
| DCAP 关（回到 2 pane） | 2（697/100） | 1 条 | **0** | 0px |

- 「candle↔VOL 边界由 klinecharts 自身分隔线提供」在 **DCAP 关态亦在**（1 条，落在两 pane 交界 y=773/774）✅
- 拖高 VOL 后**无"不随 pane 移动的全宽横线"** ✅

**反向证据（防空跑，必红）**：在只读页面上把修复前的那行 `border-top` 注回锚点（`style.borderTop='1px solid #e5e7eb'`，仅页面 DOM，随后 reload，不动文件/不落库）：

```text
注入后（默认布局）stray = 1 条：{ y: 735.2, kind: 'border-on-element', borderTop: '1px solid rgb(229,231,235)',
                                  cls: 'pointer-events-none absolute inset-x-0 bottom-0 h-…' }
再拖高 VOL：klinecharts 分隔线 y: 773 → 635（移动），而注入那条仍停在 y = 735.2（不动）
```

⇒ 我的断言能捕获该缺陷的**原始形状**（"不随 pane 移动的僵线"），且线上构建**捕获不到**任何 stray。反向对照截图：`tester/evidence/049/p2-injected-default.png` / `p2-injected-dragged.png`。

**3-① 结论：PASS**

### 3-② DCAP 副图常驻 0 参考线

**多形态（4 种，真实数据，鼠标移出图表区，排除十字光标）**：pane 内 0 线（颜色 `#76808F`、虚线）单行、横跨 pane 绘图区 ~93%：

| 形态（标的/周期） | DCAP pane 内 0 线行 | 虚线几何 | 数据三线像素行范围 | y(0) 独立计算 | Δ=|线行−y(0)| | 线行反推值 |
|---|---|---|---|---|---|---|
| 518880 / 15m | row 53 | on≈5/off≈3（周期 8px ≈ dash[4,4]） | s 40–87, m 40–91, l 42–92 | 53.21 | **0.21px** | +1.1e-4 |
| 518880 / 1m | row 67 | 周期 8px | s 57–78, m 57–92, l 52–80 | 66.46 | **0.54px** | −4.2e-5 |
| 518880 / 日 | row 49 | 周期 8px | s 33–70, m 17–82, l 15–92 | 49.02 | **0.02px** | +6.7e-5 |
| 161226 / 15m | row 37 | 周期 8px | s 21–89, m 23–92, l 22–87 | 36.94 | **0.06px** | −4.2e-5 |

y(0) **独立计算口径**（不依赖被测自述）：真实浏览器像素测出 DCAP 三线的上下极值像素行 → 用**线上 `/api/config/dcap` 实际参数**（`n_s8/n_m26/n_l60/r=1/smooth=0/m3`）从仓库 CORE `computeDcapSeries` 独立算出同标的同时段序列 → 以 6 个约束点（每序列 min/max × 像素行）线性最小二乘求 `row = A + B·value` ⇒ `y(0) = A`。
- 拟合残差（模型自洽性）：1m/日/161226 = **0.36 / 0.45 / 0.23 px**；518880-15m = 2.92 px（单形态偏高，见下"限制"）。
- 0 线所在行的反推值 |v| ≤ 1.1e-4，而同时段 DCAP 值域 ≈ 0.019 ~ 0.18 ⇒ 反推值 ≈ 0（相对值域 ≤0.6%）。

**窗口口径**：可见 bar 窗口非图 API 可变，我用可达的两条独立线索交叉：
- 像素测得的 barSpace=11px（= 代码 `clamp(round(1299/120))`），0 线横跨 x∈[0,1154] ⇒ 绘制约 **106 根**；
- 对"以最后一根为右端的尾窗"族（L=37/66/96…）与全窗口暴力搜索（`pass8.mjs`，12505 个候选窗）取最小残差窗，二者给出的 **y(0) 一致到 0.6px 内**；518880-15m 的尾窗族 y(0)=53.21（Δ −0.21px，残差 2.92px）。

**配套证据（同层/邻近层，独立取得）**：
- **单元层**：`npx vitest run src/features/indicators/dcapIndicator.test.ts -t zero` → **6 passed**（含「每条 bar 都返回 zero=0」「数据不足断线段 zero 仍为 0」「异常降级 zero 恒 0」）；全量前端 `npx vitest run` → **56 files / 562 tests passed, exit 0**（与 commit 自述一致，独立复现）。
- **仓库自带红线用例**：`E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/dashboard-pane-separator.e2e.ts` → **1 passed**（对线上真实 bundle）。
- **阴性对照 A（DCAP 关）**：无 DCAP pane ⇒ 该 pane 不存在、无 `#76808F` 线（`p2-s5-dcap-off`）。
- **阴性对照 B（同图其它 pane）**：VOL pane 无该色线；candle pane 的 `#76808F` 虚线是 klinecharts **priceMark 高低价标线**（DCAP 关态同样存在 ⇒ 与本次修复无关，且不同 pane）。
- **十字光标混淆排除**：`#76808F` 恰是 klinecharts `Color.GREY`，也是**十字光标水平线**默认色（dash[4,2]）与 priceMark/图例用色。实测：鼠标移出图表区后该线仍在（且 4 形态各行位置随数据变化）；鼠标置于图内时该线**未**在 DCAP pane 新增（`p2-s6-mouse-inside`）⇒ 测到的是常驻线，非光标；且实测虚线周期 8px（dash[4,4]）与光标 dash[4,2]（周期 6）不同。
- **反向证据（必红）**：在 DCAP pane 的 canvas 上于**错误位置**（canvas row 18）注入同色同虚线 →

```text
BEFORE: zeroRows = [{row:53, frac:0.347}]
AFTER : zeroRows = [{row:18, frac:0.500}, {row:53, frac:0.347}]   # 错误位置被检出 ⇒ |row−y(0)|=35px ⇒ 断言会红
```

**限制（如实说明）**：
1. pane Y 轴标度的可见 bar 窗口无法从 DOM 直接读取；我用像素 barSpace/绘制跨度 + 最小残差窗口族交叉，y(0) 在两种口径下一致到 0.6px。**若架构师要求"窗口级"严格，需要 klinecharts 实例 API（`convertToPixel`）**——线上 bundle 不暴露实例（`getChart` 不存在，实测 React fiber 深搜亦未命中），本车道为此自建了 x 轴交叉校验：4 形态中 5/6 极值点的"x→bar 序号"与数据 argmax/argmin 精确吻合（161226-15m），其余形态最小值吻合、最大值部分不吻合，说明个别形态绘制窗口未必是"载入集的最后一截"，故上表 Δ 含 ±3px 量级的窗口口径不确定度。
2. 518880-15m 形态的 6 约束拟合残差 2.92px（模型自洽性偏弱），其 Δ=−0.21px 应视为 ±3px；其余三形态残差 ≤0.45px，Δ ≤0.54px。
3. 线上真实数据"跨 0"（DCAP 值 min≈−0.030/max≈+0.019），未能构造"全正"数据形态（需缓存注入）；本报告用"4 种标的×周期"覆盖了不同值域/不同 pane 标度，并含"数据不足断线段 zero 仍在"的单元层证据。

**3-② 结论：PASS**（四形态均满足"0 线存在且位于 y(0)"；含必红反向对照；上列限制已标注）

---

## 4) 回归与健康（含 `/api/config/dcap` 变更核对）—— **本项 ❌**

```text
$ curl -sS -w 'HTTP %{http_code}\n' http://127.0.0.1:8081/healthz        → {"status":"ok"}  HTTP 200
$ curl -sS http://127.0.0.1:8081/api/symbols | len                    → symbols: 44
$ curl -sS -o /dev/null -w '%{http_code}' /api/kline?code=518880&period=15m&limit=120 → 200（bars 正常返回）
$ /api/config/ma 200 ; /api/config/kline → {"viewport_bars":120} ; /api/sources/health → 200
$ grep -c '"level":"(ERROR|FATAL)"' logs/app_dev_8081_redeploy_20260913_212141.log → 0
   （该日志 7 行，无 WARN/ERROR/FATAL）
```

**dcap 配置端点**（关键差异）：

```text
现在（21:26–21:47，三次读取逐字节相同）：
{"n_s":8,"n_m":26,"n_l":60,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":0,"m":3}
keys = 8 = [m, n_l, n_m, n_s, r_l, r_m, r_s, smooth] ; has_th = False      ← 形状 ✅（仍 8 参不含 th）

本窗口前最后一次独立观测（tester 046，20:35:54 报告，20:32 部署的验收）：
{"n_s":8,"n_m":26,"n_l":60,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":1,"m":3}   ← smooth = 1
（tester 038 §2.3 亦记录默认 smooth:1；bundle 内默认 Jr={…,smooth:1,…}）
```

⇒ **`smooth` 1 → 0 与"与重启前一致"的条款不符**，且**无法证明发生在本窗口（21:21 重启）之前**。

**（a）为何可以不归因于本次运维操作**（实测/源码口径）：
- 该值只可能由 `PUT /api/config/dcap` 写入：`crates/web/src/rest.rs:387` `st.config.set(K_DCAP, value)` 是唯一写路径（`ConfigStore::set` = `INSERT … ON CONFLICT DO UPDATE, updated_at=now()`）；**GET 只读**、启动路径不写 `app_config`（启动日志仅 schema self-check / 策略播种 / sim-live 恢复 / 监听），重启**不会重置已存配置**。
- 本窗口内各方**零写请求**：我自建的 4 轮页面渲染取证 + 反向对照共 **71 / 53 / 43 / 37 次请求，非 GET = 0**；运维自述的渲染脚本亦只点击 DCAP 开关（`getByRole('DCAP')`），未开配置面板、未发 PUT；仓库内**没有任何测试引用 `/api/config/dcap`**（`crates/` 全量搜索仅 src，无 tests）。
- 因此：**本次"重建前端 + kill/重启 8081/8082 + GET 冒烟"不可能写入该值**；差异来自更早的第三方写入（更早某车道/有人经 UI 保存过 `smooth=0`），但**证据不足以判定其时刻**。

**（b）最小修正建议**：
1. 若要恢复默认观感：由架构师裁决后显式 `PUT /api/config/dcap` 写回 `smooth=1`（唯一写路径，一次调用即可；建议同时核对 n/r/m 是否为期望值）。
2. 若要**定位写入时刻**：`app_config` 表有 `updated_at`（迁移 `0021_app_config.sql`），一条**只读** SQL 即可定案：
   `SELECT key, value, updated_at FROM app_config WHERE key='dcap';`
   本车道遵守"禁动 5433"纪律**未执行该查询**（如需，请架构师显式授权只读 SELECT）。
3. 报告口径纠正：运维自述把该差异写成"本轮之前既已持久化的状态"，属于**未证推断**；本轮独立证据只能支撑"非本次操作所致"，**不能**支撑"发生在重启前"。

**结论：FAIL(4)** —— `/api/config/dcap` 形状合规（8 参无 th）、但取值与本窗口前基线不一致，"与重启前一致 / 未被本次操作改动"未能证实（无写路径归因于本次运维，但差异客观存在且无法定时）。

---

## 5) 残留与卫生

```text
$ pgrep -af target/debug/eestock-app
2102695 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml        # 唯一应用进程 ✅
2102692 /bin/bash -c cd <repo> && … nohup ./target/debug/eestock-app …    # 运维启动壳残留（PPID 1、无监听端口；纪律内未清理）
$ ss -lnt | wc -l → 52；与本次会话起始端口清单**逐条 diff：新增 0 / 消失 0**（无遗留监听端口，含我自建 harness 期间）✅
$ git diff --cached --name-only → 空（无 staged）✅
$ git status --porcelain --untracked-files=no → 空（tracked 改动 0；运维未弄脏仓库）✅
$ git check-ignore -v logs/  → .gitignore:23:/logs/     （logs/ 忽略仍生效）✅
$ git check-ignore -v web/e2e/artifacts/…  → web/e2e/.gitignore:2:artifacts/   （运维 21:22–21:24 写入的取证产物被忽略，未弄脏仓库）✅
$ git check-ignore -v web/dist/ → web/.gitignore:1:dist/ ✅
```

- 唯一 untracked 新增均在本车道测试产物约定位置（`tester/test/049_*.md`、`tester/evidence/049/`），未改任何既有文件。
- 8080(data)/5433(timescaledb) 端口、进程均未被触碰。

**结论：PASS**

---

## 6) 明确未做

- 未修改仓库任何既有文件（仅新增报告 + 证据目录）；未 `git add/commit/stash`。
- 未评价 dcap 信息量/口径取舍。
- 未 kill/重启任何服务（含 8081/8082）；未动 8080/5433；未用 `deploy.sh`/compose。
- 未修改用户浏览器配置（自建 headless chromium + 临时 profile，未连 9222）。
- 未读取数据库（含只读 SELECT）；未执行 `PUT /api/config/*` 等任何写请求。

## 逐项结论

| # | 项 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 形态（同 PID 持 8081+8082 / cwd / cmdline） | ✅ PASS | PID `2102695`（派单前提 `2029836` 已不存在，需勘误）；cwd inode 94635068 相等；cmdline 含 `--config /tmp/app_dev_8081.toml` |
| 2 | 部署一致性（后端空跑 + served bundle == dist） | ✅ PASS | `cargo build -p app` 0.06s 空跑；exe/磁盘 sha256 同为 `8eb98376…`；index.html/js/css 三件 `cmp` 字节一致；线上 JS 名由 `index-BcRLZ7uk.js` → `index-DGKMabUW.js` |
| 3-① | 分割线移除 | ✅ PASS | 锚点 borderTopWidth=0px（默认/拖高/DCAP 开）；主图区 stray=0；引擎分隔线数=pane−1 且随拖拽 773→635；注入旧 border-t ⇒ stray@735.2 不动（必红对照成立） |
| 3-② | DCAP 副图常驻 0 线 | ✅ PASS（含限制） | 4 形态（2 标的×3 周期）均有 `#76808F` 虚线，Δ=|线行−独立 y(0)| = 0.02/0.06/0.21/0.54px，反推值≈0；vitest 562/562、dacpIndicator zero 子集 6/6、仓库 e2e 1/1；错位注入必红 |
| 4 | 回归与健康 + dcap 配置不变 | ❌ **FAIL** | healthz/symbols44/kline 正常、日志 0 ERROR；但 `/api/config/dcap` 现 `smooth:0` vs 窗口前基线（046 @20:35）`smooth:1` ⇒ "与重启前一致"不成立（归因证据见 §4a，时刻无法判定） |
| 5 | 残留与卫生 | ✅ PASS | 仅 1 个 app 进程（+运维 nohup 壳，无监听）；端口清单 diff 新增/消失 0；无 staged、tracked 改动 0；logs/、web/e2e/artifacts/、web/dist/ 均被忽略 |

## 最小修正建议（按优先级）

1. **【必须裁决】** `/api/config/dcap` 的 `smooth=0`：确认是否为期望现状；`updated_at` 只读查询授权（一条 SELECT）或写回期望值（一次 PUT）。此项为本次 FAIL 的唯一来源。
2. **【勘误】** 派单中"在线 PID 2029836"应更新为当前 PID（重启后为 2102695）；同时提示：运维启动壳 PID 2102692 长期残留（无监听、PPID=1），建议下轮清理以免误判"多余进程"。
3. **【可选·加固】** 分割线/0 线的线上取证若要"窗口级严格"，需在 bundle 暴露 chart 实例（或保留一条可注入 spy 的验收构建）；本报告已用像素 barSpace + 尾窗族 + x 轴 argmax 交叉替代，但 518880-15m 形态仍有 ±3px 量级不确定度。
4. **【可选·防回归】** `PUT /api/config/dcap` 建议加 `deny_unknown_fields`（沿用 tester 046 观察项 B），与本项无关但可减少调用错觉。

**VERDICT: FAIL(4)**
