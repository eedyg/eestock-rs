# 271 — P2-C 独立验收 harness 设计（真实渲染 + 像素级）

- **本文件路径**：`tester/design/271_p2c_independent_harness_design.md`
- **配套执行报告**：`tester/test/271_p2c_independent_acceptance_execution.md`
- **harness 源码副本**：`tester/evidence/271_p2c_independent/harness/`（entry.tsx / kcspy.ts / index.html / vite.config.mjs / render.mjs / probe2.mjs / probe3.mjs）
- **运行期工作目录**：`/tmp/p2c`（临时；不进仓库）；运行命令：`cd web && ./node_modules/.bin/vite build --config /tmp/p2c/vite.config.mjs` 然后 `node /tmp/p2c/probe3.mjs`

## 目标
把「卫星实例真的这么渲染了吗」从 jsdom 桩推进到**真实 klinecharts 10.0.3 + 真实产品组件 + 画布像素**，用于独立验收 T2 / T5 / G4 / T8（init 计数）/ 反向对照 / 溢出实测。

## 分层策略
| 层 | 手段 | 覆盖 |
|---|---|---|
| L1 库事实 | `web/tester/p2-satellite-harness/`（file:// + UMD，既有） | `height:0` 单独无效、`minimize+minHeight:0` 有效、`separator:0`、缩放后成立、`getConvertPictureUrl` 抛错 |
| L2 产品级真实渲染 | 本 harness（Vite 打包真实 `MultiPeriodSatellite`/`KlineChart`） | T2 几何/像素、T5 逐实例指标、G4 像素、T8 init 计数、反向对照、溢出 |
| L3 行为/契约 | `web/src/features/dashboard/multiPeriod*.test.*`（jsdom 忠实桩） | WS 订阅数、并发闸、排队不丢、生命周期、裁决 A 等价性、失败可见 |

## 关键设计点
1. **实例捕获**：Vite alias `klinecharts` → `kcspy.ts`（`export * from '<real esm>'` + 覆盖 `init`/`dispose`）⇒ 拿到每个真实 chart，按宿主打标（`sat:<period>` / `base:<host>`）。避免修改产品代码。
2. **几何/布局**：卫星根 `style.height=180px` + `KlineChart` 根 `relative h-full w-full` 依赖 tailwind 工具类 ⇒ harness 注入**最小工具类子集**（flex/flex-col/flex-1/min-h-0/h-full/w-full/shrink-0/overflow-hidden/relative/absolute），否则容器高 0（首轮实测即为该伪影，已修正）。
3. **像素采样**：逐 pane `getDom(paneId)` → 其 canvases → `getImageData`；分类计数：up `#ff5c6c` / down `#00e0a4`（蜡烛，tol 20）、axis `#8b93b0`（坐标轴文本）、zero `#76808F`（DCAP 0 参考线，tol 8）、saturated（通道差和 >110）。**禁用 `getConvertPictureUrl`**（零高 pane 抛 `InvalidStateError`）。
4. **文本归因**：patch `fillText`，记录 `{host, text, x, y, textBaseline, font}` ⇒ 既做图例/精度证据（5 位小数、`0:` 图例），也做 `y == y(0)`（`textBaseline:'top'` + `12px` ⇒ 文本中心 = y+6，与本轮实测零点线像素行 55 吻合）。
5. **阳性/阴性/反向对照**：基准（不隐藏 + 有 DCAP）= 阳性；卫星 candle pane（h=0）= 阴性；`candle-visible`（不隐藏）= T2 反向；`dcap-off`（隐藏 + DCAP 关）= T5/G4 反向。
6. **零出网**：假 api（合成 bar）/假 ws；仅本地静态服务（随机临时端口，进程内创建、结束关闭）；`page.on('request')` 断言无非本地请求。真指针：`nonLocalRequests=[]`。
7. **溢出实测**：`#main{height:600px}` + 基准 420 + 4×180 ⇒ `scrollHeight 1140 / clientHeight 600` ⇒ 540px 溢出（已知限制，P5）。

## 边界/例外
- 不触及后端与线上进程；不写库；不改产品代码（仅新增 harness 临时文件与 tester 证据）。
- DCAP「数据不足断线」像素级证据未取得 ⇒ 明确标注为证据范围限制，不做判据放宽亦不做判 FAIL。
- harness 为等价复刻（无 tailwind 全量 CSS），几何量级与产品一致但非逐像素同版。
