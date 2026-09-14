# 07 线上三处修复的渲染级取证（真实 served bundle + 真实 klinecharts 10.0.3）

- 目标：线上只读 `http://127.0.0.1:8081`（本轮部署后的 bundle `index-CzeoM0It.js`）
- 脚本：`verify_live_deploy.mjs`（Playwright；chart 实例经 React fiber 取得，只读）
- 结果：**65/65 passed; failed=0; puts=2（全部浏览器侧本地兑现）; nonGetOther=0; pageErrors=0**
  （原始 stdout `live_deploy_run.log`、原始 JSON `live-deploy-results.json`）
- 另有既有 e2e 对线上 8081：`web/e2e/dashboard-pane-separator.e2e.ts` → **1 passed**（`e2e_pane_separator_live8081.log`；该用例只发 GET）

## 只读纪律（本目录证据的成立前提）
- GET 一律放行；`PUT /api/config/dcap` **由 Playwright route 本地兑现**（记录 body，绝不转发后端）；
  其余非 GET 一律 abort ⇒ `nonGetOther=[]`。
- 保存后 GET 配置读「浏览器侧镜像」（仍不写服务端）。
- 脚本尾部 Node 直连复读三份配置，与基线逐字节一致（见 `../04_config_baseline.txt`）。

## init 计数如何在线上取得（无 kc-spy）
klinecharts@10.0.3 `init()` 内部有模块级 `chartBaseId`，实例 `chart.id = k_line_chart_<N>` 单调递增，
且写入容器属性 `k-line-chart-id`。故线上直接读 `chart.id` 即可判定「是否发生整图 remount（dispose+init）」——
无需向页面注入任何产品代码。实测整场（mount → 切 2 次周期 → 切 2 次标的 → 保存 2 次参数）恒为 `k_line_chart_1`。

## 关键数值

### ③ 切 period / 切 stock（拖到非默认高度后）
拖拽前（DCAP 开态默认高）：MA 596 / VOL 100 / DCAP 100
拖拽后（分隔线 2 条各拖一次）：**MA 447 / VOL 199 / DCAP 150**（`chartId = k_line_chart_1`）

| 动作 | 高度 Δ（MA/VOL/DCAP） | pane id | indicator id | chart.id | 分隔线 | 数据 |
|---|---|---|---|---|---|---|
| 切 period 15m→1h | 0 / 0 / 0 | 全不变 | 全不变 | 1 → 1 | 2 → 2 | 首根 1787896800000(close 9.415) → 1785459600000(8.45)；188 根；命中 `/api/kline?...period=1h&limit=188` |
| 切 period 1h→5m | 0 / 0 / 0 | 全不变 | 全不变 | 1 → 1 | 2 → 2 | 首根 1785459600000(8.45) → 1788836700000(9.095)；命中 `period=5m` |
| 切 stock 518880→161226 | 0 / 0 / 0 | 全不变 | 全不变 | 1 → 1 | 2 → 2 | close 9.095→1.955；命中 `/api/kline?code=161226&period=5m&limit=188` |
| 切 stock 161226→513310 | 0 / 0 / 0 | 全不变 | 全不变 | 1 → 1 | 2 → 2 | close 1.955→4.993；命中 `code=513310` |
| 切回 518880 | 保持 MA 447 / VOL 199 / DCAP 150 | — | — | 1 | — | — |

pane id（全程不变）：`candle_pane` / `indicator_pane_1789351435873_3`(VOL) / `indicator_pane_1789351438939_2`(DCAP)
（对照 163 报告的修复前行为：pane id 全换、高度 199→100、inits 1→2）

### ② 保存 dcap 参数（**仅浏览器侧本地兑现**）
| 保存 | PUT body（本地兑现，未发后端） | 应用后 calcParams | 高度 Δ | pane id | indicator id | chart.id | 分隔线 | m 线尾值 | 离线 oracle |
|---|---|---|---|---|---|---|---|---|---|
| ① | `{"n_s":8,"n_m":36,"n_l":66,"r_s":1,"r_m":1.5,"r_l":1,"smooth":1,"m":3}` | [8,36,66,1,**1.5**,1,1,3] | 0/0/0 | 全不变 | 全不变 | 1 → 1 | 2 → 2 | [-0.0004354658,…] → **[-0.0014945885,…]** | 451 点比对，**0 失配**，maxAbs 0 |
| ② | `{"n_s":8,"n_m":30,"n_l":66,"r_s":1,"r_m":1.5,"r_l":1,"smooth":1,"m":3}` | [8,**30**,66,1,1.5,1,1,3] | 0/0/0 | 全不变 | 全不变 | 1 → 1 | 2 → 2 | [-0.0014945885,…] → **[-0.0014946133,…]** | 457 点比对，**0 失配**，maxAbs 0 |

离线 oracle = Node 侧 esbuild 转译**仓库内同一份 CORE**（`web/src/features/indicators/dcap.ts` 生成物），
用 chart 的 dataList closes + 实际 calcParams 重算 `s/m/l` 并与线上指标 result 逐点比对（浮点全等）。

### ① 分割线 / 0 线
| 状态 | klinecharts 分隔线 | 残留全宽线(stray) | sub-chart 锚点 |
|---|---|---|---|
| 默认态 | 1 条 @top=697（`rgb(221,221,221)`，宽 1299） | **[]** | borderTopWidth `0px`、border-top-style solid、背景 `rgba(0,0,0,0)`、class 无 `border-t` |
| DCAP 开 | 2 条 | **[]** | 同上 |
| 拖拽后 | 2 条 @top=447 / 647（上分隔线随 pane 移动 250px） | **[]**（无僵线） | 同上 |

DCAP 副图 0 线（`zero` figure）：
- `figKeys = ['s','m','l','zero']`、`precision = 5`、独立副图 pane（≠ `candle_pane`）
- 每根 bar `zero === 0`（constant）；真实数据三线跨 0（min −0.02207 / max +0.02537），Y 轴 range 含 0
- 0 线 y = **53** == pane 内 y(0) = **53**（paneH 100 → 落在 pane 内）
- y(0) 行渲染出 **439** 个 `#76808F` 像素；x 间距集 {1,2,4,5,6,7}（体现 `dashedValue:[4,4]` 的线段+间隙）
- 截图：`live-deploy-dcap-zero-crop.png`（DCAP 副图裁图）、`live-deploy-after-drag.png`、`live-deploy-final.png`
