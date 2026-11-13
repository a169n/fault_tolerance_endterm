"""Build the compact endterm report. From the repo root:
    python3 -I reports/endterm/compact/build.py . /tmp/report.html
    node reports/endterm/compact/render.cjs /tmp/report.html reports/endterm/REPORT-compact.pdf
Numbers come from reports/endterm/results.csv; edit template.html for the text."""
import csv
import sys
from pathlib import Path

REPO = Path(sys.argv[1]).resolve()
OUT = Path(sys.argv[2])
rows = list(csv.DictReader(open(REPO / "reports/endterm/results.csv")))
R = {(r["scenario"], r["mode"]): r for r in rows}
MODES = ["baseline", "midterm", "endterm"]
SC = [
    ("E1", "app-crash", "Service process crashes", "student-1 kills itself (/chaos/crash)", "fault"),
    ("E2", "db-failure", "Primary database down", "docker compose stop postgres-primary", "fault"),
    ("E3", "net-timeout", "One replica becomes slow", "+3 000 ms latency on student-1", "fault"),
    ("E4", "node-failure", "A whole node dies", "kill student-1 and payment-1 together", "fault"),
    ("E5", "txn-interrupt", "Payment interrupted mid-way", "both payment replicas crash after the checkpoint", "fault"),
    ("E6", "high-load", "Load spike", "+100 concurrent clients (10 to 110)", "fault"),
    ("E7", "gateway-failure", "One gateway dies", "docker compose kill gateway-1", "fault"),
    ("E8", "error-spike", "Error spike (alert test)", "failRate 1.0 on both student and both payment replicas", "monitoring"),
    ("E9", "unauthorized-access", "Unauthorized access", "63 attacks in 7 kinds: no / forged / expired / alg:none token; student pays for another, creates a student, lists all", "security"),
    ("E10", "abuse", "Abuse and malformed input", "203 malformed bodies, request flood, 50 bad logins", "security"),
]


def g(s, m, k):
    return R[(s, m)][k]


def num(s, m, k):
    v = g(s, m, k)
    return float(v) if v not in ("", None) else None


def pct(v, d=2):
    return f"{v * 100:.{d}f} %"


def verdict(s, m):
    v = g(s, m, "verdict")
    ok = v.startswith("PASS")
    k = g(s, m, "reps_all_passed")
    n = g(s, m, "n")
    return f'<span class="chip {"pass" if ok else "fail"}">{"PASS" if ok else "FAIL"} {k}/{n}</span>'


passed = {m: sum(g(s, m, "verdict").startswith("PASS") for _, s, *_ in SC) for m in MODES}
dups = {m: sum(int(float(g(s, m, "duplicates") or 0)) for _, s, *_ in SC) for m in MODES}
lost = {m: sum(int(float(g(s, m, "lost") or 0)) for _, s, *_ in SC) for m in MODES}

# ---------- charts (inline SVG, drawn to one scale each) ----------
COL = {"baseline": "var(--c-base)", "midterm": "var(--c-mid)", "endterm": "var(--c-end)"}


def grouped_bars(items, key, lo, hi, fmt, title, ticks, unit_note):
    W, H, L, B, T = 680, 200, 40, 30, 10
    plot_w, plot_h = W - L - 10, H - B - T
    gw = plot_w / len(items)
    bw = (gw - 18) / 3
    y = lambda v: T + plot_h - (max(lo, min(hi, v)) - lo) / (hi - lo) * plot_h
    out = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="{title}">']
    for t in ticks:
        out.append(f'<line x1="{L}" x2="{W-10}" y1="{y(t):.1f}" y2="{y(t):.1f}" class="grid"/>'
                   f'<text x="{L-6}" y="{y(t)+3.5:.1f}" class="tick" text-anchor="end">{fmt(t)}</text>')
    for i, (code, s) in enumerate(items):
        x0 = L + i * gw + 9
        for j, m in enumerate(MODES):
            v = num(s, m, key)
            x = x0 + j * bw
            out.append(f'<rect x="{x:.1f}" y="{y(v):.1f}" width="{bw-2:.1f}" height="{T+plot_h-y(v):.1f}" fill="{COL[m]}"/>')
        out.append(f'<text x="{x0 + 1.5*bw:.1f}" y="{H-B+16}" class="lab" text-anchor="middle">{code}</text>')
    out.append(f'<line x1="{L}" x2="{W-10}" y1="{T+plot_h}" y2="{T+plot_h}" class="axis"/>')
    out.append(f'<text x="{L}" y="{H-2}" class="tick">{unit_note}</text></svg>')
    return "\n".join(out)


