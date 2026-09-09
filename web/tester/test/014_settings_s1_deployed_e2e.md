# 014 执行报告 — 设置页 S1 真实 E2E 验收 + 页面截图（已部署环境）

> **本文件位置**：`/home/eestock/workspace/git/eestock/eestock-rs/web/tester/test/014_settings_s1_deployed_e2e.md`
> 角色/纪律：tester（只测不改；**零产品代码改动、零 commit / git add、零 DB 写**）
> 测试方式：真实已部署环境 Playwright E2E（独立脚本 `/tmp/settings_e2e.mjs`，未入仓）
> 执行时间：2026-09-05 14:13–14:15 CST；验收结论 **16/16 检查项 PASS**
> 被验环境：`eestock-app` healthy（container `539fb12d0ee6…`，image `22303381a980…`），SPA
> `index-DT0b4Z2M.js`（bundle 内含「系统设置/S2 占位」字符串）；前端/API `http://127.0.0.1:8081`
> （同 192.168.50.100:8081）；DB `eestock-timescaledb`（5433）；部署基线 commit `c6061b6`
> （设置页 S1）；Playwright chromium 1.62.1，viewport 1280×800，locale zh-CN / Asia/Shanghai
> 证据目录：`/tmp/settings_screenshots/`（9 张截图 + `evidence.json`，均带时间/环境标注）

## 0. 执行摘要

| # | 验收项 | 结论 | 一句话证据 |
|---|---|---|---|
| 1 | 首页导航「⑧ 系统设置」可点 → `/settings` | ✅ **PASS** | ⑧ 渲染为 `<a href="/settings">`（cursor:pointer，非置灰 span），点击后 URL 落 `/settings` |
| 2 | `/settings` 7 个 data-region 齐全、无「加载失败」 | ✅ **PASS** | settings-nav/source-config/collector-config/mcp-config/system-info/log-viewer/danger-zone 各 1；body 无「加载失败」文本 |
| 3 | system-info 真实值（版本/crate/DB/时长） | ✅ **PASS** | DOM 与 `GET /api/system/info` JSON 全等：v0.1.0、crates c/s/d=0.1.0、DB 已连接、运行时长一致 |
| 4 | source/collector/mcp 只读 + S2 禁用 | ✅ **PASS** | 3 区均含「参数配置化将在下一阶段上线（S2）」；保存按钮 3 个全 disabled；8 源清单/60s 间隔/MCP 开关与 `/api/config/*` JSON 一致；会话 PATCH=0 |
| 5 | danger-zone confirm；空 confirm→400、不执行 | ✅ **PASS** | UI 层空 confirm 双按钮禁用、点击 0 POST；同源直 POST confirm="" → purge-raw 400 `{"error":"confirm 须为 PURGE…"}`、reset-circuits 400 `{"error":"confirm 须为 RESET…"}`；DB 前后不变（见 §5） |
| 6 | log-viewer S2 占位 | ✅ **PASS** | 「日志跟随将在下一阶段上线（需日志采集层）｜级别过滤 / WS 持续推送（S2）」，无报错 |
| 7 | 无 pageerror/console error；读接口 200 | ✅ **PASS** | pageerror 0、console error 0、`/api/system/info`×2 与 `/api/config/{sources,collector,mcp}`×2 全部 200、无 PATCH、无非探针 4xx/5xx |

**验收结论：设置页 S1（c6061b6 部署）真实环境验收全部 PASS（16/16）。**

## 1. 测试运行

命令：`node /tmp/settings_e2e.mjs`（Playwright 1.62.1，复用 `eestock-rs/web/node_modules`；
browser chromium-1234 命中本地 cache）。断言结果落 `/tmp/settings_screenshots/evidence.json`。

### 1.1 逐项证据（DOM / network 摘录）

**① 首页导航 → `/settings`**
- `nav[data-region="nav"] a:has-text("⑧ 系统设置")` 计数 1，`href=/settings`，CSS cursor=pointer；
  置灰样式 span（cursor-not-allowed）含 ⑧ 的计数 0。点击后 `url=http://127.0.0.1:8081/settings`。
- 导航全文本（`|` 分隔）：`① 行情看板 | ② 数据源诊断 | ③ 标的管理 | ④ 数据质量 | ⑤ 回测工作台 W3 | ⑥ 交易面板 W4 | ⑦ 告警中心 | ⑧ 系统设置`

**② /settings 区域**
- 区域计数：`{"settings-nav":1,"source-config":1,"collector-config":1,"mcp-config":1,"system-info":1,"log-viewer":1,"danger-zone":1}`（各 1，含内容）。
- 骨架（4 个 `*-skeleton` data-testid）加载后全部 detach；body 无「加载失败」。

**③ system-info（真实值，非骨架）**
- region innerText：`应用 v0.1.0·crates：collector 0.1.0/storage 0.1.0/diagnose 0.1.0` + `DB 已连接·运行 0时 5分`
- 与 `/api/system/info` JSON 交叉核对：`app_version=0.1.0`（DOM `v`+值 全等）、`crate_versions{c,s,d}=0.1.0` 全等、
  `db_ok=true ↔ 已连接`、`uptime_secs=332 ↔ DOM 0时 5分`。

**④ 三只读配置区**
- source-config：8 行（`/api/config/sources` 亦 8 源），每行源 label/速率/抖动/熔断连续失败/退避/锁定标/开关；
  含 S2 注记；region 内保存按钮 disabled。
