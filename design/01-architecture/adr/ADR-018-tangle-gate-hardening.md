# ADR-018：tangle 门禁硬化（F3 立项）

- 状态：**已定**（用户 2026-09-12 拍板 D-F3-3 = **O1**：保持全文件治理 + 强制 stitch 流程）；其余决议按本 ADR 执行
- 触发：MCP 批独立验收发现 F3 —— `./scripts/check-tangle.sh` 在存在冲突时**输出 ✅ 假绿**
- 关联：ADR-007（文学式编程单向工作流）；本 ADR 修正其「门禁」条款

## 1. 事实（架构师实测复现）

1. `entangled tangle` 遇冲突时打印 `ERROR conflicts found, breaking off (use --force to run anyway)`，
   但**退出码为 0 且不写任何源文件**。
2. `check-tangle.sh` 的判据是 `entangled tangle` 之后的 `git diff --quiet`：
   由于 tangle 什么都没写，工作区自然无 diff → 脚本打印 **✅「design 与生成物一致」**，**假绿**。
3. 真实漂移点：`web/src/layouts/{DashboardGrid,SimLiveGrid}.tsx` 与
   `design/06-web/{01-dashboard,10-simlive}.md` 不一致。溯源：偏离来自已提交提交 `4d55f17`
   （fix(web): /sim-live 样式对齐静态样机）——**手改了生成物、未回写文档**，违反 ADR-007
   「src 为生成物，改码必改文档」。文档侧最后更新于 `40eeb2c`。
4. **冲突会连锁放大**：entangled 遇冲突即 break off，**其后所有待再生文件本应发生的同步全部被跳过**，
   漂移静默累积。因此假绿不是"少报一个错"，而是**掩盖整条生成链的失同步**。
5. **门禁依赖未版本化状态**：`.entangled/`（filedb）在 `.gitignore` 中。
   在无该状态的干净副本里，entangled 行为与真实仓库不同（实测出现 `create`/`not managed`
   等另一类输出）→ **门禁在 CI/新克隆场景不可复现**，属独立缺陷。
6. 工具能力（实测 `entangled --help`）：`tangle -s/--show`（dry-run）、
   `stitch`（代码改动回写文档）、`sync`（智能选择）、`status`（总览）——
   **"改码后回写文档"的官方路径早已存在（stitch），本仓库未使用**。
7. **全局 `stitch` 是破坏性的（隔离副本实测，HAZARD）**：`entangled stitch`（无范围限定）
   会把 `design/07-app-plane/{00-web-api,01-mcp}.md` 的代码块改写成自引用 `<<crates/mcp/src/tools.rs>>`
   （-3579 行），随后 `entangled tangle` 直接死于 `ERROR Cyclic reference`；
   另会被无关冲突整体阻断（ADR 文件在末次 tangle 后被编辑 → "changed outside the control of Entangled" → break off）。
   → **全局 stitch 禁止在真实仓库执行**；stitch 必须沙箱 scoped（见 D-F3-4 / F3-d）。
8. **限定范围的沙箱 stitch 可用（实测）**：仅加载 `design/06-web/{01-dashboard,10-simlive}.md` 的沙箱 stitch
   成功把实现回写进文档块（文档内出现 `tabCls`/`1w,1mo`/`enabled`/`favorite`/`grid-rows` 等真实实现内容），
   两份 TSX **逐字节不变**、其它文档零改动、沙箱 round-trip 校验通过。
9. **文档卫生遗留（F3-f，另项）**：`design/07-app-plane/{00-web-api,01-mcp}.md` 的代码块内嵌
   `~/~ begin` 遗留标记——这是全局 stitch 破坏的成因之一，属文档卫生问题（非漂移）。

## 2. 决议

