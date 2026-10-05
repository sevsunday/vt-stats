#!/usr/bin/env python3
"""Archive every source cited by the ELO critique into critique/publications/.

Standalone operator tool — NOT invoked by scripts/process_stats.py and not part
of the pipeline cache key (same posture as scripts/import_f9_ledger.py).

Input:  critique/publications/sources.json   (hand-authored; one entry per
        citation in critique/elo-analysis-v4.md Part IX)
Output: critique/publications/NN[key]-<slug>.<ext>   one local copy per item
        critique/publications/manifest.json           what was fetched, from
                                                      where, when, sha256, bytes

For each item the candidates are tried in order; the first one that yields a
valid file wins:
  * "download"  — fetched as-is; accepted when the body is a PDF (or, with
                  "accept": "txt", any non-trivial text response).
  * "print"     — the page is rendered to PDF with headless Microsoft Edge.
                  The DOM is dumped first and rejected when it is a bot
                  challenge / error page, so a "Just a moment..." interstitial
                  never becomes the archived copy.
Entries with a DOI also get Unpaywall's open-access PDF locations appended as
candidates (legitimate author / repository copies only — no shadow libraries).

Idempotent: an item whose file exists and matches its manifest sha256 is skipped
unless --force. Re-run when a later edition adds sources.

Usage (from repo root):
  python scripts/archive_sources.py                  # everything
  python scripts/archive_sources.py --only 33 66 68  # a few entries
  python scripts/archive_sources.py --dry-run        # plan only
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PUB_DIR = REPO_ROOT / "critique" / "publications"
SOURCES_PATH = PUB_DIR / "sources.json"
MANIFEST_PATH = PUB_DIR / "manifest.json"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0"
)
EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
UNPAYWALL_EMAIL = "vt-stats-archive@vtstats.bz"
MIN_PDF_BYTES = 10_000
MIN_TXT_BYTES = 500
FETCH_TIMEOUT_SEC = 60
EDGE_TIMEOUT_SEC = 150
POLITE_DELAY_SEC = 0.6

# Rendered-DOM markers that mean "this is not the page" (bot walls, errors).
BAD_DOM_MARKERS = (
    "just a moment...",
    "checking your browser",
    "verify you are human",
    "access denied",
    "attention required! | cloudflare",
    "page not found",
    "404 not found",
    "this page isn't working",
    "err_name_not_resolved",
    "err_connection",
)


# ----------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------
def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def http_get(url: str, timeout: int = FETCH_TIMEOUT_SEC, accept: str = "*/*") -> tuple[int, bytes, str]:
    """GET with a browser UA. Returns (status, body, final_url). Never raises for HTTP errors."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), resp.geturl()
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read()
        except Exception:  # noqa: BLE001
            body = b""
        return exc.code, body, url
    except Exception as exc:  # noqa: BLE001 — network errors are data here
        return 0, str(exc).encode("utf-8", "replace"), url


def find_edge(explicit: str | None) -> str | None:
    if explicit:
        return explicit if Path(explicit).exists() else None
    for cand in EDGE_CANDIDATES:
        if Path(cand).exists():
            return cand
    return None


def run_edge(edge: str, profile_root: Path, url: str, extra: list[str], timeout: int = EDGE_TIMEOUT_SEC) -> subprocess.CompletedProcess:
    """Run one headless Edge command against a FRESH profile directory.

    Chromium is a per-profile singleton: if a process holding the same
    --user-data-dir is still winding down, a new invocation hands the URL to it
    and exits immediately with empty output. A throw-away profile per call makes
    every --dump-dom / --print-to-pdf independent.
    """
    profile_dir = Path(tempfile.mkdtemp(prefix="edge-", dir=profile_root))
    cmd = [
        edge,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--hide-scrollbars",
        f"--user-data-dir={profile_dir}",
        f"--user-agent={USER_AGENT}",
        "--virtual-time-budget=20000",
        *extra,
        url,
    ]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
    finally:
        shutil.rmtree(profile_dir, ignore_errors=True)


def dom_looks_bad(dom: str) -> str | None:
    low = dom.lower()
    for marker in BAD_DOM_MARKERS:
        if marker in low[:20000] or marker in low[-20000:]:
            return marker
    body_text = re.sub(r"<[^>]+>", " ", low)
    if len(body_text.split()) < 40:
        return "too little text"
    return None


