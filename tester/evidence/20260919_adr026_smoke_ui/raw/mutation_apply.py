#!/usr/bin/env python3
"""ADR-026 UI E2E 变异反证 —— 对 ui_e2e.mjs **原位**施加 3 处突变（随后必须逐字节还原）。

用法：python3 mutation_apply.py <path/to/ui_e2e.mjs>
突变内容：
  M1 拦截所有 `**/audit*` 请求（审计事实源缺失）⇒ 证明 A05/A06/A07/A08 断言非恒真
  M2 把「来源列允许集」改成仅 ['正常']（本条 run 实际为「期末强平」）⇒ 证明 A10 非恒真
  M3 把强红后会被带崩的读取改为软失败（.catch）⇒ 让一次运行能吐全红清单（不改断言语义）
"""
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

# ---- M1：拦截 /audit
anchor = "page.on('request', (r) => reqStarts.set(r, Date.now()));"
assert anchor in s, 'M1 anchor missing'
s = s.replace(anchor, anchor + "\nawait page.route('**/audit*', (route) => route.abort('failed'));")

# ---- M2：错误的来源列期望
old = "const allowed = ['正常', '止损', '期末强平'];"
assert old in s, 'M2 anchor missing'
s = s.replace(old, "const allowed = ['正常'];")

# ---- M3：软失败读取（仅为让红清单打印完整）
reps = [
    ("await page.locator('[data-testid=\"wb-audit-cash\"]').innerText();",
     "await page.locator('[data-testid=\"wb-audit-cash\"]').innerText().catch(() => '<<absent>>');"),
    ("const histAuditText = histAuditVisible ? await histAudit.innerText()",
     "const histAuditText = histAuditVisible ? await histAudit.innerText().catch(() => '<<absent>>')"),
    ("check('A05', '交易明细 Tab 出「审计摘要行」（wb-audit-summary）', await auditSummary.isVisible(), `text=\"${(await auditSummary.innerText()).replace(/\\n/g, ' / ')}\"`);",
     "const auditVisible = await auditSummary.isVisible().catch(() => false);\nconst auditTxt = auditVisible ? await auditSummary.innerText().catch(() => '<<unreadable>>') : '<<not rendered>>';\ncheck('A05', '交易明细 Tab 出「审计摘要行」（wb-audit-summary）', auditVisible, `text=\"${auditTxt.replace(/\\n/g, ' / ')}\"`);"),
]
for a, b in reps:
    assert a in s, f'M3 anchor missing: {a[:60]}'
    s = s.replace(a, b)

open(p, 'w', encoding='utf-8').write(s)
print('mutation applied to', p)
