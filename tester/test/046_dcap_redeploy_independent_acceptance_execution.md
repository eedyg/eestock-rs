# 046 — dcap 重建/重启结果的独立复核（验收车道，执行报告）

- **报告自身路径**：`tester/test/046_dcap_redeploy_independent_acceptance_execution.md`
- **仓库根**：`/home/eestock/workspace/git/eestock/eestock-rs`
- **HEAD**：`024b4e0`（`024b4e01812f12a6e25c8521fe0c87c01d918bc4`）—— `chore(git): 忽略运行期 logs/…`（commit ts 2026-09-13 20:30:54 +0800）
- **复核时间**：2026-09-13 20:34–20:38 +0800（UTC 12:34–12:38）
- **报告类型**：执行既有检查（**未新增/未改动任何测试代码**）
- **性质**：独立复核。**不采信运维车道自述**，全部证据为本车道亲自执行所得。
- **结论**：**PASS**（无 blocker；2 条观察项，0 条需修复项）

---

## 0. 与任务前提的偏差（重要，先说明）

任务书写「在线形态：PID **1315848**，二进制构建于 **17:33**（早于 dcap P3 ⇒ 当前界面没有 dcap）」。
实测该描述为**重启前**的旧形态；运维车道已按任务书要求完成停机重建+重启，因此**在线形态已变**：

| 项 | 任务书前提（重启前） | 实测（重启后） |
|---|---|---|
| PID | 1315848 | **2029836** |
| 进程启动时刻 | — | 2026-09-13 20:32:25 +0800 |
| 磁盘二进制 mtime | 17:33 | **2026-09-13 20:32:16 +0800** |
| 二进制 sha256 | 1a2f1b4e…（17:33） | **8eb98376daf76381b335183714ecf94e191d256774a0b33b8e0fea00a2e367cf** |
| `/proc/<pid>/exe` | `(deleted)` | **未删除**，指向磁盘真身（inode 95109848 一致） |
| 界面 dcap | 无（`/api/config/dcap` 404） | **有**（`/api/config/dcap` 200） |

⇒ 前提中「当前界面没有 dcap」在复核时点**已不成立**；本节所有检查均针对重启后的新形态。

---

## 1) 形态：同一新 PID 同时持有 8081 与 8082

```
$ ss -lntp | grep -E ':8081|:8082'
LISTEN 0 128 0.0.0.0:8081 0.0.0.0:* users:(("eestock-app",pid=2029836,fd=11))
LISTEN 0 128 0.0.0.0:8082 0.0.0.0:* users:(("eestock-app",pid=2029836,fd=12))

$ readlink /proc/2029836/cwd
/home/eestock/workspace/git/eestock/eestock-rs            ← 仓库根 ✓

$ tr '\0' ' ' < /proc/2029836/cmdline
./target/debug/eestock-app --config /tmp/app_dev_8081.toml  ✓

$ readlink /proc/2029836/exe
/home/eestock/workspace/git/eestock/eestock-rs/target/debug/eestock-app  （非 deleted）✓

$ pgrep -a eestock-app
2029836 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml   （唯一）
```

**结论：PASS。** 同一 PID 2029836 同时持有 8081/8082；cwd 为仓库根；cmdline 含 `--config /tmp/app_dev_8081.toml`。
`/proc/2029836/fd/1`、`fd/2` → `logs/app_dev_8081_redeploy_20260913_203223.log`（仓库内，被忽略）。

---

## 2) 部署一致性：已部署二进制 == 当前 HEAD 构建

```
$ cargo build -p app
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.06s
real 0m0.091s   EXIT=0          ← 空跑（Nothing to be done）
```

⇒ 源码树相对该二进制**无待编译改动**，即二进制是当前 HEAD 源码的构建产物。

```
HEAD ctime : 1789302654  (2026-09-13 20:30:54 +0800)
bin  mtime : 1789302736  (2026-09-13 20:32:16 +0800)
bin_newer_than_HEAD = True   delta=82s     ← 二进制晚于 HEAD 提交 ⇒ 含全部 dcap P0–P4
```

```
$ sha256sum /proc/2029836/exe   → 8eb98376daf76381b335183714ecf94e191d256774a0b33b8e0fea00a2e367cf
$ sha256sum target/debug/eestock-app → 8eb98376daf76381b335183714ecf94e191d256774a0b33b8e0fea00a2e367cf
$ stat -L /proc/2029836/exe inode=95109848 ; stat target/debug/eestock-app inode=95109848   ← 同 inode
```

