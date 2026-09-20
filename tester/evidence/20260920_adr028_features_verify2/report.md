# ADR-028 D4.1 复验解除冻结 —— 独立复验报告（第二轮，tester 车道）

**本报告路径**：`tester/evidence/20260920_adr028_features_verify2/report.md`

**判词（前置一行）**：B1 **通过**（L2 跳转后「全览/回退」各 3 采样点全部命中按钮自身/子元素 + 两个按钮真实 `click({timeout:3000})` 均成功；自建 T7 由**红转绿**，且有变异反证）｜ R1 **通过**（末根 bar 两笔标签 ink 跨度/渲染器实测文本宽度 = 1.025 / 0.993，覆盖率 0.797 / 0.727，盒右缘 595.1 / 594.4 ≤ pane 605 —— 无裁剪；对照组同指标 1.04/0.90）｜ R2 **处置确认 通过**（源码去注释后无 `'loading'` 联合项、无承诺文案、无 loading 分支；被服务 bundle 三段承诺文案 0 命中且三条对照串命中；loading 期 L2 行数 0 ⇒ 分支确实不可达 ⇒ 删分支依据成立）｜ R3 **通过（附口径）**（27 个圆点：24 个圆心逐像素 == 侧别色（Δ=0）、2 个 3×3 主导色 == store 色、1 个可量化还原为「标记色 × 标签底色」混合；**止损橙不可测**（全库 367 笔成交 `StopTrigger` 计数 = 0），已写明复验口径与未来补测条件）｜ 无回归 **绿**（window-sync 6/6、axis-align-probe v2 2/2、`tsc -b` exit 0、单测 99/99）｜ T0 锚点 **已更新**（旧 `8d6022e1…` → 新 `f2504232…`，更新后规格 10/10 全绿）｜ 变异反证 **有牙**（2 次变异各自复现修复前失败签名，恢复后重建与线上 bundle 逐字节一致）｜ **线上 bundle 身份与送达方式**：`/assets/index-BY728MHs.js`，sha256 `f2504232e7a4fba582943fdbe020235013fef27752313db6cc69531f37d0fa0e`，由**主机进程** `./target/debug/eestock-app --config /tmp/app_dev_8081.toml`（`static_dir=./web/dist`）按请求从磁盘直读 —— **不是**容器层同步｜ **总判词 = 放行**

---

## 0. 交付物索引

| 路径 | 内容 |
|---|---|
| `tester/evidence/20260920_adr028_features_verify2/report.md` | 本报告 |
| `web/e2e/adr028-features-verify2.e2e.ts` | **新增**独立复验规格（V1 R1 / V2 R2 / V3 R3） |
| `web/e2e/adr028-features-verify.e2e.ts` | **规格维护**：T0 锚点更新 + T7 加固（3 采样点 × 2 按钮 + 真实 click） |
| `tester/design/304_adr028_d41_features_verify_design.md` | 设计报告（**追加**「复验二轮」章节，含新规格用例设计） |
| `tester/test/305_adr028_d41_features_verify2_execution.md` | 执行报告（本轮全部命令与结果） |
| `raw/spec1/`、`raw/spec1_final/`、`raw/spec2_final/`、`raw/spec_out/`、`raw/mut_M_LAYOUT/`、`raw/mut_M_R1/` | 页面侧原始读数（JSON/PNG；含第二轮稳定性复跑） |
| `raw/v1_last_bar_label.json`、`v1_last_bar_labels.png` | R1 读数与截图 |
| `raw/v2_r2_disposition.json` | R2 源码侧/产物侧/运行期三面证据 |
| `raw/v3_dot_pixels.json`、`v3_dot_pixels.png` | R3 页面侧合成位图逐圆点读数 |
| `raw/pixel_dots.py`、`raw/pixel_dots_offline.json` | R3 **离线**（PIL）独立复算与交叉核对 |
| `raw/served_bundle_BY728MHs.js` | 复验期间从 :8081 拉取的 bundle 快照（身份基线） |
| `logs/` | 12 份原始输出（规格执行 / 变异构建 / 变异执行 / tsc / vitest） |

---

## 1. 本次复验的**真身身份**与**送达方式**（重要披露的独立核验）

### 1.1 结论（与修复方披露不一致处已更正）

