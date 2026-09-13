# ADR-021 — 指标镜像产物的单一源约定（dcap 首例）

- 状态：**已裁决（2026-09-13，用户批复「按推荐」，方案 A1）**
- 范围：`design/14-dcap-indicator/**`、`web/src/features/indicators/**`、`crates/strategy-core/reference-plugins/dcap.js`（`entangled.toml` **不改内容** —— JS 为内置语言，见 D3）
- 关联：ADR-007（文学式单一源）、ADR-018（门禁硬化 / O1 纪律）、`design/12-strategy-system/02-plugin-abi.md`（插件 ABI，本 ADR **不改 ABI**）

---

## 1. 问题（为什么需要这条 ADR）

同一个指标 `dcap` 有**两个消费端**，且二者必须给出**同一个数**：

| 消费端 | 需求 | 数据窗口 |
|---|---|---|
| 前端 K 线副图 | **随看随有**（像 MA/MACD 一样，不需要先跑一次回测） | 当前视口加载的那段 K 线（`viewport_bars`，随缩放/翻页变化） |
| 策略插件（`on_bar`） | 逐 bar **确定性**推进，参与聚合评分与信号 | Rust 侧 `BarCtx` 持 `bars`，但 **JS `ctx` 只暴露 `index/params/bar/indicators/position/log`** ⇒ 插件只能自建滚动窗口（`02-spec.md` §5） |

⇒ **天然双实现**。若两份实现各写各的，漂移不可发现（图上那条线与策略里那条线不是同一条线），而这正是本项目在 ADR-007/ADR-018 反复治理的失败模式。

### 1.1 为什么不选另外三条路

| 方案 | 否决理由 |
|---|---|
| 只写一份，另一份 `import` 复用 | **rquickjs 以脚本方式求值插件**，不支持 ESM `import/export`；插件文件里不得出现 `export`。反向也不行：前端无法 import 一个无导出、且内嵌 `PARAMS_SCHEMA/on_bar` 的插件脚本 |
| 宿主 Rust 算 + 只读端点喂图（原 A3） | 图表仍要多一次"跑 run 或拉端点"的动作（回归 A4 的体验缺陷）；且插件侧仍是第二份 JS 实现，漂移风险不变，只是换了另一侧 |
| 前端另写一套，靠人工对齐 | 口径漂移**不可门禁化**，退回 ADR-007 之前的失同步状态 |

### 1.2 为什么不选"插件返回原始值让引擎理解"（本轮已否决）

用户裁决：**引擎不需要知道 dcap**。dcap 是插件内部实现细节，插件出口只有 0–100 分，走平台既有聚合/60-40 阈值。故本 ADR **不动 ABI、不动引擎**（原「甲方案：NORMALIZE 声明 + per_bar 留 raw」已明确不做，需要留痕时用 `ctx.log` 兜底）。

---

## 2. 决策

**D1（单一源）**：dcap 的**算法正文**只存在一处 —— `design/14-dcap-indicator/02-spec.md` 中的 entangled 代码块（ADR-007：`design/` 是事实源）。

**D2（两份镜像产物）**：由 entangled 单向生成两个文件：

| 产物 | 路径 | 消费者 |
|---|---|---|
| 前端模块 | `web/src/features/indicators/dcap.ts` | klinecharts `registerIndicator` 的 `calc` |
| 插件 | `crates/strategy-core/reference-plugins/dcap.js` | `strategy-runtime` 的 rquickjs 脚本求值 + `reference.rs` 的 `include_str!` 播种 |

**D3（不改 `entangled.toml`）**：**JS 无需注册** —— Entangled **2.4.3 的内置语言表已含** `Language("Javascript", ["javascript", "js", "ecma"], Comment("//"))`（`…/entangled-cli/config/language.py:46`，并入默认配置 `config_data.py:39-40`；用户自定义 `[[languages]]` 只是**叠加覆盖**）。本仓 `entangled.toml` 注册的 SQL / Dockerfile / TSX / HTML 都属"内置表里没有"的语言 —— 故 `{.js file=…}` **开箱可用**，本 ADR **不引入任何 tangle 配置改动**。

**D3'（一次性机制验证，只验不改）**：确认 `{.js file=…}` 块可生成、`check-tangle` 能检出其漂移、且**不引入 ADR-018 的"假绿"**（冲突仍 exit=0 的旧失败模式）。

**D4（镜像体断言 —— 补 entangled 的能力缺口）**：entangled 的 `file=` 块**一个块只能产出一个文件，无法扇出**。因此两份产物的算法正文在文档中是**两个块**，DRY 由**机械断言**兜底，而非靠约定：

- 两份产物中，`// === DCAP CORE BEGIN ===` 与 `// === DCAP CORE END ===` 之间的内容**必须逐字节相同**；
- 该断言是**自动化单测**（tester 实现，读两个文件切片比较），不是文档纪律；
- 包装层（TS 的 `export` / 插件的 `PARAMS_SCHEMA/init/on_bar/save/load`）允许不同，且必须落在哨兵区间**之外**。

**D5（跨运行时行为等价）**：同一组**黄金样本**（`closes[] × params → 期望值`，含 `r=1 ≡ 遗留 DCAP` 与手算样例）分别驱动两个产物（TS 模块经 vitest/node、插件经 rquickjs），断言输出**逐位一致**。

**D6（纳入既有门禁）**：两个新产物进入 `check-tangle` 的漂移判据（沙箱内 `entangled tangle -f` 重新生成 → 与仓库逐字节比对，ADR-018 D-F3-1）。**禁止 `--force` 让门禁变绿**（ADR-018 D-F3-6）。

---

## 3. 后果

**正面**
- 前端线与策略线在数学上同一定义，且漂移可被 CI/门禁发现（D4/D5 双保险）。
- 沿用 ADR-007 既有工作流：改口径 = 改文档 → tangle；改实现 = `./scripts/stitch.sh` 回写。无新纪律负担。

**代价与风险（必须知情）**
1. **首次引入 `{.js file=…}` 产物**：JS 虽是内置语言（D3），但本仓此前**没有任何 js 生成物** ⇒ 必须先做一次机制验证（D3'）；验证不通过则退回宿主侧实现（另起 ADR），不硬推。
2. **文档体积与心智负担**：插件全文与前端模块全文进入 `02-spec.md`（与 `design/06-web/*.md` 承载 `*Grid.tsx` 骨架的先例一致，但体量更大）。缓解：块内只放实现，设计叙述留在块外。
3. **两份块必须同步修改**：改一处忘了另一处时，D4 断言会红（这是**设计意图**，不是缺陷）。
4. `crates/strategy-core/reference-plugins/dcap.js` 一旦播种即成为 sha256 内容寻址的**冻结历史**：后续修改 = 新版本 = 新哈希，旧版本不复现（与现有 11 个播种插件同规）。
5. **CORE 哨兵注释属明文约定**：若有人把哨兵删掉，D4 断言会失败（fail-closed，不用静默放过）。
