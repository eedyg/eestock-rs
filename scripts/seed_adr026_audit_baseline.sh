#!/usr/bin/env bash
# seed_adr026_audit_baseline.sh — 保证 ADR-026 审计冻结基线的**数据主体**存在（幂等；只走公开 HTTP API）。
#
# ## 为什么需要这个脚本（背景，逐字取证）
#
# `web/e2e/adr026-audit.e2e.ts` 的冻结基线（`BASE`：成交合计 43 / 回合 1 / 名义投入 41.40% /
# 计划批数 100 / 可达轮次 43 / 买入成交 42 / 未执行挂单 1 / 3 条 warning）原本锚定**具体 run**
# `sr_1789738328788_000005`。该 run 已被**行删除**（实测 `GET /api/workbench/runs/{id}` → 404，
# 且不在 `/runs?limit=500` 列表内）⇒ 规格 7/7 红。架构侧裁决（ADR-028 §2.10.1 裁决 3）把「取哪个 run」
# 改为**谓词解析**（`adr028RunResolve.ts` 的 `audit` 谓词），但谓词解析**不创造数据**：
# 实测（2026-09-28）108 个 `D1/succeeded` 候选中满足谓词者 **0 个**（最接近的
# `sr_1790349900464_000020` 的 rt1 `l2_count=51 ≠ 43`；其余多为 2/7/37/51/59/101）。
#
# 本脚本把该 run **按其归档 config 快照重造**（不是造数，是**重放**）：
#   config 逐字来源 = `coder/evidence/20260918_sr_trades_strategy_side/raw/11_run_row.txt`
#   （被删 run 的完整 `config` jsonb；去掉 bookkeeping 字段 `sha256/version/archived/clamped/
#   clamp_reason/requested_*/estimated_bars/progress_prescan/warmup_*` 后即本脚本的 POST body）。
#   `from`/`to` 用归档里的**实际** `from_ts`/`to_ts`（`2026-01-04T16:00:00Z` / `2026-09-16T16:00:01Z`），
#   **不是**归档 config 里的 `requested_from/requested_to`（`2026-01-01` / `2026-09-18`）——
#   后两者会被服务端 `clamped=true / clamp_reason=data_range` 重夹，且区间随数据增长而漂移。
#   区间右端取死值 ⇒ 新增行情**不会**改变结果（这是「重放」可复现的前提）。
#
# ## 幂等语义（本脚本**必须先扫描谓词，命中即不再提交**）
#
#   ① 谓词（与 `web/e2e/adr028RunResolve.ts::inspectAudit` **逐条对齐**）：
#      `symbol=518880 ∧ period=D1 ∧ status=succeeded ∧ 回合数==1 ∧ rt1.rt_seq==1 ∧
#       rt1.l2_count==43 ∧ rt1 fills==43（42 Buy + 1 Sell）`
#   ② 命中 ⇒ 打印该 run id 与其 `/audit` 读数后**退出 0（不提交）**；
#   ③ 未命中 ⇒ POST `POST /api/workbench/runs`（**字段名以 `crates/web/src/workbench.rs::
#      WorkbenchSubmitReq` 为准**：`symbol/period/from/to/slots[{version_id,params,weight}]/
#      buy_threshold/sell_threshold/policy/stop/initial_capital/fee`），轮询到 `succeeded`，
#      再按 ① + ③ 核对 `/audit` 冻结读数；任一项不符 ⇒ 退出 1（**显式红，不静默**）。
#
# ## 用法
#   ./scripts/seed_adr026_audit_baseline.sh                # 幂等：命中即复用，未命中才提交
#   ./scripts/seed_adr026_audit_baseline.sh --check-only    # 只扫描，绝不提交（CI/复验用）
#   E2E_BASE_URL=http://localhost:8081 ./scripts/seed_adr026_audit_baseline.sh
#
# 输出末行 = run id（机器可读，供规格/复验脚本取用）；退出码 0 = 基线存在且已核对。
set -euo pipefail

BASE_URL="${E2E_BASE_URL:-http://127.0.0.1:8081}"
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（支持 --check-only / --help）" >&2; exit 2 ;;
  esac
done