| 项 | 实测 |
|---|---|
| `:8081` 的监听者 | **主机进程** PID 1941108：`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`，cwd = 仓库根，与 `ss -ltnp` / `/proc/1941108/{cmdline,exe,cwd}` 一致；其 mount namespace 与我的 shell 相同（`mnt:[4026531832]`）⇒ **非容器进程** |
| 配置 | `/tmp/app_dev_8081.toml`：`static_dir = "./web/dist"`、`listen = "0.0.0.0:8081"` |
| 容器事实 | `docker ps -a`：`eestock-app  eestock-rs_app  Exited (137) 9 days ago`（无端口映射）⇒ **修复方披露的「`docker cp` 把新 dist 同步进 eestock-app 容器」在本环境不成立**：该容器并未运行，`:8081` 也不是它提供的 |
| 实际送达方式 | `web/dist` 由 **主机静态目录直读**：`curl :8081/` → `index.html`（397B）引用 `/assets/index-BY728MHs.js`；`curl` 该 URL 的 sha256 = `f2504232…` == `web/dist/assets/index-BY728MHs.js` 的 sha256（**逐字节一致**）（`raw/spec1/t0_bundle.json`、`raw/served_bundle_BY728MHs.js`） |
| 「是否直读磁盘」活体验证 | 在 `web/dist/` 放探针文件 → `:8081` 返回其内容；**改写内容后再取 → 立即返回新内容**（v1→v2，排除内容缓存）；删除后同 URL 回退 SPA `index.html`（397B，`text/html`）⇒ **进程按请求读盘**，不存在「内存里留着旧 bundle」的情形（探针文件已删除） |
| 可复现性 | 本波结束前用**当前源码树**重新 `npx vite build`（outDir=`dist-mut`，随后删除）得到的 bundle 名与 sha256 **与线上完全一致**（`f2504232…`）⇒ 本波复验对象 = 当前源码树的构建产物；**重建即可复现，无需镜像重建/容器同步** |

### 1.2 镜像级重建障碍（修复方披露，已独立复核；车道外）

`Dockerfile.app` 仅 COPY 15 个 crate 清单（`crates/{alert,app,...,web}/Cargo.toml`），**无 `crates/test-support`**（`grep -c test-support Dockerfile.app` = 0），而仓库内该目录存在 ⇒ `docker compose build app` 的 `cargo fetch` 会因缺该 workspace 成员的清单而失败（与修复方 §7.1 描述一致）。**但该障碍不影响本波结论**：`:8081` 的静态内容来自主机 `web/dist`（§1.1），与镜像无关；镜像重建问题仍登记为**车道外待办**（Rust/基建）。

### 1.3 证据卫生（须上报）

我上一轮（冻结轮）落在 `tester/evidence/20260920_adr028_features_verify/raw/` 的原始读数为 **10:2x–10:3x**，但该目录下 `t0/t1/…/t7*.json` 的 mtime 为 **10:41–10:43** —— 即修复方为核验 T0 而**用默认 `ADR028V_OUT` 跑了我方规格，覆盖了冻结轮的原始红证据**（该目录未纳入 git，无历史可恢复）。冻结轮的 T7 红读数因此只存活在文字证据里（我的冻结报告 §5 与执行报告 §2 明确写有 `Expected: <= 1 / Received: 27`）。
**处置**：本波用**自建变异构建**重新生成等价的红基线（§3.3），不再依赖被覆盖的 JSON；并在 §10 登记该流程风险（跨车道写证据目录）。

---

## 2. 方法与独立性

1. **不引用修复方读数/截图为判据**：每条判据都在自建规格内重跑；修复方产物仅用于「先确认我要复验的是哪一个 bundle」（§1）。
2. **像素读法不同**：修复方逐 canvas 图层 `getImageData`；本波把同容器内各 canvas 按 DOM 偏移/缩放**合成**为「屏幕真实可见」的位图再读数（`analyze()`），并落盘 PNG 由**离线 PIL** 独立复算（§6.3：27/27 与页面侧读数**完全一致**，最大逐通道差 0）。
3. **R1 的完整性判据不依赖修复方的字宽常量**：测试侧 init script 记录渲染器自己的 `ctx.font` / `fillText` 锚点（仪表，不改生产代码）；期望文本宽度 = 页面内 `ctx.measureText(标签, 渲染器真实 font = "normal 9px Helvetica Neue")`；测定带由「渲染器锚点 + 实测宽」导出。
   - 口径修正（R1 首跑红→修正后绿，属**规格自纠**而非放宽）：klinecharts 会把 figure 的 `align` **归一化**后绘制（实测 `ctx.textAlign` 恒为 `'left'`，右对齐由「锚点前移一个文本宽度」实现）⇒ 判据改用**有效锚点**（`锚点 x + 文本宽`）判断左右侧，不再以 `ctx.textAlign` 为依据；同时把测定带从「全 pane 宽」收紧为「文本紧盒」，避免把相邻圆点/蜡烛同色墨计入（原带宽口径会把圆点自身像素计成标签墨）。
