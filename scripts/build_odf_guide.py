#!/usr/bin/env python3
"""Build data/odf-guide.json from the vendored Steam ODF guide.

This is the one sanctioned parser of docs/reference/odf-properties-guide.md.
Runtime pages read the JSON. Do not parse the markdown from JS.

The Guide Index titles are the section boundaries. Overview and Comments are
Steam chrome with no body and are dropped. Class sections promote column-0
``name = default`` lines into property entries. The seven introductory
sections stay ordered blocks (paragraphs, lists, headings, code samples).

    python scripts/build_odf_guide.py
"""

from __future__ import annotations

import json
import re
import sys
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "reference" / "odf-properties-guide.md"
OUTPUT = ROOT / "data" / "odf-guide.json"

CHROME_TITLES = ("Overview", "Comments")

# Introductory sections stay as ordered blocks. Everything from EntityClass
# on is a class reference whose column-0 assignments are properties.
PROSE_TITLES = {
    "Object Definition Files",
    "Common Terms",
    "Classlabel List",
    "AI Process Info",
    "AI Task Info",
    "AI Command List",
    "Configuration ODFs",
}

# First title that belongs to each sidebar group, in index order.
GROUP_STARTS = (
    ("Object Definition Files", "Start here"),
    ("EntityClass", "Base classes"),
    ("AircraftClass", "Units"),
    ("WeaponClass", "Weapons"),
    ("OrdnanceClass", "Ordnance"),
    ("ExplosionClass", "Effects"),
)

NAME = r"[A-Za-z][A-Za-z0-9_#]*"
OPT = r"(?:\([^)]*\))?"
LHS = rf"{NAME}{OPT}(?:\s*\.{{2,4}}\s*{NAME}{OPT})?"
FINDER = re.compile(rf"(?<![A-Za-z0-9_#])({LHS}) = ")
RANGE_ONLY = re.compile(rf"^({NAME}{OPT}\s*\.{{2,4}}\s*{NAME}{OPT})\s*$")
BULLET = re.compile(r"^(\s*)\*\s+(.*)$")

KNOWN_HEAD = re.compile(
    r"^(Classlabel|Class Tree|classlabels|Supported Animations|"
    r"Default ODF Properties|ODF Properties)\b",
    re.IGNORECASE,
)
BARE_TITLE_REJECT = {
    "If", "This", "The", "When", "Valid", "Default", "Sets", "How", "Note",
    "For", "All", "These", "Some", "Only", "Also", "See", "Use", "Can", "Not",
    "An", "A", "It", "In", "On", "At", "To", "And", "Or", "But", "So",
}


# A leading `\*` in the export is the literal asterisk character (the
# wildcard term), not a list marker. Kept private until text is stored.
_LITERAL_STAR = "\ue000"


def unescape(text: str) -> str:
    """Undo the markdown escapes in the vendored export."""
    text = text.replace("\\_", "_")
    text = text.replace("\\*", "*")
    text = text.replace("\\[", "[")
    text = text.replace("\\]", "]")
    text = text.replace("\\-", "-")
    text = re.sub(r"\\([.()])", r"\1", text)
    return text


def prepare_line(line: str) -> str:
    """Unescape a source line without turning a literal `\\*` into a bullet."""
    line = re.sub(
        r"^(\s*)\\\*",
        lambda match: match.group(1) + _LITERAL_STAR,
        line,
        count=1,
    )
    return unescape(line)


def scrub(value):
    """Restore literal asterisks after structure detection."""
    if isinstance(value, str):
        return value.replace(_LITERAL_STAR, "*")
    if isinstance(value, list):
        return [scrub(item) for item in value]
    if isinstance(value, dict):
        return {key: scrub(item) for key, item in value.items()}
    return value


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug or "section"


def anchor_from_name(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "", name.lower())
    return base or "prop"


