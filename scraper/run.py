"""Orchestration: session -> listings -> details -> CSV.

A failure inside one job is contained to that job; only an expired session
stops the whole run, because past that point nothing else can succeed.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from .config import LISTINGS, SAMPLES_DIR, VERSION
from .detail import enrich, polite_pause
from .errors import AuthExpired, NoSession
from .listing import collect
from .progress import Progress
from .session import open_context
from .store import JobStore, export_csv


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def scrape(
    source: str = "internships",
    url: str | None = None,
    max_pages: int = 0,
    max_jobs: int = 0,
    headless: bool = True,
    allow_login: bool = True,
    resume: bool = True,
    details: bool = True,
    include_raw: bool = False,
) -> dict:
    """Run one full scrape. Returns the final progress snapshot."""
    listing_url = url or LISTINGS.get(source) or LISTINGS["internships"]

    progress = Progress()
    store = JobStore()

    if resume:
        known = store.existing_ids()
    else:
        store.clear()
        known = set()

    progress.start(source)
    progress.skipped_existing = len(known)
    progress.message = f"Resuming with {len(known)} jobs already stored." if known else ""
    progress.flush(force=True)

    browser = ctx = None
    try:
        with sync_playwright() as pw:
            browser, ctx = open_context(pw, headless=headless, allow_login=allow_login)
            page = ctx.new_page()

            listings = collect(
                page,
                listing_url,
                source,
                progress,
                known=known,
                max_pages=max_pages,
                max_jobs=max_jobs,
            )
            page.close()

            progress.phase = "details"
            progress.flush(force=True)

            for job in listings:
                record = dict(job)
                record["scraped_at"] = _now()
                record["scraper_version"] = VERSION

                if not details or not record.get("url"):
                    record["status"] = "listing_only"
                    store.append(record)
                    progress.processed += 1
                    progress.flush()
                    continue

                progress.current = record.get("title") or record["url"]
                try:
                    record.update(enrich(ctx, record["url"]))
                    record["status"] = "ok"
                    progress.processed += 1
                except AuthExpired:
                    raise
                except Exception as exc:
                    record["status"] = "failed"
                    record["error"] = f"{type(exc).__name__}: {exc}"
                    progress.failed += 1
                    progress.error(f"{record.get('title', record['url'])} — {exc}")

                store.append(record)
                progress.flush()
                polite_pause()

            progress.phase = "export"
            progress.flush(force=True)
            path, rows = export_csv(include_raw=include_raw)
            progress.finish("done", f"Wrote {rows} rows to {path}")

    except AuthExpired as exc:
        progress.error(str(exc))
        progress.finish("needs_login", "Session expired. Run `python run_scraper.py login`.")
    except NoSession as exc:
        progress.finish("needs_login", str(exc))
    except Exception as exc:
        progress.error(f"{type(exc).__name__}: {exc}")
        progress.finish("failed", str(exc))
        raise
    finally:
        # Export whatever made it to disk even if the run died mid-way.
        if progress.status not in ("done",):
            try:
                export_csv(include_raw=include_raw)
            except Exception:
                pass
        for closer in (ctx, browser):
            try:
                if closer:
                    closer.close()
            except Exception:
                pass

    return progress.snapshot()


def capture_samples(source: str = "internships", headless: bool = True) -> list[str]:
    """Dump one listing page and one detail page for pinning selectors.

    Every selector in config.py is a guess until it is checked against the
    real markup — this is how you check it.
    """
    from .detail import fetch_detail
    from .listing import parse_card
    from .config import CARD_SELECTOR

    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    stamp = time.strftime("%Y%m%d-%H%M%S")

    with sync_playwright() as pw:
        browser, ctx = open_context(pw, headless=headless)
        page = ctx.new_page()
        page.goto(LISTINGS[source], wait_until="domcontentloaded")
        page.wait_for_timeout(2500)

        listing_file = SAMPLES_DIR / f"listing-{source}-{stamp}.html"
        listing_file.write_text(page.content(), encoding="utf-8")
        written.append(str(listing_file))

        cards = page.eval_on_selector_all(CARD_SELECTOR, "els => els.map(e => e.outerHTML)")
        print(f"Matched {len(cards)} cards with: {CARD_SELECTOR}")
        if cards:
            card_file = SAMPLES_DIR / f"card-{source}-{stamp}.html"
            card_file.write_text(cards[0], encoding="utf-8")
            written.append(str(card_file))

            first = parse_card(cards[0], source)
            print("First card parsed as:")
            for key, val in first.items():
                if key.startswith("raw_"):
                    continue
                print(f"  {key:16} {val}")

            if first.get("url"):
                detail_file = SAMPLES_DIR / f"detail-{source}-{stamp}.html"
                detail_file.write_text(fetch_detail(ctx, first["url"]), encoding="utf-8")
                written.append(str(detail_file))

        page.close()
        ctx.close()
        browser.close()

    return written
