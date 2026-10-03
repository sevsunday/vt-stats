#!/usr/bin/env python3
"""Build the BZCC console command reference.

Standalone. Not invoked by process_stats.py. Read-only over the game
install; writes three files in the repo:

    data/reference/console-dump.json        scrubbed console tree (committed)
    data/console-reference.json             ODF Guide "Console commands" book
    docs/reference/bzcc-console-reference.md  human-readable twin

Sources, most authoritative first:

1. The in-game console itself. With ``console.log`` on, every console line is
   written to the session log (``Battlezone <date>.log`` in the game's
   My Games folder) as ``DIAG|  console:NNN  |HH:MM:SS|tick |<text>``.
   Typing ``ls`` lists the namespaces; typing a bare namespace name lists its
   members as ``  Cmd <name>`` (commands), ``  <var> = <value>`` (variables)
   and ``  [sub]`` (nested scopes, listed in turn as ``ns.sub``). The parse
   of those logs is the scrubbed dump: names, kinds, nesting and value types
   everywhere; example values only for non-personal namespaces.
2. ``battlezone2.exe`` printable strings: the dotted identifiers the engine
   registers (kept in file order, which is registration order) and the
   output/help format strings the commands print.
3. ``bz2r_res/config/**/*.cfg``: every ``Cmd("name args")`` and
   ``UseVar("name")`` -- argument shapes and the shell screens that use them.
4. ``bz2r_res/config/GamePrefs.ini``: the comment block above every key.
5. ``bz2r_res/config/editor/bzeditor_*.cfg``: the editor panel label bound to
   each variable (``UseVar``), e.g. ``sky.visibilityrange`` <-> "Visibility
   Range".
6. ``scripts/console_reference_notes.json``: curated explanations from the
   lighting/fog investigation, each tagged ``verified`` or ``unverified``.

Every entry carries an evidence tier (verified / engine / usage / inferred /
unverified) so a guess never reads as a fact.

    python scripts/extract_console_reference.py --console-log "<log>" [--console-log ...]
    python scripts/extract_console_reference.py            # rebuild from the committed dump
    python scripts/extract_console_reference.py --bz2r "D:/Steam/steamapps/common/BZ2R"
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import re
import struct
import sys
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DUMP_PATH = ROOT / "data" / "reference" / "console-dump.json"
REFERENCE_JSON = ROOT / "data" / "console-reference.json"
REFERENCE_MD = ROOT / "docs" / "reference" / "bzcc-console-reference.md"
NOTES_PATH = ROOT / "scripts" / "console_reference_notes.json"
DEFAULT_BZ2R = Path(r"C:\Program Files (x86)\Steam\steamapps\common\BZ2R")
DEFAULT_LOG_DIR = Path.home() / "OneDrive" / "Documents" / "My Games" / "Battlezone Combat Commander"

DUMP_SCHEMA = 1
REFERENCE_SCHEMA = 1
GROUP_TITLE = "Console commands"
SECTION_PREFIX = "console-"

# The 36 namespaces `ls` printed, in the game's own order.
LS_ORDER = (
    "iface sys profile debug dome vid bump iam multilanguage keybind console "
    "options ai sky audio gameprefs script network mission inputbind mesh "
    "terrain view editor shell game chrome fog rain splat sprites sun stars "
    "control scrap status"
).split()

# Theme order for the TOC, with the one-line descriptor shown in the title.
THEMES = [
    ("World and atmosphere", [
        ("sky", "atmosphere, fog, clouds"),
        ("sun", "light, time of day"),
        ("fog", "local, ground and water fog"),
        ("dome", "sky dome mesh and dome light"),
        ("stars", "starfield layer"),
        ("sprites", "sky billboards"),
        ("rain", "weather"),
        ("splat", "ground, water and windshield splats"),
        ("chrome", "environment reflection map"),
        ("terrain", "terrain material and detail"),
        ("bump", "bump mapping"),
        ("mesh", "mesh rendering"),
        ("vid", "video and render settings"),
    ]),
    ("Game and mission", [
        ("game", "game session"),
        ("mission", "load, save, restart"),
        ("script", "mission script and cinematics"),
        ("ai", "AI debugging"),
        ("scrap", "scrap readouts"),
        ("control", "command panel, groups, satellite, teams"),
        ("status", "HUD readouts"),
        ("view", "camera views"),
        ("editor", "map editor"),
    ]),
    ("Multiplayer", [
        ("network", "multiplayer sessions"),
    ]),
    ("Settings and input", [
        ("options", "player options"),
        ("gameprefs", "GamePrefs.ini overrides"),
        ("keybind", "key binding commands"),
        ("inputbind", "input bindings"),
        ("audio", "audio"),
        ("iface", "interface and console display"),
        ("shell", "menu shell"),
    ]),
    ("System", [
        ("console", "console logging"),
        ("sys", "system information"),
        ("debug", "debug overlays"),
        ("profile", "empty"),
        ("multilanguage", "empty"),
        ("iam", "internal"),
    ]),
]
DESCRIPTOR = {ns: desc for _, items in THEMES for ns, desc in items}
THEME_ORDER = [ns for _, items in THEMES for ns, _ in items]

# Namespaces whose live values are engine or map data, not personal settings.
EXAMPLE_NAMESPACES = set(
    "sky sun fog dome stars sprites rain splat chrome terrain mesh vid bump game "
    "mission scrap status control view script ai debug sys console iface shell".split()
)
# Never carry a value for these leaves, whatever the namespace.
VALUE_DENYLIST = {"namebox", "joinipstr", "password", "playerlist", "team1list",
                  "team2list", "servermsg", "namecrc"}

# Sibling scopes that share one shape; the listed one stands for the rest.
SIBLING_PATTERNS = (
    ("control.command.item0", r"^control\.command\.item\d$"),
    ("status.weapon1.shot", r"^status\.weapon[1-5]\.shot$"),
)
AXIS_BINDINGS = {"steer", "pitch", "strafe", "throttle"}

TIER_LABEL = {
    "verified": "verified in-game",
    "engine": "engine text",
    "usage": "usage context",
    "inferred": "inferred from name, unverified",
    "unverified": "community knowledge, unverified",
}
TIER_RANK = {"verified": 0, "engine": 1, "unverified": 2, "usage": 3, "inferred": 4}

DOTTED_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+")
FILE_EXT_RE = re.compile(
    r"\.(dll|exe|cfg|odf|tga|dds|wav|bzn|trn|ter|sky|wat|fbx|xsi|msh|material|txt|ini|"
    r"pak|h|cpp|hlsl|fxc|csv|bmp|pic|png|ogg|mp3|lib|pdb|log|des|inf|bmf|fnt|xml|json|"
    r"dat|bin|net|xsl|map|sav|lua)$",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Session-log parsing
# ---------------------------------------------------------------------------

def _console_lines(log_paths: list[Path]) -> list[tuple[str, str, str | None]]:
    """(time, payload, map_stem) for every console line, in log order.

    `map_stem` is the mission named by the latest ``Loaded from file
    <stem>.bzn`` / ``Reading Sky File <stem>.SKY`` line before this console
    line (any log channel), so listings can be tagged with the map whose
    values they show.
    """
    out: list[tuple[str, str, str | None]] = []
    mission_re = re.compile(r"(?:Loaded from file|Reading Sky File)\s+([A-Za-z0-9_\-]+)\.(?:bzn|SKY)\b", re.IGNORECASE)
    for path in log_paths:
        current_map = None
        for raw in path.read_text(encoding="latin1", errors="replace").splitlines():
            m = mission_re.search(raw)
            if m:
                current_map = m.group(1).lower()
            parts = raw.split("|")
            if len(parts) < 5 or not re.search(r"^\s*console:\d+\s*$", parts[1]):
                continue
            out.append((parts[2].strip(), "|".join(parts[4:]).rstrip("\r\n"), current_map))
    return out


def _infer_type(literal: str) -> tuple[str, str]:
    """(type, cleaned example) for a `name = value` right-hand side."""
    text = literal.strip()
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        return "string", text[1:-1]
    if re.fullmatch(r"-?\d+", text):
        return "int", text
    if re.fullmatch(r"-?\d+\.\d+(e[-+]?\d+)?", text, re.IGNORECASE):
        return "float", text
    return "string", text


class _Block:
    __slots__ = ("time", "name", "members", "map_stem")

    def __init__(self, time: str, name: str, members: list[str], map_stem: str | None):
        self.time = time
        self.name = name
        self.members = members
        self.map_stem = map_stem


def _blocks(lines) -> list[_Block]:
    blocks: list[_Block] = []
    i = 0
    header = re.compile(r"\[([A-Za-z0-9_]+)\]")
    while i < len(lines):
        time, text, stem = lines[i]
        m = header.fullmatch(text.strip())
        if m and not text.startswith(" "):
            j = i + 1
            members: list[str] = []
            while j < len(lines) and lines[j][1].startswith(" "):
                members.append(lines[j][1])
                j += 1
            blocks.append(_Block(time, m.group(1), members, stem))
            i = j
        else:
            i += 1
    return blocks


def _split_ls_runs(blocks: list[_Block]) -> tuple[list[list[str]], list[_Block]]:
    """Separate `ls` output (runs of 5+ empty headers) from real listings."""
    runs: list[list[str]] = []
    kept: list[_Block] = []
    i = 0
    while i < len(blocks):
        j = i
        while j < len(blocks) and not blocks[j].members:
            j += 1
        if j - i >= 5:
            # Back-to-back `ls` calls run together; a repeated name starts a new one.
            run: list[str] = []
            for block in blocks[i:j]:
                if block.name in run:
                    runs.append(run)
                    run = []
                run.append(block.name)
            runs.append(run)
            i = j
            continue
        kept.append(blocks[i])
        i += 1
    return runs, kept


def parse_console_logs(log_paths: list[Path], exe_names: set[str]) -> dict:
    """Parse console listings into the scrubbed tree."""
    lines = _console_lines(log_paths)
    if not lines:
        raise SystemExit("no console lines found; turn file logging on with `console.log` first")
    all_blocks = _blocks(lines)
    runs, blocks = _split_ls_runs(all_blocks)
    namespaces = list(runs[0]) if runs else list(LS_ORDER)
    for run in runs[1:]:
        if len(run) >= 30 and run != namespaces:
            print(f"  warn: a later `ls` listed {len(run)} namespaces; using the first run")
            break

    scopes: "OrderedDict[str, dict]" = OrderedDict()

    def ensure(path: str) -> dict:
        if path not in scopes:
            scopes[path] = {
                "parent": path.rsplit(".", 1)[0] if "." in path else None,
                "children": [],
                "commands": [],
                "variables": OrderedDict(),
                "listed": False,
                "example_map": None,
                "inferred_from": None,
            }
        return scopes[path]

    for ns in namespaces:
        ensure(ns)

    def candidates(name: str) -> list[str]:
        out = []
        if name in namespaces:
            out.append(name)
        for path, scope in scopes.items():
            if name in scope["children"]:
                out.append(f"{path}.{name}")
        return out

    def member_leaves(block: _Block) -> list[str]:
        leaves = []
        for raw in block.members:
            s = raw.strip()
            if s.startswith("Cmd "):
                leaves.append(s[4:].strip())
            elif "=" in s and not s.startswith("["):
                leaves.append(s.split("=", 1)[0].strip())
        return leaves

    def score(path: str, block: _Block) -> float:
        total = 0.0
        if path.lower() in exe_names:
            total += 0.5
        for leaf in member_leaves(block):
            if f"{path}.{leaf}".lower() in exe_names:
                total += 1.0
        return total

    def resolve(block: _Block) -> str:
        cands = candidates(block.name)
        if not cands:
            print(f"  warn: [{block.name}] at {block.time} has no known parent; kept as a top-level scope")
            return block.name
        if len(cands) == 1:
            return cands[0]
        # Best exe-string support wins; then prefer a scope not listed yet;
        # then declaration order (the order the user typed them in).
        scored = [(score(c, block), 0 if not scopes[c]["listed"] else 1, idx, c)
                  for idx, c in enumerate(cands)]
        scored.sort(key=lambda t: (-t[0], t[1], t[2]))
        return scored[0][3]

    for block in blocks:
        path = resolve(block)
        scope = ensure(path)
        ns = path.split(".", 1)[0]
        keep_values = ns in EXAMPLE_NAMESPACES
        for raw in block.members:
            s = raw.strip()
            sub = re.fullmatch(r"\[([A-Za-z0-9_]+)\]", s)
            if sub:
                child = sub.group(1)
                if child not in scope["children"]:
                    scope["children"].append(child)
                ensure(f"{path}.{child}")
                continue
            if s.startswith("Cmd "):
                cmd = s[4:].strip()
                if cmd and cmd not in scope["commands"]:
                    scope["commands"].append(cmd)
                continue
            if "=" in s:
                name, literal = s.split("=", 1)
                name = name.strip()
                if not name:
                    continue
                vtype, example = _infer_type(literal)
                entry = scope["variables"].get(name) or {"type": vtype}
                entry["type"] = vtype
                if keep_values and name.lower() not in VALUE_DENYLIST and "example" not in entry:
                    entry["example"] = example
                scope["variables"][name] = entry
        scope["listed"] = True
        if keep_values and scope["example_map"] is None:
            scope["example_map"] = block.map_stem

    # Siblings that share a shape: clone the listed one into the unlisted rest.
    for template, pattern in SIBLING_PATTERNS:
        rx = re.compile(pattern)
        src = scopes.get(template)
        if not src or not src["listed"]:
            continue
        for path, scope in list(scopes.items()):
            if path != template and rx.match(path) and not scope["listed"]:
                scope["commands"] = list(src["commands"])
                scope["variables"] = OrderedDict(
                    (k, {"type": v["type"]}) for k, v in src["variables"].items()
                )
                scope["inferred_from"] = template
    # Input bindings: two shapes, button and axis.
    button_src = scopes.get("inputbind.weapon_fire")
    axis_src = scopes.get("inputbind.steer")
    for path, scope in list(scopes.items()):
        if not path.startswith("inputbind.") or scope["listed"]:
            continue
        leaf = path.split(".", 1)[1]
        src = axis_src if leaf in AXIS_BINDINGS else button_src
        if src and src["listed"]:
            scope["commands"] = list(src["commands"])
            scope["variables"] = OrderedDict(
                (k, {"type": v["type"]}) for k, v in src["variables"].items()
            )
            scope["inferred_from"] = "inputbind.steer" if src is axis_src else "inputbind.weapon_fire"

    dates = sorted({
        m.group(1) for p in log_paths
        for m in [re.search(r"(\d{4}-\d{2}-\d{2})", p.name)] if m
    })
    unlisted = [p for p, s in scopes.items() if not s["listed"] and not s["inferred_from"]]
    if unlisted:
        print(f"  note: {len(unlisted)} scopes were never listed: {', '.join(unlisted[:12])}"
              + (" ..." if len(unlisted) > 12 else ""))
    return {
        "schema_version": DUMP_SCHEMA,
        "captured_on": dates,
        "method": ("In-game console with `console.log` file logging on: `ls`, then each "
                   "namespace and nested scope typed bare; parsed from the session logs. "
                   "Values are examples from the map loaded at the time; personal settings "
                   "(options, gameprefs, inputbind, network, keybind, audio) keep names and types only."),
        "namespaces": namespaces,
        "scopes": scopes,
    }


# ---------------------------------------------------------------------------
# Install harvest
# ---------------------------------------------------------------------------

def _printable_strings(blob: bytes, minimum: int = 4):
    for m in re.finditer(rb"[\x20-\x7e]{%d,200}" % minimum, blob):
        yield m.start(), m.group(0).decode("latin1")


def harvest_exe(exe_path: Path | None) -> dict:
    """Dotted identifiers (lower -> {name, offset}) and format strings."""
    out = {"path": None, "sha256": None, "file_version": None, "dotted": {}, "formats": []}
    if not exe_path or not exe_path.is_file():
        return out
    blob = exe_path.read_bytes()
    out["path"] = str(exe_path)
    out["sha256"] = hashlib.sha256(blob).hexdigest()
    out["file_version"] = _pe_file_version(blob)
    dotted: dict[str, dict] = {}
    formats: list[str] = []
    for offset, text in _printable_strings(blob):
        if DOTTED_RE.fullmatch(text) and not FILE_EXT_RE.search(text):
            key = text.lower()
            if key not in dotted:
                dotted[key] = {"name": text, "offset": offset}
        elif "%" in text and 6 <= len(text) <= 160 and re.search(r"[A-Za-z]{3}", text):
            formats.append(text.strip())
    out["dotted"] = dotted
    out["formats"] = sorted(set(formats))
    return out


def _pe_file_version(blob: bytes) -> str | None:
    key = "FileVersion".encode("utf-16-le") + b"\x00\x00"
    at = blob.find(key)
    if at < 0:
        return None
    start = at + len(key)
    # Align to 4 bytes, then read the UTF-16 value until NUL.
    while start % 4:
        start += 1
    end = blob.find(b"\x00\x00", start)
    while end >= 0 and (end - start) % 2:
        end = blob.find(b"\x00\x00", end + 1)
    if end < 0:
        return None
    try:
        return blob[start:end].decode("utf-16-le").strip(" \x00") or None
    except UnicodeDecodeError:
        return None


def harvest_cfg(bz2r: Path | None) -> dict:
    """Cmd()/UseVar() usage per dotted name from the shell configs."""
    usage: dict[str, dict] = {}
    if not bz2r:
        return usage
    config = bz2r / "bz2r_res" / "config"
    if not config.is_dir():
        return usage
    cmd_re = re.compile(r'\b(Cmd|UseVar)\(\s*"([^"]*)"')
    for path in sorted(config.rglob("*.cfg")):
        rel = path.relative_to(config).as_posix()
        text = path.read_text(encoding="latin1", errors="replace")
        for m in cmd_re.finditer(text):
            kind, body = m.group(1), m.group(2).strip()
            head = body.split()[0] if body.split() else ""
            if not re.fullmatch(r"[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+", head):
                continue
            key = head.lower()
            entry = usage.setdefault(key, {"name": head, "cmd_files": [], "usevar_files": [], "examples": []})
            if kind == "Cmd":
                if rel not in entry["cmd_files"]:
                    entry["cmd_files"].append(rel)
                if body not in entry["examples"] and len(entry["examples"]) < 5:
                    entry["examples"].append(body)
            else:
                if rel not in entry["usevar_files"]:
                    entry["usevar_files"].append(rel)
    return usage


def harvest_gameprefs(bz2r: Path | None) -> dict:
    """GamePrefs.ini keys -> {comment, default}."""
    out: dict[str, dict] = {}
    if not bz2r:
        return out
    path = bz2r / "bz2r_res" / "config" / "GamePrefs.ini"
    if not path.is_file():
        return out
    # A comment block applies to every key that follows it until a blank
    # line (`MaxVisibility`, `MinFogRange`, `MaxFogRange` share one block).
    comments: list[str] = []
    after_key = False
    for raw in path.read_text(encoding="latin1", errors="replace").splitlines():
        line = raw.strip()
        if not line:
            comments = []
            after_key = False
            continue
        if line.startswith("//"):
            if after_key:
                comments = []
                after_key = False
            comments.append(line[2:].strip())
            continue
        m = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if m:
            key = m.group(1)
            default = m.group(2).split("//", 1)[0].strip().rstrip(";")
            out[key.lower()] = {"name": key, "comment": " ".join(comments).strip(), "default": default}
            after_key = True
    return out


def harvest_editor_labels(bz2r: Path | None) -> dict:
    """Variable -> {label, panel} from the editor panel configs."""
    out: dict[str, dict] = {}
    if not bz2r:
        return out
    folder = bz2r / "bz2r_res" / "config" / "editor"
    if not folder.is_dir():
        return out
    block_re = re.compile(r'CreateControl\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)\s*\{(.*?)\n\t\}', re.S)
    # `(?<![A-Za-z])` keeps JustifyText("LEFT") from matching.
    text_re = re.compile(r'(?<![A-Za-z])Text\(\s*"([^"]*)"')
    var_re = re.compile(r'UseVar\(\s*"([^"]+)"')
    junk = {"left", "right", "centre", "center", "x", "y", "z", "u", "v", "w", "page", "close", "add"}

    def usable(label: str) -> bool:
        text = label.strip()
        if not text or len(text) > 40 or text.lower() in junk:
            return False
        return bool(re.search(r"[A-Za-z]{3}", text))

    for path in sorted(folder.glob("bzeditor_*.cfg")):
        panel = path.stem.replace("bzeditor_", "")
        titles: dict[str, str] = {}
        last_text = ""
        blocks = list(block_re.finditer(path.read_text(encoding="latin1", errors="replace")))
        for m in blocks:
            if m.group(2).upper() == "STATIC":
                texts = [t for t in text_re.findall(m.group(3)) if usable(t)]
                if texts:
                    titles[m.group(1).lower()] = texts[0].strip()
        for m in blocks:
            name, ctype, body = m.group(1), m.group(2), m.group(3)
            texts = [t for t in text_re.findall(body) if usable(t)]
            own = texts[0].strip() if texts else ""
            if own and ctype.upper() == "STATIC":
                last_text = own
            for var in var_re.findall(body):
                stem = re.sub(r"(Edit|Slider|Check|Box)$", "", name).lower()
                label = own or titles.get(stem + "title") or titles.get(stem) or last_text
                if not label:
                    continue
                key = var.lower()
                entry = out.setdefault(key, {"labels": [], "panel": panel})
                if label not in entry["labels"] and len(entry["labels"]) < 4:
                    entry["labels"].append(label)
    for entry in out.values():
        entry["label"] = " / ".join(entry["labels"])
    return out


# ---------------------------------------------------------------------------
# Reference assembly
# ---------------------------------------------------------------------------

def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _leaf_words(leaf: str) -> str:
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", leaf).replace("_", " ").lower()
    return words


def _inferred_text(path: str, leaf: str, kind: str, vtype: str | None) -> str:
    scope = path.rsplit(".", 1)[0] if "." in path else path
    words = _leaf_words(leaf)
    low = leaf.lower()
    m = re.fullmatch(r"(.+?)color([rgba])", low)
    if m:
        channel = {"r": "red", "g": "green", "b": "blue", "a": "alpha"}[m.group(2)]
        return f"The {channel} channel (0-255) of the {_leaf_words(m.group(1))} color in `{scope}`."
    if low.endswith("color"):
        return f"The {_leaf_words(leaf[:-5]) or scope} color; set with four 0-255 values `R G B A`."
    if kind == "command":
        if low == "toggle":
            return f"Toggles `{scope}` on and off."
        if low in ("save", "load"):
            return f"{leaf.capitalize()}s the `{scope}` settings file."
        return f"Command `{leaf}` in the `{scope}` scope; takes arguments in the usual `name value` form."
    if low == "enable":
        return f"Enables (1) or disables (0) `{scope}`."
    if low == "select":
        return f"Selects the active `{scope}` slot by index."
    if low in ("texture", "texturename"):
        return f"Texture file used by `{scope}`."
    if low.startswith("ivar") or low.startswith("svar"):
        return ("Per-session game variable exposed to mission scripts and the lobby options "
                "screens (`ivar` integer, `svar` string); the index is the slot number.")
    if low.startswith("civar") or low.startswith("csvar"):
        return "Client-side copy of the matching session variable (`ivar` / `svar`)."
    hint = {"int": "an integer", "float": "a number", "string": "a string"}.get(vtype or "", "a value")
    return f"`{words}` setting of `{scope}` ({hint})."


def _format_index(formats: list[str]) -> dict[str, list[str]]:
    """normalized leading phrase -> format strings (`fogMode = %d...`)."""
    index: dict[str, list[str]] = {}
    for text in formats:
        head = re.split(r"\s*(=|:|\bis\b)", text, maxsplit=1)[0]
        key = _norm(head)
        if 3 <= len(key) <= 40:
            index.setdefault(key, []).append(text)
    return index


def _explain(path: str, leaf: str, kind: str, vtype: str | None, example: str | None,
             notes: dict, gameprefs: dict, labels: dict, formats: dict, usage: dict) -> dict:
    """Return {tier, paragraphs[], usage_lines[], labels[]} for one entry."""
    key = path.lower()
    ns = key.split(".", 1)[0]
    paragraphs: list[tuple[str, str]] = []  # (tier, text)

    note = notes.get(key)
    if note:
        paragraphs.append((note.get("tier", "verified"), note["text"]))
        if note.get("example") is not None:
            example = str(note["example"])

    if ns == "gameprefs":
        pref = gameprefs.get(leaf.lower())
        if pref and pref.get("comment"):
            paragraphs.append(("engine", f"GamePrefs.ini: {pref['comment']}"
                               + (f" Default `{pref['default']}`." if pref.get("default") else "")))

    label = labels.get(key)
    if label:
        paragraphs.append(("engine", f'Editor {label["panel"]} panel control "{label["label"]}".'))

    # A bare leaf only matches when it is distinctive (`fogrange`, `visibilityrange`);
    # short generic leaves (`flags`, `height`) need the scope word in front
    # (`sun angle`, `terrain diffuse color`).
    fmt_hits: list[str] = []
    if len(_norm(leaf)) >= 7:
        fmt_hits = list(formats.get(_norm(leaf)) or [])
    scope_word = path.rsplit(".", 1)[0].split(".")[-1] if "." in path else ""
    if scope_word:
        for f in formats.get(_norm(scope_word + leaf)) or []:
            if f not in fmt_hits:
                fmt_hits.append(f)
    fmt_hits = [f for f in fmt_hits if len(f) <= 160][:3]
    if fmt_hits:
        quoted = "; ".join(f"`{f}`" for f in fmt_hits)
        paragraphs.append(("engine", f"Prints {quoted}."))

    use = usage.get(key)
    usage_lines: list[str] = []
    if use:
        files = use["cmd_files"] + [f for f in use["usevar_files"] if f not in use["cmd_files"]]
        if use["examples"]:
            usage_lines.extend(use["examples"])
        where = ", ".join(sorted(set(files))[:4])
        if where:
            verb = "invoked" if use["cmd_files"] else "bound to a control"
            paragraphs.append(("usage", f"Shell config: {verb} in {where}."))

    if not paragraphs:
        paragraphs.append(("inferred", _inferred_text(path, leaf, kind, vtype)))

    tier = min((t for t, _ in paragraphs), key=lambda t: TIER_RANK.get(t, 9))
    return {"tier": tier, "paragraphs": paragraphs, "usage_lines": usage_lines, "example": example}


def _scope_order(dump: dict) -> list[str]:
    """Namespaces in theme order, each followed by its scopes depth-first."""
    scopes = dump["scopes"]
    order: list[str] = []

    def walk(path: str) -> None:
        order.append(path)
        for child in scopes.get(path, {}).get("children", []):
            walk(f"{path}.{child}")

    names = [ns for ns in THEME_ORDER if ns in scopes] + [ns for ns in dump["namespaces"] if ns not in THEME_ORDER]
    for ns in names:
        walk(ns)
    return order


FAMILY_MIN = 4
FAMILY_RE = re.compile(r"^([A-Za-z_]+?)(\d+)$")


def _scope_rows(scope: dict) -> list[tuple]:
    """Rows `(leaf, kind, type, example, members)` for one scope.

    Numbered variable families (`ivar0 … ivar383`, `entry0 … entry31`,
    `hull0 … hull9`) with FAMILY_MIN+ members of one type collapse into a
    single `prefixN` row whose `members` lists every slot, so search still
    finds `ivar66` while the page shows one entry.
    """
    rows: list[tuple] = []
    for cmd in scope["commands"]:
        rows.append((cmd, "command", None, None, None))
    families: dict[tuple[str, str], list[tuple[int, str]]] = {}
    for var, meta in scope["variables"].items():
        m = FAMILY_RE.match(var)
        if m:
            families.setdefault((m.group(1), meta.get("type") or ""), []).append((int(m.group(2)), var))
    collapsed: dict[str, tuple[str, str]] = {}
    for (prefix, vtype), members in families.items():
        if len(members) >= FAMILY_MIN:
            for _, var in members:
                collapsed[var] = (prefix, vtype)
    emitted: set[tuple[str, str]] = set()
    for var, meta in scope["variables"].items():
        if var in collapsed:
            key = collapsed[var]
            if key in emitted:
                continue
            emitted.add(key)
            members = [v for _, v in sorted(families[key])]
            rows.append((key[0] + "N", "variable", key[1] or None, None, members))
            continue
        rows.append((var, "variable", meta.get("type"), meta.get("example"), None))
    return rows


def _anchor(path: str, leaf: str | None = None) -> str:
    base = SECTION_PREFIX + re.sub(r"[^a-z0-9]+", "-", path.lower()).strip("-")
    if leaf:
        base += "-" + re.sub(r"[^a-z0-9]+", "-", leaf.lower()).strip("-")
    return base


def build_reference(dump: dict, exe: dict, usage: dict, gameprefs: dict, labels: dict,
                    notes: dict) -> tuple[dict, str]:
    """Return (guide-schema document, markdown text)."""
    scopes = dump["scopes"]
    formats = _format_index(exe.get("formats") or [])
    entry_notes = notes.get("entries", {})
    scope_notes = notes.get("scopes", {})
    exe_dotted = exe.get("dotted") or {}

    sections: list[dict] = []
    entries: list[dict] = []
    md: list[str] = []
    stats = {"commands": 0, "variables": 0, "scopes": 0, "tiers": {}}

    version = exe.get("file_version") or "unknown"
    today = _dt.date.today().isoformat()
    provenance = {
        "title": "BZCC console command reference",
        "game_version": version,
        "exe_path": exe.get("path"),
        "exe_sha256": exe.get("sha256"),
        "dump_dates": dump.get("captured_on", []),
        "built": today,
        "method": dump.get("method"),
        "limitations": (
            "Names come from the in-game listings; the executable's string table "
            "only cross-checks them. Bare commands with no namespace (such as `ls`) "
            "are listed only where observed. Explanations carry an evidence tier; "
            "an `inferred` tier is a reading of the name, not a verified behaviour."
        ),
    }

    # --- Using the console -------------------------------------------------
    intro_id = SECTION_PREFIX + "using-the-console"
    intro_blocks = [
        {"kind": "para", "text": (
            "Battlezone: Combat Commander has a built-in console whose variables and "
            "commands are grouped into namespaces. This reference lists every one the "
            "game reported, captured from the console itself (BZCC " + version + ") and "
            "cross-checked against the executable, the shell configuration files and "
            "the map editor panels.")},
        {"kind": "subhead", "text": "Reading a listing", "anchor": intro_id + "-reading"},
        {"kind": "list", "items": [
            {"text": "`ls` prints the namespaces: " + ", ".join(f"`{n}`" for n in dump["namespaces"]) + ".", "children": []},
            {"text": "Typing a namespace or scope name on its own (`sky`, `network.session`) lists its members: `Cmd name` is a command, `name = value` is a variable, and `[sub]` is a nested scope you list the same way.", "children": []},
            {"text": "Typing a variable name prints its value; typing it followed by a value sets it (`sun.angle 12` moves the sun to noon). Commands may take arguments in the same way.", "children": []},
            {"text": "Statements end with `;`. `ls sky` and `help` are syntax errors (\"Expecting ';'\"); use the bare name instead.", "children": []},
            {"text": "`console.log` toggles file logging. While on, every console line is written to the session log (`Battlezone <date>.log` in `My Games\\Battlezone Combat Commander`, which may sit under OneDrive) as `DIAG| console:NNN |time|tick|text`.", "children": []},
        ]},
        {"kind": "subhead", "text": "Evidence tiers", "anchor": intro_id + "-tiers"},
        {"kind": "para", "text": (
            "Each entry names where its explanation comes from. **Verified in-game**: checked "
            "in the running game or decoded from map files and confirmed by the console. "
            "**Engine text**: the game's own output format, editor panel label or GamePrefs.ini "
            "comment. **Usage context**: how the shell configuration files invoke it. "
            "**Inferred**: a reading of the name only; treat as a hypothesis. "
            "**Community knowledge**: documented by players, not re-verified here.")},
        {"kind": "subhead", "text": "Map of the namespaces", "anchor": intro_id + "-map"},
        {"kind": "list", "items": [
            {"text": f"**{theme}**: " + ", ".join(f"`{ns}` ({desc})" for ns, desc in items), "children": []}
            for theme, items in THEMES
        ]},
        {"kind": "subhead", "text": "Provenance", "anchor": intro_id + "-provenance"},
        {"kind": "list", "items": [
            {"text": f"Game version `{version}`" + (f", executable SHA-256 `{exe['sha256'][:16]}…`" if exe.get("sha256") else "") + ".", "children": []},
            {"text": "Console dump captured " + ", ".join(dump.get("captured_on") or ["(date unknown)"]) + "; reference built " + today + ".", "children": []},
            {"text": provenance["limitations"], "children": []},
        ]},
    ]
    sections.append({"id": intro_id, "title": "Using the console", "group": GROUP_TITLE,
                     "linkify": False, "blocks": intro_blocks})
    entries.append({"kind": "intro", "names": [], "label": "", "default": None,
                    "text": intro_blocks[0]["text"], "anchor": intro_id, "section": intro_id})

    md.append("# BZCC console command reference\n")
    md.append(f"Generated by `scripts/extract_console_reference.py` on {today} from BZCC {version} "
              f"(executable SHA-256 `{exe.get('sha256') or 'n/a'}`). Console dump captured "
              f"{', '.join(dump.get('captured_on') or ['n/a'])}.\n")
    md.append(provenance["limitations"] + "\n")
    md.append("## Using the console\n")
    for item in intro_blocks[2]["items"]:
        md.append(f"- {item['text']}")
    md.append("")
    md.append("Evidence tiers: " + "; ".join(f"**{k}** = {v}" for k, v in TIER_LABEL.items()) + ".\n")

    # --- One section per namespace -----------------------------------------
    order = _scope_order(dump)
    by_ns: "OrderedDict[str, list[str]]" = OrderedDict()
    for path in order:
        by_ns.setdefault(path.split(".", 1)[0], []).append(path)

    for ns, paths in by_ns.items():
        section_id = SECTION_PREFIX + ns
        desc = DESCRIPTOR.get(ns, "")
        title = f"{ns} — {desc}" if desc else ns
        blocks: list[dict] = []
        md.append(f"## {title}\n")
        intro = scope_notes.get(ns)
        if intro:
            blocks.append({"kind": "para", "text": intro})
            md.append(intro + "\n")
        ns_scope = scopes[ns]
        if not ns_scope["commands"] and not ns_scope["variables"] and not ns_scope["children"]:
            text = f"`{ns}` lists no commands or variables."
            blocks.append({"kind": "para", "text": text})
            md.append(text + "\n")

        for path in paths:
            scope = scopes[path]
            stats["scopes"] += 1
            if path != ns:
                sub_anchor = _anchor(path)
                heading = path
                if scope.get("inferred_from"):
                    heading += f" (same shape as {scope['inferred_from']})"
                blocks.append({"kind": "subhead", "text": heading, "anchor": sub_anchor})
                entries.append({"kind": "heading", "names": [path], "label": path, "default": None,
                                "text": "", "anchor": sub_anchor, "section": section_id})
                md.append(f"### {heading}\n")
                sub_intro = scope_notes.get(path)
                if sub_intro:
                    blocks.append({"kind": "para", "text": sub_intro})
                    md.append(sub_intro + "\n")
            if scope.get("example_map") and scope["variables"]:
                ctx = f"Example values below were read on `{scope['example_map']}`."
                blocks.append({"kind": "para", "text": ctx})
                md.append(ctx + "\n")

            rows = _scope_rows(scope)
            if not rows:
                continue
            md.append("| Name | Kind | Type | Example | What it does | Evidence |")
            md.append("|---|---|---|---|---|---|")
            for row in rows:
                leaf, kind, vtype, example, members = row
                full = f"{path}.{leaf}"
                info = _explain(full, leaf, kind, vtype, example, entry_notes, gameprefs, labels, formats, usage)
                example = info["example"]
                if members:
                    stats["variables"] += len(members)
                else:
                    stats["commands" if kind == "command" else "variables"] += 1
                stats["tiers"][info["tier"]] = stats["tiers"].get(info["tier"], 0) + 1
                prop_blocks: list[dict] = []
                if members:
                    prop_blocks.append({"kind": "para", "text": (
                        f"{len(members)} numbered slots: `{members[0]}` … `{members[-1]}`. "
                        "One entry stands for the whole family.")})
                for tier, text in info["paragraphs"]:
                    prop_blocks.append({"kind": "para", "text": text})
                usage_text = "\n".join(info["usage_lines"][:3]) if info["usage_lines"] else (
                    full if kind == "command" else f"{full}" + (f"   // prints the current value, e.g. {example}" if example is not None else ""))
                prop_blocks.append({"kind": "code", "text": usage_text})
                prop_blocks.append({"kind": "note", "text": f"Evidence: {TIER_LABEL[info['tier']]}."})
                chip = example if example is not None else (vtype or "")
                if kind == "command":
                    chip = "command"
                names = [f"{path}.{m}" for m in members] if members else [full]
                label = f"{path}.{leaf} ({len(members)} slots)" if members else full
                block = {
                    "kind": "property",
                    "names": names,
                    "label": label,
                    "default": chip,
                    "anchor": _anchor(path, leaf),
                    "tier": info["tier"],
                    "entry_kind": kind,
                    "value_type": vtype,
                    "blocks": prop_blocks,
                }
                blocks.append(block)
                summary = " ".join(t for _, t in info["paragraphs"])
                entries.append({"kind": "property", "names": names, "label": label, "default": chip,
                                "text": summary, "anchor": block["anchor"], "section": section_id})
                cell = summary.replace("|", "\\|").replace("\n", " ")
                ex = ("`" + example.replace("|", "\\|") + "`") if example is not None else ""
                md.append(f"| `{label}` | {kind} | {vtype or ''} | {ex} | {cell} | {TIER_LABEL[info['tier']]} |")
            md.append("")

        # Names the executable registers under this namespace that no listing showed.
        listed_names = set()
        for path in paths:
            scope = scopes[path]
            for cmd in scope["commands"]:
                listed_names.add(f"{path}.{cmd}".lower())
            for var in scope["variables"]:
                listed_names.add(f"{path}.{var}".lower())
            listed_names.add(path.lower())
        exe_only = sorted(
            meta["name"] for key, meta in exe_dotted.items()
            if key.split(".", 1)[0] == ns and key not in listed_names
        )
        if exe_only:
            blocks.append({"kind": "subhead", "text": "Also present in the executable",
                           "anchor": _anchor(ns, "exe-only")})
            blocks.append({"kind": "para", "text": (
                "Identifiers the executable registers under this namespace that no console "
                "listing showed (hidden, runtime-built, or control names). Unverified.")})
            blocks.append({"kind": "list", "items": [{"text": f"`{n}`", "children": []} for n in exe_only]})
            md.append("Also present in the executable (not listed by the console): "
                      + ", ".join(f"`{n}`" for n in exe_only) + "\n")

        sections.append({"id": section_id, "title": title, "group": GROUP_TITLE,
                         "linkify": False, "blocks": blocks})

    # --- Console output formats --------------------------------------------
    fmt_id = SECTION_PREFIX + "output-formats"
    fmt_strings = [f for f in (exe.get("formats") or []) if _looks_like_console_output(f)]
    if fmt_strings:
        blocks = [
            {"kind": "para", "text": (
                "Output and help strings found in the executable that the console commands print. "
                "They are stored apart from the names they belong to, so the pairing above is by "
                "matching words only; this is the complete list for reference.")},
            {"kind": "code", "text": "\n".join(fmt_strings)},
        ]
        sections.append({"id": fmt_id, "title": "Console output formats", "group": GROUP_TITLE,
                         "linkify": False, "blocks": blocks})
        entries.append({"kind": "heading", "names": ["output formats"], "label": "Console output formats",
                        "default": None, "text": "", "anchor": fmt_id, "section": fmt_id})
        md.append("## Console output formats\n")
        md.append("```\n" + "\n".join(fmt_strings) + "\n```\n")

    md.append(f"_{stats['commands']} commands and {stats['variables']} variables across "
              f"{stats['scopes']} scopes; tiers: "
              + ", ".join(f"{k} {v}" for k, v in sorted(stats["tiers"].items())) + "._\n")

    doc = {
        "schema_version": REFERENCE_SCHEMA,
        "source": provenance,
        "groups": [GROUP_TITLE],
        "sections": sections,
        "entries": entries,
        "stats": stats,
    }
    return doc, "\n".join(md)


def _looks_like_console_output(text: str) -> bool:
    """Console readouts (`fogColor = %.0f %.0f %.0f RGB`), not engine log lines."""
    if re.match(r"^[A-Za-z][A-Za-z0-9 ]{1,40}\s*=\s*(at )?%", text):
        return True
    return bool(re.match(
        r"^(Console file logging is now|Loaded %s\.sky|Saved %s\.sky|Failed Save %s\.sky|"
        r"underwater fog is|local fog %s|top fog end|bottom fog end|exponent fog density|"
        r"fog break =|Sun period %f is too small|Command 'fog\.new')",
        text,
    ))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _load_notes() -> dict:
    if not NOTES_PATH.is_file():
        return {"scopes": {}, "entries": {}}
    data = json.loads(NOTES_PATH.read_text(encoding="utf-8"))
    entries = {k.lower(): v for k, v in (data.get("entries") or {}).items()}
    return {"scopes": data.get("scopes") or {}, "entries": entries}


def main() -> None:
    ap = argparse.ArgumentParser(description="Build the BZCC console command reference")
    ap.add_argument("--console-log", action="append", default=[],
                    help="session log with console file logging on (repeatable)")
    ap.add_argument("--log-dir", default=None,
                    help="folder of session logs; every Battlezone*.log that contains console lines is used")
    ap.add_argument("--bz2r", default=str(DEFAULT_BZ2R), help="BZCC install (the BZ2R folder)")
    ap.add_argument("--dump-only", action="store_true", help="write the scrubbed dump and stop")
    args = ap.parse_args()

    bz2r = Path(args.bz2r)
    if not bz2r.is_dir():
        print(f"warn: BZ2R not found at {bz2r}; building from the dump and notes only")
        bz2r = None
    exe = harvest_exe(bz2r / "battlezone2.exe" if bz2r else None)
    exe_names = set(exe.get("dotted") or {})

    logs = [Path(p) for p in args.console_log]
    if args.log_dir:
        folder = Path(args.log_dir)
        for p in sorted(folder.glob("Battlezone*.log"), key=lambda p: p.stat().st_mtime):
            if re.search(rb"\|\s*console:\d+\s*\|", p.read_bytes()):
                logs.append(p)
    if logs:
        missing = [p for p in logs if not p.is_file()]
        if missing:
            raise SystemExit("missing log(s): " + ", ".join(str(p) for p in missing))
        print(f"parsing {len(logs)} session log(s)")
        dump = parse_console_logs(logs, exe_names)
        DUMP_PATH.parent.mkdir(parents=True, exist_ok=True)
        DUMP_PATH.write_text(json.dumps(dump, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {DUMP_PATH.relative_to(ROOT)}: {len(dump['scopes'])} scopes")
    elif DUMP_PATH.is_file():
        dump = json.loads(DUMP_PATH.read_text(encoding="utf-8"))
        print(f"loaded {DUMP_PATH.relative_to(ROOT)}: {len(dump['scopes'])} scopes")
    else:
        raise SystemExit("no console logs given and no committed dump; pass --console-log")
    if args.dump_only:
        return

    usage = harvest_cfg(bz2r)
    gameprefs = harvest_gameprefs(bz2r)
    labels = harvest_editor_labels(bz2r)
    notes = _load_notes()
    print(f"install: {len(exe_names)} exe identifiers, {len(exe.get('formats') or [])} format strings, "
          f"{len(usage)} cfg-referenced names, {len(gameprefs)} GamePrefs keys, {len(labels)} editor labels; "
          f"notes: {len(notes['entries'])} entries, {len(notes['scopes'])} scope intros")

    doc, markdown = build_reference(dump, exe, usage, gameprefs, labels, notes)
    REFERENCE_JSON.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    REFERENCE_MD.parent.mkdir(parents=True, exist_ok=True)
    REFERENCE_MD.write_text(markdown + "\n", encoding="utf-8")
    stats = doc["stats"]
    print(f"wrote {REFERENCE_JSON.relative_to(ROOT)} and {REFERENCE_MD.relative_to(ROOT)}: "
          f"{stats['commands']} commands, {stats['variables']} variables, {stats['scopes']} scopes, "
          f"tiers {stats['tiers']}")


if __name__ == "__main__":
    main()