| # | 决议 | 内容 |
|---|---|---|
| D-F3-1 | **门禁必须 fail-loud（v1.1 实测修正）** | 检判据：① ② 用 `entangled tangle -s`（dry-run，永不写仓）取 `conflicts found`/`ERROR`/`not managed by Entangled`；**漂移判定以④为权威**：**沙箱重新生成 + 逐字节比对**（把 watch_list 输入拷入临时目录，在沙箱内 `tangle -f`，与真实仓逐字节比）。失败即 exit 非 0 并打印两条出路（改文档→tangle / 改码→stitch）。<br>**原字面条件③（仓内 tangle + git diff）被否决**：实测两个不可接受缺陷——(a) 对"仅文档尾部加一行"的合法编辑误报为"生成物与文档不一致"（诊断错误）；(b) 门禁自身在仓内 tangle 会**静默回退真实工作区的生成物**。新增硬约束：**门禁严禁修改真实工作区**。 |
| D-F3-1a | **原例场景必须被抓住（本次 F3 的成败判据）** | 原发事故形态 = **有 DB + 仅手改生成物**（文档侧未变）。此时 `entangled tangle` 判 "Nothing to be done"（DB 记的是上次写入内容 digest，**不检查磁盘生成物**）→ 条件①失效。实测：④（沙箱比对）在当前仓精确报出 web/src/layouts/{DashboardGrid,SimLiveGrid}.tsx 两处漂移、其余 139 个生成物一致；在无 .entangled 干净副本结果相同 → 天然满足 D-F3-2。 |
| D-F3-2 | **门禁必须可复现** | 门禁在**无 `.entangled` 状态**的干净副本上同样必须正确（CI 场景）；三种状态（干净 / 冲突 / 空 DB）行为必须由自测固定。 |
| D-F3-3 | **治理边界 = O1（用户 2026-09-12 拍板）** | 8 份前端骨架**保持全文件 tangle 治理**；UI 改动后必须用 `stitch`（或 `sync`）回写文档再提交。不改变治理边界（不做 O2/O3）。为此 F3-d 的便捷入口从「可选」升为「应做」：提供可发现/可脚本化的 stitch 入口（如 `make stitch` 或文档化命令 + 钩子提示），否则纪律会因摩擦而再次失效。 |
| D-F3-4 | **漂移修复路径** | 优先用官方 `stitch` 回写文档，**但仅限沙箱 scoped**（全局 stitch 已证破坏性，见 §1.7）。若 TSX（非内置语言表）stitch 不可用，则人工把当前实现同步进文档块。两条路均以「tangle 无冲突 + 沙箱比对零漂移」为验收，且**实现侧改动逐字节不变**（4d55f17 的 UI 修复是已验收成果）。 |
| D-F3-5 | **门禁自测常驻** | 新增 fixture 自测：构造 干净/冲突/空DB 三种仓库状态，断言门禁的通过/失败与提示文案；纳入回归常驻。 |
| D-F3-6 | **纪律** | 手改生成物后**必须**回写文档（stitch 或手改文档块）方可提交；`--force` 属破坏性操作，禁止用于"让门禁变绿"（它会把文档内容覆盖实现，即回退成果）。 |

## 3. 待拍板：治理边界（D-F3-3）

8 份前端骨架（`web/src/layouts/*.tsx`）当前为**全文件 tangle**治理，而 UI 天然会迭代 → 漂移高发。

| 选项 | 语义 | 优点 | 代价 |
|---|---|---|---|
| ~~O1（架构师推荐）~~ | ✅ **已拍板（用户 2026-09-12）**：保持全文件治理，**强制 stitch 流程**：改码后必须 `stitch` 回写文档 | 单一事实源最严格；改动最小；工具已支持 | UI 迭代多一步 stitch（**本次决议要求脚本化/钩子化以降低摩擦**） |
| O2 | 文档只治理**骨架区**（块内=Props 契约/区域映射/三态注释），块外手写不受管 | 彻底消除前端类漂移 | 需重构 8 份文件的块边界；文档表达力下降 |
| O3 | 前端整体移出 tangle 治理；文档仅存设计说明 | 最省事 | 放弃前端骨架的事实源纪律，与 ADR-007 精神相悖 |

**决议 O1**（用户拍板）：本次漂移的根因不是"治理太严"，而是"没人用 stitch + 门禁没抓到"。
工具与纪律完备后再考虑 O2。**F3-d 便捷入口由可选升为应做**（否则摩擦会再次击穿纪律）。

## 3.1 交付纪律（O1 下的日常操作）

1. 需求变更 → 先改 `design/` 文档 → `entangled tangle`（文档→代码，正向）。
2. 代码先行（如 UI 细节实现）→ 改码后必须 `entangled stitch`（或 `sync`）回写文档 → 提交前门禁须绿。
3. **禁止**手改生成物后直接提交（本次事故即如此）；**禁止**用 `--force` 让门禁变绿（它会把文档内容覆盖实现 = 回退成果）。

## 4. 后续（派生）

- F3-a：门禁硬化 + 自测（D-F3-1/2/5）→ 实施
- F3-b：两份 TSX 漂移修复（D-F3-4）→ 实施
- F3-c：全仓扫描一次，确认是否还有其他"冲突被 break off 掩盖"的失同步文件
- F3-d（**O1 下应做**）：提供可发现/可脚本化的 **scoped stitch** 入口（`scripts/stitch.sh`）：
  无参=所有含代码块的文档 → **排除块内嵌 `~/~ begin` 遗留标记的文档**（07-app-plane 两份，已证会破坏）并告警
  → 沙箱内 scoped `stitch -f` → **换新沙箱做 round-trip 校验**（生成物须与仓库代码逐字节一致）
  → 校验通过才把文档拷回仓库。校验失败则**拒绝回写**。真实仓只被"已校验的文档回写"触碰。
