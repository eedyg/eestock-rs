# ADR-028 D4.1 冻结解除修复报告（worker 前端车道）

**本报告路径**：`coder/evidence/20260920_adr028_features_fix/report.md`

**判词（前置一行）**：B1 **已修复**，L2 跳转后「全览 / 历史回退」三个采样点全部命中按钮自身、真实 `click()` 成功不超时（tester 自建规格 T7 由红转绿）｜R1 **已修复**（末根 bar 标签翻转收敛，ink 列覆盖率 0.995/0.869、ink 255/116，盒右缘 ≤ pane-10）｜R2 **删除**不可达分支与其承诺文案（附可达性理由 + 源码守卫单测）｜R3 **已补像素颜色断言**（24 个圆点：21 个圆心逐像素等于 store 色值、24/24 属对应色相族；卖出圆点实测 `(0,224,164)` == `#00e0a4`，Δ=0；**止损橙无样本**，已给不可测说明与复验口径）｜无回归：`window-sync 6/6` + `axis-align-probe v2 2/2` + `tsc -b exit 0` + 单测子集 25/25 **绿**；tester 规格 `9/10`，唯一红项 `T0`（硬编码旧 bundle sha256，见 §7.1，非行为回归）｜未做项：止损橙圆点的**真渲染**像素断言（现网无 `StopTrigger` 数据）、`Dockerfile.app` 镜像级重建（车道外，见 §8）

---

## 1. 变更清单（只动 `web/`，零 Rust 改动）

| 文件 | 变更 | 归属判据 |
|---|---|---|
| `web/src/features/workbench/KlineResultChart.tsx` | 卡片 `h-64 shrink-0` → `flex h-64 shrink-0 flex-col`；头部行加 `shrink-0`；图表区 `h-[calc(100%-1.25rem)]` → `min-h-0 flex-1`；删除 `'loading'` 高亮态与「标记到位后自动补齐高亮」承诺文案 | **B1** + **R2** |
| `web/src/features/dashboard/KlineChart.tsx` | 新增纯函数 `placeFillLabel()`（标签边缘收敛）+ `FILL_LABEL_GAP_PX/CW_PX/PAD_PX` 常量；`fillDot` 模板的 `text` figure 改用该函数（`p.bounding.width` 为面板宽） | **R1** |
| `web/src/features/workbench/adr028LayoutFix.test.ts`（新增） | 7 个单测：R1 纯函数 4 例、R2 源码守卫 2 例、R3 颜色身份映射 1 例 | R1/R2/R3 |
| `web/e2e/adr028-features-fix.e2e.ts`（新增） | 4 个真渲染用例 F0/F1/F2/F3 | B1/R1/R3 |

`git diff --stat`（**仅本波未暂存改动**）：`KlineChart.tsx +36/-1`、`KlineResultChart.tsx +45/-18`。
`git status --short -- crates Cargo.toml Cargo.lock` = 空 ⇒ **未改 Rust**。

---

## 2. B1（阻断项：布局溢出致按钮不可点）—— 已修复

### 2.1 修复点

旧实现：卡片固定 `h-64`，头部 `flex flex-wrap` **可换行增高**，但图表区高度写成 `h-[calc(100%-1.25rem)]`——对「头部恒 1 行」的**固定假设**。本波新增的高亮提示（~30 字）与既有图例同行 ⇒ 头部 1 行 → 2 行，图表区**不收缩** ⇒ 容器溢出卡片 27px，canvas（`position:absolute`）盖住下方 `wb-window-bar` 控制条。

修复：卡片自身 `flex flex-col`，头部 `shrink-0`，图表区 `flex-1 min-h-0`（`flex-basis:0` + 允许收缩到 0 以下）。**该布局不含任何头部行数假设**：头部 N 行时图表区恒为 `256 − headerH`；卡片高度仍 `h-64`（兄弟区域不被挤压）。

### 2.2 真渲染证据（`raw/f1_clickability.json`；规格 `e2e/adr028-features-fix.e2e.ts::F1`）