4. **R2 双侧证据**：源码侧（Node 读 `.tsx`，**去注释**后检查字符串字面量/联合类型/分支守卫）+ 产物侧（被服务 bundle 文本搜索，且要求**对照串必须命中**以证明检索路径有效）+ 运行期（真实渲染的 `data-state`；并复跑 loading 期可达性）。
5. **R3 逐圆点像素 + 双源交叉**：像素期望色**不是**取 store 自报，而是由 `/fills` 事实源（`side`/`reason` ⇒ 色）推导后再与 store/像素三方交叉；偏离点必须在**四档量化口径**内被解释（§6.2），否则记 FAIL。

---

## 3. B1（阻断项）：L2 跳转后控制条按钮可点击 —— 通过

### 3.1 判据与实测（`raw/spec1/t7_bar_clickability.json`；`logs/e2e_spec1_verify.log`）

| 观测 | 修复前（冻结轮文字证据） | 修复前**等价复现**（本波变异 M-LAYOUT，§9） | **本次线上（修复后）** |
|---|---|---|---|
| 高亮提示存在（触发条件） | 是 | 是（`guardNote=1`） | **是**（`noteState=ok`，文案含「已高亮目标成交」） |
| K 线容器溢出卡片 | **+27px** | **+27px** | **−1px** |
| 卡片底部 vs 控制条顶部 | 296 vs 304（“越界”由画布造成） | 同 | `hostBottom 296 ≤ barTop 304 + 1` ✓ |
| 图表区高度 | （旧固定假设 234） | **234** | **206**（弹性收缩，>100 可用） |
| 「全览」3 采样点（中心/15%/85%）命中 | 中心+15% = `canvas` | 中心+15% = `canvas`（`selfOrChild=false`） | **`button`×3（`selfOrChild=true`）** |
| 「回退」3 采样点命中 | 同左 | 中心+15% = `canvas` | **`button`×3（`selfOrChild=true`）** |
| 真实 `click({timeout:3000})`（全览） | `TimeoutError` | **`TimeoutError: locator.click: Timeout 3000ms exceeded`** | **成功**（`resetClickOk=true`，无异常） |
| 真实 `click`（回退，enabled） | `TimeoutError` | **`TimeoutError`** | **成功**（`backClickOk=true`） |
| 点击是否**真触发 handler** | — | — | 点「全览」后提示**被清除**（`afterReset.notePresent=false`） |
| 点击前提示仍在（保证遮挡条件成立） | — | — | `guardNote=1` ✓ |

⇒ **B1 通过**：3 采样点 ×2 按钮全部自命中，两次真实点击均成功且状态机确有响应；布局不变量（不溢出、不越过控制条、仍有可用高度）全部成立。

### 3.2 自建 T7 由**红转绿**（规格维护后的加固版）

加固内容（同一用例，判据更严）：① 每按钮 **3 采样点**（原仅「全览」中心 1 点）；② **真实 `click`**（原仅 `elementFromPoint`）；③ 触发条件守卫（`guardNote`）；④ 点击生效证据（提示被清除）。
结果：**绿**（`logs/e2e_spec1_verify.log` T7 ✓，5.5s；全套 10/10）。

### 3.3 变异反证（B1 有牙）

见 §9.1：把弹性布局改回「固定高度假设」后，T7 **红**，且读数与冻结轮**逐项一致**（溢出 +27px、中心/15% 命中 `canvas`、两次真实点击均 `Timeout 3000ms exceeded`）。

---

## 4. R1（末根 bar 标签裁剪）：通过

`raw/v1_last_bar_label.json`；用例 `adr028-features-verify2.e2e.ts::V1`（15.3s）。

### 4.1 实测（run `sr_1789865219068_000001`，末根 bar=423 的两笔）

