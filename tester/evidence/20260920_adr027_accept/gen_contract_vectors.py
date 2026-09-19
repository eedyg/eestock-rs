#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADR-027 S 段：contract-vectors.json 生成器（**独立 oracle**）。

本脚本**不读取 Rust 实现**，只按 `design/17-trade-detail-layering/02-spec.md` §2 的数学定义
（op 顺序逐条对齐 spec 公式）用 Python（IEEE-754 double，与 Rust f64 同语义）算出期望值。
生成结果作为两侧（回测聚合 / sim-live 聚合）的一致性基线与逐字段期望。

用法：python3 gen_contract_vectors.py > ../../..//design/17-trade-detail-layering/contract-vectors.json
"""
import json

BAR_SEC = 60
SESSION_START_TS = 1700000000  # 任选固定纪元；ts = start + bar_index * 60


def ts_of(bar: int) -> int:
    return SESSION_START_TS + bar * BAR_SEC


def aggregate(fills):
    """02-spec §2 口径的独立实现（op 顺序与 spec 公式逐条对齐）。"""
    buy_qty = sell_qty = 0.0
    buy_value = sell_value = 0.0
    buy_comm = sell_comm = sell_stamp = 0.0
    buy_count = sell_count = l2_count = 0
    for f in fills:
        l2_count += 1
        if f["side"] == "Buy":
            buy_count += 1
            buy_qty += f["qty"]
            buy_value += f["trade_value"]
            buy_comm += f["commission"]
        else:
            sell_count += 1
            sell_qty += f["qty"]
            sell_value += f["trade_value"]
            sell_comm += f["commission"]
            sell_stamp += f["stamp_duty"]
    closed = sell_qty > 1e-9 and abs(buy_qty - sell_qty) <= 1e-9
    invested = buy_value + buy_comm
    proceeds = sell_value - sell_comm - sell_stamp
    first, last = fills[0], fills[-1]
    return {
        "rt_seq": None,  # 由 rt_seq 分配结果填入
        "code": first["code"],
        "status": "Closed" if closed else "Open",
        "open_ts": first["ts"],
        "close_ts": last["ts"] if closed else None,
        "open_bar": first["bar_index"],
        "close_bar": last["bar_index"] if closed else None,
        "open_price": (buy_value / buy_qty) if buy_qty > 1e-9 else 0.0,
        "close_price": (sell_value / sell_qty) if sell_qty > 1e-9 else None,
        "shares": buy_qty,
        "gross_value": sell_value,
        "commission": buy_comm + sell_comm,
        "stamp_duty": sell_stamp,
        "pnl": (proceeds - invested) if closed else None,
        "hold_bars": (max(0, last["bar_index"] - first["bar_index"])) if closed else None,
        "reason": last["reason"] if closed else None,
        "l2_count": l2_count,
        "buy_count": buy_count,
        "sell_count": sell_count,
    }


def assign_rt_seq(fills):
    """02-spec §1.3 规则：买入且无持仓 ⇒ 新序号；持仓中任何成交 ⇒ 当前序号；卖出使持仓归零 ⇒ 终结。"""
    pos = {}
    seq = {}
    out = []
    for f in fills:
        c = f["code"]
        p = pos.get(c, 0.0)
        s = seq.get(c, 0)
        if f["side"] == "Buy":
            if p <= 1e-9:  # RT_SEQ_EPS
                s += 1
            p += f["qty"]
        else:
            p = max(p - f["qty"], 0.0)
        pos[c] = p
        seq[c] = s
        out.append(0 if s == 0 else s)
    return out


def fill(code, bar, side, qty, price, commission, stamp_duty, reason):
    return {
        "code": code,
        "bar_index": bar,
        "ts": ts_of(bar),
        "side": side,
        "qty": qty,
        "price": price,
        "trade_value": qty * price,
        "commission": commission,
        "stamp_duty": stamp_duty,
        "reason": reason,
    }


def vector(vid, desc, fills):
    seqs = assign_rt_seq(fills)
    # 按 (code 首现, rt_seq) 分组的期望回合
    order = []
    groups = {}
    for f, s in zip(fills, seqs):
        if f["code"] not in order:
            order.append(f["code"])
        groups.setdefault((f["code"], s), []).append(f)
    rts = []
    for c in order:
        keys = sorted([k for k in groups if k[0] == c], key=lambda k: k[1])
        for k in keys:
            rt = aggregate(groups[k])
            rt["rt_seq"] = k[1]
            rts.append(rt)
    l2 = [
        {
            "index": i,
            "rt_seq": seqs[i],
            "code": f["code"],
            "bar_index": f["bar_index"],
            "ts": f["ts"],
            "side": f["side"],
            "qty": f["qty"],
            "price": f["price"],
            "trade_value": f["trade_value"],
            "commission": f["commission"],
            "stamp_duty": f["stamp_duty"],
            "reason": f["reason"],
        }
        for i, f in enumerate(fills)
    ]
    return {
        "id": vid,
        "description": desc,
        "code": fills[0]["code"],
        "bar_sec": BAR_SEC,
        "session_start_ts": SESSION_START_TS,
        "fills": fills,
        "expected_fill_rt_seq": seqs,
        "expected_round_trips": rts,
        "expected_l2": l2,
    }


C = "600000.SH"
vectors = [
    vector(
        "V1_single_open_close",
        "单笔开平：一笔买入 + 一笔足额卖出 ⇒ 1 个 Closed 回合",
        [
            fill(C, 1, "Buy", 100.0, 10.0, 5.0, 0.0, "Policy"),
            fill(C, 3, "Sell", 100.0, 12.0, 5.0, 1.2, "Policy"),
        ],
    ),
    vector(
        "V2_multi_batch_add",
        "多批加仓：两笔买入 + 一笔足额卖出 ⇒ 同一 rt_seq",
        [
            fill(C, 1, "Buy", 100.0, 10.0, 5.0, 0.0, "Policy"),
            fill(C, 2, "Buy", 200.0, 11.0, 5.0, 0.0, "Policy"),
            fill(C, 5, "Sell", 300.0, 13.0, 5.0, 3.9, "Policy"),
        ],
    ),
    vector(
        "V3_partial_sell",
        "部分卖出：买 100 → 卖 40（部分）→ 卖 60（清仓）⇒ 单回合全回合口径 pnl",
        [
            fill(C, 1, "Buy", 100.0, 10.0, 5.0, 0.0, "Policy"),
            fill(C, 3, "Sell", 40.0, 12.0, 5.0, 0.48, "Policy"),
            fill(C, 7, "Sell", 60.0, 11.0, 5.0, 0.66, "Policy"),
        ],
    ),
    vector(
        "V4_dca_multi_batch",
        "DCA 多批：6 笔定投买入 + 期末足额卖出 ⇒ 单回合（shares = Σ 买入 qty）",
        [
            fill(C, 1, "Buy", 50.0, 10.0, 5.0, 0.0, "Policy"),
            fill(C, 2, "Buy", 50.0, 9.5, 5.0, 0.0, "Policy"),
            fill(C, 3, "Buy", 50.0, 10.5, 5.0, 0.0, "Policy"),
            fill(C, 4, "Buy", 50.0, 9.0, 5.0, 0.0, "Policy"),
            fill(C, 5, "Buy", 50.0, 11.0, 5.0, 0.0, "Policy"),
            fill(C, 6, "Buy", 50.0, 10.0, 5.0, 0.0, "Policy"),
            fill(C, 8, "Sell", 300.0, 12.0, 5.0, 3.6, "Policy"),
        ],
    ),
    vector(
        "V5_zero_length_round_trip",
        "零长回合：同一 bar 内买入 + 卖出（open_bar == close_bar）⇒ 归属仍由 rt_seq 决定",
        [
            fill(C, 4, "Buy", 100.0, 10.0, 5.0, 0.0, "Policy"),
            fill(C, 4, "Sell", 100.0, 9.5, 5.0, 0.95, "Manual"),
        ],
    ),
    vector(
        "V6_open_round_trip_unclosed",
        "Open 回合未平仓：买 100 → 部分卖 40 ⇒ status=Open、pnl=None（禁造数）",
        [
            fill(C, 1, "Buy", 100.0, 10.0, 5.0, 0.0, "Policy"),
            fill(C, 4, "Sell", 40.0, 12.0, 5.0, 0.48, "Policy"),
        ],
    ),
    vector(
        "V7_close_then_reopen_two_round_trips",
        "清仓后重开：rt_seq 1（Closed）→ rt_seq 2（Closed，同一 code）",
        [
            fill(C, 1, "Buy", 100.0, 10.0, 5.0, 0.0, "Policy"),
            fill(C, 2, "Sell", 100.0, 11.0, 5.0, 1.1, "Policy"),
            fill(C, 4, "Buy", 50.0, 9.0, 5.0, 0.0, "Policy"),
            fill(C, 6, "Sell", 50.0, 10.0, 5.0, 0.5, "Policy"),
        ],
    ),
]

doc = {
    "schema": "adr027-contract-vectors/1",
    "owner": "tester（闸门 3 独立验收）",
    "spec": "design/17-trade-detail-layering/02-spec.md §1/§2/§3",
    "note": (
        "期望值由 gen_contract_vectors.py（独立 Python oracle，逐条按 02-spec §2 公式的 op 顺序计算，"
        "不读 Rust 实现）生成；判据 = 回测聚合（backtest::assign_rt_seq + aggregate_round_trips）与 "
        "sim-live 聚合（SimLiveService::round_trips 经 sim_trades 账本）对同一向量逐字段相同，"
        "浮点**逐位**相等（JSON 字符串亦需逐字节相等）。"
    ),
    "bar_sec": BAR_SEC,
    "session_start_ts": SESSION_START_TS,
    "sim_live_reason_source": {"Policy": "strategy", "Manual": "manual"},
    "vectors": vectors,
}

print(json.dumps(doc, indent=2, ensure_ascii=False))
