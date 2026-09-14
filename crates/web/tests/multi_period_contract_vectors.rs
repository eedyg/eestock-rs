//! 多周期配置 **mock ↔ backend 契约一致性（parity）向量消费侧（Rust / 真实后端校验）** —— D5-1。
//!
//! 单一真相：`design/15-multi-period/contract-vectors.json`（两侧共用；`.json` 不被 tangle 监听，
//! 见 `entangled.toml` `watch_list = ["design/**/*.md"]`）。前端消费侧见
//! `web/src/api/multiPeriodMockParity.test.ts`；两侧必须给出**相同的接受/拒绝**与**相同的归一化输出**。
//!
//! 本文件把每条向量的 `input`（完整 config 对象）打到 `web::dto::validate_multi_period_config`
//! （纯函数：七条校验 + §7.4 总 pane 护栏 + §2 校验 6 归一化），断言：
//! - `expect.status == 200` ⇒ 校验通过，且归一化结果 `== expect.normalized`；
//! - `expect.status == 400` ⇒ 校验失败，且错误串含 `expect.errorMustContain`（被拒字段名）。
//!
//! 附加（去重语义 / 护栏本体的纯函数证据，`03-test-plan.md` T6 + `02-spec.md` §7.4）：
//! - 向量声明的 `expect.paneCountAfterDedup` 必须与 `multi_period_pane_count` 一致；
//! - 向量声明的 `expect.paneGuardErrorMustContain` 必须被 `verify_multi_period_panes` 的 `Err` 命中
//!   （v1 受支持指标仅 `dcap` ⇒ 去重后 HTTP 面无法构造纯 pane 越限，故护栏本体只能在纯函数层取证）。
//!
//! 卫生：本文件**无 IO、无 DB、无网络**（只读一个仓库内 JSON 文件 + 调用纯函数）⇒ 0 写请求。
//! 非 tangle 生成物（手写契约测试）。红/绿视现状：后端 P1-D-2/D-3 已修，预期**绿**；
//! 红侧在 TS（mock 未去重）。

use serde_json::Value;
use std::path::PathBuf;
use web::dto::{
    multi_period_pane_count, validate_multi_period_config, verify_multi_period_panes,
    MultiPeriodConfigDto,
};

/// 契约向量的**必须集合**（覆盖 `02-spec.md` §2 七条校验 + §7 护栏 + §7.4 去重/pane 计数）。
/// 少一条即判失败 ⇒ 防止向量文件被削弱后「两侧一起变绿」。
const REQUIRED_VECTOR_NAMES: [&str; 19] = [
    "valid-single-base-default",
    "valid-four-periods-max-legal-v1",
    "valid-1w-satellite-with-1d-base",
    "valid-empty-indicators",
    "dedup-two-identical-indicators",
    "dedup-n-identical-indicators-cannot-forge-over-12-panes",
    "dedup-makes-legal-repeated-indicators-over-raw-pane-budget",
    "pane-over-limit-after-dedup-names-dimension",
    "reject-empty-periods",
    "reject-more-than-4-periods",
    "reject-duplicate-periods",
    "reject-1mo-period",
    "reject-satellite-below-base",
    "reject-1w-with-base-below-1d",
    "reject-heights-key-mismatch",
    "reject-heights-below-min",
    "reject-heights-above-max",
    "reject-unsupported-indicator",
    "reject-unsupported-indicator-among-supported",
];

fn vectors_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../design/15-multi-period/contract-vectors.json")
}

fn load_vectors() -> Vec<Value> {
    let p = vectors_path();
    let raw = std::fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("契约向量文件不可读 {}：{e}", p.display()));
    let v: Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("契约向量文件 JSON 解析失败 {}：{e}", p.display()));
    v.as_array()
        .unwrap_or_else(|| panic!("契约向量文件必须是**数组**（{}）", p.display()))
        .clone()
}

fn name_of(v: &Value) -> String {
    v["name"].as_str().unwrap_or("<缺 name>").to_string()
}