| 标记 | 标签文本 | 圆点 (pane 坐标) | 渲染器锚点 `fillText.x` | 期望宽（渲染器真实 font 度量） | 文本右缘 = x+宽 | 与圆点间距 | ink 总墨量 | ink 跨度 | 覆盖率 | **跨度/期望宽** |
|---|---|---|---|---|---|---|---|---|---|---|
| `1:42` Buy | `B 1.188×843.9619` | (603, 29) | **527.8** | 67.33 | **595.1** | **7.9**（< 圆点 x=603） | 185 | 69 | 0.797 | **1.025** |
| `1:43` Sell | `S 1.195×37,764.7619` | (603, 40) | **516.8** | 77.58 | **594.4** | **8.6** | 163 | 77 | 0.727 | **0.993** |
| 对照 `1:1`（中部 bar） | `B 1.075×932.6936` | (291, 47) | **299.2**（右侧，未翻转） | 67.33 | 366.5 | 8.2（右侧） | 153 | 69 | 0.900 | **1.040** |

判据（全部通过）：① 标签整盒在 pane 内（右缘 595.1 / 594.4 ≤ `pane.cw-1` = 605；左缘 ≥ 1）；② 末根 bar 标签**翻转到圆点左侧**（文本右缘 < 圆点 x，间距 ≤10px）；③ **完整性**：ink 跨度/渲染器实测文本宽度 ∈ [0.85, 1.3]（实测 1.025 / 0.993）、墨列覆盖率 ≥ 0.5（0.797 / 0.727）、ink 墨量 ≥ 60（185 / 163）；④ ink 右缘不得侵入圆点区（596 / 593 < 603）；⑤ 对照（中部 bar）保持**右侧绘制**（既有行为不变）且同指标达标 ⇒ 阈值可达、非恒绿。
`raw/v1_last_bar_labels.png` 为对应截图。

### 4.2 修复前（变异 M-R1，§9.2）对照

同一判据下：锚点 x = **611.2**（> pane 606），文本右缘 **678.5** ⇒ 整盒越界；紧盒内 ink **total = 0 / span = 0**（标签完全不可见）⇒ 判据**必红**。

---

## 5. R2（不可达 loading 分支 + 不可验证承诺文案）：处置确认 通过

`raw/v2_r2_disposition.json`；用例 `V2`（6.4s）。

### 5.1 源码侧（去注释后）

| 检查 | 结果 |
|---|---|
| `const highlightState:` 联合类型 | `'idle' \| 'ok' \| 'unrecorded' \| 'unmatched'` ⇒ **无 `'loading'`** |
| 字符串字面量含「自动补齐」/「标记就绪后」/「标记不可得」 | **均 false**（三条承诺/错误文案字面量均已不存在） |
| `fills.loading && fills.rows.length === 0` 分支守卫 | **不存在** |
| 可达三态保留 | `ok` / `unrecorded` / `unmatched` **均在** |
| 透明的「出处」记录 | 原句在**注释**中作为删除理由被引用 2 处（`commentOnlyMentions=2`）；注释非 UI 文案，故不等价于保留文案——已在判据中显式排除并记录 |

### 5.2 产物侧（被服务 bundle `/assets/index-BY728MHs.js`）

| 检查 | 结果 |
|---|---|
| 「自动补齐」/「标记就绪后」/「标记不可得」 | **0 命中** |
| 对照串「未在 K 线标记中找到目标成交」/「该运行未记录成交明细」/「已高亮目标成交」 | **均命中**（⇒ 检索路径有效，上述缺席断言不是恒真） |

### 5.3 运行期 + 可达性复核（删分支的依据）

| 观测 | 实测 |
|---|---|
| 正常跳转提示 | `data-state=ok`，文案「已高亮目标成交 1:42（放大 + 描边脉冲，3 秒后回常态）」（不含承诺语句） |
| 注入 12s 延迟（未到位期间） | `wb-fills-note=「成交明细加载中…」`（保留的**真**披露）、`data-marker-overlays=0` |
| loading 期 L2 行可达性 | `wb-l2-row-1-42` **count = 0**（L2 表不可达） |
| loading 期 `wb-jump-highlight-note` | **count = 0**（不可能进入 `highlightState='loading'`） |

⇒ 「分支不可达」的依据成立：**在 UI 上不可达**（高亮的唯一触发面 L2 表与成交明细同批提交），删除分支并保留可达三态是**正当处置**；「自动补高亮」这类**不可验证承诺**已消失（源码 + 产物两侧）。