def heading_anchor(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return "h-" + (slug or "section")


def unique_anchor(base: str, used: set[str]) -> str:
    anchor = base
    n = 2
    while anchor in used:
        anchor = f"{base}-{n}"
        n += 1
    used.add(anchor)
    return anchor


def names_from_lhs(lhs: str) -> list[str]:
    parts = re.split(r"\s*\.{2,4}\s*", lhs.strip())
    return [p.strip() for p in parts if p.strip()]


def display_label(lhs: str) -> str:
    names = names_from_lhs(lhs)
    if len(names) >= 2:
        return f"{names[0]} … {names[-1]}"
    return names[0] if names else lhs.strip()


def split_props(stripped: str) -> list[tuple[str, str | None]] | None:
    """Split a property line. None when the line is not an assignment."""
    matches = list(FINDER.finditer(stripped))
    if not matches or matches[0].start() != 0:
        range_only = RANGE_ONLY.match(stripped)
        if range_only:
            return [(range_only.group(1), None)]
        return None
    parts: list[tuple[str, str | None]] = []
    for i, match in enumerate(matches):
        value_end = matches[i + 1].start() if i + 1 < len(matches) else len(stripped)
        default = stripped[match.end():value_end].strip().rstrip(";").strip()
        parts.append((match.group(1), default))
    return parts


def looks_like_literal(default: str) -> bool:
    """True when the right-hand side is a value, not a sentence."""
    if not default:
        return False
    if default[0] in "\"'":
        return True
    if default.lower() in {"true", "false"}:
        return True
    if re.fullmatch(r"-?[\d.]+f?", default):
        return True
    if re.fullmatch(r"[\d.,\s\-]+", default):
        return True
    if len(default) <= 48 and not default.endswith("."):
        return True
    return False


def peel_default(default: str) -> tuple[str | None, str | None, str | None]:
    """Return (literal or None, // comment, trailing [Header])."""
    header = None
    note = None
    header_match = re.search(r"\s*(\[[A-Za-z0-9_]+\])\s*$", default)
    if header_match:
        header = header_match.group(1)
        default = default[:header_match.start()].strip()
    comment = re.match(r"^(.*?)\s+//\s*(.*)$", default)
    if comment and comment.group(1).strip():
        default = comment.group(1).strip()
        note = comment.group(2).strip() or None
    default = default.strip()
    if not default or not looks_like_literal(default):
        # A sentence parked on the assignment line is description, not a default.
        sentence = default or None
        if sentence and note:
            sentence = f"{sentence} ({note})"
            note = None
        return None, note, header if not sentence else header
    return default, note, header


def inner_bold(stripped: str) -> str | None:
    """Return the inside of a full-line **bold** or bullet-wrapped bold."""
    match = re.match(r"^\*\s+(.+)$", stripped)
    inner = match.group(1).strip() if match else stripped
    if re.fullmatch(r"\*\*.+\*\*", inner) and len(inner) <= 160:
        return inner[2:-2].strip()
    if re.fullmatch(r"\[[A-Za-z0-9_ ]+\]", inner):
        return inner
    return None


def is_bare_title(stripped: str) -> bool:
    if not 3 <= len(stripped) <= 48:
        return False
    if any(ch in stripped for ch in ".*=[]_`"):
        return False
    words = stripped.split()
    if not 1 <= len(words) <= 6:
        return False
    if not stripped[0].isupper():
        return False
    if words[0] in BARE_TITLE_REJECT:
        return False
    return True


def is_subhead_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    if not line.startswith((" ", "\t")) and split_props(stripped):
        return False
    bold = inner_bold(stripped)
    if bold is not None:
        return True
    bare = stripped
    if bare.startswith("* "):
        return False
    if KNOWN_HEAD.match(bare):
        return True
    return is_bare_title(bare)


def subhead_text(stripped: str) -> str:
    bold = inner_bold(stripped)
    if bold is not None:
        return bold
    return stripped


def is_note_line(stripped: str) -> bool:
    return stripped.startswith("_Note:_") or stripped.startswith("_Note_:")


def note_text(stripped: str) -> str:
    return re.sub(r"^_Note:_\s*", "", stripped).strip()


def load_sections(text: str) -> list[tuple[str, list[str]]]:
    lines = text.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == "Guide Index")
    except StopIteration as exc:
        raise SystemExit("Guide Index heading not found") from exc

    titles: list[str] = []
    seen: set[str] = set()
    for line in lines[start + 1:]:
        title = line.strip()
        if not title:
            continue
        if title in seen:
            break
        seen.add(title)
        titles.append(title)

    body_titles = [title for title in titles if title not in CHROME_TITLES]
    title_set = set(body_titles)
    found: list[tuple[int, str]] = []
    for index, line in enumerate(lines):
        title = line.strip()
        if title in title_set and line == f" {title} ":
            found.append((index, title))

    found_titles = [title for _, title in found]
    if found_titles != body_titles:
        missing = [title for title in body_titles if title not in found_titles]
        extra = [title for title in found_titles if title not in body_titles]
        raise SystemExit(
            "Section headers do not match the Guide Index. "
            f"missing={missing!r} extra={extra!r}"
        )

    dropped = [title for title in titles if title in CHROME_TITLES]
    print(f"Dropped index-only chrome: {', '.join(dropped)}")

    sections: list[tuple[str, list[str]]] = []
    for pos, (index, title) in enumerate(found):
        end = found[pos + 1][0] if pos + 1 < len(found) else len(lines)
        body = [prepare_line(line) for line in lines[index + 1:end]]
        sections.append((title, body))
    return sections


