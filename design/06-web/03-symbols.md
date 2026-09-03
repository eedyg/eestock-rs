# 06-web / 03 — 标的管理（页面③）

> Grill P3 定稿（2026-09-02，全按推荐）。

## 1. 布局（三层法表达，规范见 00-shell.md；样板 01-dashboard.md §1）

### L1 ASCII 线框

默认视图（列表）：

```
┌────────────────────────────────────────────────────────────────┐
│ 顶部状态条 H=44px（shell 级，见 00-shell）                       │
├────────┬───────────────────────────────────────────────────────┤
│ 导航栏  │ table-toolbar H=48px                                  │
│ W=208px│ [+ 注册标的]              （右侧：标的计数）            │
│ (shell)├───────────────────────────────────────────────────────┤
│        │ symbol-table (flex-1)                                  │
│        │ 表头 H=40：code│名称│抓取间隔│启用│今日bar数│最新bar时刻│操作 │
│        │ 行 H=44 × N（操作列：编辑 / 停用）                      │
└────────┴───────────────────────────────────────────────────────┘
min-width: 1280px（桌面优先，不响应式）
```

表单视图（注册/编辑共用模态，遮罩居中）：

```
┌──── 遮罩（半透明，点击不关闭，防误触）─────────────────────────┐
│   ┌─ form-dialog W=480 ────────────────────────────────┐      │
│   │ 标题：注册标的 / 编辑标的（code 主键编辑态只读）      │      │
│   │ code（6位数字，市场规则校验，北交所拒绝提示）         │      │
│   │ 抓取间隔秒（默认 60，下限 60）                       │      │
│   │ 交收规则 T+0/T+1（按分类预填，修改需二次确认）        │      │
│   │ 启用开关（默认开）                                  │      │
│   │ [取消]                        [保存]                 │      │
│   └─────────────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────────┘
```

### L1.5 可视化样机（静态 HTML，tangle 生成，浏览器直接打开看效果）