---

## 6. R3（圆点颜色身份）：通过（附口径）

`raw/v3_dot_pixels.json`、`raw/v3_dot_pixels.png`、`raw/pixel_dots_offline.json`；用例 `V3`（7.6s）。

### 6.1 聚合读数（L2 跳转后窗口内、完全落在画布内的圆点 = **27 个**）

| 项 | 值 |
|---|---|
| 采样圆点 / 全部 overlay | **27 / 44** |
| 侧别（由 `/fills` 事实源推导） | 买 26 / 卖 1 |
| `store` 色值 == `/fills` 侧别⇒色（Buy=#ff5c6c / Sell=#00e0a4） | **27 / 27** |
| 圆心像素**逐像素等于**侧别色（Δ=0） | **24 / 27 = 0.889**（≥0.75 判据） |
| 圆心或 3×3 主导色属对应色相族 | **26 / 27** |
| 四档口径内可解释（无 FAIL） | **27 / 27**（exact 24 / near 0 / store-exact 0 / dominant 2 / blend 1 / **fail 0**） |
| 唯一卖出圆点（`1:43`，ForceClose） | 圆心 = `(0,224,164)` == `#00e0a4`（Δ=0） |
| 买入圆点样例 | 圆心 = `(255,92,108)` == `#ff5c6c`（Δ=0，21+ 条） |

**四档口径**（每条都必须落档，否则判 FAIL）：`exact` 圆心 Δ≤10 ｜ `near` 圆心 Δ≤25 ｜ `store-exact/dominant`（3×3 主导色 == store 色，Δ≤10 / ≤25）｜ `blend`：像素可**量化还原**为「期望色 × 已知覆盖层」（`px ≈ α·C + (1-α)·期望色`，C ∈ {标签底色 (9,13,24), 面板底色 (11,15,26), 白描边 (255,255,255)}，α∈(0.05,0.95)，残差 ≤12）。反假绿：把期望色换成异色族（绿↔红）时 `blend` 必然不成立（数学上无法用「期望色 + 暗覆盖层」拟合出异色族的通道关系）。

**3 个偏离点（逐条落盘，均为**渲染层覆盖**而非身份错配）**：

| key | 圆心像素 | 3×3 主导色 | 判定 | 说明 |
|---|---|---|---|---|
| `1:19` | `(142,145,173)`（灰蓝，被指示线压住） | `(255,92,108)` | `dominant`（Δ=0） | 圆心被覆盖，但圆点本体色在 3×3 内逐像素等于 store 色 |
| `1:29` | `(22,119,255)`（蓝，被指示线压住） | `(239,93,117)` | `dominant`（Δ=16 ≤25） | 同上；主导色为标记色与指示线的混合 |
| `1:40` | `(52,25,38)` | `(52,25,38)` | `blend`（α=0.83，覆盖色 = 标签底色 (9,13,24)，**残差 1.4**） | 相邻标记的标签底盒压在该圆点上；可**定量**还原为「标记红 × 标签底色」 |

### 6.2 止损橙（`#fb923c`）—— **不可测**（写明口径与补测条件）

| 项 | 实测 |
|---|---|
| 全库 `reason` 计数（10 个 run、**367 笔**成交） | `Policy 360 / ForceClose 7 / **StopTrigger 0**` |
| 本 run（run A） | `Policy 43 / ForceClose 1 / StopTrigger 0`（44 笔） |
| ⇒ 橙色圆点样本 | **0 个可渲染**（无数据） |
| 源码侧映射（本次复核） | `COLOR_BUY='#ff5c6c'` / `COLOR_SELL='#00e0a4'` / `COLOR_STOP='#fb923c'` 且 `stop ? COLOR_STOP : …` 分支存在 —— 但**源码常量不是像素证据** |
| **复验口径（未来补测条件）** | 一旦有 `reason='StopTrigger'` 的成交：① `/fills` 侧别⇒色应得 `#fb923c`；② 该圆点圆心（或 3×3 主导色）须落于 `#fb923c ±10`，或按 §6.1 `blend` 档给出覆盖层定量还原；③ 本规格 `V3` 已内置该断言（`stopDots.length>0` 时逐条判 `tier != FAIL` 且 `store == COLOR_STOP`）⇒ **有数据即自动开测，无需新写用例** |

### 6.3 离线（PIL）独立复算（读图路径与页面侧完全独立）

