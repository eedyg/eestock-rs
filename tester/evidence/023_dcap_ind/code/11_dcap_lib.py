"""车道 A（dcap 指标本身）统计工具库 —— 纯 numpy + 标准库（无 scipy/pandas）。

口径守卫（03-test-plan §3.2）：本模块**不含任何 dcap 公式**；所有 dcap 数值都从
`/tmp/dcap_ind_out/run*/<etf>_<freq>_dcap.f64bin` 读入，而该二进制由 rquickjs 求值产物
`crates/strategy-core/reference-plugins/dcap.js` 的 CORE 产出（见 dcap_ind_probe.rs）。
本模块只做统计（秩相关 / 分位 / ACF / IC / 回归 / 检验）。

诚实性：NaN/缺值一律显式 mask；样本不足时返回 nan 并在报告中标注「证据不足」。
"""

import json
import math
import os
from dataclasses import dataclass

import numpy as np

DATA_DIRS = ["/tmp/dcap_ind_data"]
RUNS = {"run1": "/tmp/dcap_ind_out/run1", "run2": "/tmp/dcap_ind_out/run2"}
ETFS = ["510050", "510880", "512800", "512480", "513050", "518880", "159985"]
H_LIST = [1, 2, 4, 8, 16, 32]
M_MAIN = 3  # 主分析平滑周期（生产默认 m=3）


# ── 数据装载 ────────────────────────────────────────────────────────────────

@dataclass
class Panel:
    etf: str
    freq: str
    dates: list
    closes: np.ndarray            # (T,)
    cfg_ids: list                 # 列名（= 配置 id）
    cfgs: list                    # [{n,r,m,...}]
    X: np.ndarray                 # (T, C)  f64；null → NaN
    meta: dict

    def col(self, n, r, m):
        cid = f"n{fmt_num(n)}_r{fmt_num(r)}_m{fmt_num(m)}"
        try:
            return self.X[:, self.cfg_ids.index(cid)]
        except ValueError:
            raise KeyError(f"{self.etf}/{self.freq} 无配置 {cid}")


def fmt_num(v):
    v = float(v)
    return str(int(v)) if v == int(v) else str(v)


def load_panel(etf, freq, run="run1"):
    d = RUNS[run]
    meta_path = os.path.join(d, f"meta_{etf}_{freq}.json")
    with open(meta_path, encoding="utf-8") as fh:
        meta = json.load(fh)
    rows, cols = meta["rows"], meta["cols"]
    X = np.fromfile(os.path.join(d, f"{etf}_{freq}_dcap.f64bin"), dtype="<f8")
    assert X.size == rows * cols, f"{etf}_{freq} bin 尺寸 {X.size} != {rows}x{cols}"
    X = X.reshape(rows, cols).copy()
    bars = os.path.join(d, f"{etf}_{freq}_bars.csv")
    dates, closes = [], []
    with open(bars, encoding="utf-8") as fh:
        next(fh)
        for line in fh:
            line = line.strip()
            if not line:
                continue
            a, b = line.split(",")
            dates.append(a)
            closes.append(float(b))
    closes = np.array(closes, float)
    assert closes.size == rows, f"{etf}_{freq} bars {closes.size} != {rows}"
    cfgs = [{k: c[k] for k in ("id", "n", "r", "m")} for c in meta["grid"]]
    return Panel(etf, freq, dates, closes, [c["id"] for c in cfgs], cfgs, X, meta)


def load_all(freq, run="run1"):
    return [load_panel(e, freq, run) for e in ETFS]


def cfg_pairs():
    """主网格 63 组合（n × r × m）。"""
    ns = [8.0, 26.0, 60.0]
    rs = [0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0]
    ms = [1.0, 3.0, 5.0]
    return [(n, r, m) for n in ns for r in rs for m in ms]


def cbars(freq="d1"):
    ns = [8.0, 26.0, 60.0]
    rs = [0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0]
    ms = [1.0, 3.0, 5.0]
    for n in ns:
        for r in rs:
            for m in ms:
                yield (n, r, m)


# ── 秩与相关 ────────────────────────────────────────────────────────────────

def rankdata(x):
    """平均秩（tie 取均值）。输入须为有限值。"""
    x = np.asarray(x, float)
    u, inv, cnt = np.unique(x, return_inverse=True, return_counts=True)
    csum = np.cumsum(cnt)
    start = csum - cnt
    avg = (start + csum + 1) / 2.0
    return avg[inv]


