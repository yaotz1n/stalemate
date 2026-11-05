#!/usr/bin/env python3
"""Build data/puzzles.db from the Lichess puzzle database.

Download the source (CC0) from https://database.lichess.org/#puzzles:
    lichess_db_puzzle.csv.zst  ->  data/raw/

Then run:
    python3 tools/build_puzzle_db.py data/raw/lichess_db_puzzle.csv.zst

.zst input needs the `zstd` command on PATH; a plain .csv works without it.

Puzzles are filtered for quality, then the best ones in each 100-point rating
bucket are kept so every skill level gets coverage. Pass --target 0 to keep
every puzzle that passes the filters.
"""

import argparse
import csv
import heapq
import io
import math
import os
import sqlite3
import subprocess
import sys
import time

BUCKET_SIZE = 100
MIN_RATING = 400
MAX_RATING = 3200

SCHEMA = """
CREATE TABLE puzzles (
    id TEXT PRIMARY KEY,
    fen TEXT NOT NULL,
    moves TEXT NOT NULL,        -- UCI, space separated; moves[0] is the opponent's setup move
    rating INTEGER NOT NULL,
    rd INTEGER NOT NULL,
    popularity INTEGER NOT NULL,
    nb_plays INTEGER NOT NULL,
    themes TEXT NOT NULL        -- space separated theme names, for display
) WITHOUT ROWID;
CREATE TABLE themes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    count INTEGER NOT NULL
);
CREATE TABLE puzzle_themes (
    theme_id INTEGER NOT NULL,
    puzzle_id TEXT NOT NULL,
    PRIMARY KEY (theme_id, puzzle_id)
) WITHOUT ROWID;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def open_source(path):
    if path.endswith(".zst"):
        proc = subprocess.Popen(["zstd", "-dc", path], stdout=subprocess.PIPE)
        return io.TextIOWrapper(proc.stdout, encoding="utf-8", newline=""), proc
    return open(path, encoding="utf-8", newline=""), None


def quality(popularity, nb_plays):
    # Popularity is the share of upvotes (-100..100); plays add confidence.
    return popularity + 4 * math.log10(nb_plays + 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", help="lichess_db_puzzle.csv(.zst)")
    ap.add_argument("-o", "--output", default=os.path.join("data", "puzzles.db"))
    ap.add_argument("--target", type=int, default=150_000, help="approximate puzzle count (0 = no cap)")
    ap.add_argument("--min-popularity", type=int, default=80)
    ap.add_argument("--min-plays", type=int, default=300)
    ap.add_argument("--max-rd", type=int, default=90, help="skip puzzles whose rating is still uncertain")
    args = ap.parse_args()

    n_buckets = (MAX_RATING - MIN_RATING) // BUCKET_SIZE
    per_bucket = math.ceil(args.target / n_buckets) if args.target else None

    buckets = {}  # bucket -> min-heap of (quality, seq, row)
    kept_all = []
    seen = passed = 0
    started = time.time()

    src, proc = open_source(args.source)
    for rec in csv.DictReader(src):
        seen += 1
        if seen % 500_000 == 0:
            print(f"  read {seen:,} rows, {passed:,} passed filters", file=sys.stderr)
        try:
            rating = int(rec["Rating"])
            rd = int(rec["RatingDeviation"])
            popularity = int(rec["Popularity"])
            plays = int(rec["NbPlays"])
        except (KeyError, ValueError):
            continue
        if popularity < args.min_popularity or plays < args.min_plays or rd > args.max_rd:
            continue
        passed += 1
        row = (rec["PuzzleId"], rec["FEN"], rec["Moves"], rating, rd, popularity, plays, rec["Themes"])
        if per_bucket is None:
            kept_all.append(row)
            continue
        bucket = min(max(rating, MIN_RATING), MAX_RATING - 1) // BUCKET_SIZE
        heap = buckets.setdefault(bucket, [])
        item = (quality(popularity, plays), seen, row)
        if len(heap) < per_bucket:
            heapq.heappush(heap, item)
        elif item > heap[0]:
            heapq.heapreplace(heap, item)
    src.close()
    if proc and proc.wait() != 0:
        sys.exit("zstd failed to decompress the source file")

    rows = kept_all if per_bucket is None else [item[2] for heap in buckets.values() for item in heap]
    print(f"Read {seen:,} puzzles, {passed:,} passed filters, keeping {len(rows):,}", file=sys.stderr)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    tmp = args.output + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript(SCHEMA)

    theme_ids = {}
    theme_counts = {}
    links = []
    for row in rows:
        for name in row[7].split():
            tid = theme_ids.setdefault(name, len(theme_ids) + 1)
            theme_counts[tid] = theme_counts.get(tid, 0) + 1
            links.append((tid, row[0]))

    db.executemany("INSERT INTO puzzles VALUES (?,?,?,?,?,?,?,?)", rows)
    db.executemany(
        "INSERT INTO themes VALUES (?,?,?)",
        [(tid, name, theme_counts[tid]) for name, tid in theme_ids.items()],
    )
    db.executemany("INSERT INTO puzzle_themes VALUES (?,?)", links)
    db.execute("CREATE INDEX idx_puzzles_rating ON puzzles(rating)")
    db.executemany(
        "INSERT INTO meta VALUES (?,?)",
        [
            ("source", "Lichess puzzle database (CC0), https://database.lichess.org"),
            ("built", time.strftime("%Y-%m-%d")),
            ("count", str(len(rows))),
            ("schema_version", "1"),
        ],
    )
    db.commit()
    db.execute("ANALYZE")
    db.execute("VACUUM")
    db.close()
    os.replace(tmp, args.output)

    size_mb = os.path.getsize(args.output) / 1_000_000
    print(f"Wrote {args.output} ({size_mb:.1f} MB) in {time.time() - started:.0f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