`raw/pixel_dots.py` → `raw/pixel_dots_offline.json`：同样 27 个点，档位分布与页面侧**完全一致**（exact 24 / dominant 2 / blend 1 / fail 0），**27/27 点页面侧与离线侧逐通道差 ≤2（实测最大差 0）**。

---

## 7. 无回归：绿

| # | 套件（均 `--workers=1 --retries=0`，全程 `timeout` 前缀） | 结果 | 原始输出 |
|---|---|---|---|
| 1 | `e2e/adr028-features-verify.e2e.ts`（自建，**锚点已更新**） | **10 / 10 绿**（1.1m） | `logs/e2e_spec1_verify.log` |
| 2 | `e2e/adr028-features-verify2.e2e.ts`（新增） | **3 / 3 绿**（29.7s） | `logs/e2e_spec2_verify.log` |
| 3 | `e2e/adr028-window-sync.e2e.ts` | **6 / 6 绿**（23.5s） | `logs/e2e_adr028_window_sync.log` |
| 4 | `e2e/adr028-axis-align-probe.e2e.ts`（v2） | **2 / 2 绿**（43.4s） | `logs/e2e_adr028_axis_align_probe.log` |
| 5 | `npx tsc -b` | **exit 0**（空输出） | `logs/tsc_b.log` |
| 6 | 单测子集（10 文件：`adr028LayoutFix` / `adr028FocusHighlight` / `KlineChart` / `KlineChartVisibleRange` / `resultWindow` / `resultWindowSync` / `resultAxisIndex` / `resultBarSpaceLimit` / `chartUtils` / `chartSyncAlignClosedLoop`） | **99 / 99 绿**（4.94s；`--maxWorkers=1` + `NODE_OPTIONS=--max-old-space-size=2048`） | `logs/vitest_subset.log` |
| 7 | 崩溃 / core dump | **无**（无异常退出、无 core 文件；失败用例仅为断言失败） | — |

> **稳定性复跑（同一天第二次执行，判据未变）**：规格 1 **10/10 绿**（`logs/e2e_spec1_verify_final.log`，10/10 含 T7 5.5s）、规格 2 **3/3 绿**（`logs/e2e_spec2_verify_final.log`）⇒ 时间敏感的 T7（3s 高亮窗口）与 V1/V3 无抖动。
> 附注：`adr028-window-sync` 的 E4（`全览 / 历史回退` 真身行为）本轮也真跑到并通过，与 B1 的「按钮可点」互为佐证。
> 未跑（资源纪律限定「只跑相关规格」）：修复方 `adr028-features-fix.e2e.ts`、`adr028-fill-focus-highlight.e2e.ts`、`adr028-axis-align-verify.e2e.ts`、以及全量 e2e/单测。

---

## 8. T0 锚点维护（属规格维护，非放宽）

| 项 | 值 |
|---|---|
| 旧锚点（冻结轮硬编码） | `8d6022e1c71cbf1b362396f0d7fde9a07d62bc9832eff621b2df06d6991e44fb`（`assets/index-DhgvwmsX.js`） |
| 新锚点（本波更新） | **`f2504232e7a4fba582943fdbe020235013fef27752313db6cc69531f37d0fa0e`**（`assets/index-BY728MHs.js`） |
| 维护方式 | 规格内新增常量 `EXPECT_BUNDLE_NAME` / `EXPECT_BUNDLE_SHA256`（附「产物合法变更须由规格维护者显式更新、**不得放宽为任意 bundle / 不得加 env 旁路**」的注释）；并**加强**：① 被服务 URL 必须含该名；② `web/dist/index.html` 必须引用同一 URL；③ 被服务字节 == `web/dist` 同名文件 sha256（逐字节）；④ 等于上述锚点 |
| 防漂移 | 复验开始（10:47）与结束（11:0x）两次拉取 sha256 相同；`web/dist/{index.html,assets/*}` mtime 仍为修复方 10:44:59 ⇒ 复验期间产物未变动 |
| 更新后全套 | **10/10 绿**（T0 绿，T7 绿） |

---

## 9. 反假绿：2 次变异反证（**有牙**）

变异**只作用于临时构建目录**（`npx vite build --outDir dist-mut` + `vite preview --outDir dist-mut --port 4175`，代理到 `:8081`）；**线上 `:8081`/`web/dist` 全程未被触碰**；每次变异后逐字节复原并重建校验。