| 观测 | 跳转前（对照） | L2 跳转后（提示在） | **变异反证**（改回固定高度假设） |
|---|---|---|---|
| K 线容器溢出卡片 | −1px | **−1px** | **+27px** |
| 「全览」中心 / 15% / 85% 命中 | button/button/button | **button/button/button（均 `selfOrChild=true`）** | canvas/canvas/button |
| 「历史回退」三点命中 | button（自命中） | **button×3（`selfOrChild=true`）** | — |
| 真实 `click({timeout:3000})`（全览） | — | **成功**（`resetClickOk=true`，无异常） | **TimeoutError（被 canvas 拦截）** |
| 真实 `click`（回退，enabled） | — | **成功**（`backClickOk=true`） | **TimeoutError** |
| 卡片高 / 图表区高 | — | **256 / 206** | — |
| 点「全览」后提示 | — | 已清除（`notePresent=false`） | — |

另有断言：`host.bottom ≤ barTop+1`（卡片底部不越过控制条）、图表区高度 > 100（收缩后仍有可用高度）、`noteText` 含「已高亮目标成交」（确认 B1 触发条件真的复现）。

**变异反证（判据 4）**：把弹性布局改回 `h-[calc(100%-1.25rem)]` 的固定高度假设 ⇒ 重建 + 同步到 :8081 后 **F0/F1 双红**，读数与 tester 复验**逐项一致**（溢出 +27px、中心/15% 命中 `canvas`、两按钮真实点击 `TimeoutError: locator.click: Timeout 3000ms exceeded`）。原始输出：`logs/mutation_b1_revert_flex.log`，读数：`raw/mut_b1_fixed_height/f1_clickability.json`。改回后已逐字节复原（`grep -c 'flex h-64 shrink-0 flex-col' = 1`）。

**交叉验证（tester 自有规格，未修改）**：`T7 回归：L2 跳转后「全览/历史回退」必须仍可点击` 由 **红 → 绿**（`logs/e2e_adr028_features_verify.log`）。

---

## 3. R1（标签在面板右缘被裁剪）—— 已修复

### 3.1 修复点

`KlineChart.fillDot` 模板的标签 figure 原恒为 `x = 圆点x + r + 3, align='left'` ⇒ 圆点贴 pane 右缘（run 末根 bar 被窗口推到右缘）时文本画出面板外被裁。

新增纯函数 `placeFillLabel({x, r, text, paneWidth})`：
1. 右侧放得下 ⇒ **保持旧位置**（既有居中 bar 逐像素不变，单测 ① 锁死该口径）；
2. 右侧放不下、左侧放得下 ⇒ **翻转到圆点左侧 + 右对齐**；
3. 两侧都放不下（面板极窄）⇒ 向面板内**夹紧**，锚点不越界。

### 3.2 真渲染证据（`raw/f2_last_bar_label.json`；用例 `F2`）

前置：L2 跳转把末根 bar 推到 pane 右缘（`paneW=606`；容器宽 666）→ 等窗口生效 → 等 3.6s 高亮回常态（避免白环干扰像素）。

| 标记（末根 bar，ts=1789660800） | 边侧 | 标签盒 [x0,x1] | ink 列覆盖率 | ink 像素 |
|---|---|---|---|---|
| `1:42` `B 1.188×843.9619` | **left（翻转）** | [521, 597] | **0.995** | 255 |
| `1:43` `S 1.195×37,764.7619` | **left（翻转）** | [508, 597] | **0.869** | 116 |
| 对照：中部标记（34 个）覆盖率**中位数** | right（未变） | — | **0.915** | — |

断言：翻转盒右缘 ≤ `paneW-9`（不越界）+ 覆盖率 ≥ 0.6 + ink ≥ 80（阈值取自实测：红标签 255、绿标签 116；**旧实现**在翻转盒内仅剩 ~0-50 的蜡烛/MA 噪声）。「口径有区分力」由中部标记中位数 0.915 佐证（该指标不是恒绿）。