``` {.html file=design/06-web/preview/03-symbols.html}
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>页面③ 标的管理 — 布局样机</title>
<style>
  :root {
    --bg:#0b0e17; --panel:#121627; --panel2:#171c33; --line:rgba(255,255,255,.07);
    --txt:#e5e9f2; --dim:#8b93b0; --up:#ff5c6c; --down:#00e0a4;
    --acc1:#38bdf8; --acc2:#a78bfa; --warn:#fbbf24;
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px; background:radial-gradient(1200px 600px at 70% -10%, #1a2040 0%, var(--bg) 55%);
         font:14px/1.6 "Inter","PingFang SC",sans-serif; color:var(--txt); }
  .frame { min-width:1280px; margin:0 auto 28px; background:rgba(18,22,39,.75); border:1px solid var(--line);
           border-radius:16px; overflow:hidden; backdrop-filter:blur(6px); box-shadow:0 12px 40px rgba(0,0,0,.45); }
  .frame h2 { margin:0; padding:12px 18px; font-size:13px; font-weight:600; letter-spacing:.08em; color:var(--dim);
              background:rgba(255,255,255,.03); border-bottom:1px solid var(--line); }
  .region { position:relative; }
  .tag { position:absolute; top:6px; left:10px; font-size:11px; color:var(--dim); opacity:.85; z-index:2; }
  .num { font-variant-numeric:tabular-nums; font-family:"JetBrains Mono",monospace; }
  .topbar { height:44px; display:flex; align-items:center; gap:14px; padding:0 18px; border-bottom:1px solid var(--line); }
  .pill { display:flex; align-items:center; gap:7px; padding:4px 12px; border-radius:999px;
          background:rgba(255,255,255,.04); border:1px solid var(--line); font-size:12px; }
  .dot { width:8px; height:8px; border-radius:50%; }
  .live { background:#00e0a4; box-shadow:0 0 8px #00e0a4aa; animation:pulse 2s infinite; }
  @keyframes pulse { 50% { opacity:.45; } }
  .body { display:flex; height:520px; }
  .nav { width:208px; padding:14px 10px; border-right:1px solid var(--line); }
  .nav div { padding:9px 14px; margin:2px 0; border-radius:10px; color:var(--dim); font-size:13px; }
  .nav .on { color:#fff; background:linear-gradient(90deg, rgba(56,189,248,.18), rgba(167,139,250,.14));
             border-left:3px solid var(--acc1); }
  .nav .off { opacity:.4; }
  .page { flex:1; display:flex; flex-direction:column; }
  .btn { padding:4px 12px; border-radius:8px; font-size:12px; color:var(--dim); border:1px solid transparent; }
  .btn.on { color:#fff; background:linear-gradient(135deg, var(--acc1), var(--acc2)); box-shadow:0 2px 10px rgba(56,189,248,.35); }
  .btn.ghost { border-color:var(--line); }
  .btn.danger { color:var(--up); border:1px solid rgba(255,92,108,.4); }
  .up { color:var(--up); } .down { color:var(--down); } .warn { color:var(--warn); }
  /* table-toolbar */
  .tbar { height:48px; display:flex; align-items:center; gap:12px; padding:0 18px; border-bottom:1px solid var(--line); }
  /* symbol-table */
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; padding:10px 14px; color:var(--dim); font-weight:500; font-size:12px;
       border-bottom:1px solid var(--line); letter-spacing:.04em; }
  td { padding:10px 14px; border-bottom:1px solid var(--line); }
  tr:hover td { background:rgba(255,255,255,.03); }
  .swt { display:inline-block; width:32px; height:18px; border-radius:999px; background:rgba(0,224,164,.25);
         border:1px solid rgba(0,224,164,.5); position:relative; vertical-align:middle; }
  .swt::after { content:""; position:absolute; top:2px; right:2px; width:12px; height:12px; border-radius:50%; background:var(--down); }
  .swt.off { background:rgba(255,255,255,.06); border-color:var(--line); }
  .swt.off::after { right:auto; left:2px; background:var(--dim); }
  /* form-dialog */
  .mask { flex:1; background:rgba(4,6,12,.6); display:flex; align-items:center; justify-content:center; position:relative; }
  .dlg { width:480px; background:var(--panel); border:1px solid var(--line); border-radius:16px;
         box-shadow:0 20px 60px rgba(0,0,0,.6); padding:20px 22px; position:relative; }
  .dlg h3 { margin:0 0 14px; font-size:15px; }
  .fld { margin-bottom:12px; }
  .fld label { display:block; font-size:12px; color:var(--dim); margin-bottom:4px; }
  .fld .inp { height:34px; border-radius:8px; background:var(--panel2); border:1px solid var(--line);
              color:var(--dim); display:flex; align-items:center; padding:0 12px; font-size:13px; }
  .fld .inp.ro { opacity:.55; }
  .fld .hint { font-size:11px; color:var(--warn); margin-top:3px; }
  .note { max-width:1280px; margin:0 auto; color:var(--dim); font-size:12px; }
</style>
</head>
<body>

<div class="frame">
  <h2>默认视图（列表）· min-width 1280</h2>
  <div class="topbar region" data-region="topbar">
    <span class="pill"><span class="dot live"></span>交易中 10:23</span>
    <span class="pill"><span class="dot live"></span>采集正常</span>
    <span class="pill">1m 源健康 <b class="num">2/2</b></span>
  </div>
  <div class="body">
    <div class="nav region" data-region="nav">
      <div>① 行情看板</div><div>② 数据源诊断</div><div class="on">③ 标的管理</div>
      <div class="off">④ 数据质量 · W2</div><div class="off">⑤ 回测 · W3</div>
      <div class="off">⑥ 交易 · W4</div><div class="off">⑦ 告警 · W2</div><div class="off">⑧ 设置</div>
    </div>
    <div class="page">
      <!-- table-toolbar H=48 -->
      <div class="tbar region" data-region="table-toolbar">
        <span class="btn on">+ 注册标的</span>
        <span style="flex:1"></span>
        <span class="pill">共 <b class="num">44</b> 只</span>
      </div>
      <!-- symbol-table：GET /api/symbols?with_stats=1 -->
      <div class="region" data-region="symbol-table" style="flex:1">
        <span class="tag">symbol-table · GET /api/symbols?with_stats=1</span>
        <table>
          <tr><th>code</th><th>名称</th><th>抓取间隔</th><th>启用</th><th>今日已采 bar</th><th>最新 bar 时刻</th><th>操作</th></tr>
          <tr><td class="num">518880</td><td>黄金ETF</td><td class="num">60s</td><td><span class="swt"></span></td><td class="num">205</td><td class="num">10:23:00</td><td><span class="btn ghost">编辑</span> <span class="btn danger">停用</span></td></tr>
          <tr><td class="num">513310</td><td>纳指ETF</td><td class="num">60s</td><td><span class="swt"></span></td><td class="num">189</td><td class="num">10:23:00</td><td><span class="btn ghost">编辑</span> <span class="btn danger">停用</span></td></tr>
          <tr><td class="num">161226</td><td>白银LOF</td><td class="num">300s</td><td><span class="swt"></span></td><td class="num">41</td><td class="num">10:20:00</td><td><span class="btn ghost">编辑</span> <span class="btn danger">停用</span></td></tr>
          <tr style="opacity:.45"><td class="num">159776</td><td>港股通医药</td><td class="num">60s</td><td><span class="swt off"></span></td><td class="num">—</td><td class="num">昨 14:59</td><td><span class="btn ghost">编辑</span> <span class="btn ghost">启用</span></td></tr>
        </table>
      </div>
    </div>
  </div>
</div>

<div class="frame">
  <h2>表单视图 · 注册/编辑共用模态 form-dialog W=480（遮罩点击不关闭）</h2>
  <div class="body" style="height:480px">
    <div class="nav region"><div class="on">③ 标的管理</div></div>
    <div class="mask region" data-region="form-dialog">
      <div class="dlg">
        <span class="tag" style="top:8px;left:12px">form-dialog · 注册 POST /api/symbols · 编辑 PATCH /api/symbols/{code}</span>
        <h3>注册标的</h3>
        <div class="fld"><label>code（6 位数字；5/6/9→沪，0/1/2/3→深；北交所 4/8/920 拒绝）</label><div class="inp num">600519</div></div>
        <div class="fld"><label>抓取间隔（秒，默认 60，下限 60；保存后下一周期热生效）</label><div class="inp num">60</div></div>
        <div class="fld"><label>交收规则（按分类预填：跨境/债券/商品/货币→T0，股票型→T1；修改需二次确认 ⚠️ 影响回测撮合）</label><div class="inp">T+1（股票型 · 已按分类预填）</div></div>
        <div class="fld"><label>启用（默认开）</label><div class="inp">开 <span class="swt" style="margin-left:8px"></span></div></div>
        <div class="fld"><label>名称（注册时从行情源反查，失败留空可手工修改）</label><div class="inp">贵州茅台（服务端反查）</div></div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
          <span class="btn ghost">取消</span><span class="btn on">保存</span>
        </div>
      </div>
    </div>
  </div>
</div>

<p class="note">样机仅表达布局/区域/尺寸与风格基调（深色交易终端风，同 01-dashboard 基线），非最终视觉设计稿。三态与交互契约见 L2 表。</p>
</body>
</html>
```