- collector-config：DOM `全局默认抓取间隔…60s · 交易时段 09:30-11:30/13:00-15:00 写死不开放（只读展示）`
  ↔ API `default_interval_sec=60, trading_hours="09:30-11:30/13:00-15:00"`。
- mcp-config：DOM `MCP 服务总开关｜交易工具独立开关 默认关；开启需页面二次确认（ADR-009）｜每日下单限额：金额 50,000 · 笔数 20`
  ↔ API `enabled=true, trading_tools_enabled=false, daily_limit_amount=50000`。
- S2 注记（`参数配置化将在下一阶段上线（S2）`）source/collector/mcp 三区均在；3 个「保存」按钮 `isDisabled()=true`；
  **全会话 PATCH 请求 = 0**（无 `/api/config/*` PATCH）。

**⑤ danger-zone（只验证拒绝路径，不真执行）**
- 空 confirm 态：`清空 kline_raw` 与 `全部源熔断重置` 按钮均 disabled（`isDisabled()=true`）；
  placeholder=`输入 PURGE 或 RESET 确认`；force 点击 disabled 按钮后 **POST 数 before=0 / after=0**（无请求发出），
  `danger-message` 元素未出现——UI 层设计即「空/不匹配 confirm 不发请求」（源码注释口径）。
- 服务端拒绝路径（同源直 POST，模拟空 confirm 提交）：`POST /api/system/purge-raw {confirm:""}` → **400**
  `{"error":"confirm 须为 PURGE（危险操作：清空 kline_raw）"}`；`POST /api/system/reset-circuits {confirm:""}` → **400**
  `{"error":"confirm 须为 RESET（危险操作：全部源熔断重置）"}`。
- 未执行证明：purge-raw/reset-circuits 处理器在 confirm 校验后才会触碰 DB；DB 前后探针
  `kline_raw count = 24709 → 24709`、`circuit_reset_requests count = 0 → 0`（见 §5）。

> 口径说明：页面源码/注释（`DangerZone.tsx`、`api_settings.rs`）即「UI 空 confirm 禁发、服务端缺失 400」双层防御；
> 前端错误提示元素 `[data-testid="danger-message"]` 存在（操作失败渲染位），但空 confirm 在 UI 层不可达请求
> （disabled 按钮），故「空 confirm→前端错误提示」无法在真实 UI 以不执行方式触发——本项按设计语义验证为：
> UI 层阻断（0 请求）+ 服务端 400（同源直 POST 证据）+ 不执行（DB 不变）。若验收口径要求 UI 内可见错误提示，
> 需 S2 或联调环境放开，非本次部署缺陷。

**⑥ log-viewer**
- region innerText：`日志跟随将在下一阶段上线（需日志采集层）｜级别过滤 / WS 持续推送（S2）`（占位文案与源一致，无报错）。

**⑦ 网络 / console**
- 页面内 `/api/system/info` GET×2、`/api/config/sources|collector|mcp` GET×2 全部 **200**；无 PATCH；无非探针 ≥400 响应；
  console error **0**（浏览器侧日志亦 0；服务端 400 探针改用 Node fetch 同源直发，不污染页面 console）；
  pageerror **0**。
- 部署 bundle 校验：`GET /` 返回 `index-DT0b4Z2M.js`（517,113 B），bundle 内含「系统设置/参数配置化将在下一阶段上线（S2）」字符串。

## 2. 截图证据清单（/tmp/settings_screenshots/，均带环境+时间标注，ImageMagick 底部 caption）

| 文件 | 尺寸 | 内容 |
|---|---|---|
| `settings_nav_settings.png` | 208×794 | 首页左侧导航整列：⑧ 系统设置为可点链接（非置灰），⑤⑥ 置灰对照 |
| `settings_fullpage.png` | 1488×1112 | /settings 整页（全部 7 区域；1488 宽为全站既有壳层 EV-2 特征，非设置页缺陷） |
| `settings_systeminfo.png` | 1072×147 | system-info 真实值 |
| `settings_sourceconfig.png` | 1072×336 | source-config 只读 8 源 + S2 禁用保存 |
| `settings_collectorconfig.png` | 1072×88 | collector-config 只读 + S2 禁用保存 |
| `settings_mcpconfig.png` | 1072×138 | mcp-config 只读开关/限额 + S2 禁用保存 |
| `settings_dangerzone.png` | 1072×149 | danger-zone 双按钮 + confirm 输入框（空态） |
| `settings_logviewer.png` | 1072×275 | log-viewer S2 占位 |
| `settings_settingsnav.png` | 176×794 | settings-nav 面板（骨架锚点，S1 空态） |

标注样例（每张底部 caption）：`eestock-app 539fb12d0ee6 / img 22303381a980 | http://127.0.0.1:8081 | 2026-09-05 14:14:31 +08 | settings_systeminfo.png`

## 3. 结果统计与残留风险

- 检查项 16/16 PASS；无崩溃、无 core dump；无 pageerror / console error。
- 未改动产品代码 / 未 commit / 未 git add / 未写 DB（SELECT 探针与同源 400 POST 仅验证拒绝路径）。
- 残留风险：① 本地 `web/dist`（index-CCp6SOZc.js）与部署 bundle（index-DT0b4Z2M.js）哈希不一致——本地 dist 非本次部署产物，
  验收以运行中容器为准（bundle 字符串与 DOM 行为均与源码基线 c6061b6 一致）；② 空 confirm 的前端错误提示为设计上不可
  UI 触发路径（见 §1.1⑤口径说明）；③ MCP 总开关当前 enabled=true、交易工具关——为现网真实配置快照，仅只读展示。
- 复现路径：无需（无 FAIL）。
