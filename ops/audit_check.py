#!/usr/bin/env python3
"""Reads the two audit reports the headless builds left in the page (<pre id="auditOut">) and checks them against the rules.
Prints a uniformity report: for each check, how many passed of how many, and the rate."""
import sys, re, json, html
def load(p):
    d = open(p, encoding='utf-8', errors='replace').read(); m = re.search(r'<pre id="auditOut"[^>]*>(.*?)</pre>', d, re.S)
    if not m: sys.exit(f'audit: no report in {p} (the world did not finish building: raise BUDGET_MS?)')
    return json.loads(html.unescape(m.group(1)))
a, b, rules = load(sys.argv[1]), load(sys.argv[2]), json.load(open(sys.argv[3]))
S, C, fails = a['summary'], a['checked'], []
json.dump(a, open(__file__.replace('audit_check.py', 'last-audit.json'), 'w'), indent=1)   # (the full report, every case, for fixing)
def allowed(name, samples):   # known, accepted exceptions (e.g. airport terminals on their apron)
    al = [tuple(x) for x in rules.get('allow', {}).get(name, [])]
    return [s for s in samples if not any(abs(s[0] - x) <= 3 and abs(s[1] - z) <= 3 for x, z in al)]
counts = dict(S)
for k in ('buildingsOnRoad',): counts[k] = len(allowed(k, a.get(k, [])))   # (the audit lists every case when run for CI)
rows = [
  ('determinism (world fingerprint)', 1 if a['worldHash'] == b['worldHash'] else 0, 1),
  ('buildings clear of roads', C['buildings'] - counts['buildingsOnRoad'], C['buildings']),
  ('walls not across roads', C['buildings'] - S['wallsAcrossRoad'], C['buildings']),
  ('doors clear in front', C['doors'] - S['doorBlocked'], C['doors']),
  ('doors on the ground', C['doors'] - S['doorFloating'], C['doors']),
  ('doors not onto water', C['doors'] - S['doorOnWater'], C['doors']),
  ('entrances reachable', C['entrances'] - S['entranceBlocked'], C['entrances']),
  ('entrances lead to a room', C['entrances'] - S.get('noRoom', 0), C['entrances']),
  ('coming out onto solid ground', C['entrances'] - S.get('exitBad', 0), C['entrances']),
  ('buildings with windows', C['windowed'] - S['noWindows'], C['windowed']),
]
print(f"\n{'check':34} {'passed':>9} {'of':>8} {'rate':>8}")
tp = tn = 0
for name, ok, n in rows:
    r = 100.0 * ok / n if n else 100.0; tp += ok; tn += n; print(f"{name:34} {ok:>9} {n:>8} {r:>7.2f}%")
uni = 100.0 * tp / tn; print(f"{'UNIFORMITY (all checks)':34} {tp:>9} {tn:>8} {uni:>7.3f}%")
print(f"kerb strips fixed: {S['kerbsFixed']}, kerb cells left mid-road: {S['kerbMidRoad']}, houses nudged: {S['nudged']}, skipped: {S['skipped']}")
if a['worldHash'] != b['worldHash']: fails.append(f"not deterministic: {a['worldHash']} vs {b['worldHash']}")
for k, v in rules.get('max', {}).items():
    if counts.get(k, 0) > v: fails.append(f"{k} = {counts.get(k)} (max {v}); e.g. {a.get(k, [])[:5]}")
if uni < rules.get('minUniformity', 99.9): fails.append(f"uniformity {uni:.3f}% < {rules.get('minUniformity')}%")
for k, v in rules.get('min', {}).items():
    if S.get(k, 0) < v: fails.append(f"{k} = {S.get(k)} (min {v})")
if fails: print('\nAUDIT FAILED:\n  ' + '\n  '.join(fails)); sys.exit(1)
print('\nAUDIT PASSED')
