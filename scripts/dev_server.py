#!/usr/bin/env python3
"""
VT Stats — local dev server with CORS relay.

Serves the repository as a static site (like `python -m http.server`) AND
exposes a tiny same-origin proxy at `/__proxy?url=<encoded>` that relays GET
requests to an allowlisted set of upstream hosts, returning the body with
`Access-Control-Allow-Origin: *`.

Why: the MultiplayerSessionList API (live lobby data for /gw, the Tools
live-session card, and the topnav Tools pulse) enforces a CORS origin
ALLOWLIST — vtstats.bz is on it, localhost never will be. `js/bz2api.js`
detects localhost contexts and routes MSL through this relay first, so local
development never depends on flaky public CORS proxies. JS never fetches
GameListAssets getdata.php (no CORS); that host stays on the relay allowlist
only for manual `/__proxy` debugging.

Usage:
    python scripts/dev_server.py              # serve repo on :8000
    python scripts/dev_server.py --port 8080

The relay works cross-port too: if you serve the site with another tool
(e.g. VS Code Live Server on :5500), keep this running on :8000 —
`js/bz2api.js` also tries http://localhost:8000/__proxy as a candidate, and
the ACAO:* header makes that cross-origin localhost fetch legal.

Stdlib only. GET and OPTIONS serve the site and the relay. POST
/__topdown/<stem> writes one overhead PNG into data/render/topdown/.
Upstream hosts are allowlisted below.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

PROXY_PATH = "/__proxy"
TOPDOWN_PREFIX = "/__topdown/"
TOPDOWN_DIR = REPO_ROOT / "data" / "render" / "topdown"
TOPDOWN_STEM_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
TOPDOWN_MAX_BYTES = 4 * 1024 * 1024
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# Only these upstream hosts may be relayed (https only).
ALLOWED_PROXY_HOSTS = {
    "multiplayersessionlist.iondriver.com",  # MSL sessions API
    "gamelistassets.iondriver.com",          # getdata.php — JS no longer fetches GLA; keep for manual /__proxy debugging
}

UPSTREAM_TIMEOUT_SEC = 15


class DevHandler(SimpleHTTPRequestHandler):
    """Static file handler + /__proxy CORS relay."""

    # Quieter default logging (one line per request is plenty).
    def log_message(self, fmt, *args):  # noqa: N802 (stdlib signature)
        sys.stderr.write("[dev] %s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        # Static files otherwise stick in the browser module cache. A stale
        # replay-structures.js then fails the named import in replay.js.
        if "Cache-Control" not in str(getattr(self, "_headers_buffer", b"")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ------------------------------------------------------------- helpers

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _proxy_error(self, code: int, message: str):
        body = json.dumps({"error": message}).encode("utf-8")
        self.send_response(code)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _handle_proxy(self, parsed: urllib.parse.ParseResult):
        qs = urllib.parse.parse_qs(parsed.query)
        target = (qs.get("url") or [None])[0]
        if not target:
            self._proxy_error(400, "missing ?url= parameter")
            return

        tparsed = urllib.parse.urlparse(target)
        if tparsed.scheme != "https":
            self._proxy_error(400, "only https upstreams are allowed")
            return
        if tparsed.hostname not in ALLOWED_PROXY_HOSTS:
            self._proxy_error(403, f"host not allowlisted: {tparsed.hostname}")
            return

        req = urllib.request.Request(target, headers={"User-Agent": "vtstats-dev-proxy"})
        try:
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT_SEC) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type", "application/json; charset=utf-8")
        except urllib.error.HTTPError as e:
            self._proxy_error(502, f"upstream HTTP {e.code}")
            return
        except Exception as e:  # URLError, timeout, ...
            self._proxy_error(502, f"upstream fetch failed: {e}")
            return

        self.send_response(200)
        self._send_cors_headers()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------------------- verbs

    def do_GET(self):  # noqa: N802 (stdlib signature)
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == PROXY_PATH:
            self._handle_proxy(parsed)
            return
        super().do_GET()

    def do_POST(self):  # noqa: N802 (stdlib signature)
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith(TOPDOWN_PREFIX):
            self._handle_topdown(parsed)
            return
        self.close_connection = True
        self.send_error(404, "POST is only accepted at /__topdown/<stem>")

    def _handle_topdown(self, parsed: urllib.parse.ParseResult):
        stem = urllib.parse.unquote(parsed.path[len(TOPDOWN_PREFIX):])
        if (
            not stem
            or "/" in stem
            or "\\" in stem
            or not TOPDOWN_STEM_RE.fullmatch(stem)
        ):
            self._discard_body()
            self._proxy_error(400, "bad map stem")
            return

        body = self._read_limited_body()
        if body is None:
            return
        if not body.startswith(PNG_MAGIC):
            self._proxy_error(400, "body is not a PNG")
            return

        dest = (TOPDOWN_DIR / f"{stem}.png").resolve()
        root = TOPDOWN_DIR.resolve()
        if dest.parent != root:
            self._proxy_error(400, "path escapes the topdown folder")
            return

        TOPDOWN_DIR.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(body)
        self.send_response(204)
        self._send_cors_headers()
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _read_limited_body(self) -> bytes | None:
        raw = self.headers.get("Content-Length", "")
        try:
            length = int(raw)
        except ValueError:
            self.close_connection = True
            self._proxy_error(400, "bad content-length")
            return None
        if length < len(PNG_MAGIC) or length > TOPDOWN_MAX_BYTES:
            self.close_connection = True
            self._proxy_error(413, "png must be under 4 MB")
            return None
        body = self.rfile.read(length)
        if len(body) != length:
            self.close_connection = True
            self._proxy_error(400, "short body")
            return None
        return body

    def _discard_body(self):
        raw = self.headers.get("Content-Length", "")
        try:
            length = int(raw)
        except ValueError:
            self.close_connection = True
            return
        if length < 0 or length > TOPDOWN_MAX_BYTES:
            self.close_connection = True
            return
        got = self.rfile.read(length)
        if len(got) != length:
            self.close_connection = True

    def do_OPTIONS(self):  # noqa: N802 (stdlib signature)
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()


def main() -> int:
    ap = argparse.ArgumentParser(description="VT Stats dev server (static + CORS relay)")
    ap.add_argument("--port", type=int, default=8000, help="listen port (default 8000)")
    ap.add_argument("--root", default=str(REPO_ROOT), help="static root (default: repo root)")
    args = ap.parse_args()

    handler = partial(DevHandler, directory=args.root)
    server = ThreadingHTTPServer(("0.0.0.0", args.port), handler)

    print(f"VT Stats dev server")
    print(f"  static root : {args.root}")
    print(f"  site        : http://localhost:{args.port}/")
    print(f"  game watch  : http://localhost:{args.port}/gw/")
    print(f"  CORS relay  : http://localhost:{args.port}{PROXY_PATH}?url=<encoded>")
    print(f"  topdown save: POST http://localhost:{args.port}{TOPDOWN_PREFIX}<stem>")
    print(f"  allowlist   : {', '.join(sorted(ALLOWED_PROXY_HOSTS))}")
    print("Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