### L2 区域规格表

| 区域 id | 内容 | 数据源 | loading/空/错误态 | 交互 |
|---|---|---|---|---|
| `table-toolbar` | 注册入口按钮「+ 注册标的」、标的计数 | 本地状态（计数来自 symbol-table 数据） | 不可能空（静态控件）/ — / — | 点击打开 form-dialog（注册模式） |
| `symbol-table` | 表格列：code、名称、当前抓取间隔、启用状态、今日已采 bar 数、最新 bar 时刻、操作（编辑/停用）；停用行置灰 | `GET /api/symbols?with_stats=1` | 骨架行 / 「未注册标的」空态 + 注册引导按钮 / 顶部错误条+重试 | 编辑→form-dialog（编辑模式，code 只读）；停用→确认后 `PATCH /api/symbols/{code} {enabled:false}`（仅停用，历史数据保留，无物理删除入口） |
| `form-dialog` | 注册/编辑共用表单：code（6 位数字；5/6/9→沪、0/1/2/3→深；北交所 4/8/920 拒绝并提示「暂不支持」）、抓取间隔（默认 60、下限 60）、交收规则 T+0/T+1（按分类预填，人工确认可改）、启用开关（默认开）、名称（注册时服务端反查，失败留空可手工改） | 注册 `POST /api/symbols`（服务端反查名称）；编辑 `PATCH /api/symbols/{code}`（间隔热生效，下一采集周期按新间隔调度） | 提交中按钮禁用+spinner / 不可能空（表单上下文由入口决定）/ 校验错误字段内联提示（code 格式/北交所/间隔下限）、提交错误顶部提示可重试 | settlement 修改需二次确认（⚠️ 回测撮合规则输入，改错污染回测结论）；code 主键编辑态只读（改 code=停用旧+注册新）；遮罩点击不关闭防误触 |

### L3 布局骨架（tangle 生成；结构+锚点+尺寸类，视觉样式手写）