avail_items = [("E1", "app-crash"), ("E4", "node-failure"), ("E5", "txn-interrupt"), ("E7", "gateway-failure"), ("E8", "error-spike")]
chart_avail = grouped_bars(avail_items, "availability_request_mean", 0.6, 1.0, lambda t: f"{t*100:.0f}%",
                           "Request availability", [0.6, 0.7, 0.8, 0.9, 1.0],
                           "Successful requests / all requests, mean of 3 runs (axis starts at 60 %)")


def ratio_chart():
    s = "net-timeout"
    W, H, L, T = 680, 118, 70, 8
    bar_h, gap = 22, 10
    sx = lambda v: L + v * (W - L - 190)
    out = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="E3 goodput ratio">']
    for t in [0, 0.25, 0.5, 0.75, 1.0]:
        out.append(f'<line x1="{sx(t):.1f}" x2="{sx(t):.1f}" y1="{T}" y2="{T+3*(bar_h+gap)-gap}" class="grid"/>'
                   f'<text x="{sx(t):.1f}" y="{H-2}" class="tick" text-anchor="middle">{t:.2f}</text>')
    for i, m in enumerate(MODES):
        pre, dur = num(s, m, "pre_fault_rps_mean"), num(s, m, "during_fault_rps_mean")
        r = dur / pre
        yy = T + i * (bar_h + gap)
        out.append(f'<text x="{L-8}" y="{yy+15}" class="lab" text-anchor="end">{m}</text>'
                   f'<rect x="{L}" y="{yy}" width="{sx(r)-L:.1f}" height="{bar_h}" fill="{COL[m]}"/>'
                   f'<text x="{sx(r)+6:.1f}" y="{yy+15}" class="val">{r:.2f}  ({dur:.1f} of {pre:.1f} req/s)</text>')
    out.append(f'<line x1="{sx(0.7):.1f}" x2="{sx(0.7):.1f}" y1="{T-4}" y2="{T+3*(bar_h+gap)-gap+4}" class="thr"/>'
               f'<text x="{sx(0.7)+5:.1f}" y="{T+14}" class="thrlab">target 0.70</text></svg>')
    return "\n".join(out)


chart_ratio = ratio_chart()

# ---------- tables ----------
matrix = "\n".join(
    f'<tr><td class="code">{c}</td><td>{name}</td><td class="kind">{kind}</td>'
    + "".join(f"<td>{verdict(s, m)}</td>" for m in MODES) + "</tr>"
    for c, s, name, _, kind in SC)

scen_table = "\n".join(
    f'<tr><td class="code">{c}</td><td>{name}</td><td class="small">{inj}</td></tr>' for c, s, name, inj, _ in SC)

key_rows = []
for c, s, name, _, _ in SC:
    if s in ("abuse", "unauthorized-access"):
        continue
    cells = "".join(f'<td class="num">{pct(num(s, m, "availability_request_mean"), 2)}</td>' for m in MODES)
    cells += "".join(f'<td class="num">{num(s, m, "p95_ms_mean"):.0f}</td>' for m in MODES)
    cells += "".join(f'<td class="num">{int(float(g(s, m, "duplicates") or 0))}</td>' for m in MODES)
    key_rows.append(f'<tr><td class="code">{c}</td>{cells}</tr>')
key_table = "\n".join(key_rows)

