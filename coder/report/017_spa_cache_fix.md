# Coder 报告 017：SPA 缓存头策略修复（防"无 K 线图"）

> **报告位置**：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/017_spa_cache_fix.md`
> 根因（父级已定位，未重复排查）：`crates/web/src/spa.rs` 服务 index.html 无 `Cache-Control`，
> 浏览器启发式缓存旧 index.html → 引用已替换的旧 bundle 哈希 → JS 404 → React 未挂载图空白。

---

## 0. 执行摘要

| 项 | 结果 |
|---|---|
| 修复 index.html 无缓存头（根因） | ✅ `Cache-Control: no-store` |
| 哈希静态资产长期缓存 | ✅ `public, max-age=31536000, immutable` |
| /app/dist 旧 bundle 残留清理 | ✅ `rm -rf dist` 于 frontend 阶段构建前 |
| 部署验证（真实容器 :8081） | ✅ index.html no-store；JS/CSS immutable；JS 200 |
| E2E 头断言 | ✅ 新增 2 用例，均通过 |
| 架构歧义 | 无（改动全在批准范围内，见 §1 架构对齐） |

---

## 1. 架构对齐（每层归属，不越界）

| 文件 | 层 | 说明 |
|---|---|---|
| `design/07-app-plane/00-web-api.md` | 设计事实源 | §1.3 SPA 托管 + §6 部署 prose 更新缓存头/dist 清理策略；`spa.rs` 与 `Dockerfile.app` 的 tangle 代码块同步更新 |
| `crates/web/src/spa.rs` | Presentation（web） | 静态托管缓存头：`cache_control_for`/`is_hashed_asset` + `file_response` 加 `Cache-Control` 头；属 SPA 托管域，零新依赖（未引 tower-http） |
| `Dockerfile.app` | 部署（构建） | frontend 阶段构建前 `rm -rf dist` 清空历史产物，确保 `/app/dist` 仅当前构建 |
| `web/e2e/smoke.e2e.ts` | E2E 用例层 | 新增「SPA 缓存头策略」describe：index.html no-store + 哈希资产 immutable |

**未动**：业务组件（`web/src/**`、`KlineChart.tsx`）、其他 crate、REST/WS handler、其他 docker 服务。改动范围严格限定在 SPA 托管 + 前端构建产物清理 + E2E 头断言。

---

## 2. 问题 / 需求描述

SPA 部署时 index.html 未设 `Cache-Control`，浏览器按启发式（`Last-Modified`/`ETag`/无显式）缓存旧 index.html → 引用已被新构建替换的旧 bundle 哈希 → JS 请求 404 → React 未挂载。用户打开页面偶发"无 K 线图"（图空）。

**修复策略**（§1.3 缓存头策略）：
- `index.html` 及一切**非哈希**静态 → `Cache-Control: no-store`（禁用启发式缓存，旧页每次重新校验）。
- **哈希**静态资产（`assets/<name>-<hash>.<ext>`，Vite 内容寻址产物）→ `Cache-Control: public, max-age=31536000, immutable`（内容随哈希变化不可变，可长期缓存，安全）。

**补充**：`/app/dist` 出现多个历史 `index-*.js`（旧镜像产物残留）。生产镜像 frontend 阶段 `COPY web/ ./` 可能把本地旧 `web/dist` 带入，vite `emptyOutDir` 默认清空但防御性再加 `RUN rm -rf dist`，确保 `/app/dist` 只有当前构建产物。

---

## 3. 实现方式（预批准架构内）

`crates/web/src/spa.rs`：
- `file_response(path, cache_key)`：响应附带 `Cache-Control`（来源 = `cache_control_for(cache_key)`）。
- `cache_control_for(rel)`：哈希资产 → `public, max-age=31536000, immutable`；其余 → `no-store`（保守回退，宁可不缓存不缓存错）。
- `is_hashed_asset(rel)`：路径以 `assets/` 前缀 + basename 去扩展名后形如 `<name>-<hash>`，其中 `<hash>` 为第一个 `-` 之后部分，长度 >= 8 且均为 `[A-Za-z0-9_-]`。**注意**：Vite url-safe hash 可含 `-`（真实样例 `index-D4J30-jW.css`），故按第一个 `-` 分段的**整段**判 hash 长度，避免漏判。

`Dockerfile.app`：frontend 阶段 `npm run build` 前加 `RUN rm -rf dist`（vite 默认清空之外的防御）。

`web/e2e/smoke.e2e.ts`：新增 2 用例，用 Playwright `request` fixture（不共享 page 缓存）直接断言原始响应头，防缓存回退回归。

---

## 4. 测试覆盖

| 测试 | 类型 | 断言 |
|---|---|---|
| `cache_control_index_html_is_no_store` | cargo 单测 | `index.html`/`/`/`""` → `no-store` |
| `cache_control_non_hashed_static_is_no_store` | cargo 单测 | `favicon.ico`/`assets/vite.svg`/`assets/index.js`/`assets/foo-123.js` → `no-store` |
| `cache_control_hashed_assets_is_immutable` | cargo 单测 | `assets/index-D3fG4fH1.js`/`.css` → `immutable` |
| `is_hashed_asset_detection` | cargo 单测 | 含 `-` 的 hash（`index-D4J30-jW.css`）正确判为哈希；无哈希/根文件/短 hash 判非哈希 |
| `index.html 响应头含 Cache-Control: no-store` | E2E | `GET /` → header 含 `no-store` |
| `哈希静态资产响应头含 immutable 长期缓存` | E2E | 解析 index.html 取首个 `/assets/index-*.js` → header 含 `immutable` |

既有 Spa 单测（sanitize 穿越/规范化、mime）全部保留并绿；无既有测试被改。

---

## 5. 验证证据

### 5.1 单元测试
```
cargo test -p web --lib spa
running 7 tests ... test result: ok. 7 passed
```

### 5.2 修复前后响应头对比（真实容器 :8081）

**修复前（旧镜像）**：
```
GET /            → HTTP/1.1 200, content-type: text/html; charset=utf-8   # 无 cache-control
GET /assets/index-B3e2W1Ku.js → HTTP/1.1 200, content-type: text/javascript   # 无 cache-control
容器 /app/dist/assets/ 含多历史 bundle：index-B3e2W1Ku.js / index-BAvDLevl.js / index-CYhipt-A.js / ...（旧产物残留）
```

**修复后（新镜像 + 部署）**：
```
GET /            → HTTP/1.1 200, content-type: text/html; charset=utf-8, cache-control: no-store
GET /assets/index-B3e2W1Ku.js → HTTP/1.1 200, content-type: text/javascript, cache-control: public, max-age=31536000, immutable
GET /assets/index-D4J30-jW.css → HTTP/1.1 200, content-type: text/css, cache-control: public, max-age=31536000, immutable
GET /sources（深链回退）→ HTTP/1.1 200, content-type: text/html, cache-control: no-store
GET /api/nonexistent → HTTP/1.1 404, application/json {"error":"not found"}   # 不回退 index.html
JS bundle  → HTTP 200（非 404）
容器 /app/dist/assets/ 仅当前构建：index-B3e2W1Ku.js / index-D4J30-jW.css（无旧产物残留）
```

### 5.3 部署
- `docker-compose build app`（compose v1）→ 构建成功，tag `eestock-rs_app:latest`。
- `docker-compose up -d app`（首个 recreate 遇 compose v1 `KeyError: ContainerConfig` 崩溃、容器退出；手动 `docker rm -f` 孤儿容器后重新 `up -d app` 成功，容器 healthy）。
- 部署验证全部通过（§5.2）。

### 5.4 E2E
```
npx playwright test e2e/smoke.e2e.ts -g "缓存头策略"
✓ index.html 响应头含 Cache-Control: no-store
✓ 哈希静态资产响应头含 immutable 长期缓存
2 passed (309ms)
```

---

## 6. 边界 / 已知豁免（上报，非本次引入）

- **smoke 全量 13 用例中 1 例失败**：`冒烟：五页全加载 › 页面 行情（/）加载且 data-region 齐` 断言 `[data-region="sub-chart"]` 为 `hidden`。**根因非本次改动**：为报告 014 §7.1 已记录的 **KlineChart 布局缺陷**（`KlineChart.tsx` 容器 `h-[125%]` 在 flex-1 父级下被 CSS 解析为 ~33M px 高 → 图表几乎空白、sub-chart 区域不可见）。本次未动任何前端业务组件，该失败在改动前即存在。修复方向（容器改 `h-full`/flex 自适应）待产品/架构裁决，不在本轮范围。

---

## 7. changed-files

- 修改：`design/07-app-plane/00-web-api.md`（§1.3 缓存头策略 + §6 部署 dist 清理 prose + `spa.rs`/`Dockerfile.app` tangle 块）
- 修改：`crates/web/src/spa.rs`（tangle 生成：`file_response` 加 `Cache-Control` + `cache_control_for`/`is_hashed_asset` + 4 单测）
- 修改：`Dockerfile.app`（tangle 生成：frontend 构建前 `rm -rf dist`）
- 修改：`web/e2e/smoke.e2e.ts`（新增「SPA 缓存头策略」2 用例）
- 新增（本报告）：`coder/report/017_spa_cache_fix.md`

> 已 `git add`（staged，未 commit）。未改动前端业务组件。`Dockerfile.app`/`crates/web/src/spa.rs` 由 design 文档 tangle 单向生成，未手改生成物。

### 6.1 gitnexus 影响面（index 重建后）
- 风险级别：**medium**（非 HIGH/CRITICAL，无需升级）。
- 受影响执行流：`Spa_fallback → Is_hashed_asset`、`Spa_fallback → Mime_of`、`Spa_fallback → Sanitize`——均为 SPA 静态托管路径，无业务流波及。
- 文本复核：`spa_fallback` 唯一外呼点为 `web/src/lib.rs:37`（axum `.fallback()`）；`cache_control_for`/`is_hashed_asset`/`file_response`/`serve_path` 均为模块私有。
