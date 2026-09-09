/**
 * 指标 API 文档侧栏（静态内容；取自 02-plugin-abi.md §2/§2.5，中文）。
 * 列出 ctx 结构、指标签名（数据不足返回 null）、position 5 字段、log/save/load 契约与沙箱禁区。
 */
export function DocSidebar() {
  return (
    <div className="flex flex-col gap-3 overflow-auto p-3 text-xs" data-testid="doc-sidebar">
      <section>
        <h3 className="mb-1 font-medium text-txt">生命周期钩子</h3>
        <pre className="whitespace-pre-wrap rounded-lg bg-panel2 p-2 font-mono text-[11px] text-dim">{`const PARAMS_SCHEMA = [ ... ];  // 首行级字面量（必须）
function init(params) {}          // 可选
function on_bar(ctx) { return 50; } // 必须，返回 0-100
function save() { return {}; }    // 可选：状态快照（JSON 可序列化）
function load(state) {}           // 可选：恢复`}</pre>
      </section>

      <section>
        <h3 className="mb-1 font-medium text-txt">ctx.bar / ctx.index / ctx.params</h3>
        <ul className="list-inside list-disc text-dim">
          <li><code>ctx.bar</code> = {'{ ts, open, high, low, close, volume }'}（ts = Unix 秒）</li>
          <li><code>ctx.index</code>：当前 bar 序号（0 起）</li>
          <li><code>ctx.params</code>：init 时同一对象（冻结，按 schema 校验/填缺省后）</li>
        </ul>
      </section>

      <section>
        <h3 className="mb-1 font-medium text-txt">ctx.indicators（host 侧确定性计算）</h3>
        <table className="w-full text-left">
          <tbody className="font-mono text-[11px] text-dim">
            <tr><td className="py-0.5 pr-2 text-acc2">ma(n)</td><td>number | null</td></tr>
            <tr><td className="py-0.5 pr-2 text-acc2">ema(n)</td><td>number | null</td></tr>
            <tr><td className="py-0.5 pr-2 text-acc2">macd()</td><td>{'{ dif, dea, macd }'} | null</td></tr>
            <tr><td className="py-0.5 pr-2 text-acc2">kdj()</td><td>{'{ k, d, j }'} | null</td></tr>
            <tr><td className="py-0.5 pr-2 text-acc2">boll(n, mult)</td><td>{'{ mid, upper, lower }'} | null</td></tr>
            <tr><td className="py-0.5 pr-2 text-acc2">rsi(n)</td><td>number | null</td></tr>
            <tr><td className="py-0.5 pr-2 text-acc2">atr(n)</td><td>number | null</td></tr>
          </tbody>
        </table>
        <p className="mt-1 text-[11px] text-dim">所有指标数据不足返回 null，策略需自行判空。</p>
      </section>

      <section>
        <h3 className="mb-1 font-medium text-txt">ctx.position（只读；纯评分试算恒 null）</h3>
        <ul className="list-inside list-disc text-dim">
          <li><code>qty</code>：当前持仓股数（0/空仓时 host 给 null）</li>
          <li><code>avg_cost</code>：摊薄成本价</li>
          <li><code>entry_ts</code>：首次建仓时间（Unix 秒）</li>
          <li><code>bars_since_entry</code>：建仓以来经过的 bar 数</li>
          <li><code>unrealized_pnl</code>：浮动盈亏（金额）</li>
        </ul>
      </section>

      <section>
        <h3 className="mb-1 font-medium text-txt">副作用与状态</h3>
        <ul className="list-inside list-disc text-dim">
          <li><code>ctx.log(msg)</code>：唯一副作用通道，落 run 事件流</li>
          <li><code>save()</code> / <code>load(state)</code>：状态快照契约（host 持有，用于暂停/恢复/精确重放）</li>
        </ul>
      </section>

      <section>
        <h3 className="mb-1 font-medium text-txt">沙箱禁区（引用即异常）</h3>
        <p className="text-[11px] text-dim">
          无 Date / Math.random / setTimeout / fetch / require 等全局能力；返回值越界由 host clamp 至 [0,100]；
          插件永不获得下单/账户写接口。
        </p>
      </section>
    </div>
  );
}