def unpaywall_pdf_urls(doi: str, email: str) -> list[str]:
    url = f"https://api.unpaywall.org/v2/{urllib.parse.quote(doi, safe='/()<>:;-')}?email={urllib.parse.quote(email)}"
    status, body, _ = http_get(url, timeout=30, accept="application/json")
    if status != 200:
        return []
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        return []
    urls: list[str] = []
    best = data.get("best_oa_location") or {}
    for loc in [best, *(data.get("oa_locations") or [])]:
        for key in ("url_for_pdf", "url"):
            u = loc.get(key)
            if u and u not in urls:
                urls.append(u)
    return urls


def item_id(n: int, key: str) -> str:
    return f"{n:02d}{key}"


def target_name(n: int, key: str, slug: str, ext: str) -> str:
    return f"{item_id(n, key)}-{slug}.{ext}"


# ----------------------------------------------------------------------------
# fetch strategies
# ----------------------------------------------------------------------------
def curl_get(url: str, timeout: int = 90) -> tuple[int, bytes, str]:
    """Fallback fetch through the system curl (schannel trust store, different TLS
    fingerprint) for hosts that reject urllib with 403 / certificate errors."""
    curl = shutil.which("curl.exe") or shutil.which("curl")
    if not curl:
        return 0, b"", url
    with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as tmp:
        tmp_path = Path(tmp.name)
    try:
        proc = subprocess.run(
            [curl, "-sSL", "-A", USER_AGENT, "--max-time", str(timeout), "-o", str(tmp_path),
             "-w", "%{http_code} %{url_effective}", url],
            capture_output=True, text=True, timeout=timeout + 15)
        parts = (proc.stdout or "").strip().split(" ", 1)
        status = int(parts[0]) if parts and parts[0].isdigit() else 0
        final_url = parts[1] if len(parts) > 1 else url
        body = tmp_path.read_bytes() if tmp_path.exists() else b""
        return status, body, final_url
    except (subprocess.TimeoutExpired, ValueError):
        return 0, b"", url
    finally:
        tmp_path.unlink(missing_ok=True)


def try_download(cand: dict, dest: Path) -> dict | None:
    url = cand["url"]
    accept_txt = cand.get("accept") == "txt"
    status, body, final_url = http_get(url, accept="application/pdf,*/*;q=0.8")
    for attempt in range(3):  # Wayback and a few publishers rate-limit: back off and retry
        if status != 429:
            break
        time.sleep(10 * (attempt + 1))
        status, body, final_url = http_get(url, accept="application/pdf,*/*;q=0.8")
    if status in (0, 403) or (status == 200 and not accept_txt and not body.lstrip().startswith(b"%PDF")):
        c_status, c_body, c_final = curl_get(url)
        if c_status == 200 and c_body and (accept_txt or c_body.lstrip().startswith(b"%PDF")):
            status, body, final_url = c_status, c_body, c_final
    if status != 200 or not body:
        return {"ok": False, "url": url, "http_status": status, "reason": f"status {status}"}
    if accept_txt:
        if len(body) < MIN_TXT_BYTES or body.lstrip().startswith(b"<"):
            return {"ok": False, "url": url, "http_status": status, "reason": "not a text document"}
    elif not body.lstrip().startswith(b"%PDF"):
        return {"ok": False, "url": url, "http_status": status, "reason": "not a PDF"}
    elif len(body) < MIN_PDF_BYTES:
        return {"ok": False, "url": url, "http_status": status, "reason": f"PDF too small ({len(body)} bytes)"}
    dest.write_bytes(body)
    return {"ok": True, "url": url, "final_url": final_url, "http_status": status, "method": "download"}


def try_print(cand: dict, dest: Path, edge: str, profile_dir: Path) -> dict | None:
    url = cand["url"]
    http_status = None
    if cand.get("check", True):
        http_status, _, _ = http_get(url, timeout=30, accept="text/html,*/*;q=0.8")
        if http_status in (404, 410) or http_status == 0:
            return {"ok": False, "url": url, "http_status": http_status, "reason": f"pre-check status {http_status}"}
    # 1. rendered DOM sanity check (bot walls / error pages must not be archived)
    try:
        dom_proc = run_edge(edge, profile_dir, url, ["--dump-dom"])
    except subprocess.TimeoutExpired:
        return {"ok": False, "url": url, "http_status": http_status, "reason": "dump-dom timeout"}
    dom = dom_proc.stdout or ""
    bad = dom_looks_bad(dom)
    if bad:
        return {"ok": False, "url": url, "http_status": http_status, "reason": f"rendered page rejected ({bad})"}
    title_match = re.search(r"<title[^>]*>(.*?)</title>", dom, re.I | re.S)
    title = re.sub(r"\s+", " ", title_match.group(1)).strip() if title_match else ""
    # 2. print
    if dest.exists():
        dest.unlink()
    try:
        run_edge(edge, profile_dir, url, [f"--print-to-pdf={dest}", "--print-to-pdf-no-header"])
    except subprocess.TimeoutExpired:
        return {"ok": False, "url": url, "http_status": http_status, "reason": "print timeout"}
    if not dest.exists():
        return {"ok": False, "url": url, "http_status": http_status, "reason": "no PDF produced"}
    head = dest.read_bytes()[:5]
    size = dest.stat().st_size
    if not head.startswith(b"%PDF") or size < MIN_PDF_BYTES:
        dest.unlink(missing_ok=True)
        return {"ok": False, "url": url, "http_status": http_status, "reason": f"bad PDF ({size} bytes)"}
    return {"ok": True, "url": url, "http_status": http_status, "method": "print", "page_title": title}