**结论：PASS。** 构建空跑 + 运行中 exe 与磁盘二进制同 inode/同 sha256 + 二进制晚于 HEAD 提交 82s。

---

## 3) 健康与数据

```
GET /healthz          → {"status":"ok"}   HTTP=200   time=0.000547s
GET /api/symbols      → 44 条（count=44）
GET /api/kline?code=518880&period=15m&limit=3 → HTTP=200
  bars: 2026-09-11T06:30:00Z O8.940 H8.946 L8.930 C8.938 V29781904
        2026-09-11T06:45:00Z O8.937 H8.950 L8.937 C8.942 V38672400
        2026-09-11T07:00:00Z O8.943 H8.943 L8.943 C8.943 V2912700
  next_before=2026-09-11T06:30:00Z    bars 升序 ✓
复核时点（UTC）: 2026-09-13T12:34Z（周日）
```

**新鲜度判定**：最新 bar = `2026-09-11T07:00:00Z` = 周五 15:00 CST **收盘** bar。复核日为周日（非交易日），
周五收盘 bar 即最近一根，**时间合理**（非陈旧/非空洞）。

> 观察项 A（非缺陷）：`GET /api/kline` 的周期参数是 **`period`**（契约 `design/07-app-plane/00-web-api.md:52`：
> `code` 必填 + `period=1m|5m|15m|1h|1d|1w|1mo`，**无 `interval` 参数**）。
> 传 `interval=15m`/`klt=15m`/`timeframe=15m` 会被忽略并回落默认 `1m`（HTTP 仍 200）。**属未文档化参数被忽略，不是缺陷**；
> 用契约参数 `period=15m` 即返回正确 15m bars。

**结论：PASS。**

---

## 4) dcap 契约（独立复现，含负例 + 防污染）

**4a 形状**：`GET /api/config/dcap`
```
{"n_s":8,"n_m":26,"n_l":60,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":1,"m":3}   HTTP=200
keys = [m, n_l, n_m, n_s, r_l, r_m, r_s, smooth]   count=8   has_th=False ✓
```

**4b 正例（PUT 合法 → 200 + 读回一致）**
```
PUT {"n_s":10,"n_m":30,"n_l":80,"r_s":1.2,"r_m":1.5,"r_l":1.8,"smooth":0,"m":5}
→ 200 {"n_s":10,"n_m":30,"n_l":80,"r_s":1.2,"r_m":1.5,"r_l":1.8,"smooth":0,"m":5}
GET 读回 → 逐字段一致 ✓
```

**4b 负例（全部 400，且不污染状态）**
| 用例 | 请求 | 结果 |
|---|---|---|
| 非单调 n | `{n_s:26,n_m:26,n_l:8,…}` | **400** `{"error":"须满足 n_s < n_m < n_l，收到 26/26/8"}` |
| n_s 越界 | `{n_s:1,…}` | **400** `{"error":"n_s 须为 2..=250 整数，收到 1"}` |
| m 越界 | `{m:61,…}` | **400** `{"error":"m 须为 1..=60 整数，收到 61"}` |
| smooth 越界 | `{smooth:2,…}` | **400** `{"error":"smooth 须为 0 或 1，收到 2"}` |
| 类型错误 | `{n_s:"8",…}` | **400** `{"error":"dcap 请求体非法：invalid type: string \"8\", expected i32"}`（非 500） |

拒绝后立查：值仍为上一次**合法** PUT 的 `{10,30,80,1.2,1.5,1.8,0,5}`（**拒绝不写库**）✓

**4c 用户原配置未被污染（前后比对）**
```
BEFORE : {"n_s":8,"n_m":26,"n_l":60,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":1,"m":3}
AFTER  : {"n_s":8,"n_m":26,"n_l":60,"r_s":1.0,"r_m":1.0,"r_l":1.0,"smooth":1,"m":3}
diff BEFORE AFTER → 无差异；IDENTICAL=true
```
且 BEFORE 与**运维车道报告记录的原始值**（`coder/report/159_…` §8a）逐字段一致 ⇒ 交叉印证，原值未被改动 ✓
（本车道在比对完成后已回写原值并复读确认。）