``` {.tsx file=web/src/layouts/SymbolsGrid.tsx}
// 由 design/06-web/03-symbols.md L3 代码块 tangle 生成，禁止手改
// 骨架职责：Props 契约 + 区域→组件映射 + 数据源/三态内联注释 + 定稿默认值；视觉样式与数据获取实现在组件内手写

/** 已定稿默认值（定稿 P3，勿改常量改文档） */
export const SYMBOLS_DEFAULTS = {
  intervalSec: 60,                // 抓取间隔默认 60s
  minIntervalSec: 60,             // 间隔下限 60s
  enabled: true,                  // 启用开关默认开
  settlementByCategory: true,     // 交收规则按分类预填：跨境/债券/商品/货币→T0，股票型→T1
  bseRejected: true,              // 北交所前缀（4/8/920）拒绝并提示「暂不支持」
} as const;

export type Settlement = 'T0' | 'T1';
export type FormMode = 'register' | 'edit';

/** 页面 Props 契约 */
export interface SymbolsGridProps {
  formMode: FormMode | null;                   // null=弹窗关闭
  editingCode: string | null;                  // 编辑模式的 code（主键只读）
  onOpenRegister(): void;                      // table-toolbar「+ 注册标的」
  onOpenEdit(code: string): void;              // 行操作「编辑」
  onDisable(code: string): void;               // 行操作「停用」：PATCH {enabled:false}（仅停用，无物理删除）
  onSubmitForm(mode: FormMode, values: SymbolFormValues): void;  // 注册 POST / 编辑 PATCH
  onCloseForm(): void;
}

/** 表单值（注册/编辑共用；编辑时 code 只读） */
export interface SymbolFormValues {
  code: string;                    // 6 位数字；市场前缀校验；北交所拒绝
  intervalSec: number;             // ≥ SYMBOLS_DEFAULTS.minIntervalSec，热生效
  settlement: Settlement;          // ⚠️ 修改需二次确认（回测/交易撮合规则输入）
  enabled: boolean;
  name: string;                    // 注册时服务端反查，失败留空可手工改
}

export function SymbolsGrid(props: SymbolsGridProps) {
  return (
    <div data-region="symbols" className="flex min-w-[1280px] flex-1 flex-col">

      {/* table-toolbar：静态控件无三态；注册入口 + 标的计数 */}
      <div data-region="table-toolbar" className="flex h-12 items-center border-b px-4">
        {/* <RegisterButton onOpenRegister/> */}
      </div>

      {/* symbol-table：GET /api/symbols?with_stats=1；
          三态=骨架行/「未注册标的」空态+注册引导/错误条+重试；停用行置灰 */}
      <div data-region="symbol-table" className="flex-1">
        {/* <SymbolTable onOpenEdit onDisable/>（操作列：编辑/停用） */}
      </div>

      {props.formMode && (
        /* form-dialog：注册 POST /api/symbols（服务端反查名称）/ 编辑 PATCH /api/symbols/{code}；
            三态=提交中禁用+spinner/不可能空/校验内联+提交错误提示；
            settlement 修改二次确认；code 编辑态只读；遮罩点击不关闭 */
        <div data-region="form-dialog" className="fixed inset-0 flex items-center justify-center">
          {/* <SymbolFormDialog mode editingCode values onSubmitForm onCloseForm/> W=480 */}
        </div>
      )}
    </div>
  );
}
```

## 2. 列表

表格列：code、名称、当前抓取间隔、启用状态、今日已采 bar 数、最新 bar 时刻、操作（编辑/停用）。
- **名称自动反查**：注册时从行情源反查一次名称（快照接口 name 字段），失败留空、可手工修改

## 3. 注册 / 编辑

- 注册表单字段：code、间隔秒数（默认 60，下限 60）、**交收规则 T+0/T+1（默认按分类规则预填：跨境/债券/商品/货币→T0，股票型→T1，人工确认可改）**、启用开关（默认开）
- code 校验：6 位数字；市场规则 5/6/9→沪、0/1/2/3→深；北交所前缀（4/8/920）拒绝并明确提示「暂不支持」
- **间隔修改热生效**：写 symbols 表后下一采集周期即按新间隔调度，无需重启
- 编辑：间隔、启用状态、名称、**settlement** 可改；code 主键不可改（改 code = 停用旧的 + 注册新的）
- ⚠️ settlement 是回测/交易的撮合规则输入：T+1 当日买不可当日卖，T+0 可日内回转——改错会直接污染回测结论，修改需二次确认

## 4. 删除语义

- **仅停用**（enabled=false，保留全部历史数据）；UI 不提供物理删除入口
- 物理删除仅限 DBA 手工 SQL，不在产品功能内

## 5. 批量操作

- 不做批量导入（标的数量小，逐个注册即可）

## 6. API 依赖

| 用途 | 接口 |
|---|---|
| 列表（含今日 bar 数/最新时刻） | `GET /api/symbols?with_stats=1` |
| 注册（服务端反查名称） | `POST /api/symbols` |
| 编辑（间隔/启停/名称，热生效） | `PATCH /api/symbols/{code}` |
| 停用 | `PATCH /api/symbols/{code} {enabled:false}` |

## 7. 验收（Wave 1）

- [ ] 注册 600519 成功（沪）、830799 被拒并提示北交所不支持
- [ ] 间隔 60→300 保存后，下周期采集间隔实测变为 5 分钟
- [ ] 停用后采集停止、历史数据仍在、行情看板可查历史
