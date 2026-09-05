//! 参数网格展开 + `serde_json` 参数 → `backtest::StrategyParams`。
//! 网格格式（ADR §7）：`{k: "起:止:步长"}`，多个键取**笛卡尔积**展开为 N 个子任务参数点。

use anyhow::{anyhow, Result};
use backtest::{ParamValue, StrategyParams};
use std::collections::HashMap;

/// 解析 `"起:止:步长"` → 升序 `Vec<f64>`（含止；浮点容差；步长为正）。
pub fn parse_range(s: &str) -> Result<Vec<f64>> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 3 {
        return Err(anyhow!("范围应为 \"起:止:步长\"，实际: {s}"));
    }
    let start: f64 = parts[0].trim().parse().map_err(|e| anyhow!("起始值解析失败: {e}"))?;
    let stop: f64 = parts[1].trim().parse().map_err(|e| anyhow!("截止值解析失败: {e}"))?;
    let step: f64 = parts[2].trim().parse().map_err(|e| anyhow!("步长解析失败: {e}"))?;
    if step <= 0.0 {
        return Err(anyhow!("步长必须为正，实际: {step}"));
    }
    let mut out = Vec::new();
    let eps = 1e-9;
    let mut v = start;
    while v <= stop + eps {
        out.push(v);
        v += step;
    }
    if out.is_empty() {
        return Err(anyhow!("范围展开为空: {s}"));
    }
    Ok(out)
}

/// 展开参数网格：`base(params)` ∪ 网格键笛卡尔积 → `Vec<serde_json::Value>`（每个参数点）。
/// 无网格 → 返回 base 单点（base 非对象则记空对象）。
pub fn expand_grid(base: &serde_json::Value, grid: &serde_json::Value) -> Result<Vec<serde_json::Value>> {
    let mut keys: Vec<(String, Vec<f64>)> = Vec::new();
    if let serde_json::Value::Object(map) = grid {
        for (k, v) in map {
            let range_str = v
                .as_str()
                .ok_or_else(|| anyhow!("网格 {k} 的值应为 \"起:止:步长\" 字符串"))?;
            let values = parse_range(range_str)?;
            keys.push((k.clone(), values));
        }
    }
    let base_obj = base.as_object().cloned().unwrap_or_default();
    if keys.is_empty() {
        return Ok(vec![serde_json::Value::Object(base_obj)]);
    }
    let mut results = vec![base_obj];
    for (k, values) in keys {
        let mut next = Vec::new();
        for r in &results {
            for v in &values {
                let mut obj = r.clone();
                obj.insert(k.clone(), serde_json::json!(v));
                next.push(obj);
            }
        }
        results = next;
    }
    Ok(results.into_iter().map(serde_json::Value::Object).collect())
}

/// `serde_json::Value` 参数对象 → `backtest::StrategyParams`（数值 → `Num`，字符串 → `Choice`）。
pub fn to_strategy_params(params: &serde_json::Value) -> Result<StrategyParams> {
    let obj = params.as_object().ok_or_else(|| anyhow!("params 应为对象"))?;
    let mut map: HashMap<String, ParamValue> = HashMap::new();
    for (k, v) in obj {
        match v {
            serde_json::Value::Number(n) => {
                let f = n
                    .as_f64()
                    .ok_or_else(|| anyhow!("参数 {k} 非有限数值"))?;
                map.insert(k.clone(), ParamValue::Num(f));
            }
            serde_json::Value::String(s) => {
                map.insert(k.clone(), ParamValue::Choice(s.clone()));
            }
            other => return Err(anyhow!("参数 {k} 类型不支持: {other:?}")),
        }
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_range_basic_inclusive() {
        assert_eq!(parse_range("2:6:2").unwrap(), vec![2.0, 4.0, 6.0]);
        assert_eq!(parse_range("0:10:5").unwrap(), vec![0.0, 5.0, 10.0]);
    }

    #[test]
    fn parse_range_stops_before_overshoot() {
        // 2:6:3 → 2,5（8 超出 6，容差内不入）
        assert_eq!(parse_range("2:6:3").unwrap(), vec![2.0, 5.0]);
    }

    #[test]
    fn parse_range_rejects_bad_input() {
        assert!(parse_range("a:b:c").is_err());
        assert!(parse_range("1:10").is_err());
        assert!(parse_range("1:10:-1").is_err());
    }

    #[test]
    fn expand_grid_cartesian_product() {
        let base = serde_json::json!({"mode": "trend"});
        let grid = serde_json::json!({"fast": "2:4:2", "slow": "3:6:3"});
        // fast ∈ [2,4] (2 值) × slow ∈ [3,6] (2 值) = 4 点
        let children = expand_grid(&base, &grid).unwrap();
        assert_eq!(children.len(), 4);
        for c in &children {
            let o = c.as_object().unwrap();
            assert_eq!(o["mode"], "trend", "base 参数应保留");
            assert!(o.contains_key("fast"));
            assert!(o.contains_key("slow"));
        }
    }

    #[test]
    fn expand_grid_no_grid_returns_single_point() {
        let base = serde_json::json!({"fast": 5.0});
        let children = expand_grid(&base, &serde_json::json!({})).unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].as_object().unwrap()["fast"], 5.0);
    }

    #[test]
    fn to_strategy_params_maps_num_and_choice() {
        let p = serde_json::json!({"fast": 5.0, "mode": "mean_reversion"});
        let m = to_strategy_params(&p).unwrap();
        assert_eq!(m.get("fast"), Some(&ParamValue::Num(5.0)));
        assert_eq!(m.get("mode"), Some(&ParamValue::Choice("mean_reversion".into())));
    }

    #[test]
    fn to_strategy_params_rejects_unsupported_type() {
        let p = serde_json::json!({"fast": [1, 2]});
        assert!(to_strategy_params(&p).is_err());
    }
}