> 观察项 B（非缺陷）：`PUT` 若附带多余字段 `th`（`{…,"th":0.7}`）→ **200**，`th` 被 serde 静默忽略、**不入库**
> （读回仍 8 参无 th；`DcapConfigDto` 未设 `deny_unknown_fields`）。GET 契约「8 参不含 th」**成立**；
> 若期望「服务端显式拒绝 th」则需另开需求——本车道仅记录，不构成当前契约违例。

**结论：PASS。**

---

## 5) 前端生效（served == dist，且含 dcap 注册痕迹）

```
GET /            → HTTP=200
served index.html sha256 = db5320b49a2aff483e356b456f18c247cf6a21554496b285316ebc3166ea4814
dist   index.html sha256 = db5320b49a2aff483e356b456f18c247cf6a21554496b285316ebc3166ea4814   ✓ 一致
served bundle = index-BcRLZ7uk.js ; dist bundle = index-BcRLZ7uk.js   INDEX_BUNDLE_MATCH=YES ✓

GET /assets/index-BcRLZ7uk.js → 200 bytes=1176290
  served sha256 = 119484839a89d0be6e4ce39f9b53dd340d127e9d3b572a03112e7ca8c7d29cb0
  dist   sha256 = 119484839a89d0be6e4ce39f9b53dd340d127e9d3b572a03112e7ca8c7d29cb0   ✓ 一致
GET /assets/index-Cm6bbPuq.css → 200 bytes=22007
  served sha256 = 698283dfab325cb2e1ee90c69755fe10bb73280283020d59128f908a2b04e688
  dist   sha256 = 698283dfab325cb2e1ee90c69755fe10bb73280283020d59128f908a2b04e688   ✓ 一致
cmp served_bundle dist_bundle → CMP_IDENTICAL=YES（字节级相同）
```

**bundle 内 dcap 注册痕迹（阳性）**：
```
DCAP                 -> 13
 dcap                -> 17
 DCAP 参数           -> 1
 DCAP 配置           -> 1
 n_s                 -> 21
 r_s                 -> 21
 config/dcap         -> 2
 dcap-input-smooth   -> 1
片段：
 const gm="DCAP",M$=5,vm=2,Om=250,xm=.5,ym=2,bm=1,wm=60,Jr={n_s:8,n_m:26,n_
 {key:"n_s",label:"DCAP 短窗口 n_s"} … {key:"n_l",label:"DCAP 长窗口 n_l"}
 {key:"r_s",label:"DCAP 短窗增长比 r_s"} … {key:"m",label:"DCAP 平滑周期 m"}
 aria-label:"DCAP 配置" / aria-label:"DCAP 参数"（面板 + 工具栏入口）
 {value:"dcap",label:"DCAP"}（副图指标下拉注册）
```
**阴性对照**（同一 grep 方法，同一个文件）：`ZZQ_NOT_A_REAL_NAME`=0、`aistock_sentinel_xyz`=0、`DCAP_NOT_REGISTERED_XX`=0 ✓

**结论：PASS。**

---

## 6) 反向证据（证明比对方法有鉴别力，非空跑）

| 6a 单字节翻转 | 手段 | 结果 |
|---|---|---|
| 把 dist bundle 拷贝到 /tmp 并翻转第 100000 字节 1 bit | `cmp` served vs 变体 | **CMP=DIFFERENT**（方法能检出 1 字节差）✓ |
| 同上 | `sha256sum` | 变体 `c2a2a4be…` ≠ served `11948483…` ⇒ SHA256_DISCRIMINATES=YES ✓ |

| 6b bundle 名提取 | 结果 |
|---|---|
| 把 index.html 中 `index-BcRLZ7uk.js` 伪改为 `index-DEADBEEF.js` 后跑同一提取逻辑 | real≠fake ⇒ **MATCH=NO（能检出分歧）** ✓ |

| 6c grep 极性 | 结果 |
|---|---|
| 向 dist 拷贝追加 `ZZQ_NOT_A_REAL_NAME` 后 grep | 变体 **1 hit**（非恒 0）✓ |
| 真实 served bundle 同 token | **0 hit** ✓ |

(临时变体均在 /tmp，已 `rm` 清理；未触碰仓库文件。)

**结论：PASS** —— 上述 4 项阳性/负性证明本报告 5) 的「一致」与「命中有 dcap」不是空跑/恒真。

> 方法学自纠：首轮我曾把「下载 bundle」与「grep bundle」放在**并行**工具调用中，导致 grep 读到**半写文件**、
> `DCAP` 误报 0。随后**串行**重跑（先落盘、再 grep、再 cmp）后得到 `DCAP=13` 与 `CMP_IDENTICAL=YES`。
> 谨记：读写同一文件的验证步骤不得并行化。

