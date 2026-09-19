#!/usr/bin/env bash
# 本轮取证的全部**只读**命令（逐条可复跑）。
# 纪律：只 SELECT / 只 GET；无 UPDATE/INSERT/DELETE/DDL；无 git add/commit；不改任何代码。
# 目录约定：D = 本证据目录（raw/ 下），仓库根 = eestock-rs
set -u
export PGPASSWORD=eestock
PSQL="psql -h 127.0.0.1 -p 5433 -U eestock -d eestock"
D="coder/evidence/20260918_sr_trades_strategy_side/raw"
RUN=sr_1789738328788_000005
SV=sv_1789211089727_000010

mkdir -p "$D"

# ── 0. 表结构 ────────────────────────────────────────────────────────────────
$PSQL -c "\d strategy_version"          > "$D/00_schema_strategy_version.txt"
$PSQL -c "\d strategy_run"              > "$D/01_schema_strategy_run.txt"
$PSQL -c "\d strategy_run_result"       > "$D/02_schema_strategy_run_result.txt"

# ── 1. 版本行 / run 行 + 源码 sha256 三方比对 ────────────────────────────────
$PSQL -A -x -c "select id,strategy_id,version,status,approval_level,sha256,length(code) as code_len,created_at,published_at from strategy_version where id='$SV'" | tee "$D/10_sv_row.txt"
$PSQL -A -x -c "select id,name,symbol,period,from_ts,to_ts,status,progress,error,config from strategy_run where id='$RUN'" | tee "$D/11_run_row.txt"
$PSQL -At -c "select code from strategy_version where id='$SV'" > "$D/12_sv_code.sql.txt"
head -c -1 "$D/12_sv_code.sql.txt" > "$D/12_sv_code.exact.txt"     # 去掉 psql 追加的换行 = 精确存储字节（1248）
sha256sum "$D/12_sv_code.exact.txt"                                 # = 5d7f83df…（= 库内声明 = 作者源文件）

# 全量 sha 复核（注意：encode(base64) 默认每 76 字符换行，必须 replace 掉，否则得到假 MISMATCH）
$PSQL -At -F$'\t' -c "select id,sha256,replace(encode(convert_to(code,'UTF8'),'base64'),E'\n','') from strategy_version order by created_at" > "$D/13_all_versions_sha.tsv"
python3 - <<'PY' | tee "$D/14_sha_audit.txt"
import base64, hashlib
for line in open("coder/evidence/20260918_sr_trades_strategy_side/raw/13_all_versions_sha.tsv"):
    line = line.rstrip("\n")
    if not line: continue
    vid, sha, b64 = line.split("\t")
    code = base64.b64decode(b64); calc = hashlib.sha256(code).hexdigest()
    print(f"{vid}\tdeclared={sha}\tcalc={calc}\t{'MATCH' if calc == sha else 'MISMATCH'}\tbytes={len(code)}")
PY

# ── 2. 成交 / 分块 / per_bar / 行情 ─────────────────────────────────────────
$PSQL -At -c "select jsonb_agg(x) from (select jsonb_array_elements(payload) x from strategy_run_bars where run_id='$RUN' and kind='fills') t" > "$D/20_fills_raw.json"
$PSQL -c "select kind, seq, jsonb_array_length(payload) as n from strategy_run_bars where run_id='$RUN' order by kind, seq" | tee "$D/22_bars_by_kind.txt"
$PSQL -At -c "select payload->0, payload->(jsonb_array_length(payload)-1) from strategy_run_bars where run_id='$RUN' and kind='per_bar' order by seq limit 1" | tee "$D/23_per_bar_firstlast.txt"
$PSQL -At -c "select jsonb_agg(e->>'ts') from strategy_run_bars, jsonb_array_elements(payload) e where run_id='$RUN' and kind='per_bar'" > "$D/25_per_bar_ts.json"
$PSQL -At -c "select jsonb_pretty(payload) from strategy_run_bars where run_id='$RUN' and kind='per_bar'" > "$D/28_per_bar_pretty.json"
$PSQL -At -c "select metrics from strategy_run_result where run_id='$RUN'"           | tee "$D/30_metrics_raw.json"
$PSQL -At -c "select payload->-1 from strategy_run_bars where run_id='$RUN' and kind='net_value'" | tee "$D/31_nav_last.txt"
$PSQL -At -c "select payload->0  from strategy_run_bars where run_id='$RUN' and kind='net_value'" | tee "$D/32_nav_first.txt"
$PSQL -At -c "select jsonb_pretty(trades) from strategy_run_result where run_id='$RUN'" > "$D/33_trades_pretty.json"