- F3-f（另项）：`design/07-app-plane/{00-web-api,01-mcp}.md` 的块内嵌遗留标记清理（文档卫生）。

---

## 6. 端口绑定（S1）处置记录（2026-09-12，**已定案**）

- **事实**：`/tmp/app_dev_8081.toml` 显式设置 `listen = "0.0.0.0:8081"`、`mcp_listen = "0.0.0.0:8082"`
  → 绑定是**配置项**（ADR-018 §3 S1 的 loopback-only 目标与现行配置不一致）。
- **触发排查的证据**：早前存在 `python3 /tmp/relay.py 18082 192.168.50.100 8082` 中继进程，
  提示可能有跨机访问。**2026-09-12 复核：该 relay 进程与 `/tmp/relay.py` 均已不存在，
  且当前无非 loopback 连接到 8081/8082，访问日志亦无远程客户端证据。**
- **处置（架构师裁定）**：**不擅自收紧绑定**。理由：绑定是显式配置（很可能为支持远程浏览器访问），
  收紧会立即中断该路径；而"是否有人跨机访问"缺正向证据，属"不能证明不需要"而非"证明不需要"。
  按"不破坏既有访问"优先。
- **如需收紧**：改配置为 `listen = "127.0.0.1:8081"` + `mcp_listen = "127.0.0.1:8082"` 并重启
  （跨机访问须经 SSH 隧道等显式中继，见 §3 S2）。
- **遗留**：S1 目标保持"待确认访问方式后执行"；本 ADR 记录为已知偏差，不作为缺陷。

---

## 7. F3-f 处置记录：entangled 标记嵌套污染清理（2026-09-12）

### 7.1 事实与污染清单（修复前）

全仓 `~/~ begin|end` 逐条分类（枚举范围 `design/**`、`crates/**`、`web/**`）：

| 类别 | 位置 | 判定 |
|---|---|---|
| (a) 文档代码块内 = **污染** | `design/07-app-plane/01-mcp.md`（块 `crates/mcp/src/tools.rs` 内 2×begin L384/385 + 2×end L3905/3906）；`design/07-app-plane/00-web-api.md`（块 `crates/app/src/bin/eestock-app.rs` 内 1×begin L4656 + 1×end L4861） | 须清（本次对象） |
| (b) 生成物注解 = 期望 | `crates/**`、`web/src/layouts/*.tsx` 约 60 份生成物各恰 1 组 begin/end；**例外**：`crates/mcp/src/tools.rs` 累积 3 组（6 行）、`crates/app/src/bin/eestock-app.rs` 累积 2 组（4 行）——即污染在生成物侧的显形 | 清污染后须恰 1 组 |
| (c) 散文提及 | 本 ADR 正文 §1.9 / §4（`~/~ begin` 字样） | 保留 |
| (d) `design/**/preview/*.html` | `design/06-web/preview/*.html`(7)、`design/11-sim-live/preview/*.html`(2)，各恰 1 组 `<!-- ~/~ begin <<...>> -->` / `end`，出处为 `design/06-web/*.md`、`design/11-sim-live/01-adr.md` 中声明生成物的代码块，且在 `.entangled` filedb 中登记 | **tangle 生成物**（非污染、非设计资产），符合预期 |

另发现（**超出 F3-f 范围**，作为遗留登记）：`crates/web/src/settings.rs`、`crates/web/tests/api_settings.rs` 各含 1 行**孤立 begin**（无对应 end；`design/06-web/08-settings.md` 已无对应生成物声明块，二者亦不在 filedb 中）。二者不受 tangle 治理、也未被全局 stitch 触碰（无块可回写），属独立治理缺口，另行处理。

### 7.2 处置

- **只改文档代码块**：删除上述 (a) 6 个标记行（`01-mcp.md` 4 行、`00-web-api.md` 2 行），**未手改任何生成物**。
- 随后 `entangled tangle` 由生成器重建：`crates/mcp/src/tools.rs`（6→2 行标记，恰 1 组）、`crates/app/src/bin/eestock-app.rs`（4→2 行，恰 1 组）；其余生成物零改动。
- 终态：文档代码块内标记 **0**；生成物按 entangled 注解设置**恰 1 组 begin/end**。

### 7.3 语义零漂移证据

对两份重建生成物做**忽略标记行**（过滤 `~/~` 行）的逐字节比对：