---

## 4. R2（`loading` 分支不可达 + 可能不真文案）—— 处置：**删除**（二选一已选，理由如下）

- **可达性事实**（tester 复验 `l2ReachableDuring=false`，我方复核一致）：`bars / fills / round-trips` 由 `useRunSeries` 的 `Promise.allSettled` **同批原子提交**，成交明细未到位期间 **L2 表本身不可达** ⇒ 组件拿不到 `highlight`，`highlightState==='loading'` 在 UI 上**不可达**。
- 该分支文案「标记就绪后自动补齐高亮」是**不可验证的承诺**，且与事实相悖（高亮窗口从**点击时刻**起算，数据晚到不会补画）⇒ 按判据选择**删除**分支与文案，而非"造一个可触发路径"（后者需要把三段数据改为分片提交，属接口/数据流架构变更，超出本车道且无可验证收益）。
- 保留的可达文案：`ok` / `unrecorded` / `unmatched`；`fills.loading` 的**真**披露仍在头部 `wb-fills-note='成交明细加载中…'`（tester T6c 已证可达）。
- 防回归：单测 `adr028LayoutFix.test.ts` 源码守卫 2 例（不得再出现该承诺文案；`highlightState` 联合类型不得再含 `loading`）+ 产物锚定 `F0`（被服务 bundle 内不得含该文案）。
- 未做：未新增"分片提交触发测试"（理由同上，且会改动数据提交时序=架构面）。

---

## 5. R3（圆点颜色身份未被独立证明）—— 已补真渲染像素断言

### 5.1 方法与判据（`raw/f3_dot_pixels.json`；用例 `F3`）

对 run `sr_1789865219068_000001` 的**每一个** fillDot：由真图表 store 取 `(ts, price, stackIndex, color)` → `convertToPixel` 得锚点 → 加堆叠偏移（`stack×12`）→ 逐 canvas 图层读 `getImageData` 的 **3×3 邻域**。判据两档（任一成立）：

- 档 1（严）：**圆心像素逐像素等于** store 色值（Δmax ≤ 10）；
- 档 2（容差）：圆心像素属该标记的**色相族**（买 r 主导 / 卖 g 主导）——覆盖"指标线/MA 压在圆心上造成混合色"的情形。

聚合判据：档 1 占比 ≥ 0.75；逐标记两档必有一成立；买/卖样本各 ≥ 1（防空绿）。

### 5.2 实测（24 个完全落在画布内的标记）

| 项 | 值 |
|---|---|
| 采样标记数 / 买 / 卖 | 24 / 23 / 1 |
| 圆心**逐像素相等**（Δ=0） | **21 / 24 = 0.875**（逐像素偏离者 = `1:30 / 1:40 / 1:41`，均为指标线交叠：实测 `[217,96,131]`/`[166,62,77]`/`[120,48,61]`，逐条落盘） |
| 档 2（色相族）成立 | **24 / 24** |
| 卖出圆点（`1:43`，ForceClose） | 圆心 = **`(0,224,164)` == `#00e0a4`**（Δ=0）、3×3 全 9 像素同色、该处仅 1 个不透明图层 ⇒ **纯标记 ink**（买红 `(255,92,108)` == `#ff5c6c` 同法） |

**止损橙（`#fb923c`）—— 不可测说明 + 复验口径（落到 tester 口径）**：
现网 10 个 run 的 `/fills` **无任何 `reason=StopTrigger`**（仅 `Policy` / `ForceClose`；`raw/f3_stop_reasons.json` 复核 run A：Policy 43 / ForceClose 1 / StopTrigger 0）⇒ **无橙色圆点可渲染**。因此"止损橙"的身份用**两段合成证明**：