def _pearson(a, b):
    a = a - a.mean()
    b = b - b.mean()
    d = math.sqrt(float((a * a).sum()) * float((b * b).sum()))
    if d == 0.0:
        return float("nan")
    return float((a * b).sum()) / d


def spearman(x, y, min_n=10):
    x = np.asarray(x, float)
    y = np.asarray(y, float)
    m = np.isfinite(x) & np.isfinite(y)
    if m.sum() < min_n:
        return float("nan")
    return _pearson(rankdata(x[m]), rankdata(y[m]))


def pearson(x, y, min_n=10):
    x = np.asarray(x, float)
    y = np.asarray(y, float)
    m = np.isfinite(x) & np.isfinite(y)
    if m.sum() < min_n:
        return float("nan")
    return _pearson(x[m], y[m])


def safe_spearman_full(x, y, min_n=10):
    """x、y 为对齐数组；返回 (rho, n_有效)。min_n 为最小样本（横截面 IC 用 4）。"""
    x = np.asarray(x, float)
    y = np.asarray(y, float)
    m = np.isfinite(x) & np.isfinite(y)
    if m.sum() < min_n:
        return float("nan"), int(m.sum())
    return _pearson(rankdata(x[m]), rankdata(y[m])), int(m.sum())


# ── 分布 / 序列性质 ────────────────────────────────────────────────────────

def acf1(v):
    v = np.asarray(v, float)
    a, b = v[:-1], v[1:]
    m = np.isfinite(a) & np.isfinite(b)
    x, y = a[m], b[m]
    if x.size < 30:
        return float("nan")
    x = x - x.mean()
    y = y - y.mean()
    d = math.sqrt(float((x * x).sum()) * float((y * y).sum()))
    return float((x * y).sum()) / d if d else float("nan")


def half_life(rho):
    """ρ ∈ (0,1) ⇒ 半衰期（bar）；否则 nan（无衰减/反相）。"""
    if not np.isfinite(rho) or rho <= 0.0 or rho >= 1.0:
        return float("nan")
    return -math.log(2.0) / math.log(rho)


def zero_cross_rate(v):
    v = np.asarray(v, float)
    s = np.sign(v)
    m = np.isfinite(s) & (s != 0)
    s = s[m]
    if s.size < 2:
        return float("nan")
    return float((s[1:] != s[:-1]).sum()) / float(s.size - 1)


def effective_lookback(n, r):
    """02-spec §1.3 定义的有效回看（加权平均年龄）：Σ w_k (n−k) / Σ w_k，w_k = r^(k−1)，k=1 最旧。"""
    k = np.arange(1, int(n) + 1, dtype=float)
    age = n - k  # k=n（当前 bar）年龄 0
    w = np.power(r, k - 1)
    return float((w * age).sum() / w.sum())


# ── 未来收益 / IC ──────────────────────────────────────────────────────────

def fwd_return(closes, h):
    c = np.asarray(closes, float)
    T = c.size
    out = np.full(T, np.nan)
    if h < T:
        out[: T - h] = c[h:] / c[: T - h] - 1.0
    return out


def sma(x, n):
    x = np.asarray(x, float)
    out = np.full(x.size, np.nan)
    if n <= x.size:
        cs = np.cumsum(np.insert(x, 0, 0.0))
        out[n - 1 :] = (cs[n:] - cs[:-n]) / n
    return out


def roc(closes, h):
    c = np.asarray(closes, float)
    out = np.full(c.size, np.nan)
    if h < c.size:
        out[h:] = c[h:] / c[: c.size - h] - 1.0
    return out


def t_split(T, frac=0.7):
    cut = int(T * frac)
    idx = np.arange(T)
    return idx < cut, idx >= cut


# ── 回归 / 检验 ────────────────────────────────────────────────────────────

def ols(y, X):
    """最小二乘；返回 beta, resid, XtX_inv。X 含常数列（调用方保证）。"""
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    try:
        XtX_inv = np.linalg.inv(X.T @ X)
    except np.linalg.LinAlgError:
        XtX_inv = np.linalg.pinv(X.T @ X)
    return beta, resid, XtX_inv