def group_for(title: str, current: str) -> str:
    for start, name in GROUP_STARTS:
        if title == start:
            return name
    return current


def parse_list(lines: list[str], start: int) -> tuple[list[dict], int]:
    roots: list[dict] = []
    stack: list[tuple[int, dict]] = []
    index = start
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            peek = index + 1
            while peek < len(lines) and not lines[peek].strip():
                peek += 1
            if peek < len(lines) and BULLET.match(lines[peek]) and not is_subhead_line(lines[peek]):
                index = peek
                continue
            break
        if is_subhead_line(line):
            break
        bullet = BULLET.match(line)
        if bullet:
            indent = len(bullet.group(1).replace("\t", "    "))
            node = {"text": bullet.group(2).strip(), "children": []}
            while stack and stack[-1][0] >= indent:
                stack.pop()
            if stack:
                stack[-1][1]["children"].append(node)
            else:
                roots.append(node)
            stack.append((indent, node))
            index += 1
            continue
        if line.startswith((" ", "\t")) and stack:
            extra = line.strip()
            node = stack[-1][1]
            node["text"] = (node["text"] + " " + extra).strip()
            index += 1
            continue
        break
    return roots, index


def parse_blocks(lines: list[str], promote: bool, used: set[str]) -> list[dict]:
    blocks: list[dict] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            index += 1
            continue
        if is_subhead_line(line):
            text = subhead_text(stripped)
            blocks.append({
                "kind": "subhead",
                "text": text,
                "anchor": unique_anchor(heading_anchor(text), used),
            })
            index += 1
            continue
        if is_note_line(stripped):
            blocks.append({"kind": "note", "text": note_text(stripped)})
            index += 1
            continue
        props = None
        col0 = not line.startswith((" ", "\t"))
        if promote and col0:
            props = split_props(stripped)
        if props:
            body_lines, index = take_body(lines, index + 1)
            body = parse_blocks(body_lines, promote=False, used=used)
            shared: list[dict] = []
            emitted: list[dict] = []
            for lhs, raw_default in props:
                note = None
                header = None
                default: str | None
                if raw_default is None:
                    default = None
                else:
                    default, note, header = peel_default(raw_default)
                    if default is None and raw_default.strip():
                        # Sentence on the assignment line leads the description.
                        sentence = raw_default.strip()
                        sentence = re.sub(r"\s*\[[A-Za-z0-9_]+\]\s*$", "", sentence).strip()
                        sentence = re.sub(r"\s+//\s*", " — ", sentence).strip()
                        if sentence:
                            shared.append({"kind": "para", "text": sentence})
                names = names_from_lhs(lhs)
                block = {
                    "kind": "property",
                    "names": names,
                    "label": display_label(lhs),
                    "default": default,
                    "anchor": unique_anchor(anchor_from_name(names[0]), used),
                    "blocks": [],
                }
                if note:
                    block["note"] = note
                emitted.append(block)
                if header:
                    blocks.extend(emitted)
                    for earlier in emitted:
                        earlier["blocks"] = deepcopy(shared) + deepcopy(body)
                    emitted = []
                    shared = []
                    blocks.append({
                        "kind": "subhead",
                        "text": header,
                        "anchor": unique_anchor(heading_anchor(header), used),
                    })
            for block in emitted:
                block["blocks"] = deepcopy(shared) + deepcopy(body)
                if block.get("note") and not any(
                    part.get("kind") == "note" for part in block["blocks"]
                ):
                    block["blocks"].append({"kind": "note", "text": block["note"]})
                blocks.append(block)
            continue
        if BULLET.match(line):
            items, index = parse_list(lines, index)
            if items:
                blocks.append({"kind": "list", "items": items})
            continue
        if split_props(stripped) or stripped.startswith("["):
            code_anchor = None
            code_names: list[str] = []
            parsed = split_props(stripped)
            if parsed and parsed[0][1] is not None and FINDER.match(stripped):
                code_names = names_from_lhs(parsed[0][0])
                code_anchor = unique_anchor(anchor_from_name(code_names[0]), used)
            block = {"kind": "code", "text": stripped}
            if code_anchor:
                block["anchor"] = code_anchor
                block["names"] = code_names
            blocks.append(block)
            index += 1
            continue
        blocks.append({"kind": "para", "text": stripped})
        index += 1
    return scrub(blocks)