1. **store 侧映射**（单测 `adr028LayoutFix.test.ts` R3）：`Buy→#ff5c6c/B`、`Sell→#00e0a4/S`、`StopTrigger→#fb923c/⊗`（同一 `createPointFigures` 模板用 `d.color` 同时画圆点填充与标签文字）；
2. **渲染恒等**（本用例）：真实渲染的圆点 ink **逐像素等于** store 色值（21/24 Δ=0，余者同色相族）。

⇒ 只要出现 `StopTrigger` 样本，复验口径 = 同法采样该标记圆心，色值须落于 `#fb923c ± 10`；**这一条未做**（无数据），已在完成判词中登记为未做项。

---

## 6. 无回归

| 项 | 结果 | 原始输出 |
|---|---|---|
| `E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/adr028-window-sync.e2e.ts --reporter=list --retries=0` | **6/6 绿**（23.5s） | `logs/e2e_adr028_window_sync.log` |
| `… e2e/adr028-axis-align-probe.e2e.ts …` | **2/2 绿**（43.4s） | `logs/e2e_adr028_axis_align_probe.log` |
| 本波规格 `e2e/adr028-features-fix.e2e.ts` | **4/4 绿**（14.6s） | `logs/e2e_adr028_features_fix.log` |
| `npx tsc -b` | **exit 0** | `logs/tsc_b.log` |
| 单测子集（`adr028LayoutFix` / `adr028FocusHighlight` / `KlineChart.test`） | **25/25 绿**（`--maxWorkers=1` + `NODE_OPTIONS=--max-old-space-size=2048`） | `logs/vitest_subset.log` |
| `npm run build` 后 `dist/index.html` 引用 | `assets/index-BY728MHs.js`（新 bundle 名），`dist/assets/` 内文件一致；:8081 服务该 bundle（md5 逐一相等） | `logs/*`、`raw/f0_bundle_anchor.json` |
| 未修改三个 tester 规格 | `git diff` 这三个文件 = 0 行 | — |

### 6.1 tester 自有规格 `adr028-features-verify.e2e.ts`（**未修改**，只自跑落盘）

`9 passed / 1 failed`（1.1m，`logs/e2e_adr028_features_verify.log`）：

- **T7（本波阻断项）现为绿**；T1–T6c 全绿（含 T2 标签 ink、T4 白簇唯一性+3s 回落、T5 竖线、T6a/T6b/T6c 三态）。
- 唯一红项 **T0 真身锚定**：该用例的第三段断言**硬编码**"实现方 bundle sha256 = `8d6022e1…44fb`"。本波按要求产出**新 bundle**（`BY728MHs`，内容含修复，`sha256=f2504232…`），故该硬编码期望必然不成立；T0 的**前两段**（index.html 必须引用打包产物、**被服务 bundle 必须与 `web/dist` 逐字节一致**）仍为绿。⇒ 属**规格内的过期锚点**，需规格拥有者 tester 在复验时更新该常量；**我未修改该规格**（判据 1 禁止）。

---

## 7. 资源纪律与真身同步披露

- 单车道、**未 spawn 子代理**；playwright 只跑 4 个相关规格（本波规格 + tester 复验规格 + window-sync + axis-align-probe），`--workers=1 --retries=0`，全部 `timeout` 前缀；vitest 单文件/三文件子集、`--maxWorkers=1`、`NODE_OPTIONS=--max-old-space-size=2048`。
- `free -h` 每步记录：各步 `used ≈ 18–19Gi / available ≈ 27Gi`，无压力。
- 结束核验：无 `vite preview` 进程（仅一条自身命令行文本自匹配，非进程）、`pgrep -c chromium = 0`、无 `web/dist-mut` 残留、无遗留临时容器/端口。
- **真身同步（重要披露）**：`:8081` 由 `eestock-app` **镜像内** `/app/dist` 静态托管，容器**无 dist 绑定挂载**（`docker inspect Mounts` 仅 `app.toml`）。本波本地 `npm run build` 后用 `docker cp web/dist/index.html + dist/assets/. eestock-app:/app/dist/` 使 :8081 提供含修复的 bundle（核验：index.html 引用 `assets/index-BY728MHs.js`；curl 取回的 js 与本地产物 **md5 逐字节一致**）。**这是容器层临时同步，不是镜像级重建**——判据 1/2 的真身仍是 tester 复验时的同一个 `web/dist`，但若之后有人 `docker compose up -d --force-recreate` 会回到镜像内旧 bundle。

