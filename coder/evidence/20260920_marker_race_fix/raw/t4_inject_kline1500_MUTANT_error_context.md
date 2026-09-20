# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: zz-t4-inject.e2e.ts >> T4 只高亮被点击那一笔 [@mut]：白描边簇恰 1 个且质心落在该笔堆叠位置；3 秒后回落为 0
- Location: e2e/zz-t4-inject.e2e.ts:653:1

# Error details

```
Error: 成交明细到位后每笔成交必须已建成 fillDot 标记（data-marker-overlays == 已加载成交笔数）

成交明细到位后每笔成交必须已建成 fillDot 标记（data-marker-overlays == 已加载成交笔数）

expect(received).toBe(expected) // Object.is equality

Expected: "OK"
Received: "MISMATCH data-marker-overlays=0 want=44 note=成交合计 44 笔（精确源 /fills，已加载 44 / 共 44）"

Call Log:
- Timeout 15000ms exceeded while waiting on the predicate
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - generic [ref=e5]: 已收盘 13:14
    - generic [ref=e8]: 采集停止
    - link "1m 源健康 0/0 →数据源诊断" [ref=e11] [cursor=pointer]:
      - /url: /sources
  - generic [ref=e14]:
    - navigation [ref=e15]:
      - list [ref=e16]:
        - listitem [ref=e17]:
          - link "① 行情看板" [ref=e18] [cursor=pointer]:
            - /url: /
        - listitem [ref=e19]:
          - link "② 数据源诊断" [ref=e20] [cursor=pointer]:
            - /url: /sources
        - listitem [ref=e21]:
          - link "③ 标的管理" [ref=e22] [cursor=pointer]:
            - /url: /symbols
        - listitem [ref=e23]:
          - link "④ 数据质量" [ref=e24] [cursor=pointer]:
            - /url: /quality
        - listitem [ref=e25]:
          - generic [ref=e26]:
            - generic [ref=e27]: ⑥ 交易面板
            - emphasis [ref=e28]: W4
        - listitem [ref=e29]:
          - link "⑦ 告警中心" [ref=e30] [cursor=pointer]:
            - /url: /alerts
        - listitem [ref=e31]:
          - link "⑧ 系统设置" [ref=e32] [cursor=pointer]:
            - /url: /settings
        - listitem [ref=e33]:
          - link "⑨ 模拟实盘" [ref=e34] [cursor=pointer]:
            - /url: /sim-live
        - listitem [ref=e35]:
          - link "⑩ 策略" [ref=e36] [cursor=pointer]:
            - /url: /strategies
        - listitem [ref=e37]:
          - link "⑪ 回测工作台" [ref=e38] [cursor=pointer]:
            - /url: /backtest-workbench
    - generic [ref=e39]:
      - generic [ref=e40]:
        - generic [ref=e42]:
          - generic [ref=e43]:
            - generic [ref=e44]: 组合预设
            - combobox [ref=e47]:
              - option "选择预设…" [selected]
            - generic [ref=e48]:
              - textbox "预设名" [ref=e49]
              - button "保存" [ref=e50] [cursor=pointer]
              - button "重命名" [disabled] [ref=e51]
              - button "删除" [disabled] [ref=e52]
          - generic [ref=e53]:
            - generic [ref=e54]: 策略（多选，加权聚合）
            - generic [ref=e55]:
              - combobox [ref=e56]:
                - option "添加策略…" [selected]
                - option "双均线交叉 v1"
                - option "均线+RSI 过滤 v1"
                - option "MACD 金叉/死叉 v1"
                - option "BOLL 带突破 v1"
                - option "KDJ 金叉/死叉 v1"
                - option "动量突破 v1"
                - option "ATR 通道突破 v1"
                - option "纯评分模板 v1"
                - option "两态门控模板 v1"
                - option "定投模板 v1"
                - option "趋势+止损模板 v1"
                - option "定投·定期定额基线 v1"
                - option "定投·均线偏离分档 v1"
                - option "定投·回撤触发 v1"
                - option "定投·定期不定额 v1"
                - option "15min 超跌反弹·波动率归一（主变体） v1"
                - option "15min 超跌反弹·连续阴线（弱信号变体） v1"
                - option "15min 对照臂·永不交易 v1"
              - button "添加" [disabled] [ref=e57]
          - generic [ref=e58]:
            - generic [ref=e59]:
              - text: 名称（可选）
              - textbox "名称（可选）" [ref=e60]
            - generic [ref=e61]:
              - text: 标的
              - combobox "标的" [ref=e62]:
                - option "518880 华安黄金易ETF" [selected]
                - option "161226 国投瑞银白银期货(LOF)A"
                - option "513310 华泰柏瑞中韩半导体ETF(QDII)"
                - option "159776 银华中证港股通医药卫生综合ETF"
                - option "159742 博时恒生科技ETF(QDII)"
                - option "159337 中证500ETF基金"
                - option "159577 汇添富MSCI美国50ETF"
                - option "159638 嘉实中证高端装备细分50ETF"
                - option "159740 大成恒生科技ETF(QDII)"
                - option "159781 易方达中证科创创业50ETF"
                - option "159825 富国中证农业主题ETF"
                - option "159842 银华中证全指证券公司ETF"
                - option "159869 华夏中证动漫游戏ETF"
                - option "159870 鹏华中证细分化工产业ETF"
                - option "159890 招商中证云计算ETF"
                - option "159980 大成有色金属期货ETF"
                - option "159981 建信易盛能源化工期货ETF"
                - option "159985 华夏饲料豆粕期货ETF"
                - option "160723 嘉实原油(QDII-LOF)"
                - option "510050 华夏上证50ETF"
                - option "510880 华泰柏瑞上证红利ETF"
                - option "511130 博时上证30年期国债ETF"
                - option "511220 海富通上证城投债ETF"
                - option "511360 海富通中证短融ETF"
                - option "511380 博时可转债ETF"
                - option "512200 南方中证房地产ETF"
                - option "512480 国联安中证半导体ETF"
                - option "512670 鹏华中证国防ETF"
                - option "512690 鹏华中证酒ETF"
                - option "512800 华宝中证银行ETF"
                - option "513050 易方达中概互联50ETF"
                - option "513690 博时恒生高股息ETF"
                - option "513750 广发中证港股通非银ETF"
                - option "513920 华安恒生港股通中国央企红利ETF"
                - option "513970 景顺长城恒生消费ETF(QDII)"
                - option "515070 华夏中证人工智能主题ETF"
                - option "515710 华宝中证细分食品饮料主题ETF"
                - option "515790 华泰柏瑞中证光伏产业ETF"
                - option "516380 华宝智能电动汽车ETF"
                - option "551000"
                - option "561910 招商中证电池主题ETF"
                - option "562500 华夏中证机器人ETF"
                - option "562800 嘉实中证稀有金属主题ETF"
                - option "588000 华夏上证科创板50成份ETF"
            - generic [ref=e63]:
              - text: 周期
              - combobox "周期" [ref=e64]:
                - option "M1"
                - option "M5"
                - option "M15"
                - option "M30"
                - option "H1"
                - option "D1" [selected]
            - generic [ref=e65]:
              - text: 初始资金
              - spinbutton "初始资金" [ref=e66]: "100000"
            - generic [ref=e67]:
              - text: 起始
              - textbox "起始" [ref=e68]: 2026-06-22
            - generic [ref=e69]:
              - text: 截止
              - textbox "截止" [ref=e70]: 2026-09-20
          - generic [ref=e71]: 可用区间：2013-07-28 ~ 2026-09-17
          - generic [ref=e72]:
            - generic [ref=e73]:
              - text: 买入阈值（≥ 买）
              - spinbutton "买入阈值（≥ 买）" [ref=e74]: "60"
            - generic [ref=e75]:
              - text: 卖出阈值（≤ 卖）
              - spinbutton "卖出阈值（≤ 卖）" [ref=e76]: "40"
          - generic [ref=e77]:
            - generic [ref=e78]:
              - text: 执行策略（ExecutionPolicy）
              - combobox "执行策略（ExecutionPolicy）" [ref=e79]:
                - option "LumpSum 一次性" [selected]
                - option "DCA 分批"
            - generic [ref=e80]:
              - text: 仓位比例 (0,1]
              - spinbutton "仓位比例 (0,1]" [ref=e81]: "1"
          - generic [ref=e83]:
            - checkbox "启用硬止损（触发即绕过评分平仓）" [ref=e84]
            - text: 启用硬止损（触发即绕过评分平仓）
          - generic [ref=e85]:
            - generic [ref=e86]:
              - text: 佣金率%
              - spinbutton "佣金率%" [ref=e87]: "0.025"
            - generic [ref=e88]:
              - text: 最低佣金
              - spinbutton "最低佣金" [ref=e89]: "5"
            - generic [ref=e90]:
              - text: 滑点 bp
              - spinbutton "滑点 bp" [ref=e91]: "2"
          - button "提交回测" [ref=e92] [cursor=pointer]
        - generic [ref=e94]:
          - generic [ref=e95]:
            - generic [ref=e96]: 运行历史（勾选 0/4 对比）
            - button "刷新" [ref=e97] [cursor=pointer]
          - generic [ref=e98]:
            - generic [ref=e100]:
              - checkbox "勾选对比（2-4 个已完成运行）" [ref=e101]
              - button "sr_1789875663473_000004 159776 · 日 · 09-20 11:41" [ref=e102] [cursor=pointer]:
                - generic [ref=e103]: sr_1789875663473_000004
                - generic [ref=e104]: 159776 · 日 · 09-20 11:41
              - generic [ref=e105]: 完成
            - generic [ref=e107]:
              - checkbox "勾选对比（2-4 个已完成运行）" [ref=e108]
              - button "sr_1789875082403_000003 159776 · 日 · 09-20 11:31" [ref=e109] [cursor=pointer]:
                - generic [ref=e110]: sr_1789875082403_000003
                - generic [ref=e111]: 159776 · 日 · 09-20 11:31
              - generic [ref=e112]: 完成
            - generic [ref=e114]:
              - checkbox "勾选对比（2-4 个已完成运行）" [ref=e115]
              - button "sr_1789865536364_000002 159776 · 日 · 09-20 08:52" [ref=e116] [cursor=pointer]:
                - generic [ref=e117]: sr_1789865536364_000002
                - generic [ref=e118]: 159776 · 日 · 09-20 08:52
              - generic [ref=e119]: 完成
            - generic [ref=e121]:
              - checkbox "勾选对比（2-4 个已完成运行）" [ref=e122]
              - button "sr_1789865219068_000001 159776 · 日 · 09-20 08:46" [active] [ref=e123] [cursor=pointer]:
                - generic [ref=e124]: sr_1789865219068_000001
                - generic [ref=e125]: 159776 · 日 · 09-20 08:46
              - generic [ref=e126]: 完成
            - generic [ref=e128]:
              - checkbox "勾选对比（2-4 个已完成运行）" [ref=e129]
              - button "sr_1789865144110_000000 159776 · 日 · 09-20 08:45" [ref=e130] [cursor=pointer]:
                - generic [ref=e131]: sr_1789865144110_000000
                - generic [ref=e132]: 159776 · 日 · 09-20 08:45
              - generic [ref=e133]: 完成
            - generic [ref=e135]:
              - checkbox "勾选对比（2-4 个已完成运行）" [ref=e136]
              - button "adr027E-accept-M5-macross 518880 · 5m · 09-19 23:41" [ref=e137] [cursor=pointer]:
                - generic [ref=e138]: adr027E-accept-M5-macross
                - generic [ref=e139]: 518880 · 5m · 09-19 23:41
              - generic [ref=e140]: 完成
            - generic [ref=e142]:
              - checkbox "勾选对比（2-4 个已完成运行）" [ref=e143]
              - button "adr027E-accept-D1-macross 159776 · 日 · 09-19 23:41" [ref=e144] [cursor=pointer]:
                - generic [ref=e145]: adr027E-accept-D1-macross
                - generic [ref=e146]: 159776 · 日 · 09-19 23:41
              - generic [ref=e147]: 完成
            - generic [ref=e149]:
              - checkbox "勾选对比（2-4 个已完成运行）" [ref=e150]
              - button "adr027E-accept-D1-multirt 159776 · 日 · 09-19 23:41" [ref=e151] [cursor=pointer]:
                - generic [ref=e152]: adr027E-accept-D1-multirt
                - generic [ref=e153]: 159776 · 日 · 09-19 23:41
              - generic [ref=e154]: 完成
            - generic [ref=e156]:
              - checkbox "勾选对比（2-4 个已完成运行）" [ref=e157]
              - button "adr027E-accept-M5-multirt 518880 · 5m · 09-19 23:41" [ref=e158] [cursor=pointer]:
                - generic [ref=e159]: adr027E-accept-M5-multirt
                - generic [ref=e160]: 518880 · 5m · 09-19 23:41
              - generic [ref=e161]: 完成
            - generic [ref=e163]:
              - checkbox "勾选对比（2-4 个已完成运行）" [ref=e164]
              - button "adr027E-accept-DCApartial-1 159776 · 日 · 09-19 23:41" [ref=e165] [cursor=pointer]:
                - generic [ref=e166]: adr027E-accept-DCApartial-1
                - generic [ref=e167]: 159776 · 日 · 09-19 23:41
              - generic [ref=e168]: 完成
            - generic [ref=e169]:
              - generic [ref=e170]:
                - button "adr027-accept-e2e-2 518880 · 5m · 09-19 23:31" [ref=e171] [cursor=pointer]:
                  - generic [ref=e172]: adr027-accept-e2e-2
                  - generic [ref=e173]: 518880 · 5m · 09-19 23:31
                - generic [ref=e174]: 失败
              - 'generic "结果分块落库失败: error returned from database: new row for relation \"strategy_run_bars\" violates check constraint \"strategy_run_bars_kind_check\"" [ref=e175]'
            - generic [ref=e176]:
              - generic [ref=e177]:
                - button "adr027-accept-e2e 159776 · 日 · 09-19 23:31" [ref=e178] [cursor=pointer]:
                  - generic [ref=e179]: adr027-accept-e2e
                  - generic [ref=e180]: 159776 · 日 · 09-19 23:31
                - generic [ref=e181]: 失败
              - 'generic "结果分块落库失败: error returned from database: new row for relation \"strategy_run_bars\" violates check constraint \"strategy_run_bars_kind_check\"" [ref=e182]'
      - generic [ref=e184]:
        - generic [ref=e185]:
          - generic [ref=e186]: sr_1789865219068_000001
          - generic [ref=e187]:
            - text: 159776 · 日 · 完成 ·
            - generic [ref=e188]: 进度 100%
        - generic [ref=e190]:
          - generic [ref=e191]:
            - generic "双击复位高度" [ref=e192]: K线 159776（D1）
            - generic [ref=e193]: B 买入
            - generic [ref=e194]: S 卖出
            - generic [ref=e195]: ⊗ 硬止损触发
            - generic [ref=e196]: 成交合计 44 笔（精确源 /fills，已加载 44 / 共 44）
            - generic [ref=e197]:
              - generic [ref=e198]: 指标
              - button "MA" [pressed] [ref=e200] [cursor=pointer]
              - button "VOL" [pressed] [ref=e202] [cursor=pointer]
              - button "MACD" [ref=e204] [cursor=pointer]
              - button "KDJ" [ref=e206] [cursor=pointer]
              - button "BOLL" [ref=e208] [cursor=pointer]
              - button "DCAP" [ref=e210] [cursor=pointer]
          - generic "kline 卡片高度拖拽把手（双击复位）" [ref=e234]
        - generic [ref=e235]:
          - button "全览" [ref=e236] [cursor=pointer]
          - button "回退" [disabled] [ref=e237]
          - generic [ref=e238]: 窗口 [1776960000, 1789660800] · 102 根 · 来源 kline · rev 2
          - generic [ref=e239]: 可回退 0 步（上限 20）
        - generic [ref=e240]: 窗口已应用：[1776960000, 1789660800] rev 2
        - generic [ref=e241]:
          - generic [ref=e242]: 聚合总分曲线
          - img "总分曲线" [ref=e245]
          - generic [ref=e250]:
            - generic [ref=e251]: 聚合总分 0-100（虚线 = 买入阈 60 / 卖出阈 40；三区 = 买/持/卖）
            - generic [ref=e252]: 共 424 bar
          - generic "aggregate 卡片高度拖拽把手（双击复位）" [ref=e253]
        - generic [ref=e254]:
          - generic [ref=e255]: 各策略评分
          - generic [ref=e258]:
            - checkbox "定投·定期定额基线 v1（权重 1）" [checked] [ref=e259]
            - text: 定投·定期定额基线 v1（权重 1）
          - img "各策略评分曲线" [ref=e261]
          - generic [ref=e263]: 各策略评分 0-100（图例开关，默认前 3 条）· 共 424 bar
          - generic "slot 卡片高度拖拽把手（双击复位）" [ref=e264]
        - generic [ref=e265]:
          - generic [ref=e266]: 净值 + 回撤
          - generic [ref=e268]:
            - img "净值与回撤" [ref=e269]
            - generic:
              - generic: 净值 101880.27
              - generic: +2.5%
            - generic: 回撤（最大 −5.5%，着色区间）
            - generic: 净值 共 174 bar · 回撤 共 174 bar
          - generic "equity 卡片高度拖拽把手（双击复位）" [ref=e367]
        - generic [ref=e368]:
          - generic [ref=e369]: 持仓比率（时点市值 / 时点净值）
          - generic [ref=e371]:
            - img "持仓比率曲线" [ref=e372]
            - generic:
              - generic: position_ratio 0.00%
              - generic: cash_ratio 100.00%
              - generic: nav 101880.27（= 持仓市值 0.00 + 现金 101880.27）
            - generic: 持仓比率 共 174 bar
          - generic [ref=e375]:
            - text: 持仓比率 position_ratio（分母 = **时点净值** nav，即 持仓市值 / 时点净值） ｜ 现金比率 cash_ratio（分母 = **时点净值** nav，即 1 − position_ratio） ｜
            - generic [ref=e376]: deployed_pct（分母 = **初始资金**，区间**累计**敞口 / 初始资金）=43.01%
            - text: ｜
            - generic [ref=e377]: cash_consumed_pct（分母 = **初始资金**，区间**累计**资金占用（含佣金）/ 初始资金）=43.23%
            - text: ：三者**不同物**，不得互相解释（前者时点/时点，后两者区间累计/初始资金）。
          - generic "position 卡片高度拖拽把手（双击复位）" [ref=e378]
        - generic [ref=e379]:
          - generic [ref=e380]:
            - button "交易明细" [ref=e381] [cursor=pointer]
            - button "8项绩效" [ref=e382] [cursor=pointer]
            - button "逐bar评分" [ref=e383] [cursor=pointer]
            - button "事件日志" [ref=e384] [cursor=pointer]
          - generic [ref=e386]:
            - generic [ref=e387]:
              - generic [ref=e388]: 成交合计 44 笔（含期末强平卖出 1 笔）｜回合 1 条（其中强平合成 1 条）｜名义投入 43.01%（分母 = 初始资金）
              - generic [ref=e389]: 现金消耗（含佣金）43.23%｜计划批数 100｜可达轮次 44｜买入成交 43 笔｜未执行挂单 1（末根 bar 无次 bar 可执行）
              - generic [ref=e390]:
                - status [ref=e391]: ⚠ 计划 100 批，区间内最多可推进 44 批、已成交 43 批（剩余批次随买入区结束取消）
                - status [ref=e392]: ⚠ 名义投入 43.01% 初始资金，年化/回撤/夏普分母仍为初始资金
                - status [ref=e393]: ℹ 1 笔挂单未成交（末根 bar 无次 bar 可执行）
            - generic [ref=e394]:
              - generic [ref=e395]: 回合 已加载 1 / 共 1 条（ADR-027 D8：L2 逐笔按 rt_seq 懒加载）
              - table [ref=e396]:
                - rowgroup [ref=e397]:
                  - row [ref=e398]:
                    - columnheader "回合" [ref=e399]
                    - columnheader "标的" [ref=e400]
                    - columnheader "状态" [ref=e401]
                    - columnheader "开仓" [ref=e402]
                    - columnheader "平仓" [ref=e403]
                    - columnheader "开价" [ref=e404]
                    - columnheader "平价" [ref=e405]
                    - columnheader "股数" [ref=e406]
                    - columnheader "卖出金额" [ref=e407]
                    - columnheader "佣金" [ref=e408]
                    - columnheader "印花税" [ref=e409]
                    - columnheader "盈亏" [ref=e410]
                    - columnheader "持仓" [ref=e411]
                    - columnheader "来源" [ref=e412]
                    - columnheader "成交" [ref=e413]
                    - columnheader "操作" [ref=e414]
                - rowgroup [ref=e415]:
                  - row [ref=e416]:
                    - cell "1" [ref=e417]
                    - cell "159776" [ref=e418]
                    - cell "已平仓" [ref=e419]
                    - cell "01-20 00:00" [ref=e420]
                    - cell "09-18 00:00" [ref=e421]
                    - cell "1.139" [ref=e422]
                    - cell "1.195" [ref=e423]
                    - cell "37,764.7619" [ref=e424]
                    - cell "45119.86" [ref=e425]
                    - cell "226.28" [ref=e426]
                    - cell "0.00" [ref=e427]
                    - cell "1880.27" [ref=e428]
                    - cell "162bar" [ref=e429]
                    - cell "期末强平" [ref=e430]
                    - cell "成交 44 笔（买 43 / 卖 1）" [ref=e431]
                    - cell [ref=e432]:
                      - button "明细" [ref=e433] [cursor=pointer]
                      - button "跳转" [ref=e434] [cursor=pointer]
```