| 变异 | 改动（生产源码临时改，随后复原） | 结果 | 关键读数 |
|---|---|---|---|
| **M-LAYOUT**（B1 牙口） | 卡片 `flex flex-col` 去掉、头部 `shrink-0` 去掉、图表区 `min-h-0 flex-1` → `h-[calc(100%-1.25rem)]`（= 修复前固定高度假设） | **T7 红** | 溢出 **+27px**；`hostBottom 296 / barTop 304`；图表区 234；两按钮中心与 15% 点命中 `canvas`（`selfOrChild=false`）；`guardNote=1`；真实点击 **`TimeoutError: locator.click: Timeout 3000ms exceeded`**（全览、回退各一次）— 与冻结轮签名**逐项一致**。`logs/mut_M_LAYOUT_T7.log`、`raw/mut_M_LAYOUT/t7_bar_clickability.json` |
| **M-R1**（R1 牙口） | `placeFillLabel` 调用回退为 `x = c.x + r + 3, align='left'`（= 修复前「恒在右侧」） | **V1 红** | 锚点 x = **611.2**（> pane 606），文本右缘 **678.5**；紧盒内 ink **总墨量 0 / 跨度 0 / 覆盖率 0**（标签完全落在 pane 外）⇒ 首个断言「标签右缘必须落在 pane 内」即红。`logs/mut_M_R1_V1.log`、`raw/mut_M_R1/v1_last_bar_label.json` |
| 复原校验 | 两个文件 `cp` 回备份，sha256 与备份**相等**（`3dc58efc…` / `efa61a16…`）；`git diff --stat` 恢复为 `2 files changed, 63 insertions(+), 18 deletions(-)`（与波次起点一致）；变异标记 `grep -c 'M-R1 变异'`=0、`placeFillLabel(...)` 调用在 | **通过** | — |
| 恢复后逐字节一致 | 复原后用同一源码重建（`dist-mut`）⇒ `index-BY728MHs.js` sha256 = **`f2504232…`** == 线上 bundle == 我波次起点快照（构建确定性 + 复原保真） | **通过** | `logs/restore_rebuild.log` |

---

## 10. 残留风险 / 未做项

1. **止损橙圆点无真渲染像素证据**（全库 `StopTrigger=0`）；已给可自动触发的复验口径（§6.2③），当前登记为**不可测**而非通过。
2. **3/27 圆点圆心被覆盖层染色**（指示线 / 相邻标签底盒）：属**渲染层级**现象，非颜色身份错配；已逐条量化还原（§6.1）。若未来要求「圆心必然可见」，需调整标记与指示线的绘制层级（本波未涉）。
3. **证据目录被跨车道写入**：修复方为核验 T0 用默认 `ADR028V_OUT` 跑了我方规格，覆盖冻结轮 `raw/`（§1.3）。建议：后续规格产物目录显式由执行者指定，或用 `ADR028V_OUT` 指向各自证据目录。
4. **R1 的文本宽度依赖渲染器 `fillText` 仪表**：若未来 klinecharts 改用非 `fillText` 的文本绘制（如 `strokeText`/离屏位图），V1 的「期望宽度」需要换仪表（判据会因取不到记录而**显式失败**，不会静默放行）。
5. **R1 字宽常量**：实现的 `FILL_LABEL_CW_PX=4.4` 是 9px 文本近似宽度（与浏览器实测 67.33/16 字符 ≈ 4.2 有偏差），实现用**保守偏大**估计 ⇒ 只会更早翻转，不影响「不裁剪」结论；若字号/字体变化需同步该常量（本波未改生产代码）。
6. **`Dockerfile.app` 缺 `crates/test-support`** ⇒ 镜像级重建仍失败（车道外，§1.2）；本环境 `:8081` 不依赖镜像，故不影响放行，但**部署可复现性**仍需基建车道修复。
7. 未跑修复方规格与全量套件（资源纪律）；未改动任何生产代码/接口/架构（sha256 与波次起点备份一致，§9）。

---

## 11. 资源纪律记录