curl -s "http://127.0.0.1:8081/api/kline?code=518880&period=1d&limit=1000" -o "$D/27_kline_api_518880_1d.json"

# ── 3. S4：值域穷举（用库内精确字节在 node 中实例化真实插件）────────────────
node "$D/40_value_domain_enum.js" "$D/12_sv_code.exact.txt" | tee "$D/40_value_domain_enum.txt"

# ── 4. S6-a：相位/预热证据；S2②：每窗 batch_amount 精确反算 ─────────────────
python3 "$D/41_index_phase_check.py"      | tee "$D/41_index_phase_check.txt"
python3 "$D/34_batch_amount_exact.py"     | tee "$D/34_batch_amount_exact.txt"

# ── 5. 复算（纸面模型；含对两个 run 的 1e-4 级校验）─────────────────────────
python3 "$D/42_policy_projection.py"          | tee "$D/42_policy_projection_out.txt"
python3 "$D/43_paper_engine.py"               | tee "$D/43_paper_engine_out.txt"
python3 "$D/62_same_window_comparison.py"     | tee "$D/62_same_window_comparison.txt"

# ── 6. 横向对照样本（同插件的其它 run / 同区间 A1 臂 / 作者 A1-A2）───────────
$PSQL -c "select id,symbol,period,from_ts::date,to_ts::date,status,config->'policy' as policy, config->'slots'->0->>'version_id' as vid, config->>'initial_capital' as cap, config->>'estimated_bars' as bars from strategy_run where config->'slots'->0->>'version_id'='$SV' order by created_at" | tee "$D/60_same_plugin_other_runs.txt"
$PSQL -x -c "select r.id,r.symbol,r.period,r.from_ts,r.to_ts,r.config->'policy' policy, r.config->'fee' fee, res.metrics, jsonb_array_length(res.trades) as n_trades from strategy_run r join strategy_run_result res on res.run_id=r.id where r.id in ('sr_1789738272901_000004','sr_1789731376244_000003')" | tee "$D/61_same_window_lumpsum_arm.txt"
$PSQL -x -c "select r.id, r.symbol, r.period, r.from_ts::date, r.to_ts::date, r.config->'policy' policy, res.metrics, res.trades->0->>'shares' as shares, res.trades->0->>'pnl' as pnl from strategy_run r join strategy_run_result res on res.run_id=r.id where r.id in ('sr_1789212710079_000053','sr_1789212695054_000052','sr_1789211239591_000017','sr_1789211555164_000024') order by r.id" | tee "$D/63_author_A1A2_runs.txt"

# ── 7. 外部设计文档只读副本与指纹（原件不在本仓库）──────────────────────────
S=/home/eestock/workspace/scrylink/eestock/eestock
cp "$S/design/01-dca-strategy-family.md"               "$D/50_design_01_copy.md"
cp "$S/design/03-dca-policy-semantics-correction.md"    "$D/51_design_03_copy.md"
cp "$S/strategies/dca_baseline.js"                      "$D/52_author_source_dca_baseline.js"
{ echo "# 外部设计文档来源与指纹（只读副本，原件在策略研发侧工作区，不在本仓库）"; echo
  echo "origin_dir=$S"; echo
  sha256sum "$S/design/01-dca-strategy-family.md" "$S/design/03-dca-policy-semantics-correction.md" \
            "$S/design/02-platform-issues-for-upstream.md" "$S"/strategies/*.js \
            "$S/tools/dca_matrix.py" "$S/tools/strategy_eval.py" "$S/results/RESULTS-dca-family.md"
  echo; echo "## git ls-files 反证：本仓库（eestock-rs）内不存在该设计文档"
  git ls-files | grep -ci "dca-strategy-family" || true
} > "$D/53_external_docs_provenance.txt"

echo "done. 本脚本只读；`git diff --cached` 应始终为空。"
