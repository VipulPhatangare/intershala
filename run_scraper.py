"""Command line entry point.

    python run_scraper.py login                     one-time manual sign-in
    python run_scraper.py check                     is the saved session still good?
    python run_scraper.py fast --source all         parallel scrape -> MongoDB
    python run_scraper.py mongo                     inspect the MongoDB copy
    python run_scraper.py scrape --source all       slow browser path (fallback)
    python run_scraper.py show                      print what has been collected
    python run_scraper.py samples                   dump HTML for pinning selectors
    python run_scraper.py export                    rebuild the CSV from the JSONL
    python run_scraper.py status                    show the last run's state
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import pandas as pd
from playwright.sync_api import sync_playwright

from scraper.config import (
    CSV_PATH,
    DATA_DIR,
    DETAIL_CONCURRENCY,
    JSONL_PATH,
    LISTING_CONCURRENCY,
    LISTINGS,
    PID_PATH,
    SESSION_PATH,
    SOURCES,
    VERSION,
)
from scraper.errors import AuthExpired, NoSession
from scraper.progress import read_state
from scraper.run import capture_samples, scrape
from scraper.session import _new_context, launch_browser, manual_login, probe_session
from scraper.store import JobStore, export_csv, to_dataframe


def cmd_login(args: argparse.Namespace) -> int:
    with sync_playwright() as pw:
        browser = launch_browser(pw, headless=False)
        ctx = _new_context(browser, use_session=False)
        manual_login(ctx)
        ctx.close()
        browser.close()
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    """Report whether the saved session works — without ever deleting it."""
    if not SESSION_PATH.exists():
        print(f"No session file at {SESSION_PATH}. Run `python run_scraper.py login`.")
        return 1

    with sync_playwright() as pw:
        browser = launch_browser(pw, headless=not args.headed)
        ctx = _new_context(browser, use_session=True)
        ok, details = probe_session(ctx, save_debug=True)
        ctx.close()
        browser.close()

    mode = "headed" if args.headed else "headless"
    print(f"session file : {SESSION_PATH}")
    print(f"browser mode : {mode}")
    print(f"verdict      : {details.get('verdict')}\n")
    for attempt in details["attempts"]:
        print(f"  {attempt['requested']}")
        if "error" in attempt:
            print(f"     error: {attempt['error']}")
            continue
        print(f"     landed on : {attempt['landed']}")
        print(f"     title     : {attempt['title']}")
        print(f"     signed-in markers  : {attempt['in'] or '(none)'}")
        print(f"     signed-out markers : {attempt['out'] or '(none)'}")
    if details.get("debug_html"):
        print(f"\nPage HTML saved to {details['debug_html']}")
        if not args.headed:
            print("If this says signed out, try: python run_scraper.py check --headed")
    return 0 if ok else 1


def cmd_scrape(args: argparse.Namespace) -> int:
    sources = sorted(LISTINGS) if args.source == "all" else [args.source]
    if args.url and len(sources) > 1:
        print("--url applies to a single listing; pass --source internships or jobs.")
        return 2

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PID_PATH.write_text(str(os.getpid()), encoding="utf-8")
    states = []
    try:
        for index, source in enumerate(sources):
            if len(sources) > 1:
                print(f"\n{'=' * 60}\n  {source}\n{'=' * 60}")
            
            target_url = args.url
            if getattr(args, "keyword", None):
                target_url = f"https://internshala.com/{source}/keywords-{args.keyword.strip().lower()}"

            states.append(
                scrape(
                    source=source,
                    url=target_url,
                    max_pages=args.max_pages,
                    max_jobs=args.max_jobs,
                    headless=not args.headed,
                    allow_login=not args.no_login,
                    # --fresh clears the store once, before the first source;
                    # later sources must append or they would wipe it again.
                    resume=(not args.fresh) or index > 0,
                    details=not args.no_details,
                    include_raw=args.include_raw,
                )
            )
    finally:
        PID_PATH.unlink(missing_ok=True)

    print()
    for source, state in zip(sources, states):
        print(
            f"{source:12} {state['status']:12} "
            f"{state['processed']} processed, {state['failed']} failed, "
            f"{state['duplicates']} duplicates, {state['elapsed']:.0f}s"
        )
        if state.get("message"):
            print(f"{'':12} {state['message']}")
    return 0 if all(s["status"] == "done" for s in states) else 1


def cmd_fast(args: argparse.Namespace) -> int:
    """The parallel path: no browser, concurrent pages + details, into Mongo."""
    from scraper.fast import scrape_parallel

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PID_PATH.write_text(str(os.getpid()), encoding="utf-8")
    started = time.time()

    max_pages = args.max_pages
    recent_hours = getattr(args, "recent_hours", 0) or 0
    if recent_hours > 0 and max_pages == 0:
        # Approximate pages based on recent hours window (1 page = ~40 listings ordered by date)
        if recent_hours <= 12:
            max_pages = 2
        elif recent_hours <= 24:
            max_pages = 3
        elif recent_hours <= 36:
            max_pages = 4
        elif recent_hours <= 48:
            max_pages = 5
        elif recent_hours <= 72:
            max_pages = 8
        else:
            max_pages = 10

    try:
        summaries = scrape_parallel(
            source=args.source,
            listing_concurrency=args.listing_concurrency,
            detail_concurrency=args.concurrency,
            max_pages=max_pages,
            with_details=not args.no_details,
            resume=not args.fresh,
            use_mongo=not args.no_mongo,
        )
    except NoSession as exc:
        print(f"\n{exc}")
        return 1
    except AuthExpired as exc:
        print(f"\nSession expired: {exc}\nRun `python run_scraper.py login`.")
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted — everything already fetched is saved.")
        return 130
    finally:
        PID_PATH.unlink(missing_ok=True)

    total = sum(s["written"] for s in summaries)
    elapsed = time.time() - started
    print(f"\n{'=' * 62}")
    for s in summaries:
        print(
            f"  {s['source']:14} {s['written']:>6} written  "
            f"{s['failed']:>4} failed  {s['requests']:>6} requests  "
            f"{s['elapsed']:>6.0f}s"
        )
    print(f"  {'TOTAL':14} {total:>6} records in {elapsed:.0f}s")

    if not args.no_csv:
        path, rows = export_csv(include_raw=args.include_raw)
        print(f"\nCSV: {rows} rows -> {path}")
    return 0


def cmd_mongo(args: argparse.Namespace) -> int:
    """Inspect the local Mongo copy, or backfill it from the JSONL."""
    from scraper.fast import sync_jsonl_to_mongo
    from scraper.mongo import MongoStore

    if args.sync:
        written = sync_jsonl_to_mongo()
        for source, count in written.items():
            print(f"  {source:14} {count} upserted from {JSONL_PATH.name}")
        return 0

    store = MongoStore()
    try:
        print(f"MongoDB {store.ping()} at {store.uri}")
    except Exception as exc:
        print(f"Cannot reach MongoDB at {store.uri}: {exc}")
        return 1

    print(f"database: {store.db_name}\n")
    for source, count in store.counts().items():
        coll = store.db[source]
        done = coll.count_documents({"status": "ok"})
        print(f"  {source:14} {count:>6} documents  ({done} with full details)")
        top = coll.aggregate([
            {"$group": {"_id": "$company", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
            {"$limit": args.top},
        ])
        for row in top:
            if row["_id"]:
                print(f"      {str(row['_id'])[:44]:44} {row['n']}")
    store.close()
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    rows = JobStore().read_all()
    if not rows:
        print(f"Nothing collected yet ({JSONL_PATH} is empty or missing).")
        return 1

    df = to_dataframe(rows)
    df = df.drop(columns=[c for c in df.columns if c.startswith("raw_")], errors="ignore")

    print(f"\n{len(df)} jobs collected  ->  {JSONL_PATH}")
    if CSV_PATH.exists():
        print(f"{'':>{len(str(len(df)))}} CSV: {CSV_PATH}")

    for column, title in (("source", "By source"), ("status", "By status")):
        if column in df.columns:
            counts = df[column].value_counts()
            print(f"\n{title}:")
            for key, count in counts.items():
                print(f"  {str(key):20} {count}")

    if "company" in df.columns:
        top = df["company"].replace("", pd.NA).dropna().value_counts().head(args.top)
        if not top.empty:
            print(f"\nTop {len(top)} companies:")
            for name, count in top.items():
                print(f"  {str(name)[:44]:44} {count}")

    view = df
    if args.source and "source" in view.columns:
        view = view[view["source"] == args.source]
    if args.failed_only and "status" in view.columns:
        view = view[view["status"] == "failed"]
    if args.search:
        hay = view.astype(str).agg(" ".join, axis=1).str.lower()
        view = view[hay.str.contains(args.search.lower(), regex=False)]

    if args.columns:
        columns = [c.strip() for c in args.columns.split(",") if c.strip() in view.columns]
    else:
        columns = [
            c
            for c in ("title", "company", "location", "stipend", "salary",
                      "duration", "apply_by", "status")
            if c in view.columns
        ]
    if not columns:
        print("\nNone of the requested columns exist. Available:")
        print("  " + ", ".join(view.columns))
        return 1

    table = view[columns].copy()
    if args.limit:
        table = table.head(args.limit)
    if not args.full:
        # Keep rows on one terminal line; --full turns this off.
        table = table.map(lambda v: (str(v)[:30] + "…") if len(str(v)) > 31 else str(v))

    print(f"\nShowing {len(table)} of {len(view)} matching rows:\n")
    with pd.option_context("display.max_rows", None, "display.width", None,
                           "display.max_colwidth", None):
        print(table.to_string(index=False))

    if len(view) > len(table):
        print(f"\n… {len(view) - len(table)} more. Use --limit 0 for everything.")
    print(f"\nFull detail per job: open {CSV_PATH} or run `python -m streamlit run dashboard.py`")
    return 0


def cmd_samples(args: argparse.Namespace) -> int:
    for path in capture_samples(args.source, headless=not args.headed):
        print("wrote", path)
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    source_rows = None
    origin = JSONL_PATH.name
    if args.from_mongo:
        from scraper.mongo import MongoStore

        store = MongoStore()
        try:
            store.ping()
        except Exception as exc:
            print(f"Cannot reach MongoDB: {exc}")
            return 1
        source_rows = store.read_all()
        store.close()
        origin = "MongoDB"

    path, rows = export_csv(rows=source_rows, include_raw=args.include_raw)
    print(f"Wrote {rows} rows to {path} (from {origin})")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    state = read_state()
    print(json.dumps(state, indent=2) if state else "No run recorded yet.")
    print("session:", "saved" if SESSION_PATH.exists() else "missing")
    return 0


def cmd_web(args: argparse.Namespace) -> int:
    """Launch the Web Dashboard and 36-hour Auto Scraper."""
    from web.app import app
    host = getattr(args, "host", "0.0.0.0")
    port = getattr(args, "port", 5000)
    print(f"\n========================================================")
    print(f"  Internshala Live Hub & 36h Auto Scraper")
    print(f"  Access UI at: http://localhost:{port}")
    print(f"========================================================\n")
    app.run(host=host, port=port, debug=args.debug)
    return 0


def main(argv: list[str] | None = None) -> int:
    # Windows consoles default to cp1252, which cannot encode the rupee sign
    # that shows up in every stipend we print.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser(description=f"Internshala scraper v{VERSION}")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("web", help="start the web dashboard and 36h auto scraper")
    p.add_argument("--host", default="0.0.0.0", help="host address (default 0.0.0.0)")
    p.add_argument("--port", type=int, default=4000, help="port (default 4000)")
    p.add_argument("--debug", action="store_true", help="run flask in debug mode")
    p.set_defaults(func=cmd_web)


    sub.add_parser("login", help="sign in once and save the session").set_defaults(
        func=cmd_login
    )

    p = sub.add_parser("check", help="test the saved session without deleting it")
    p.add_argument("--headed", action="store_true", help="check with a visible browser")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("scrape", help="collect listings and details")
    p.add_argument("--source", choices=[*sorted(LISTINGS), "all"], default="internships")
    p.add_argument("--url", help="scrape a specific listing URL (filters, search, etc.)")
    p.add_argument("--keyword", help="scrape a specific category/field keyword (e.g. python, web-development, data-science, finance)")
    p.add_argument("--max-pages", type=int, default=0, help="0 = all pages")
    p.add_argument("--max-jobs", type=int, default=0, help="0 = no cap")
    p.add_argument("--headed", action="store_true", help="show the browser window")
    p.add_argument("--fresh", action="store_true", help="ignore and overwrite stored jobs")
    p.add_argument("--no-details", action="store_true", help="listing fields only")
    p.add_argument("--no-login", action="store_true", help="fail instead of prompting")
    p.add_argument("--include-raw", action="store_true", help="keep raw_* columns in the CSV")
    p.set_defaults(func=cmd_scrape)

    p = sub.add_parser(
        "fast",
        help="parallel scrape (no browser) into MongoDB — use this one",
    )
    p.add_argument("--source", choices=[*SOURCES, "all"], default="all")
    p.add_argument("--concurrency", type=int, default=DETAIL_CONCURRENCY,
                   help=f"parallel detail fetches (default {DETAIL_CONCURRENCY})")
    p.add_argument("--listing-concurrency", type=int, default=LISTING_CONCURRENCY,
                   help=f"parallel listing pages (default {LISTING_CONCURRENCY})")
    p.add_argument("--max-pages", type=int, default=0, help="0 = every page")
    p.add_argument("--recent-hours", type=float, default=0, help="target hours window for scraping (e.g. 12, 24, 36, 48)")
    p.add_argument("--fresh", action="store_true",
                   help="re-fetch everything instead of skipping stored ids")
    p.add_argument("--no-details", action="store_true", help="listing fields only")
    p.add_argument("--no-mongo", action="store_true", help="JSONL only")
    p.add_argument("--no-csv", action="store_true", help="skip the CSV export")
    p.add_argument("--include-raw", action="store_true")
    p.set_defaults(func=cmd_fast)

    p = sub.add_parser("mongo", help="inspect or backfill the MongoDB copy")
    p.add_argument("--sync", action="store_true",
                   help="replay the JSONL checkpoint into MongoDB")
    p.add_argument("--top", type=int, default=5, help="companies to list per section")
    p.set_defaults(func=cmd_mongo)

    p = sub.add_parser("show", help="print collected jobs in the terminal")
    p.add_argument("--limit", type=int, default=40, help="rows to print; 0 = all")
    p.add_argument("--columns", help="comma-separated column names")
    p.add_argument("--source", choices=sorted(LISTINGS), help="filter by listing")
    p.add_argument("--search", help="substring match across every field")
    p.add_argument("--failed-only", action="store_true")
    p.add_argument("--full", action="store_true", help="do not truncate cells")
    p.add_argument("--top", type=int, default=10, help="how many companies to summarise")
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("samples", help="dump HTML samples for pinning selectors")
    p.add_argument("--source", choices=sorted(LISTINGS), default="internships")
    p.add_argument("--headed", action="store_true")
    p.set_defaults(func=cmd_samples)

    p = sub.add_parser("export", help="rebuild the CSV from the JSONL checkpoint")
    p.add_argument("--from-mongo", action="store_true",
                   help="export from MongoDB instead — authoritative if a run "
                        "was killed and left the JSONL with a torn line")
    p.add_argument("--include-raw", action="store_true")
    p.set_defaults(func=cmd_export)

    sub.add_parser("status", help="show the last run's state").set_defaults(func=cmd_status)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
