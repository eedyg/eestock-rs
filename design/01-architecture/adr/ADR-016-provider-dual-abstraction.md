# ADR-016：Provider 双抽象——实时与历史

- 状态：✅ 已定（2026-09-02 用户明确要求）
- 决策：数据 Provider 分两个抽象——
  1. **RealtimeDataProvider**（实时）：近期 1m 抓取 + 快照；实现：腾讯 ifzq、新浪 jsonp、快照池（ADR-015 分层）
  2. **HistoricalDataProvider**（历史）：按 (code, period, start, end) 拉取历史 K线；实现：tushare（ETF 全历史，含分钟级——用户付费档位，旧库已验证 1m 至 2013 年）
- 职责划分：实时层喂 kline_raw（日内增量），历史层喂 kline_accurate（准确层回填/同步），双真值模型（ADR-003）的物理基础
- 连带修订：`Bar` 增加 `period` 字段（历史层多粒度需要）；`kline_accurate` 增加 `period` 列并入主键 (code,ts,period)；merge 视图仅合并 accurate 的 M1 部分（raw 恒为 M1），日级 accurate 由消费方直接查询
- 旧代码参考：golang/pkg/data/source/tushare/client.go（API 协议/限频）、pipeline/tushare_hist.go（分钟历史重建逻辑）