### 7.1 车道外障碍（已通过 intercom 上报父车道，未擅自处理）

`docker compose build app` **当前恒失败**（`logs/docker_build_app.log`）：`Dockerfile.app`（`design/07-app-plane/00-web-api.md` tangle 生成）builder 阶段只 COPY 15 个 crate 清单，**缺 `crates/test-support`** ⇒ `cargo fetch` 报 `failed to read /build/crates/test-support/Cargo.toml (os error 2)` 中断。修它需动 Dockerfile + 设计文档源（Rust/基建车道），非前端边界。

---

## 8. 残留风险 / 未做项

1. **止损橙圆点的真渲染像素断言未做**（现网无 `StopTrigger` 样本）；已给复验口径（§5.2）。
2. `T0` 硬编码旧 bundle sha256 需 tester 更新（§6.1）；本波未修改任何 tester 规格。
3. 部分圆点圆心被指标线（MA 等）覆盖（3/24 逐像素非等值，但同色相族）——这是**渲染层级**现象（指标线在某些位置画在标记之上），非本波需求范围；已逐条落盘。
4. `Dockerfile.app` 镜像重建障碍（§7.1）：镜像级复现需修复 Dockerfile。
5. R1 的标签宽度用的是 9px 文本近似字宽（4.4px/字符 + padding 5，实测 16 字符 = 76px）；若未来字号/字体变化，需同步该常量（现已在单测中锁定口径）。
6. 未跑 tester 的 `adr028-axis-align-verify.e2e.ts` 与实现方 `adr028-fill-focus-highlight.e2e.ts`（资源纪律限定"只跑相关规格"，且判据只要求两项回归）。

---

## 9. 复现命令（单车道 / 全程 timeout）

```bash
cd web
timeout 300 npx tsc -b                                                                        # exit 0
timeout 300 npm run build                                                                      # 新 bundle
# 真身同步（镜像重建受阻，见 §7.1）：把新 dist 同步进运行容器
timeout 60 docker cp dist/index.html eestock-app:/app/dist/index.html
timeout 60 docker cp dist/assets/. eestock-app:/app/dist/assets/
timeout 400 env E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/adr028-features-fix.e2e.ts --reporter=list --retries=0 --workers=1    # 4/4
timeout 400 env E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/adr028-features-verify.e2e.ts --reporter=list --retries=0 --workers=1 # 9/10（仅 T0 硬编码 hash）
timeout 400 env E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/adr028-window-sync.e2e.ts --reporter=list --retries=0 --workers=1     # 6/6
timeout 400 env E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/adr028-axis-align-probe.e2e.ts --reporter=list --retries=0 --workers=1 # 2/2
timeout 400 env NODE_OPTIONS=--max-old-space-size=2048 npx vitest run \
  src/features/workbench/adr028LayoutFix.test.ts src/features/workbench/adr028FocusHighlight.test.tsx \
  src/features/dashboard/KlineChart.test.ts --maxWorkers=1 --reporter=basic                      # 25/25
# 变异反证（B1）：把图表区改回 h-[calc(100%-1.25rem)] + 卡片去掉 flex-col ⇒ 重建同步后 F0/F1 必红
#   原始输出：logs/mutation_b1_revert_flex.log ；读数：raw/mut_b1_fixed_height/f1_clickability.json
```

产物目录：`coder/evidence/20260920_adr028_features_fix/`
（`report.md`、`logs/`（6 份原始输出）、`raw/`（`f0_bundle_anchor`、`f1_clickability`、`f2_last_bar_label`、`f3_dot_pixels`、`f3_stop_reasons`、`mut_b1_fixed_height/`、`spec_out/`））
