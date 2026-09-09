# 030 — 内嵌图表深测 3 缺陷修复（R1 宫格行高坍缩 / R2 格表头 D2 不一致 / EV-1 timescaledb shm）

本报告文件位置：`coder/report/030_embedded_chart_3defects_fix.md`
（tester 深测报告：`web/tester/test/013_embedded_charts_deployed.md`）

---

## 0. 概览

| 项 | 级别 | 根因 | 改动文件 | 结果 |
|----|------|------|----------|------|
| R1 宫格行高坍缩 | 高 | grid-view 无 `grid-rows`（auto 行按内容分高）+ GridCell chart `flex-1` 在 auto 行下解析 0 高；且 grid-view 作为 flex 子项缺 `min-h-0`（`min-height:auto` 按内容 3×322px 撑高，2×3 纵向溢出） | `DashboardGrid.tsx`、`GridCell.tsx` | ✅ 行均分（ratio=1）、无 0 高 canvas、docScrollH=720（=viewport，无溢出） |
| R2 格表头 D2 不一致 | 中高 | `GridCell` 表头直接 `symbol.changePct.toFixed(2)`，无 disabled/no-data 分支 → 停用/无数据标伪造 `+0.00%` | `GridCell.tsx` | ✅ 停用→已停用、启用无数据→无数据，不伪造 0.00% |
| EV-1 timescaledb shm | 设施 | timescaledb 未设 `shm_size` → 默认 `/dev/shm=64MB` | `docker-compose.yml` | ⚠️ `shm_size: 2g` 已加且 `/dev/shm` 现 2.0G；但并发 kline 探到残留 500（`out of shared memory`，PostgreSQL 层，非 /dev/shm）——见 §4，已 escalate |

---

## 1. R1（高）：宫格行高不均 + 2×3 末行坍缩

### 1.1 根因
- `web/src/layouts/DashboardGrid.tsx` grid-view 容器原 `grid flex-1 grid-cols-2`，**无 grid-rows** → auto 行按内容分高；`GridCell` 的 chart 容器 `min-h-0 flex-1` 在 auto 行下解析为 0 高 → 末行两格画布 0 高、行高不均（ratio≈3.47）。
- 额外发现（实测）：grid-view 作为 `main-area`（flex 列）的子项缺 `min-h-0`，其默认 `min-height:auto` 会按内容（3 行 × 322px=966px）撑高 grid-view，导致 2×3 页面纵向溢出（docScrollH=1042 > viewport=720）。仅在加了 `grid-rows` 后暴露（2×2 两行=644 恰好等于可用高，2×3 三行=966 超出）。

### 1.2 改动文件
- `web/src/layouts/DashboardGrid.tsx`
  - grid-view 容器按 `gridMode` 显式行：`grid2x2 → grid-rows-2`，`grid2x3 → grid-rows-3`（Tailwind `repeat(2/3,minmax(0,1fr))`）。
  - grid-view 容器加 `min-h-0`，保证作为 flex 子项可收缩到可用高度。
- `web/src/features/dashboard/GridCell.tsx`
  - 外层 flex 列加 `min-h-0`（`flex min-h-0 cursor-pointer flex-col ...`），确保 chart 容器 `flex-1` 拿到真实高度。

### 1.3 架构对齐
- 均在页面①前端布局层（`layouts/DashboardGrid` + `features/dashboard/GridCell`），纯样式/类名，无数据流与接口改动；不改 tangle 骨架语义（注释补充说明）。

### 1.4 RED→Green 证据
- **单元（R1 结构断言）**：`GridCell.test.tsx`「外层 data-grid-cell 具备 min-h-0」修复前 RED（classList 无 `min-h-0`）→ 修复后 GREEN。`DashboardPage.test.tsx`「grid-view 含 grid-rows-2 / grid-rows-3」GREEN。
- **e2e（R1 强断言）**：`embedded-charts.e2e.ts` `R1 宫格行高均分`。修复前（旧 dist）RED（ratio22≈3.47、`docOverflow=true`）；修复后 GREEN。实测证据 `/tmp/embedded_evidence/r1_grid_row_geometry.json`：
  - 2×2：`rows22=[322,322]` `ratio22=1`，`zero22=[]`（无 0 高 canvas）。
  - 2×3：`rows23=[215,215,215]` `ratio23=1`，`bottomZero=[]`（末行不再坍缩），`docOverflow=false`，`grid23.h=644`，`scroll.H=720 == winH=720`（无纵向溢出）。
  - 每格主画布 `477x270`（非 0 高）。

---

## 2. R2（中高）：格表头 D2 一致性

### 2.1 根因
- `web/src/features/dashboard/GridCell.tsx` 表头直接 `symbol.changePct.toFixed(2)`（正值加 `+`），未判断 `symbol.enabled` 与 `symbol.last`；停用/无数据标按 `dtoToSnapshot` 映射后 `changePct=0` → 表头伪造 `+0.00%`，与 `SymbolList`「已停用/无数据」口径不一致。

### 2.2 改动文件
- `web/src/features/dashboard/GridCell.tsx`
  - 新增 `inactive = !symbol.enabled`、`hasData = symbol.enabled && symbol.last !== null`。
  - 表头：`hasData` → 显示 `changePct`（>0 加 `+`，保 `text-up`/`text-down` 变色）；否则 → `已停用`（`!enabled`）/`无数据`（`enabled && last===null`），`text-dim`，`ml-auto num`。

### 2.3 架构对齐
- 与 `SymbolList.tsx` 完全同口径（复用同一判定 `enabled`+`last===null`）；仅改展示层渲染逻辑，不改 `SymbolSnapshot` 契约 / `dtoToSnapshot` 映射 / 后端。

