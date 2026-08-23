#!/usr/bin/env python3
"""Synthesize a proto-v3 .binpb.gz fixture from a real v2 session.

The real 2026-08-23 v3 batch covers the happy paths (attested team wins,
phantom roster entries, bullet-hit gap), but NOT the rarer outcome/roster
cases the pipeline must handle. This tool up-converts a genuine v2 session
into a clean v3 file so those paths can be exercised end-to-end before
real data with them exists:

  * --outcome draw / cancelled          (attested no-winner outcomes)
  * --outcome 2                         (out-of-enum, e.g. IDCANCEL from
                                         ESCing the collector's dialog)
  * --phantom                           (adds an invalid-Steam64 garbage
                                         roster entry on an empty slot,
                                         mimicking the observed collector
                                         artifact)
  * --conflict                          (duplicates an occupied slot with a
                                         second VALID Steam64 so the
                                         earliest-UpdateTick tie-break and
                                         match.roster_conflicts fire)

Conversion mechanics: the source bytes are parsed with the CURRENT (v3)
descriptor -- the v2 identity-map fields land in the unknown-field set
(they're `reserved` in v3) and are dropped via DiscardUnknownFields(), so
the output wire bytes carry no legacy map fields, exactly like a real v3
recording. The `players` roster is rebuilt from the source's v2 maps
(parsed separately with the frozen v2 descriptor).

Usage:
  python scripts/dev_make_v3_fixture.py SRC.binpb.gz OUT.binpb.gz \
      [--outcome team1|team2|draw|cancelled|unspecified|<int>] \
      [--phantom] [--conflict]

Output is NOT for committing -- drop it under data/sessions/_v3test/ for a
pipeline run, then delete the folder and its processed outputs.
"""

import argparse
import gzip
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

import statsgate_pb2      # v3 (current)
import statsgate_v2_pb2   # frozen v2 (identity maps readable)

OUTCOME_BY_NAME = {
    "team1":       statsgate_pb2.OUTCOME_TEAM1_WIN,       # 1000
    "team2":       statsgate_pb2.OUTCOME_TEAM2_WIN,       # 1001
    "draw":        statsgate_pb2.OUTCOME_DRAW,            # 1002
    "cancelled":   statsgate_pb2.OUTCOME_GAME_CANCELLED,  # 1003
    "unspecified": 0,
}

# Deliberately invalid Steam64 (fails the (s64 >> 32) == 0x01100001 gate).
# Mirrors the real observed empty-slot artifact 30064771072 == 7 << 32.
PHANTOM_S64 = 7 << 32


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("src", help="source v2 .binpb.gz")
    ap.add_argument("out", help="output v3 .binpb.gz")
    ap.add_argument("--outcome", default="team1",
                    help="team1|team2|draw|cancelled|unspecified|<raw int> (default team1)")
    ap.add_argument("--phantom", action="store_true",
                    help="add an invalid-Steam64 garbage roster entry (empty slot 10)")
    ap.add_argument("--conflict", action="store_true",
                    help="add a second valid Steam64 claiming an occupied slot")
    ap.add_argument("--shift-years", type=int, default=50,
                    help="shift header.start_time forward N years so the fixture's "
                         "match id (derived from start_time) can't collide with the "
                         "real source match (default 50)")
    args = ap.parse_args()

    raw = gzip.open(args.src, "rb").read()

    # Source identity from the frozen v2 descriptor.
    s2 = statsgate_v2_pb2.ClientStatSession()
    s2.ParseFromString(raw)
    if not s2.header.s64_to_nick:
        sys.exit("source file has no v2 identity maps -- is it already v3 or a v1 file?")

    # Re-parse with the v3 descriptor; the map fields (reserved in v3) land
    # in the unknown-field set and are discarded so the output is clean v3.
    s3 = statsgate_pb2.ClientStatSession()
    s3.ParseFromString(raw)
    s3.DiscardUnknownFields()

    # Shift start_time so the derived match id can't collide with the real
    # source match (the pipeline names outputs by start_time).
    if args.shift_years:
        s3.header.start_time.seconds += args.shift_years * 365 * 24 * 3600

    for slot, s64 in sorted(s2.header.teamnum_to_s64.items()):
        p = s3.header.players.add()
        p.steam64 = s64
        p.teamnum = slot
        p.nickname = s2.header.s64_to_nick.get(s64, "")

    if args.phantom:
        p = s3.header.players.add()
        p.steam64 = PHANTOM_S64
        p.teamnum = 10
        p.nickname = "Unknown"

    if args.conflict:
        # Duplicate the first occupied slot with a fresh VALID Steam64 that
        # never appears in the event stream -- the earliest-UpdateTick
        # tie-break must keep the original occupant and record this one in
        # match.roster_conflicts.
        first_slot = sorted(s2.header.teamnum_to_s64)[0]
        p = s3.header.players.add()
        p.steam64 = 76561199999999999  # valid range, unused by real data
        p.teamnum = first_slot
        p.nickname = "SlotThief"

    try:
        outcome = OUTCOME_BY_NAME.get(args.outcome.lower(), None)
        if outcome is None:
            outcome = int(args.outcome)
    except ValueError:
        sys.exit(f"unrecognized --outcome {args.outcome!r}")
    # setattr via merge: proto3 open enums accept out-of-range ints only
    # through serialization, not the generated setter -- write the field
    # raw when the value is outside the enum.
    try:
        s3.header.game_outcome = outcome
    except ValueError:
        # Out-of-enum (e.g. 2 == IDCANCEL): append the varint manually.
        # Field 21, wire type 0 -> tag byte (21 << 3) | 0 = 0xA8, 0x01.
        s3.header.game_outcome = 0
        payload = s3.SerializeToString()
        import io
        def varint(n):
            out = b""
            while True:
                b7 = n & 0x7F
                n >>= 7
                out += bytes([b7 | (0x80 if n else 0)])
                if not n:
                    return out
        # Re-serialize header with the extra field appended, then rebuild
        # the session (header is field 1, length-delimited).
        hdr_bytes = s3.header.SerializeToString() + b"\xa8\x01" + varint(outcome)
        body = b"\x0a" + varint(len(hdr_bytes)) + hdr_bytes
        for evt in s3.event_stream:
            eb = evt.SerializeToString()
            body += b"\x12" + varint(len(eb)) + eb
        Path(args.out).write_bytes(gzip.compress(body))
        print(f"wrote {args.out} (out-of-enum outcome {outcome}, manual wire append)")
        return

    Path(args.out).write_bytes(gzip.compress(s3.SerializeToString()))
    n_players = len(s3.header.players)
    print(f"wrote {args.out}: outcome={outcome} players={n_players} "
          f"phantom={args.phantom} conflict={args.conflict}")


if __name__ == "__main__":
    main()