def take_body(lines: list[str], start: int) -> tuple[list[str], int]:
    body: list[str] = []
    index = start
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            body.append(line)
            index += 1
            continue
        if is_subhead_line(line):
            break
        col0 = not line.startswith((" ", "\t"))
        if col0 and split_props(line.strip()):
            break
        body.append(line)
        index += 1
    while body and not body[-1].strip():
        body.pop()
    return body, index


def plain_list(items: list[dict]) -> str:
    chunks: list[str] = []
    for item in items:
        chunks.append(item.get("text") or "")
        if item.get("children"):
            chunks.append(plain_list(item["children"]))
    return "\n".join(chunk for chunk in chunks if chunk)


def plain_blocks(blocks: list[dict]) -> str:
    chunks: list[str] = []
    for block in blocks:
        kind = block.get("kind")
        if kind in {"para", "note", "code", "subhead"}:
            chunks.append(block.get("text") or "")
        elif kind == "list":
            chunks.append(plain_list(block.get("items") or []))
        elif kind == "property":
            chunks.append(block.get("label") or "")
            if block.get("default"):
                chunks.append(str(block["default"]))
            chunks.append(plain_blocks(block.get("blocks") or []))
    return "\n".join(chunk for chunk in chunks if chunk)


def build_entries(section_id: str, blocks: list[dict]) -> list[dict]:
    entries: list[dict] = []
    intro: list[str] = []
    head: dict | None = None
    head_chunks: list[str] = []

    def flush_head() -> None:
        nonlocal head, head_chunks
        if head is None:
            return
        head["text"] = "\n".join(chunk for chunk in head_chunks if chunk).strip()
        entries.append(head)
        head = None
        head_chunks = []

    for block in blocks:
        kind = block.get("kind")
        if kind == "subhead":
            flush_head()
            head = {
                "kind": "heading",
                "names": [block["text"]],
                "label": block["text"],
                "default": None,
                "text": "",
                "section": section_id,
                "anchor": block["anchor"],
            }
            continue
        if kind == "property":
            flush_head()
            intro.clear()
            entries.append({
                "kind": "property",
                "names": block["names"],
                "label": block["label"],
                "default": block.get("default"),
                "text": plain_blocks(block.get("blocks") or []),
                "section": section_id,
                "anchor": block["anchor"],
            })
            continue
        if kind == "code" and block.get("anchor"):
            flush_head()
            entries.append({
                "kind": "code",
                "names": block.get("names") or [],
                "label": block["text"],
                "default": None,
                "text": block["text"],
                "section": section_id,
                "anchor": block["anchor"],
            })
            continue
        chunk = plain_blocks([block])
        if head is not None:
            head_chunks.append(chunk)
        else:
            intro.append(chunk)
    flush_head()
    intro_text = "\n".join(chunk for chunk in intro if chunk).strip()
    if intro_text:
        entries.insert(0, {
            "kind": "intro",
            "names": [],
            "label": "",
            "default": None,
            "text": intro_text,
            "section": section_id,
            "anchor": "",
        })
    return entries