def try_print_static(cand: dict, dest: Path, edge: str, profile_root: Path) -> dict | None:
    """Fetch the HTML ourselves, strip scripts (and a Wayback toolbar if present),
    then print the static document from disk. For pages whose live copy sits
    behind a bot wall but whose archived HTML is reachable: the archive's
    replay scripts otherwise navigate away before Edge can print."""
    url = cand["url"]
    status, body, final_url = http_get(url, timeout=120, accept="text/html,*/*;q=0.8")
    if status in (0, 403, 429) or not body:
        status, body, final_url = curl_get(url, timeout=120)
    if status != 200 or not body:
        return {"ok": False, "url": url, "http_status": status, "reason": f"status {status}"}
    cleaned = re.sub(rb"<script\b.*?</script>", b"", body, flags=re.S | re.I)
    cleaned = re.sub(rb"<!-- BEGIN WAYBACK TOOLBAR INSERT -->.*?<!-- END WAYBACK TOOLBAR INSERT -->", b"", cleaned, flags=re.S)
    text = re.sub(rb"<[^>]+>", b" ", cleaned)
    if len(text.split()) < 40:
        return {"ok": False, "url": url, "http_status": status, "reason": "too little text"}
    title_match = re.search(rb"<title[^>]*>(.*?)</title>", cleaned, re.I | re.S)
    title = re.sub(r"\s+", " ", title_match.group(1).decode("utf-8", "replace")).strip() if title_match else ""
    with tempfile.NamedTemporaryFile(delete=False, suffix=".html") as tmp:
        tmp.write(cleaned)
        tmp_path = Path(tmp.name)
    try:
        if dest.exists():
            dest.unlink()
        run_edge(edge, profile_root, tmp_path.as_uri(), [f"--print-to-pdf={dest}", "--print-to-pdf-no-header"])
    except subprocess.TimeoutExpired:
        return {"ok": False, "url": url, "http_status": status, "reason": "print timeout"}
    finally:
        tmp_path.unlink(missing_ok=True)
    if not dest.exists() or dest.stat().st_size < MIN_PDF_BYTES or not dest.read_bytes()[:5].startswith(b"%PDF"):
        dest.unlink(missing_ok=True)
        return {"ok": False, "url": url, "http_status": status, "reason": "bad or no PDF"}
    return {"ok": True, "url": url, "final_url": final_url, "http_status": status, "method": "print-static", "page_title": title}


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
def load_json(path: Path, default):
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="*", type=int, default=None, help="citation numbers to process")
    ap.add_argument("--force", action="store_true", help="refetch even when the manifest hash matches")
    ap.add_argument("--dry-run", action="store_true", help="list what would be fetched")
    ap.add_argument("--edge", default=None, help="path to msedge.exe (auto-detected)")
    ap.add_argument("--unpaywall-email", default=UNPAYWALL_EMAIL)
    ap.add_argument("--no-unpaywall", action="store_true")
    args = ap.parse_args()
    try:  # titles carry en/em dashes; never let the console encoding abort a run
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

    sources = load_json(SOURCES_PATH, None)
    if not sources:
        print(f"missing {SOURCES_PATH}", file=sys.stderr)
        return 2
    manifest = load_json(MANIFEST_PATH, {"schema_version": 1, "items": {}})
    items_out: dict = manifest.setdefault("items", {})

    edge = find_edge(args.edge)
    if not edge:
        print("warning: msedge.exe not found — 'print' candidates will be skipped", file=sys.stderr)

    PUB_DIR.mkdir(parents=True, exist_ok=True)
    profile_dir = Path(tempfile.gettempdir()) / "vt-stats-archive-edge-profile"
    profile_dir.mkdir(exist_ok=True)

    rows: list[tuple[str, str, str]] = []
    wanted = set(args.only) if args.only else None

    for entry in sources["entries"]:
        n = entry["n"]
        if wanted is not None and n not in wanted:
            continue
        slug = entry["slug"]
        kind = entry.get("kind", "document")
        for item in entry["items"]:
            key = item.get("key", "")
            iid = item_id(n, key)
            record = {
                "n": n, "key": key, "slug": slug, "title": entry["title"], "kind": kind,
                "original": item.get("original"), "label": item.get("label"),
            }
            if kind in ("repo", "none", "book"):
                record["file"] = None
                record["local"] = item.get("local", [])
                record["method"] = kind
                items_out[iid] = {**items_out.get(iid, {}), **record}
                rows.append((iid, kind, "—"))
                continue

            candidates = list(item.get("fetch", []))
            ext = "txt" if any(c.get("accept") == "txt" for c in candidates) else "pdf"
            dest = PUB_DIR / target_name(n, key, slug, ext)

            # adopt a previously vendored file under the new name
            existing = item.get("existing_file")
            if existing and not dest.exists() and (PUB_DIR / existing).exists():
                shutil.move(str(PUB_DIR / existing), str(dest))

            prev = items_out.get(iid, {})
            if (not args.force and dest.exists() and prev.get("sha256")
                    and prev.get("file") == dest.name and sha256_of(dest) == prev["sha256"]):
                rows.append((iid, "skip", dest.name))
                continue
            if dest.exists() and not args.force and not prev.get("sha256"):
                # file present (e.g. just adopted) but not yet in the manifest → record it
                items_out[iid] = {**record, "file": dest.name, "method": prev.get("method", "vendored"),
                                  "source_url": prev.get("source_url"), "bytes": dest.stat().st_size,
                                  "sha256": sha256_of(dest), "fetched_at": prev.get("fetched_at") or now_iso()}
                rows.append((iid, "recorded", dest.name))
                continue

            if entry.get("doi") and not args.no_unpaywall:
                for u in unpaywall_pdf_urls(entry["doi"], args.unpaywall_email):
                    if not any(c["url"] == u for c in candidates):
                        candidates.append({"url": u, "method": "download", "via": "unpaywall"})

            if args.dry_run:
                rows.append((iid, "plan", " | ".join(f"{c['method']}:{c['url']}" for c in candidates) or "(no candidates)"))
                continue

            result = None
            attempts = []
            for cand in candidates:
                time.sleep(POLITE_DELAY_SEC)
                if cand["method"] == "download":
                    result = try_download(cand, dest)
                elif cand["method"] in ("print", "print_static"):
                    if not edge:
                        attempts.append({"url": cand["url"], "reason": "no Edge"})
                        continue
                    fn = try_print if cand["method"] == "print" else try_print_static
                    result = fn(cand, dest, edge, profile_dir)
                else:
                    attempts.append({"url": cand.get("url"), "reason": f"unknown method {cand['method']}"})
                    continue
                attempts.append({k: v for k, v in result.items() if k != "ok"})
                if result["ok"]:
                    if cand.get("original_if_used"):
                        record["original"] = cand["url"]
                    if cand.get("via"):
                        result["via"] = cand["via"]
                    break
                result = None

            if result:
                items_out[iid] = {**record, "file": dest.name, "method": result["method"], "via": result.get("via"),
                                  "source_url": result["url"], "final_url": result.get("final_url"),
                                  "page_title": result.get("page_title"), "http_status": result.get("http_status"),
                                  "bytes": dest.stat().st_size, "sha256": sha256_of(dest), "fetched_at": now_iso(),
                                  "attempts": attempts}
                rows.append((iid, result["method"], f"{dest.name} ({dest.stat().st_size:,} B)"))
            else:
                items_out[iid] = {**record, "file": None, "method": None, "attempts": attempts,
                                  "checked_at": now_iso()}
                reasons = "; ".join(a.get("reason", "?") for a in attempts) or "no candidates"
                rows.append((iid, "MISSING", reasons))

            # persist after every item so a crash loses nothing
            manifest["generated_at"] = now_iso()
            manifest["accessed"] = sources.get("accessed")
            with MANIFEST_PATH.open("w", encoding="utf-8") as fh:
                json.dump(manifest, fh, indent=2, ensure_ascii=False)
                fh.write("\n")

    if not args.dry_run:
        manifest["generated_at"] = now_iso()
        manifest["accessed"] = sources.get("accessed")
        with MANIFEST_PATH.open("w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2, ensure_ascii=False)
            fh.write("\n")

    width = max((len(r[0]) for r in rows), default=4)
    for iid, status, detail in rows:
        print(f"{iid:<{width}}  {status:<9} {detail}")
    missing = [r for r in rows if r[1] == "MISSING"]
    print(f"\n{len(rows)} items; {len(missing)} missing")
    return 0


if __name__ == "__main__":
    sys.exit(main())