---

## 7) 残留与卫生

```
$ pgrep -a eestock-app
2029836 ./target/debug/eestock-app --config /tmp/app_dev_8081.toml    ← 仅 1 个，无残留包装 shell

$ ss -lntp | grep -E ':8081|:8082'
8081 pid=2029836 ; 8082 pid=2029836                                   ← 无第二实例
（全量端口扫描中未出现 8181 或额外 eestock 端口；8080/5433 原容器端口未被本车道触碰）

$ grep -c '"level":"ERROR"' logs/app_dev_8081_redeploy_20260913_203223.log → 0
$ grep -c '"level":"WARN"'  同上 → 0
$ 级别分布：{"level":"INFO"} × 7   ← 0 ERROR / 0 WARN（含 "serving 0.0.0.0:8081" 与 mcp 8082）

$ git check-ignore -v logs/app_dev_8081_redeploy_20260913_203223.log
.gitignore:23:/logs/   logs/app_dev_8081_redeploy_20260913_203223.log    ← 命中 .gitignore:/logs/ ✓
$ git check-ignore -v logs/  → .gitignore:23:/logs/   logs/ ✓
$ git status --porcelain | grep -i logs  → 无输出（grep_exit=1）✓ 无 logs/ 条目

$ git diff --stat        → 空   （tracked 改动为空 ✓）
$ git diff --cached      → 空   （暂存区为空 ✓）
$ sim-live sessions      → 12 条，statuses={'ended':12}，non_ended=[] ✓
```

**结论：PASS。**

---

## 8) 明确不做

- 未评价 dcap 的信息量/研究结论（已另案）。
- 未修改任何源码 / 接口 / 配置 / dist / 二进制（仅本执行报告为本车道新产出的未跟踪文档）。
- 未 `git add` / `commit` / `stash`；未动 8080(data)、5433(timescaledb) 容器；未用 `./scripts/deploy.sh` 或 compose up app；未起额外常驻服务。

---

## 观察项汇总（非 blocker，供最小修正参考）

| # | 观察 | 影响 | 最小修正建议 |
|---|---|---|---|
| A | `GET /api/kline` 忽略未文档化的 `interval=`，静默回落 `1m` | 调用方若误用 `interval` 会拿到 1m 数据而 HTTP 仍 200，易误判 | 可选：契约未定义该参则维持现状；若要防误用，可在 handler 对未知查询键返回 400 或在文档显式标注「仅 `period`」 |
| B | `PUT /api/config/dcap` 接受并静默丢弃多余字段 `th` | 无状态污染（读回仍 8 参无 th），但「传 th 也 200」可能给调用方错觉 | 可选：若要求严格，`DcapConfigDto` 加 `#[serde(deny_unknown_fields)]`（注意会影响所有反序列化路径与既有测试） |

> 两条均**不构成当前接口契约违例**，是否处理由架构决策；本车道不擅自改动。

---

## 逐项结论

| 项 | 内容 | 结论 |
|---|---|---|
| 1 | 单 PID 持 8081+8082、cwd=仓库根、cmdline 正确 | **PASS** |
| 2 | `cargo build -p app` 空跑；exe==磁盘二进制（同 inode/sha256）；二进制晚于 HEAD | **PASS** |
| 3 | /healthz 200；/api/symbols=44；/api/kline?period=15m 升序、最新 bar=周五收盘（周日复核，合理） | **PASS** |
| 4 | dcap 8 参无 th；合法 PUT 200 读回一致；非单调/越界/类型错 400；原配置前后 IDENTICAL 且与运维记录一致 | **PASS** |
| 5 | served index.html/JS/CSS sha256 == dist；bundle 名一致；bundle 内 DCAP 阳性 + 阴性对照 0 | **PASS** |
| 6 | 单字节翻转/dist 名伪改/哨兵注入 均能被检出（方法有鉴别力，非空跑） | **PASS** |
| 7 | 无多余进程/端口；启动日志 0 ERROR 0 WARN；logs/ 忽略命中 `.gitignore:/logs/`；tracked 改动空；暂存区空；sim-live 12/12 ended | **PASS** |
| 8 | 未评价研究结论；未改任何源码/配置；未 git add/commit/stash；未动 8080/5433；未起额外常驻服务 | **PASS** |

**VERDICT: PASS**