STEAM_GUIDE_URL = "https://steamcommunity.com/sharedfiles/filedetails/?id=1423355866"
ABOUT_SECTION_ID = "about-this-document"


def about_section() -> tuple[dict, list]:
    """Sev's own front section. Not part of the Steam guide."""
    blocks = [
        {
            "kind": "para",
            "text": (
                "This page is Sev's searchable copy of the community "
                "**ODF Documentation** guide for Battlezone: Combat Commander. "
                "It was written by **GenBlackDragon**, with **[BZ] Ultraken**."
            ),
        },
        {
            "kind": "para",
            "text": (
                "The original guide is on Steam: "
                "[ODF Documentation](" + STEAM_GUIDE_URL + ")."
            ),
        },
        {
            "kind": "subhead",
            "text": "What this covers",
            "anchor": "h-what-this-covers",
        },
        {
            "kind": "para",
            "text": (
                "The guide lists Object Definition File settings for "
                "Battlezone: Combat Commander version 2.0.185. "
                "It was posted on 24 July 2018 and last updated on Steam "
                "on 10 May 2026."
            ),
        },
        {
            "kind": "para",
            "text": (
                "Every chapter after this one is the authors' text, in the "
                "same order as their guide index. Sev did not rewrite "
                "those chapters. This page is the only section we added."
            ),
        },
        {
            "kind": "subhead",
            "text": "How to use this page",
            "anchor": "h-how-to-use-this-page",
        },
        {
            "kind": "list",
            "items": [
                {
                    "text": (
                        "The search box in the top bar matches property names, "
                        "class names, and terms. Enter opens the best match."
                    ),
                    "children": [],
                },
                {
                    "text": (
                        "The list on the left is the guide index: Start here, "
                        "then base classes, units, weapons, ordnance, and effects."
                    ),
                    "children": [],
                },
                {
                    "text": (
                        "A property row shows the name, the default the guide "
                        "lists, and the description under it."
                    ),
                    "children": [],
                },
                {
                    "text": (
                        "A link to a property keeps the section and the entry, "
                        "for example "
                        "?section=gameobjectclass-p3-combat-settings#weaponhard1."
                    ),
                    "children": [],
                },
            ],
        },
        {
            "kind": "subhead",
            "text": "Mods and the current copy",
            "anchor": "h-mods-and-the-current-copy",
        },
        {
            "kind": "para",
            "text": (
                "The defaults here are the ones the guide documents for the "
                "stock game. A mod, including VSR, can set a different value "
                "in its own ODF. If a line here and the current Steam page "
                "disagree, the Steam guide is the authors' current copy."
            ),
        },
    ]
    section = {
        "id": ABOUT_SECTION_ID,
        "title": "About This Document",
        "group": "Start here",
        "blocks": blocks,
    }
    return section, build_entries(ABOUT_SECTION_ID, blocks)