# Test source

```ts
  63  | /** 白簇最小计重（< 该值视为恒定背景噪声，实测为 y 轴小簇 size 4/1）。 */
  64  | const CLUSTER_MIN = 30;
  65  | /** 标签 ink run 阈值（校准口径见设计报告 §2/T2；真实构建实测 24）。 */
  66  | const INK_RUN_MIN = 15;
  67  | 
  68  | const PAGE_CAPTURE = `
  69  |   (() => {
  70  |     const w = window;
  71  |     w.__wbCharts = [];
  72  |     const orig = Map.prototype.set;
  73  |     Map.prototype.set = function (k, v) {
  74  |       try {
  75  |         if (v && typeof v === 'object' && typeof v.convertToPixel === 'function' && typeof v.getDataList === 'function') {
  76  |           w.__wbCharts.push(v);
  77  |         }
  78  |       } catch {}
  79  |       return orig.call(this, k, v);
  80  |     };
  81  |   })();
  82  | `;
  83  | 
  84  | function writeJson(name: string, data: unknown): void {
  85  |   mkdirSync(OUT, { recursive: true });
  86  |   writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
  87  | }
  88  | 
  89  | async function readAttrs(page: Page, testId: string): Promise<Record<string, string>> {
  90  |   return page.getByTestId(testId).evaluate((e) =>
  91  |     Object.fromEntries(Array.from(e.attributes).map((a) => [a.name, a.value])),
  92  |   );
  93  | }
  94  | 
  95  | /** 页面上屏的图表真身状态（就绪判据读点）。 */
  96  | async function chartReadyState(page: Page): Promise<{ maxDataLen: number; markers: string; fillsNote: string }> {
  97  |   const dataLens = await page.evaluate(() => {
  98  |     const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
  99  |     return (w.__wbCharts ?? []).map((c) => {
  100 |       try {
  101 |         return (((c['getDataList'] as () => unknown[])() ?? []) as unknown[]).length;
  102 |       } catch {
  103 |         return -1;
  104 |       }
  105 |     });
  106 |   });
  107 |   const markers = (await page.getByTestId('kline-chart').getAttribute('data-marker-overlays')) ?? '';
  108 |   const fillsNote = (await page.getByTestId('wb-fills-note').textContent()) ?? '';
  109 |   return { maxDataLen: dataLens.reduce((a, b) => Math.max(a, b), 0), markers, fillsNote };
  110 | }
  111 | 
  112 | /** 由 `wb-fills-note` 文案导出**期望已建标记数**（= 已加载成交笔数）。
  113 |  *  与 K 线标记的事实源同源：`成交合计 N 笔（精确源 /fills，已加载 L / 共 N）` ⇒ 期望 L（每笔一个 fillDot）。
  114 |  *  `加载中…` / `未记录…` ⇒ 期望 0（与 T6b/T6c 的显式判据同口径）。
  115 |  *  文案无法解析 ⇒ **显式抛错**（就绪判据失去依据时必须变红，禁止静默放宽）。 */
  116 | function expectedMarkerCount(fillsNote: string): number {
  117 |   if (fillsNote.includes('加载中')) return 0;
  118 |   if (fillsNote.includes('未记录')) return 0;
  119 |   const m = /已加载\s*(\d+)\s*\/\s*共\s*\d+/.exec(fillsNote);
  120 |   if (!m) throw new Error(`wb-fills-note 文案无法解析（就绪判据失效，须更新规格）：${fillsNote}`);
  121 |   return Number(m[1]);
  122 | }
  123 | 
  124 | /** 打开工作台 + 选中 run + 等初始装载落定（结果页可见、窗口事实源来自 kline、成交明细到位）。
  125 |  *
  126 |  *  **2026-09-20（T4 flaky 取证）**：本条原先以 `waitForTimeout(2500)`「等落定」——固定 sleep 不能保证任何
  127 |  *  前置条件成立（数据慢于 2.5s ⇒ 断言跑在未就绪状态上；数据快于 2.5s ⇒ 白白等待）。现改为**显式就绪判据**：
  128 |  *  ① 图表 K 线数据到位（`dataList` 非空 ⇒ 窗口事实源/几何定位可用）；
  129 |  *  ② 成交明细到位且**每笔成交一个 `fillDot`**（`data-marker-overlays` == 已加载成交数，读页面自身上屏口径）。
  130 |  *  就绪判据超时 ⇒ 显式红（附实际/期望计数），不再随机停在后续断言上。
  131 |  *  取证与残留在产品侧的竞态见 `tester/evidence/20260920_t4_flaky_rootcause/report.md`。 */
  132 | async function openRunSettled(page: Page, runId: string): Promise<void> {
  133 |   await page.goto('/backtest-workbench');
  134 |   await expect(page.getByTestId('wb-run-list')).toBeVisible();
  135 |   const sel = page.getByTestId(`wb-run-select-${runId}`);
  136 |   await expect(sel, `运行 ${runId} 必须在历史列表内`).toBeVisible();
  137 |   await sel.click();
  138 |   await expect(page.getByTestId('wb-result')).toBeVisible();
  139 |   await expect(page.getByTestId('wb-window-bar')).toBeVisible();
  140 |   await expect(page.getByTestId('wb-fills-note')).toBeVisible();
  141 |   // ① 图表 K 线数据就绪（窗口事实源来自 kline；dataList 为空则「定位/画标记」无从谈起）
  142 |   await expect
  143 |     .poll(async () => (await chartReadyState(page)).maxDataLen, {
  144 |       timeout: 15_000,
  145 |       intervals: [100],
  146 |       message: '图表 K 线数据必须到位（真图表实例 dataList 非空）',
  147 |     })
  148 |     .toBeGreaterThan(0);
  149 |   // ② 成交明细就绪 + 每笔成交一个标记（读页面上屏计数，与 T1/T4 判据同源）
  150 |   await expect
  151 |     .poll(
  152 |       async () => {
  153 |         const { markers, fillsNote } = await chartReadyState(page);
  154 |         const want = expectedMarkerCount(fillsNote);
  155 |         return markers === String(want) ? 'OK' : `MISMATCH data-marker-overlays=${markers} want=${want} note=${fillsNote}`;
  156 |       },
  157 |       {
  158 |         timeout: 15_000,
  159 |         intervals: [100],
  160 |         message: '成交明细到位后每笔成交必须已建成 fillDot 标记（data-marker-overlays == 已加载成交笔数）',
  161 |       },
  162 |     )
> 163 |     .toBe('OK');
      |      ^ Error: 成交明细到位后每笔成交必须已建成 fillDot 标记（data-marker-overlays == 已加载成交笔数）
  164 | }
  165 | 
  166 | /** 真图表 store：`fillDot`（常态标记）/`fillDotHighlight`（跳转高亮）逐条读回。 */
  167 | type StoreDump = {
  168 |   ok: boolean;
  169 |   names: string[];
  170 |   fillDot: Array<{ key: string; stack: number; label: string; color: string; ts: number; price: number; zLevel: number }>;
  171 |   highlight: Array<{ key: string; stack: number; label: string; color: string; ts: number; price: number; zLevel: number; pulse: number }>;
  172 | };
  173 | 
  174 | async function storeDump(page: Page): Promise<StoreDump> {
  175 |   return page.evaluate(() => {
  176 |     const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
  177 |     const cands = (w.__wbCharts ?? []).filter((c) => {
  178 |       try {
  179 |         return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
  180 |       } catch {
  181 |         return false;
  182 |       }
  183 |     });
  184 |     if (cands.length === 0) return { ok: false, names: [], fillDot: [], highlight: [] } as unknown as never;
  185 |     const chart = cands[0]!;
  186 |     const all = (chart['getOverlays'] as () => Array<Record<string, unknown>>)();
  187 |     const pick = (o: Record<string, unknown>) => {
  188 |       const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
  189 |       const pts = (o['points'] ?? []) as Array<{ timestamp?: number; value?: number }>;
  190 |       return {
  191 |         key: String(ext['fillKey'] ?? ''),
  192 |         stack: Number(ext['stackIndex'] ?? 0),
  193 |         label: String(ext['label'] ?? ''),
  194 |         color: String(ext['color'] ?? ''),
  195 |         pulse: Number(ext['pulse'] ?? 0),
  196 |         zLevel: Number(o['zLevel'] ?? 0),
  197 |         ts: Number(pts[0]?.timestamp ?? 0),
  198 |         price: Number(pts[0]?.value ?? 0),
  199 |       };
  200 |     };
  201 |     return {
  202 |       ok: true,
  203 |       names: all.map((o) => String(o['name'])),
  204 |       fillDot: all.filter((o) => o['name'] === 'fillDot').map(pick),
  205 |       highlight: all.filter((o) => o['name'] === 'fillDotHighlight').map(pick),
  206 |     } as unknown as never;
  207 |   }) as Promise<StoreDump>;
  208 | }
  209 | 
  210 | 
  211 | /** 几何（**键方案无关**）：按 (ts, price) 定位目标笔的渲染位置——供变异态（键被粗化）下仍能测到位置。 */
  212 | async function geomByFill(
  213 |   page: Page,
  214 |   targets: Array<{ ts: number; price: number }>,
  215 | ): Promise<Record<string, { x: number; yRaw: number; y: number; stack: number; label: string; color: string; fillKey: string }>> {
  216 |   return page.evaluate((want) => {
  217 |     const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
  218 |     const cands = (w.__wbCharts ?? []).filter((c) => {
  219 |       try {
  220 |         return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
  221 |       } catch {
  222 |         return false;
  223 |       }
  224 |     });
  225 |     if (cands.length === 0) return {};
  226 |     const chart = cands[0]!;
  227 |     const out: Record<string, unknown> = {};
  228 |     const all = (chart['getOverlays'] as (f?: unknown) => Array<Record<string, unknown>>)({ name: 'fillDot' });
  229 |     for (const o of all) {
  230 |       const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
  231 |       const pts = (o['points'] ?? []) as Array<{ timestamp: number; value: number }>;
  232 |       const hit = want.find((t) => Math.abs(pts[0]!.timestamp - t.ts * 1000) < 1000 && Math.abs(pts[0]!.value - t.price) < 1e-9);
  233 |       if (!hit) continue;
  234 |       const p = (chart['convertToPixel'] as (a: unknown, b: unknown) => { x?: number; y?: number })(
  235 |         { timestamp: pts[0]!.timestamp, value: pts[0]!.value },
  236 |         { paneId: 'candle_pane' },
  237 |       );
  238 |       const stack = Number(ext['stackIndex'] ?? 0);
  239 |       out[`${hit.ts}:${hit.price}`] = {
  240 |         x: Number(p.x ?? NaN),
  241 |         yRaw: Number(p.y ?? NaN),
  242 |         y: Number(p.y ?? NaN) + stack * 12,
  243 |         stack,
  244 |         label: String(ext['label'] ?? ''),
  245 |         color: String(ext['color'] ?? ''),
  246 |         fillKey: String(ext['fillKey'] ?? ''),
  247 |       };
  248 |     }
  249 |     return out as never;
  250 |   }, targets) as Promise<Record<string, { x: number; yRaw: number; y: number; stack: number; label: string; color: string; fillKey: string }>>;
  251 | }
  252 | 
  253 | /** 几何：目标 `fillKey` 的**渲染位置**（kline 容器相对坐标，**含堆叠偏移**）与锚点价/ts。 */
  254 | type Geom = Record<string, { x: number; yRaw: number; y: number; stack: number; label: string; color: string; ts: number; price: number }>;
  255 | async function geomOf(page: Page, keys: string[]): Promise<Geom> {
  256 |   return page.evaluate((want) => {
  257 |     const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
  258 |     const cands = (w.__wbCharts ?? []).filter((c) => {
  259 |       try {
  260 |         return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
  261 |       } catch {
  262 |         return false;
  263 |       }
```