e3 = {m: (num("net-timeout", m, "during_fault_rps_mean"), num("net-timeout", m, "pre_fault_rps_mean")) for m in MODES}
e7a = {m: num("gateway-failure", m, "availability_request_mean") for m in MODES}
e6p95 = {m: num("high-load", m, "p95_ms_mean") for m in MODES}
e6rps = {m: num("high-load", m, "during_fault_rps_mean") for m in MODES}
e2rps = {m: num("db-failure", m, "during_fault_rps_mean") for m in MODES}
e2a = {m: num("db-failure", m, "availability_request_mean") for m in MODES}
dbdown = g("db-failure", "endterm", "alerts_detection_mean_ms")


def alert_ms(s, m, name):
    for part in g(s, m, "alerts_detection_mean_ms").split(";"):
        if part.startswith(name + ":"):
            return float(part.split(":")[1]) / 1000
    return None


det = {
    "DatabaseDown (E2)": alert_ms("db-failure", "endterm", "DatabaseDown"),
    "InstanceDown (E4)": alert_ms("node-failure", "endterm", "InstanceDown"),
    "InstanceDown (E7)": alert_ms("gateway-failure", "endterm", "InstanceDown"),
    "HighErrorRate (E8)": alert_ms("error-spike", "endterm", "HighErrorRate"),
    "AuthFailureSpike (E9)": alert_ms("unauthorized-access", "endterm", "AuthFailureSpike"),
    "AuthFailureSpike (E10)": alert_ms("abuse", "endterm", "AuthFailureSpike"),
}
det_rows = "".join(f'<tr><td>{k}</td><td class="num">{v:.1f} s</td></tr>' for k, v in det.items())

html = (Path(__file__).parent / "template.html").read_text()
subs = {
    "MATRIX": matrix, "SCEN_TABLE": scen_table, "KEY_TABLE": key_table,
    "CHART_AVAIL": chart_avail, "CHART_RATIO": chart_ratio, "DET_ROWS": det_rows,
    "P_BASE": str(passed["baseline"]), "P_MID": str(passed["midterm"]), "P_END": str(passed["endterm"]),
    "DUP_BASE": f"{dups['baseline']:,}".replace(",", " "), "DUP_MID": str(dups["midterm"]), "DUP_END": str(dups["endterm"]),
    "LOST_ALL": str(sum(lost.values())), "MIDEND_BAD": str(dups["midterm"]+dups["endterm"]+lost["midterm"]+lost["endterm"]), "MIDEND_DUP": str(dups["midterm"]+dups["endterm"]),
    "E7_BASE": pct(e7a["baseline"]), "E7_MID": pct(e7a["midterm"]), "E7_END": pct(e7a["endterm"]),
    "E3_BASE": f"{e3['baseline'][0]/e3['baseline'][1]:.2f}", "E3_MID": f"{e3['midterm'][0]/e3['midterm'][1]:.2f}",
    "E3_END": f"{e3['endterm'][0]/e3['endterm'][1]:.2f}",
    "E6_P95_BASE": f"{e6p95['baseline']:.0f}", "E6_P95_MID": f"{e6p95['midterm']:.0f}", "E6_P95_END": f"{e6p95['endterm']:.0f}",
    "E6_RPS_BASE": f"{e6rps['baseline']:.1f}", "E6_RPS_MID": f"{e6rps['midterm']:.1f}", "E6_RPS_END": f"{e6rps['endterm']:.1f}",
    "E2_RPS_BASE": f"{e2rps['baseline']:.1f}", "E2_RPS_END": f"{e2rps['endterm']:.1f}",
    "E2_A_BASE": pct(e2a["baseline"]), "E2_A_END": pct(e2a["endterm"]),
    "FIG_DB": (REPO / "reports/endterm/figures/db-failure__endterm__r1.png").as_uri(),
}
for k, v in subs.items():
    html = html.replace("{{" + k + "}}", v)
assert "{{" not in html, html[html.index("{{"):html.index("{{") + 40]
OUT.write_text(html)
print("passed", passed, "dups", dups, "lost", lost)
