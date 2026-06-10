"""Smoke-verify fable/index.html: asset references resolve, JS-referenced ids exist."""
import os
import re

ROOT = os.path.join(os.path.dirname(__file__), "..")
html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
js = open(os.path.join(ROOT, "js", "fable.js"), encoding="utf-8").read()

refs = re.findall(r'(?:src|href)="([^"]+)"', html)
missing = [
    r for r in refs
    if not r.startswith(("#", "http")) and not os.path.exists(os.path.join(ROOT, r))
]
print("asset refs:", len(refs), "missing:", missing)

ids = set(re.findall(r'getElementById\("([^"]+)"\)', js))
ids |= set(re.findall(r'querySelector\("#([\w-]+)', js))
missing_ids = [i for i in sorted(ids) if f'id="{i}"' not in html]
print("ids checked:", len(ids), "missing:", missing_ids)

externals = [r for r in refs if r.startswith("http")]
print("external requests:", externals)