python3 - "$BASE_URL" "$CHECK_ONLY" <<'PY'
"""ADR-026 审计基线的**数据主体**保证（幂等；纯 HTTP，不改库、不造数）。"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1].rstrip('/')
CHECK_ONLY = sys.argv[2] == '1'

# ── 谓词常量（与 `web/e2e/adr028RunResolve.ts` 的 AUDIT_* 逐字同值：**改这里必须同步改那边**）──
SYMBOL = '518880'
PERIOD = 'D1'
AUDIT_L2_COUNT = 43
AUDIT_FILL_TOTAL = 43
AUDIT_BUY_FILLS = 42
AUDIT_SELL_FILLS = 1

# ── 冻结基线读数（逐字取自 `coder/evidence/20260919_adr026_redeploy/raw/12_audit_resp.json`）──
FROZEN_NUMERIC = {
    'capital_basis': 100000.0,
    'deployed_notional': 41397.97208076086,
    'deployed_pct': 0.4139797208076086,
    'cash_consumed': 41607.97208076086,
    'cash_consumed_pct': 0.41607972080760863,
    'planned_tranches': 100,
    'reachable_batches': 43,
    'batches_done': 42,
    'unexecuted_orders': 1,
    'last_bar_unfilled': True,
    'round_trips_total': 1,
    'round_trips_force_closed': 1,
}
FROZEN_WARNINGS = [
    ('DCA_PLAN_UNDERFILLED', 'warn', '计划 100 批，区间内最多可推进 43 批、已成交 42 批（剩余批次随买入区结束取消）'),
    ('PARTIAL_DEPLOYMENT', 'warn', '名义投入 41.40% 初始资金，年化/回撤/夏普分母仍为初始资金'),
    ('ORDERS_UNEXECUTED', 'info', '1 笔挂单未成交（末根 bar 无次 bar 可执行）'),
]

# ── 重放 body（config 快照去掉 bookkeeping 字段；来源见脚本头部注释）──
SUBMIT_BODY = {
    'name': 'adr026-audit-baseline',
    'symbol': SYMBOL,
    'period': PERIOD,
    'from': '2026-01-04T16:00:00Z',
    'to': '2026-09-16T16:00:01Z',
    'slots': [
        {
            'version_id': 'sv_1789211089727_000010',
            'params': {'cadence': 20.0, 'plan_bars': 5.0},
            'weight': 1.0,
        }
    ],
    'buy_threshold': 60.0,
    'sell_threshold': 40.0,
    'policy': {'Dca': {'mode': 'Equal', 'amount': None, 'interval': 1, 'tranches': 100}},
    'stop': None,
    'initial_capital': 100000.0,
    'fee': {'min_fee': 5.0, 'rate_pct': 0.025, 'slippage_bp': 2.0, 'stamp_duty_pct': 0.0},
}


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def post(path, body):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode('utf-8'),
        headers={'content-type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.status, json.load(r)


def rt1_fill_mix(run_id):
    """回合 1 的 {l2_count, fills, buy, sell}（取数失败 → 谓词视为未命中，不炸整体扫描）。"""
    try:
        rts = (get(f'/api/workbench/runs/{run_id}/round-trips?limit=500').get('round_trips') or [])
        if len(rts) != 1:
            return None, f'回合数 {len(rts)} ≠ 1'
        rt = rts[0]
        if rt.get('rt_seq') != 1:
            return None, f'唯一回合 rt_seq={rt.get("rt_seq")} ≠ 1'
        if rt.get('l2_count') != AUDIT_L2_COUNT:
            return None, f'rt1 l2_count={rt.get("l2_count")} ≠ {AUDIT_L2_COUNT}'
        fills = (get(f'/api/workbench/runs/{run_id}/round-trips/1/fills?limit=200').get('fills') or [])
        buy = sum(1 for f in fills if f.get('side') == 'Buy')
        sell = sum(1 for f in fills if f.get('side') == 'Sell')
        if len(fills) != AUDIT_FILL_TOTAL:
            return None, f'rt1 fills={len(fills)} ≠ {AUDIT_FILL_TOTAL}'
        if buy != AUDIT_BUY_FILLS or sell != AUDIT_SELL_FILLS:
            return None, f'rt1 Buy={buy}/Sell={sell} ≠ {AUDIT_BUY_FILLS}/{AUDIT_SELL_FILLS}'
        return {'l2_count': rt.get('l2_count'), 'fills': len(fills), 'buy': buy, 'sell': sell}, None
    except Exception as e:  # noqa: BLE001 — 单候选取数失败只记拒绝原因（与谓词解析同口径）
        return None, f'取数失败：{e}'


def audit_report(run_id):
    rep = get(f'/api/workbench/runs/{run_id}/audit')
    bad = []
    for k, want in FROZEN_NUMERIC.items():
        got = rep.get(k)
        if got != want:
            bad.append(f'{k}: {got!r} ≠ 归档 {want!r}')
    got_warn = [(w.get('code'), w.get('severity'), w.get('message')) for w in (rep.get('warnings') or [])]
    if got_warn != FROZEN_WARNINGS:
        bad.append(f'warnings ≠ 归档：{json.dumps(got_warn, ensure_ascii=False)}')
    return rep, bad


def report_table(run_id, rep, mix):
    print(f'run_id（基线数据主体）= {run_id}')
    for k, want in FROZEN_NUMERIC.items():
        got = rep.get(k)
        print(f'  {"OK " if got == want else "DIFF"} {k}: {got!r}（归档 {want!r}）')
    for code, sev, msg in FROZEN_WARNINGS:
        hit = next((w for w in (rep.get('warnings') or []) if w.get('code') == code), None)
        ok = hit is not None and hit.get('severity') == sev and hit.get('message') == msg
        print(f'  {"OK " if ok else "DIFF"} warning {code}/{sev}: {json.dumps(hit.get("message") if hit else None, ensure_ascii=False)}')
    print(f'  rt1 l2_count={mix["l2_count"]} fills={mix["fills"]}（Buy {mix["buy"]} / Sell {mix["sell"]}）')


print(f'[seed] 后端 {BASE}；谓词：{SYMBOL} ∧ {PERIOD} ∧ succeeded ∧ 回合数==1 ∧ rt1 l2_count=={AUDIT_L2_COUNT} ∧ '
      f'rt1 fills=={AUDIT_FILL_TOTAL}（{AUDIT_BUY_FILLS} Buy + {AUDIT_SELL_FILLS} Sell）')

# ① 扫描（新→旧；与谓词解析「最新命中者优先」同序）——命中即复用，**不重复提交**。
runs = [r for r in get('/api/workbench/runs?status=succeeded&limit=500')
        if r.get('period') == PERIOD and r.get('symbol') == SYMBOL]
runs.sort(key=lambda r: (r.get('created_at') or ''), reverse=True)
scanned = 0
rejects = []
for run in runs:
    scanned += 1
    mix, why = rt1_fill_mix(run['id'])
    if mix is None:
        rejects.append(f'{run["id"]}: {why}')
        continue
    rep, bad = audit_report(run['id'])
    if bad:
        # 结构命中但冻结读数不符：**不静默采信**（规格基线断言会红），继续扫描并记录。
        rejects.append(f'{run["id"]}: 结构命中但 /audit 与归档不符 → {"; ".join(bad)}')
        continue
    print(f'[seed] 谓词命中（扫描 {scanned} 个 {PERIOD}/succeeded/{SYMBOL} 候选）：复用既有 run，**未提交新 run**')
    report_table(run['id'], rep, mix)
    print(run['id'])
    sys.exit(0)

print(f'[seed] 未命中（已扫描 {len(rejects)} 个候选）。最接近的拒绝原因（末 5 条）：')
for line in rejects[-5:]:
    print(f'  - {line}')
if CHECK_ONLY:
    print('[seed] --check-only ⇒ 不提交；退出 1（基线数据主体缺失）')
    sys.exit(1)

# ② 未命中 ⇒ 重放归档 config 提交（区间右端为死值 ⇒ 不受新增行情影响）
print('[seed] 提交重放 run …')
status, created = post('/api/workbench/runs', SUBMIT_BODY)
run_id = created['id']
print(f'[seed] HTTP {status}；run_id={run_id}；轮询至终态 …')

deadline = time.time() + 600
while True:
    cur = get(f'/api/workbench/runs/{run_id}')
    st = cur.get('status')
    if st in ('succeeded', 'failed', 'canceled'):
        break
    if time.time() > deadline:
        print(f'[seed] 超时（仍 {st}）⇒ 退出 1', file=sys.stderr)
        sys.exit(1)
    time.sleep(2)
if st != 'succeeded':
    print(f'[seed] run {run_id} 终态 = {st}（error={cur.get("error")!r}）⇒ 退出 1', file=sys.stderr)
    sys.exit(1)

# ③ 复核：结构谓词 + 冻结读数（任一不符 ⇒ 显式红）
mix, why = rt1_fill_mix(run_id)
if mix is None:
    print(f'[seed] 新 run {run_id} 不满足谓词：{why} ⇒ 退出 1', file=sys.stderr)
    sys.exit(1)
rep, bad = audit_report(run_id)
report_table(run_id, rep, mix)
if bad:
    print('[seed] /audit 与归档读数不符 ⇒ 退出 1（**不要**改常量，见 `coder/report/...`）', file=sys.stderr)
    for line in bad:
        print(f'  DIFF {line}', file=sys.stderr)
    sys.exit(1)
print('[seed] 基线数据主体已就绪且与归档逐字段一致')
print(run_id)
PY