| 生成物 | 修复前 filtered sha256 | 修复后 filtered sha256 | 结论 |
|---|---|---|---|
| `crates/mcp/src/tools.rs` | `da0396a4…daab40` | `da0396a4…daab40` | 完全一致 |
| `crates/app/src/bin/eestock-app.rs` | `dda3af61…5370f` | `dda3af61…5370f` | 完全一致 |

即本次仅清标记行、代码语义零改动；两份文档的 diff 亦仅删除 6 个标记行。

### 7.4 终态验证

1. `entangled tangle` 幂等：连跑两次第二次均 `Nothing to be done`。
2. `./scripts/check-tangle.sh` **绿**（沙箱重新生成 + 逐字节比对通过）。
3. **沙箱全局 `entangled stitch` 不再破坏（F3-f 成败判据）**：
   - 修复前（对照，隔离副本实测）：全局 stitch 把 `01-mcp.md`（4996→1474 行）、`00-web-api.md`（5749→5544 行）的块改写成自引用 `<<crates/mcp/src/tools.rs>>` / `<<crates/app/src/bin/eestock-app.rs>>`，随后 tangle 死于 `ERROR Cyclic reference`。
   - 修复后（隔离副本）：**①** DB 同步态直接全局 stitch → `Nothing to be done`，文档零改动；**②** 直接全局 stitch（DB 陈旧）→ 仅报 `changed outside the control of Entangled` 冲突并 break off，文档**未**被改写为自引用（`^<<` 计数 0）、行数不变，随后 tangle 正常再生；**③** 强制写回路径（块内注入代码侧探针 → stitch）→ 探针**正确回写进文档块**（非自引用），两份生成物内容不变，随后 tangle 无 `Cyclic reference`、二次 tangle `Nothing to be done`。
   - 结论：自引用 + 循环引用这一破坏模式**已消除**。残留为**通用**性质（与 F3-f 无关）：全局 stitch 会被"文档末次 tangle 后又被编辑"的无关冲突整体 break off。

### 7.5 已验证的 stitch 可用范围（本次取证）

- `design/07-app-plane/{00-web-api,01-mcp}.md` **已不再被 scoped stitch 跳过**：`scripts/stitch.sh` 的"块内嵌 `~/~ begin`"守卫对二者不再命中（守卫本身保留，防复发）。
- 全局 `entangled stitch` 的**破坏性自引用模式**已消除，但**全局执行仍不推荐**：blast radius 大（遍历全部生成物），且会被无关冲突整体 break off。治理路径仍为 D-F3-4：**沙箱 scoped `scripts/stitch.sh` + round-trip 校验**。

### 7.6 遗留

- 孤立 begin 标记（`settings.rs` / `api_settings.rs`，见 §7.1）未在本次范围内处理。
- 建议（未实施，待架构裁定）：在门禁加一条"文档代码块内不得含 `~/~` 标记"的守卫，防 F3-f 复发。

### 6.1 用户确认（2026-09-12）

**用户明确：本平台从局域网访问。** ⇒ `listen = "0.0.0.0:8081"` / `mcp_listen = "0.0.0.0:8082"`
是**有意且必需**的配置，**不是缺陷**。ADR-018 §3 中 S1（loopback-only）目标**对当前部署不适用**，
予以撤销，不再作为待办；§3 S2（跨机访问经显式中继）同样不适用（局域网直连即为设计形态）。

### 6.2 由此确定的安全边界（局域网形态）

| 项 | 现状（架构师实测） | 影响与处置 |
|---|---|---|
| 认证 | **无**（ADR-010 内网免认证前提） | 局域网内有网络可达者均可调用 MCP/REST |
| 工具开关 | **单一开关** `strategy_tools_enabled`（`McpState` 本地开关，**默认开**），同时门控 `strategy_*`/`bt_*`/`sim_*` | 默认即全开；无需时可在设置页关闭 |
| 交易类工具 | `sim_*` 为**模拟实盘（不触真实券商）** | 无真实资金风险；风险=模拟状态/研究数据（runs、sessions）被局域网内他方改动 |
| 真实券商通道 | 未接入（`03-live-readiness.md` 仅架构预留，接真实券商须书面批准） | 当前不存在真金暴露 |

**结论**：当前形态（局域网免认证 + 模拟交易）风险可接受，**前提是**：①不将 8081/8082 暴露到公网；
②不需要时关闭工具开关；③将来接入真实券商前必须先落地 M-2（Token 鉴权 + TLS）。

**可选加固（如需，各自另立 ADR/任务，本次不做）**：按源 IP 的白名单/防火墙限制；M-2 Token 鉴权；
交易类工具与查询类工具拆分为两个独立开关（现为单开关，粒度不足以"只读共享、交易自留"）。