/// 单条向量的后端校验结果（`Err` = 观测到的与期望不一致；**只观察，不修**）。
fn check_vector(v: &Value) -> Result<(), String> {
    let name = name_of(v);
    let cfg: MultiPeriodConfigDto = serde_json::from_value(v["input"].clone())
        .map_err(|e| format!("[{name}] input 不是合法 MultiPeriodConfigDto：{e}"))?;
    let expect = &v["expect"];
    let status = expect["status"]
        .as_u64()
        .ok_or_else(|| format!("[{name}] expect.status 缺失/非整数"))?;
    match status {
        200 => {
            let normalized = validate_multi_period_config(&cfg)
                .map_err(|e| format!("[{name}] 期望 200，后端却 400：{e}"))?;
            let want: MultiPeriodConfigDto = serde_json::from_value(expect["normalized"].clone())
                .map_err(|e| format!("[{name}] expect.normalized 缺失/非法：{e}"))?;
            if normalized != want {
                return Err(format!(
                    "[{name}] 归一化输出不一致：后端={} 期望={}",
                    serde_json::to_string(&normalized).unwrap_or_default(),
                    serde_json::to_string(&want).unwrap_or_default()
                ));
            }
            Ok(())
        }
        400 => match validate_multi_period_config(&cfg) {
            Ok(n) => Err(format!(
                "[{name}] 期望 400，后端却 200（归一化={}）",
                serde_json::to_string(&n).unwrap_or_default()
            )),
            Err(e) => {
                let needle = expect["errorMustContain"]
                    .as_str()
                    .ok_or_else(|| format!("[{name}] expect.errorMustContain 缺失"))?;
                if e.contains(needle) {
                    Ok(())
                } else {
                    Err(format!("[{name}] 错误串必须含「{needle}」，收到：{e}"))
                }
            }
        },
        other => Err(format!("[{name}] 未知 expect.status={other}")),
    }
}

/// **主门禁**：同一组向量在后端校验纯函数上的接受/拒绝与归一化输出必须与期望一致。
#[test]
fn all_contract_vectors_match_backend_validation() {
    let vectors = load_vectors();
    let mut failures: Vec<String> = Vec::new();
    for v in &vectors {
        if let Err(e) = check_vector(v) {
            failures.push(e);
        }
    }
    assert!(
        failures.is_empty(),
        "后端与契约向量不一致（{}/{} 条）：\n{}",
        failures.len(),
        vectors.len(),
        failures.join("\n")
    );
}

/// 向量覆盖守卫：`REQUIRED_VECTOR_NAMES` 一条都不能少（向量文件被削弱 ⇒ 此处红）。
#[test]
fn contract_vectors_cover_required_rules() {
    let vectors = load_vectors();
    let names: Vec<String> = vectors.iter().map(name_of).collect();
    let missing: Vec<&str> = REQUIRED_VECTOR_NAMES
        .iter()
        .copied()
        .filter(|n| !names.iter().any(|x| x == n))
        .collect();
    assert!(
        missing.is_empty(),
        "契约向量缺少必需用例（02-spec §2/§7 + §7.4）：{missing:?}；现有：{names:?}"
    );
    assert!(vectors.len() >= REQUIRED_VECTOR_NAMES.len());
}

/// 去重语义：向量声明的 `paneCountAfterDedup` 必须与后端纯函数计数一致
/// （含「重复项无法构造 >12 pane」与「去重后越限 = 13 > 12」两侧证据）。
#[test]
fn pane_count_after_dedup_matches_backend_pure_function() {
    let vectors = load_vectors();
    let mut checked = 0usize;
    for v in &vectors {
        let Some(want) = v["expect"]["paneCountAfterDedup"].as_u64() else { continue };
        let name = name_of(v);
        let cfg: MultiPeriodConfigDto = serde_json::from_value(v["input"].clone())
            .unwrap_or_else(|e| panic!("[{name}] input 反序列化失败：{e}"));
        let got = multi_period_pane_count(&cfg.periods, &cfg.indicators) as u64;
        assert_eq!(
            got, want,
            "[{name}] 去重后总 pane 数不一致（§7.4：计数必须基于去重后 indicators）：后端={got} 向量={want}"
        );
        checked += 1;
    }
    assert!(
        checked >= 4,
        "至少 4 条向量必须声明 paneCountAfterDedup（去重 2/n、去重后合法、去重后越限）；实际 {checked}"
    );
}

/// 护栏本体（纯函数层）：声明的 `paneGuardErrorMustContain` 必须被
/// `verify_multi_period_panes` 的 `Err` 命中（v1 HTTP 面无法构造纯 pane 越限，见 02-spec §7.4 注）。
#[test]
fn pane_guard_error_names_dimension_for_over_limit_vectors() {
    let vectors = load_vectors();
    let mut checked = 0usize;
    for v in &vectors {
        let Some(needle) = v["expect"]["paneGuardErrorMustContain"].as_str() else { continue };
        let name = name_of(v);
        let cfg: MultiPeriodConfigDto = serde_json::from_value(v["input"].clone())
            .unwrap_or_else(|e| panic!("[{name}] input 反序列化失败：{e}"));
        let err = verify_multi_period_panes(&cfg.periods, &cfg.indicators)
            .err()
            .unwrap_or_else(|| panic!("[{name}] 去重后越限却未被 pane 护栏拒绝（§7.4）"));
        assert!(
            err.contains(needle),
            "[{name}] pane 护栏错误串必须含被拒维度名「{needle}」，收到：{err}"
        );
        checked += 1;
    }
    assert!(checked >= 1, "至少 1 条向量必须声明 paneGuardErrorMustContain（去重后越限）");
}