def build() -> dict:
    if not SOURCE.is_file():
        raise SystemExit(f"Missing source guide: {SOURCE}")
    raw = SOURCE.read_text(encoding="utf-8")
    grouped = load_sections(raw)
    group = GROUP_STARTS[0][1]
    sections: list[dict] = []
    entries: list[dict] = []
    used_ids: set[str] = set()
    for title, body in grouped:
        group = group_for(title, group)
        section_id = slugify(title)
        if section_id in used_ids:
            raise SystemExit(f"Duplicate section slug: {section_id}")
        used_ids.add(section_id)
        used_anchors: set[str] = set()
        promote = title not in PROSE_TITLES
        blocks = parse_blocks(body, promote=promote, used=used_anchors)
        if not blocks:
            raise SystemExit(f"Section produced zero blocks: {title}")
        section_entries = build_entries(section_id, blocks)
        sections.append({
            "id": section_id,
            "title": title,
            "group": group,
            "blocks": blocks,
        })
        entries.extend(section_entries)
    about, about_entries = about_section()
    if any(section["id"] == about["id"] for section in sections):
        raise SystemExit("About This Document collided with a guide section id")
    sections.insert(0, about)
    entries = about_entries + entries
    return {
        "schema_version": 1,
        "source": {
            "title": "ODF Documentation",
            "url": "https://steamcommunity.com/sharedfiles/filedetails/?id=1423355866",
            "authors": ["GenBlackDragon", "[BZ] Ultraken"],
            "covers": "Battlezone: Combat Commander version 2.0.185",
            "updated": "May 10, 2026",
        },
        "groups": [name for _, name in GROUP_STARTS],
        "sections": sections,
        "entries": entries,
    }


def _entry_names(entry: dict) -> list[str]:
    return [name.lower() for name in entry.get("names") or []]


def assert_golden(doc: dict) -> None:
    if not doc["sections"] or doc["sections"][0]["id"] != ABOUT_SECTION_ID:
        raise SystemExit("Golden check failed: About This Document is not the first section")
    if doc["sections"][0]["group"] != "Start here":
        raise SystemExit("Golden check failed: About This Document is not under Start here")
    about_text = plain_blocks(doc["sections"][0]["blocks"])
    if "GenBlackDragon" not in about_text or STEAM_GUIDE_URL not in about_text:
        raise SystemExit("Golden check failed: About This Document is missing the author credit or Steam link")

    by_id = {section["id"]: section for section in doc["sections"]}

    def section_title(entry: dict) -> str:
        return by_id[entry["section"]]["title"]

    def has_name(entry: dict, prefix: str) -> bool:
        prefix = prefix.lower()
        return any(name.startswith(prefix) for name in _entry_names(entry))

    weapons = [
        entry for entry in doc["entries"]
        if has_name(entry, "weaponhard")
        and section_title(entry).startswith("GameObjectClass P3")
    ]
    if not weapons:
        raise SystemExit("Golden check failed: weaponHard is not in GameObjectClass P3")

    costs = [
        entry for entry in doc["entries"]
        if "scrapcost" in _entry_names(entry)
        and section_title(entry).startswith("GameObjectClass P4")
    ]
    if not costs:
        raise SystemExit("Golden check failed: scrapCost is not in GameObjectClass P4")

    radii = [
        entry for entry in doc["entries"]
        if "collisionradius" in _entry_names(entry)
        and "ai avoidance" in (entry.get("text") or "").lower()
    ]
    if not radii:
        raise SystemExit("Golden check failed: collisionRadius text does not mention AI avoidance")


def report_duplicates(doc: dict) -> None:
    by_id = {section["id"]: section["title"] for section in doc["sections"]}
    where: dict[str, list[str]] = {}
    for entry in doc["entries"]:
        if entry.get("kind") != "property":
            continue
        for name in entry.get("names") or []:
            key = name.lower()
            title = by_id[entry["section"]]
            bucket = where.setdefault(key, [])
            if title not in bucket:
                bucket.append(title)
    dupes = sorted(name for name, titles in where.items() if len(titles) > 1)
    print(f"Property names in more than one section: {len(dupes)}")
    for name in dupes:
        print(f"  {name}: {', '.join(where[name])}")


def main() -> None:
    doc = build()
    assert_golden(doc)
    n_sections = len(doc["sections"])
    n_props = sum(1 for entry in doc["entries"] if entry["kind"] == "property")
    print(f"Sections: {n_sections}")
    print(f"Entries: {len(doc['entries'])} ({n_props} properties)")
    counts: dict[str, int] = {}
    for section in doc["sections"]:
        counts[section["group"]] = counts.get(section["group"], 0) + 1
    for name in doc["groups"]:
        print(f"  {name}: {counts.get(name, 0)} sections")
    report_duplicates(doc)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(doc, indent=2, ensure_ascii=False)
    OUTPUT.write_text(payload + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT} ({len(payload):,} bytes)")


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