def newey_west_t(y, X, lag):
    """OLS + Newey-West (Bartlett) 稳健 t 值；lag=0 退化为普通 OLS。返回 (beta, t, resid)。"""
    beta, resid, XtX_inv = ols(y, X)
    n, k = X.shape
    u = resid[:, None] * X
    S = u.T @ u
    for l in range(1, int(lag) + 1):
        if l >= n:
            break
        w = 1.0 - l / (lag + 1.0)
        G = u[l:].T @ u[:-l]
        S += w * (G + G.T)
    V = XtX_inv @ S @ XtX_inv
    se = np.sqrt(np.maximum(np.diag(V), 0.0))
    with np.errstate(divide="ignore", invalid="ignore"):
        t = np.where(se > 0, beta / se, np.nan)
    return beta, t, resid


def betacf(a, b, x, itmax=200, eps=3e-16):
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < 1e-300:
        d = 1e-300
    d = 1.0 / d
    h = d
    for m in range(1, itmax + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < 1e-300:
            d = 1e-300
        c = 1.0 + aa / c
        if abs(c) < 1e-300:
            c = 1e-300
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < 1e-300:
            d = 1e-300
        c = 1.0 + aa / c
        if abs(c) < 1e-300:
            c = 1e-300
        d = 1.0 / d
        de = d * c
        h *= de
        if abs(de - 1.0) < eps:
            break
    return h


def betai(a, b, x):
    """正则化不完全 Beta I_x(a,b)。"""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    lbeta = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
    front = math.exp(lbeta + a * math.log(x) + b * math.log(1.0 - x))
    if x < (a + 1.0) / (a + b + 2.0):
        return front * betacf(a, b, x) / a
    return 1.0 - front * betacf(b, a, 1.0 - x) / b


def t_two_sided_p(t, df):
    if not np.isfinite(t) or df <= 0:
        return float("nan")
    return float(betai(df / 2.0, 0.5, df / (df + t * t)))


def t_crit_abs(p, df, lo=0.0, hi=200.0):
    """双侧 p 对应的 |t| 临界值（二分）。"""
    for _ in range(200):
        mid = (lo + hi) / 2.0
        if t_two_sided_p(mid, df) > p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def norm_two_sided_p(z):
    if not np.isfinite(z):
        return float("nan")
    return float(math.erfc(abs(z) / math.sqrt(2.0)))


def fisher_z_mean(rs):
    """相关系数的 Fisher-z 平均（对 rho=±1 做裁剪）。"""
    rs = np.asarray([r for r in rs if np.isfinite(r)], float)
    if rs.size == 0:
        return float("nan")
    rs = np.clip(rs, -0.999999, 0.999999)
    return float(np.tanh(np.mean(np.arctanh(rs))))


def bh_fdr(pvals, q=0.05):
    """Benjamini-Hochberg：返回 (是否拒绝数组, 阈值p, 排名)。pvals 中的 nan 视为不拒绝。"""
    p = np.asarray(pvals, float)
    ok = np.isfinite(p)
    idx = np.flatnonzero(ok)
    order = idx[np.argsort(p[idx])]
    m = idx.size
    rej = np.zeros(p.size, bool)
    thr = float("nan")
    if m == 0:
        return rej, thr, np.full(p.size, np.nan)
    crit = q * (np.arange(1, m + 1) / m)
    passed = p[order] <= crit
    if passed.any():
        kmax = np.max(np.flatnonzero(passed))
        thr = float(crit[kmax])
        rej[order[: kmax + 1]] = True
    ranks = np.full(p.size, np.nan)
    ranks[order] = np.arange(1, m + 1)
    return rej, thr, ranks


def boot_ci_mean(x, n_boot=2000, alpha=0.05, seed=20260913):
    x = np.asarray([v for v in x if np.isfinite(v)], float)
    if x.size < 3:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    s = np.array([rng.choice(x, size=x.size, replace=True).mean() for _ in range(n_boot)])
    return (float(np.quantile(s, alpha / 2)), float(np.quantile(s, 1 - alpha / 2)))


# ── 输出 ───────────────────────────────────────────────────────────────────

def fmt(v, nd=4):
    if v is None:
        return "n/a"
    v = float(v)
    if not np.isfinite(v):
        return "n/a"
    return f"{v:+.{nd}f}" if abs(v) < 1e6 else f"{v:.{nd}g}"


def fmt0(v, nd=4):
    if v is None:
        return "n/a"
    v = float(v)
    if not np.isfinite(v):
        return "n/a"
    return f"{v:.{nd}f}"


def table(rows, header):
    out = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)
