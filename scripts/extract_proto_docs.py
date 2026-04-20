#!/usr/bin/env python3
"""
Extract inline comments from `scripts/statsgate.proto` into a JSON document
consumed by the Raw Data Browser (`js/raw-browser.js`) for hover tooltips
on field names.

Output: `data/proto-docs.json` — a flat object keyed by:
  - "MessageName.fieldName"  (camelCase field name, matching protobufjs
                               toObject() output)
  - "MessageName"             (message-level description — the comment
                               block immediately preceding the
                               `message Foo { ... }` declaration)

Comment sources (in priority order for per-field entries):
  1. Trailing comment on the same line as the field declaration
     (e.g. `uint64 shooter = 2; // undefined if not a player`)
  2. Leading comment block — one or more `//` lines immediately above
     the field, terminated by a blank line or the previous declaration

Both forms produce the same output value; trailing wins on conflict.

Run via `python scripts/process_stats.py` (invoked as part of the pipeline)
or standalone: `python scripts/extract_proto_docs.py`.
"""

import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
PROTO_PATH = SCRIPT_DIR / "statsgate.proto"
OUTPUT_PATH = PROJECT_ROOT / "data" / "proto-docs.json"

# Match:  [repeated] TYPE name = 1; [// comment]
# Also handles `map<K, V> name = N;` — the type segment can contain commas.
_FIELD_RE = re.compile(
    r"""^\s*
        (?:(?:repeated|optional|required)\s+)?      # rule (optional)
        (?P<type>[\w.]+(?:\s*<[^>]+>)?)             # type (may be map<K, V>)
        \s+
        (?P<name>[a-z_][a-z0-9_]*)                  # field name (snake_case)
        \s*=\s*\d+\s*;
        \s*(?://\s*(?P<inline>.*?))?\s*$
    """,
    re.VERBOSE,
)

_MESSAGE_RE = re.compile(r"^\s*message\s+(?P<name>[A-Z][\w]*)\s*\{\s*$")
_BRACE_CLOSE_RE = re.compile(r"^\s*\}\s*$")
_COMMENT_RE = re.compile(r"^\s*//\s?(?P<text>.*)$")
_BLANK_RE = re.compile(r"^\s*$")


def snake_to_camel(name: str) -> str:
    """Convert snake_case to camelCase, matching protobufjs toObject output."""
    parts = name.split("_")
    return parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:])


def extract(proto_path: Path = PROTO_PATH) -> dict:
    """Parse the proto file and return a dict of path -> comment text."""
    text = proto_path.read_text(encoding="utf-8")
    lines = text.splitlines()

    out: dict[str, str] = {}
    current_message: str | None = None
    message_depth = 0  # > 0 means inside a message (supports oneof nesting)
    pending_leading: list[str] = []

    for line in lines:
        # Detect entering a message block.
        m_msg = _MESSAGE_RE.match(line)
        if m_msg and message_depth == 0:
            name = m_msg.group("name")
            current_message = name
            if pending_leading:
                out[name] = " ".join(pending_leading).strip()
            pending_leading = []
            message_depth = 1
            continue

        # Inside a message, track nested braces (oneof) so we don't exit early.
        if current_message:
            if "{" in line and not m_msg:
                message_depth += 1
            if _BRACE_CLOSE_RE.match(line):
                message_depth -= 1
                if message_depth <= 0:
                    current_message = None
                    message_depth = 0
                    pending_leading = []
                continue

        # Leading comment accumulation.
        c = _COMMENT_RE.match(line)
        if c:
            pending_leading.append(c.group("text"))
            continue

        if _BLANK_RE.match(line):
            # Blank line breaks the leading-comment accumulation.
            pending_leading = []
            continue

        # Field declaration inside a message.
        if current_message:
            f = _FIELD_RE.match(line)
            if f:
                field = f.group("name")
                inline = (f.group("inline") or "").strip()
                leading = " ".join(pending_leading).strip()
                comment = inline or leading
                if comment:
                    camel = snake_to_camel(field)
                    key = f"{current_message}.{camel}"
                    out[key] = comment
                pending_leading = []
                continue

        # Any other line (e.g. `oneof event_type {`, import, edition, etc.)
        # resets the leading-comment buffer so it doesn't bleed into the
        # next declaration.
        pending_leading = []

    return out


def write(docs: dict, output_path: Path = OUTPUT_PATH) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(docs, f, indent=2, ensure_ascii=False, sort_keys=True)


def main() -> int:
    if not PROTO_PATH.exists():
        print(f"Proto file not found: {PROTO_PATH}", file=sys.stderr)
        return 1
    docs = extract(PROTO_PATH)
    write(docs, OUTPUT_PATH)
    print(f"Extracted {len(docs)} proto doc entries -> {OUTPUT_PATH.relative_to(PROJECT_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