- **单车道、未 spawn 子代理**；playwright 只跑 4 个相关规格（自建×2 + window-sync + axis-align-probe），全部 `--workers=1 --retries=0` 且加 `timeout` 前缀；vitest 单次子集运行（10 文件）+ `--maxWorkers=1` + `NODE_OPTIONS=--max-old-space-size=2048`。
- `free -h` 逐步记录：`used 19–21Gi / available 25–27Gi`，无内存压力。
- 变异阶段临时 `dist-mut` + `:4175` preview（`--strictPort`，`timeout 600` 兜底）：**用后删除**（`web/dist-mut` 已不存在）。
- 结束核验：`pgrep -f '[v]ite preview' | grep -v 'bash -c'` = **空**；playwright chromium（`ms-playwright`）进程 = **0**；无 core dump；`:8081`/`web/dist` 未被改动（mtime 10:44:59 不变，sha256 一致）；探针文件已删除（`web/dist/` 仅 `assets/`、`index.html`）。
- grep/find 均带 `--exclude-dir target --exclude-dir node_modules --exclude-dir .git`（或等价限定路径）。

---

## 12. 复现命令（单车道、全程 timeout）

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs

# 0) 真身身份（送达方式）核验
ss -ltnp | grep :8081                                  # 主机进程 eestock-app（PID …）
tr '\0' ' ' < /proc/<pid>/cmdline                      # ./target/debug/eestock-app --config /tmp/app_dev_8081.toml
cat /tmp/app_dev_8081.toml                             # static_dir = "./web/dist"
docker ps -a | grep eestock-app                        # Exited (137) 9 days ago（容器未运行）
curl -s http://localhost:8081/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
curl -s http://localhost:8081/assets/index-BY728MHs.js | sha256sum   # f2504232…

cd web && free -h
# 1) 自建复验规格（锚点已更新 + T7 加固）
timeout 900 env E2E_BASE_URL=http://localhost:8081 ADR028V_OUT=$PWD/../tester/evidence/20260920_adr028_features_verify2/raw/spec1 \
  npx playwright test e2e/adr028-features-verify.e2e.ts --workers=1 --retries=0 --reporter=list          # 10/10
# 2) R1/R2/R3 独立复验规格
timeout 900 env E2E_BASE_URL=http://localhost:8081 ADR028V2_OUT=$PWD/../tester/evidence/20260920_adr028_features_verify2/raw \
  npx playwright test e2e/adr028-features-verify2.e2e.ts --workers=1 --retries=0 --reporter=list         # 3/3
# 3) 离线像素复算（R3 交叉核对）
cd ../tester/evidence/20260920_adr028_features_verify2/raw && timeout 300 python3 pixel_dots.py
# 4) 回归
cd ../../../../web
timeout 600 env E2E_BASE_URL=http://localhost:8081 ADR028_E2E_OUT=$PWD/../tester/evidence/20260920_adr028_features_verify2/raw/spec_out/window-sync \
  npx playwright test e2e/adr028-window-sync.e2e.ts --workers=1 --retries=0 --reporter=list              # 6/6
timeout 900 env E2E_BASE_URL=http://localhost:8081 ADR027_ALIGN_OUT=$PWD/../tester/evidence/20260920_adr028_features_verify2/raw/spec_out/axis-align-probe \
  npx playwright test e2e/adr028-axis-align-probe.e2e.ts --workers=1 --retries=0 --reporter=list         # 2/2
timeout 600 npx tsc -b                                                                                   # exit 0
timeout 900 env NODE_OPTIONS=--max-old-space-size=2048 npx vitest run \
  src/features/workbench/adr028LayoutFix.test.ts src/features/workbench/adr028FocusHighlight.test.tsx \
  src/features/dashboard/KlineChart.test.tsx src/features/dashboard/KlineChartVisibleRange.test.tsx \
  src/features/workbench/resultWindow.test.ts src/features/workbench/resultWindowSync.test.tsx \
  src/features/workbench/resultAxisIndex.test.tsx src/features/workbench/resultBarSpaceLimit.test.tsx \
  src/features/workbench/chartUtils.test.ts src/features/dashboard/chartSyncAlignClosedLoop.test.ts \
  --maxWorkers=1 --reporter=basic                                                                        # 99/99
# 5) 变异反证（示例：B1 固定高度假设回退；R1 同理改 placeFillLabel 调用）
#    改源码 → npx vite build --outDir dist-mut → VITE_PROXY_TARGET=http://localhost:8081 \
#    npx vite preview --outDir dist-mut --port 4175 & → 对 :4175 跑 -g "T7" / -g "V1" ⇒ 必红
#    → cp 回备份 → 重建校验 sha256 == f2504232… → rm -rf dist-mut
```