### 2.4 RED→Green 证据
- **单元**：`GridCell.test.tsx` 新增 4 用例（正/负/停用/无数据）。修复前 RED（`enabled=false` 与 `last=null` 两用例渲染 `+0.00%`，查不到「已停用/无数据」）；修复后 GREEN（6/6 通过）。
- **e2e**：`embedded-charts.e2e.ts` `T6`（no-data 格）加表头断言 + `R2 格表头 D2 一致性`。修复前 RED（旧 dist 格表头 `+0.00%`，`gridShowsOff=false`）；修复后 GREEN。证据 `/tmp/embedded_evidence/t6defect_grid_header_d2.json`：`gridShowsOff=true`、`gridShowsNoData=true`。

---

## 3. EV-1（设施）：timescaledb `/dev/shm` 不足

### 3.1 改动文件
- `docker-compose.yml` timescaledb 服务加 `shm_size: "2g"`（compose v1 语法；伴随注释说明）。

### 3.2 验证（已重建 timescaledb）
- `docker-compose config` 解析通过，`shm_size: 2g` 生效。
- 注入 `shm_size` 后 timescaledb config-hash 变化触发 compose v1 已知坑 `KeyError: ContainerConfig`；按「删孤儿容器再 up」：`docker-compose stop && rm -f && up -d` 全栈重建。
- `docker exec eestock-timescaledb sh -c 'df -h /dev/shm'` → **2.0G**（原 64M）。
- 全栈稳定：`eestock-app/data/timescaledb` 均 `Up (healthy)`；`/healthz` → `{"status":"ok"}`。

### 3.3 残留风险（重要，已 escalate 至父）
- **并发 kline 仍间歇 500，但根因非 /dev/shm**：
  - 复现：`GET /api/kline?code=<n>&period=1m&limit=120` 并发 6/12/24/30 → 6: 2×200+4×500；12: 2×200+10×500；24: 4×200+20×500；30: 全 500。
  - 并发期间 `df -h /dev/shm` 峰值仅 4.8M-5.2M（未满）→ /dev/shm 不是瓶颈。
  - app 日志错误：`error returned from database: out of shared memory`（并非任务假设的 `No space left on device`）。
  - 容器内 pg 配置：`shared_buffers=128MB`、`dynamic_shared_memory_type=posix`、`max_parallel_workers=8`、`max_parallel_workers_per_gather=2`、`max_connections=100`、`work_mem=4MB` → 高并发下 PostgreSQL 自身共享内存/并行 worker 预算耗尽。
  - 彻底消除需调 PostgreSQL 层参数（加大 `shared_buffers`、降 `max_parallel_workers_per_gather`、或 `dynamic_shared_memory_type=mmap`），属「DB 配置」，超出本任务允许改动面（iron rule 仅 docker-compose `shm_size`）。已 `contact_supervisor(reason:"progress_update")` 告知并请裁决。

---

## 4. 测试覆盖

| 文件 | 类型 | 覆盖 |
|------|------|------|
| `web/src/features/dashboard/GridCell.test.tsx` | 单元（新增） | R1：外层 `data-grid-cell` 含 `min-h-0`；R2：正/负/停用/无数据表头文本与「不伪造 0.00%」 |
| `web/src/features/dashboard/DashboardPage.test.tsx` | 单元（增改） | R1：2×2→`grid-rows-2`、2×3→`grid-rows-3` |
| `web/e2e/embedded-charts.e2e.ts` | e2e（改） | R1 强断言（ratio<1.3/无 0 高 canvas/无纵向溢出）；R2 强断言（已停用/无数据，不伪造 0.00%）；T6 增表头断言 |

## 5. 验证结果

| 命令 | 结果 |
|------|------|
| `npm run build`（`tsc -b && vite build`） | ✅ 通过（index-*.js 513KB / css 16KB） |
| `npx vitest run` | ✅ 24 文件 / 185 用例全通过 |
| `npx playwright test e2e/embedded-charts.e2e.ts` | ✅ 10/10 通过（含 R1/R2 强断言，2.5m） |
| `npx playwright test e2e/kline-matrix.e2e.ts -g "E11\|E12"` | ✅ 2/2 通过（无回归） |
| `docker-compose config` | ✅ 解析通过，`shm_size: 2g` 生效 |
| `docker exec ... df -h /dev/shm` | ✅ 2.0G（原 64M） |
| `/healthz` | ✅ `{"status":"ok"}` |
| 并发 kline（6/12/24/30） | ⚠️ 残留 500（`out of shared memory`，非 /dev/shm） |

## 6. 暂存文件（未 commit）

- `docker-compose.yml`
- `web/src/layouts/DashboardGrid.tsx`
- `web/src/features/dashboard/GridCell.tsx`
- `web/src/features/dashboard/DashboardPage.test.tsx`
- `web/src/features/dashboard/GridCell.test.tsx`（新）
- `web/e2e/embedded-charts.e2e.ts`

`web/dist` 与 `web/e2e/artifacts` 已 gitignore，不入暂存；`.claude/`、`AGENTS.md`、`logs/`、`tester/`、既有 `coder/report/*` 为其它会话未跟踪产物，未纳入本次暂存。

## 7. 残留风险

1. **EV-1 残留**（主）：并发 1m kline 在 ≥6 并发时仍间歇 `out of shared memory` 500；`/dev/shm` 未满，根因在 PostgreSQL 层（`shared_buffers=128MB`/`dynamic_shared_memory_type=posix`/并行 worker 预算）。本任务按要求仅改 compose `shm_size`，该项残留需父裁决是否授权 DB 参数变更。
2. `winH` 受 Playwright `devices['Desktop Chrome']` viewport=720 影响（覆盖顶层 800），R1 断言以 `winH+60` 容差判定无溢出，实测 docScrollH=720=winH，达标。
