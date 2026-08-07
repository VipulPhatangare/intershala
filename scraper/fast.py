"""Parallel scrape: concurrent listing sweep, concurrent detail fetch, Mongo.

Three things make this far faster than the browser pipeline in `run.py`
(~7-13 records/sec against well under 1):

1. **No browser.** Internshala serves signed-in pages to a plain HTTP client
   carrying the saved cookies, so there is no DOM to render or scroll.
2. **Pagination is an API call.** The `*_ajax` endpoints report
   `is_last_page`, so pages are requested in concurrent waves instead of
   discovered one click at a time.
3. **The two phases overlap.** Listing pages feed a queue that detail workers
   drain as it fills, so details for page 1 are already being fetched while
   page 40 is still downloading.

Point 3 also fixes the failure that cost the last run everything: the old
pipeline collected all 1,847 listings before writing a single record, so an
interrupt mid-listing lost the lot. Here every completed job is durable
within a second or two of being fetched.
"""

from __future__ import annotations

import asyncio
import os
import sys
import threading
import time
import traceback
from datetime import datetime, timezone

from bs4 import BeautifulSoup

from .config import (
    AJAX_HEADING_KEY,
    AJAX_LIST_KEY,
    CARD_SELECTOR,
    DETAIL_CONCURRENCY,
    LISTING_AJAX,
    LISTING_CONCURRENCY,
    LISTINGS,
    MONGO_BATCH,
    PAGE_PROBE_BATCH,
    SKIP_EXTERNAL,
    SOURCES,
    VERSION,
)
from .detail import parse_detail
from .errors import AuthExpired, NoSession
from .httpclient import Fetcher, is_internshala
from .listing import parse_card, _TOTAL_RE, _clean
from .mongo import MongoStore
from .progress import Progress
from .store import JobStore


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def start_stall_dumper(loop: asyncio.AbstractEventLoop, progress: Progress,
                       every: float = 30.0) -> None:
    """Dump every task's stack from an OS thread when progress stops.

    Deliberately not a coroutine. If the event loop wedges, an asyncio
    watchdog wedges with it and reports nothing — which is exactly what
    happened while debugging this pipeline. A daemon thread keeps running no
    matter what the loop is doing, and `Task.get_stack()` is just frame
    inspection, so it is safe to call from outside the loop.

    Enable with SCRAPER_DEBUG_STALL=1.
    """
    def watch() -> None:
        last, idle = -1, 0.0
        while True:
            time.sleep(every)
            if progress.processed != last:
                last, idle = progress.processed, 0.0
                continue
            idle += every
            print(f"\n=== STALL: {idle:.0f}s at {progress.processed} processed ===",
                  file=sys.stderr, flush=True)
            try:
                tasks = asyncio.all_tasks(loop)
            except RuntimeError:
                tasks = set()
            print(f"  {len(tasks)} live tasks", file=sys.stderr, flush=True)
            for task in tasks:
                stack = task.get_stack(limit=4)
                where = " <- ".join(
                    f"{f.f_code.co_name}:{f.f_lineno}" for f in reversed(stack)
                ) or "(no frames)"
                print(f"    {task.get_name():<14} {where}", file=sys.stderr, flush=True)
            print("  --- all thread stacks ---", file=sys.stderr, flush=True)
            for tid, frame in sys._current_frames().items():
                head = traceback.extract_stack(frame)[-3:]
                trail = " <- ".join(f"{f.name}:{f.lineno}" for f in head)
                print(f"    thread {tid}: {trail}", file=sys.stderr, flush=True)

    if os.environ.get("SCRAPER_DEBUG_STALL"):
        threading.Thread(target=watch, daemon=True, name="stall-dumper").start()


# --------------------------------------------------------------------------
# Listing side
# --------------------------------------------------------------------------
def _cards_from_payload(payload: dict, source: str) -> list[dict]:
    """Parse every card in one AJAX page response."""
    html = payload.get(AJAX_LIST_KEY) or ""
    if not html:
        return []
    soup = BeautifulSoup(html, "html.parser")

    jobs = []
    for node in soup.select(CARD_SELECTOR):
        # Skip a match nested inside another match, exactly as the browser
        # path does: a card wraps an inner meta div that also matches.
        if node.find_parent(class_="individual_internship"):
            continue
        job = parse_card(str(node), source)
        if job.get("job_id") or job.get("url"):
            jobs.append(job)
    return jobs


def _declared_total(payload: dict) -> int:
    """The "6580 Jobs" figure from the listing heading, or 0."""
    heading = payload.get(AJAX_HEADING_KEY) or ""
    if not heading:
        return 0
    text = _clean(BeautifulSoup(heading, "html.parser").get_text(" ", strip=True))
    match = _TOTAL_RE.search(text)
    return int(match.group(1).replace(",", "")) if match else 0


async def sweep_listings(
    fetcher: Fetcher,
    source: str,
    queue: asyncio.Queue,
    progress: Progress,
    known: set[str],
    seen: set[str],
    max_pages: int = 0,
) -> int:
    """Walk every listing page in concurrent waves, pushing cards onto `queue`.

    Pages are fetched `PAGE_PROBE_BATCH` at a time. The endpoint reports
    `is_last_page`, and pages past the end return zero cards rather than an
    error, so a wave that overshoots is harmless — it just ends the sweep.
    """
    template = LISTING_AJAX[source]
    referer = LISTINGS[source]
    page = 1
    discovered = 0

    while True:
        if max_pages and page > max_pages:
            break

        wave = list(range(page, page + PAGE_PROBE_BATCH))
        if max_pages:
            wave = [p for p in wave if p <= max_pages]
        if not wave:
            break

        results = await asyncio.gather(
            *(fetcher.get_json(template.format(page=p), referer=referer) for p in wave),
            return_exceptions=True,
        )

        finished = False
        for page_no, payload in zip(wave, results):
            if isinstance(payload, AuthExpired):
                raise payload
            if isinstance(payload, BaseException):
                progress.error(f"{source} listing page {page_no}: {payload}")
                continue

            if not progress.total:
                progress.total = _declared_total(payload)

            cards = _cards_from_payload(payload, source)
            if not cards:
                finished = True
                continue

            for job in cards:
                keys = {k for k in (job["job_id"], job["url"]) if k}
                if not keys or seen & keys:
                    continue
                seen |= keys
                if known & keys:
                    progress.duplicates += 1
                    continue
                discovered += 1
                await queue.put(job)

            progress.pages_done += 1
            if payload.get("is_last_page"):
                finished = True

        progress.discovered = discovered
        progress.current = f"{source}: page {page + len(wave) - 1}, {discovered} queued"
        progress.flush()

        if finished:
            break
        page += len(wave)

    return discovered


# --------------------------------------------------------------------------
# Detail side
# --------------------------------------------------------------------------
async def detail_worker(
    fetcher: Fetcher,
    source: str,
    queue: asyncio.Queue,
    writer: "BatchWriter",
    progress: Progress,
    with_details: bool,
    sweep_done: asyncio.Event,
) -> None:
    """Drain the queue, enrich each job, hand it to the writer.

    Termination is by `sweep_done` + an empty queue, polled through a short
    `wait_for`, rather than by sentinel values. Sentinels have to be *put*,
    and a blocking put inside a cleanup path deadlocks the moment the
    consumers are gone — which is precisely how this pipeline wedged: the
    sweep was cancelled, its `finally` tried to push one sentinel per worker
    into a full queue that nobody was draining any more, and the whole run
    parked with no timer and no error. Nothing here waits without a timeout.
    """
    while True:
        try:
            job = await asyncio.wait_for(queue.get(), timeout=1.0)
        except asyncio.TimeoutError:
            if sweep_done.is_set() and queue.empty():
                return
            continue

        record = dict(job)
        record["scraped_at"] = _now()
        record["scraper_version"] = VERSION

        drop = False
        try:
            if not with_details or not record.get("url"):
                record["status"] = "listing_only"
            elif not is_internshala(record["url"]):
                # A sponsored card links straight out to an ad tracker. There
                # is no Internshala detail page behind it, so the listing
                # fields are all we will ever get for this one — no
                # description, ever. SKIP_EXTERNAL drops them at the source so
                # they never reach either sink; set SCRAPER_KEEP_EXTERNAL=1 to
                # store them as status="external" the way earlier runs did.
                if SKIP_EXTERNAL:
                    drop = True
                else:
                    record["status"] = "external"
            else:
                html = await fetcher.get_text(record["url"], referer=LISTINGS[source])
                # ~110ms per page, and lxml releases the GIL for the parse
                # itself, so a thread overlaps usefully with the other
                # workers' I/O. Measured: the run is fetch-bound well before
                # parsing matters, which is why this is not a process pool —
                # cross-process futures bought nothing and could wedge the
                # loop with no timer attached to recover from.
                record.update(await asyncio.to_thread(parse_detail, html))
                record["status"] = "ok"
            progress.processed += 1
        except AuthExpired:
            queue.task_done()
            raise
        except Exception as exc:
            record["status"] = "failed"
            record["error"] = f"{type(exc).__name__}: {exc}"
            progress.failed += 1
            progress.error(f"{record.get('title') or record.get('url')} — {exc}")

        if drop:
            queue.task_done()
            continue

        try:
            await writer.add(record)
            progress.current = record.get("title", "")
            progress.flush()
        except Exception as exc:
            # A worker that dies here takes its share of the throughput with
            # it and, worse, used to strand the whole run. One bad record is
            # not worth a dead worker.
            progress.error(f"write failed for {record.get('job_id')} — {exc}")
        finally:
            queue.task_done()


# --------------------------------------------------------------------------
# Writing
# --------------------------------------------------------------------------
class BatchWriter:
    """Buffers records, then writes them to Mongo and the JSONL together.

    Both sinks are kept: Mongo is the queryable copy, the JSONL is the
    append-only log that survives Mongo being down or wiped.
    """

    def __init__(self, source: str, mongo: MongoStore | None, batch: int = MONGO_BATCH):
        self.source = source
        self.mongo = mongo
        self.batch = batch
        self.buffer: list[dict] = []
        self.written = 0
        self.jsonl = JobStore()
        self._lock = asyncio.Lock()

    async def add(self, record: dict) -> None:
        async with self._lock:
            self.buffer.append(record)
            if len(self.buffer) >= self.batch:
                pending, self.buffer = self.buffer, []
            else:
                return
        await self._flush(pending)

    async def close(self) -> None:
        async with self._lock:
            pending, self.buffer = self.buffer, []
        if pending:
            await self._flush(pending)

    async def _flush(self, records: list[dict]) -> None:
        if not records:
            return
        # Both sinks are blocking calls; keep them off the event loop.
        await asyncio.to_thread(self._write_jsonl, records)
        if self.mongo:
            try:
                await asyncio.to_thread(self.mongo.upsert_many, self.source, records)
            except Exception as exc:
                # Mongo failing must not kill a run — the JSONL already has
                # the data and `mongo-sync` can replay it later.
                print(f"  ! mongo write failed ({exc}); JSONL still has the rows")
        self.written += len(records)

    def _write_jsonl(self, records: list[dict]) -> None:
        for record in records:
            self.jsonl.append(record)


# --------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------
async def scrape_source(
    source: str,
    progress: Progress,
    mongo: MongoStore | None,
    listing_concurrency: int,
    detail_concurrency: int,
    max_pages: int = 0,
    with_details: bool = True,
    resume: bool = True,
) -> dict:
    """Run the pipelined scrape for one section."""
    known: set[str] = set()
    if resume and mongo:
        known = await asyncio.to_thread(mongo.existing_ids, source)
    elif resume:
        known = await asyncio.to_thread(JobStore().existing_ids)

    progress.skipped_existing = len(known)
    progress.phase = "listing+details"
    progress.flush(force=True)

    # Bounded so the listing sweep cannot run thousands of jobs ahead of the
    # detail workers and balloon memory.
    queue: asyncio.Queue = asyncio.Queue(maxsize=detail_concurrency * 20)
    writer = BatchWriter(source, mongo)
    seen: set[str] = set()
    sweep_done = asyncio.Event()

    total_concurrency = listing_concurrency + detail_concurrency

    async def watchdog(interval: float = 25.0) -> None:
        """Say something when the pipeline stops making progress.

        A silent stall is the worst failure mode here: the run looks alive,
        burns no CPU, and writes nothing. This makes it visible in the log
        instead of only in a process dump.
        """
        last, idle = progress.processed, 0.0
        while True:
            await asyncio.sleep(interval)
            if progress.processed != last:
                last, idle = progress.processed, 0.0
                continue

            idle += interval
            print(
                f"  ! no progress for {idle:.0f}s "
                f"({progress.processed} done, {queue.qsize()} queued)"
            )
            # Print where every task is actually parked. A stall here means
            # tasks are waiting on something with no timeout, and the only way
            # to know which is to look — a process dump shows the event loop
            # asleep but never the coroutines suspended on top of it.
            for task in asyncio.all_tasks():
                if task is asyncio.current_task():
                    continue
                frames = task.get_stack(limit=3)
                where = " <- ".join(
                    f"{f.f_code.co_name}:{f.f_lineno}" for f in reversed(frames)
                ) or "no stack (not started / finished)"
                print(f"      {task.get_name():<12} {task._state:<9} {where}")

    async def sweep_then_signal() -> int:
        """Sweep, then release the workers however the sweep ended.

        The signal is a flag, not a queued value: setting an Event cannot
        block, so this cleanup is safe to run while the task is being
        cancelled and no matter what the consumers are doing.
        """
        try:
            return await sweep_listings(
                fetcher, source, queue, progress, known, seen, max_pages
            )
        finally:
            sweep_done.set()

    async with Fetcher(total_concurrency) as fetcher:
        workers = [
            asyncio.create_task(
                detail_worker(
                    fetcher, source, queue, writer, progress, with_details,
                    sweep_done,
                )
            )
            for _ in range(detail_concurrency)
        ]
        sweep = asyncio.create_task(sweep_then_signal())
        guard = asyncio.create_task(watchdog())
        tasks = [sweep, *workers]

        # FIRST_EXCEPTION so an expired session stops the run promptly rather
        # than after every remaining page. Cancelling the rest is safe now
        # that no cleanup path performs a blocking await.
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)

        failure = next((t.exception() for t in done if t.exception()), None)
        guard.cancel()
        if failure or pending:
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        await asyncio.gather(guard, return_exceptions=True)

        # Whatever happened, persist what the buffer is holding.
        await writer.close()
        stats = {"requests": fetcher.requests, "retries": fetcher.retries}

    if failure:
        raise failure

    return {
        "source": source,
        "discovered": sweep.result(),
        "written": writer.written,
        **stats,
    }


async def _run(
    sources: list[str],
    listing_concurrency: int,
    detail_concurrency: int,
    max_pages: int,
    with_details: bool,
    resume: bool,
    use_mongo: bool,
) -> list[dict]:
    mongo: MongoStore | None = None
    if use_mongo:
        mongo = MongoStore()
        try:
            version = await asyncio.to_thread(mongo.ping)
            await asyncio.to_thread(mongo.ensure_indexes)
            print(f"MongoDB {version} at {mongo.uri} -> db '{mongo.db_name}'")
        except Exception as exc:
            print(f"MongoDB unavailable ({exc}). Falling back to JSONL only.")
            mongo.close()
            mongo = None

    progress = Progress()
    start_stall_dumper(asyncio.get_running_loop(), progress)
    summaries = []
    try:
        for source in sources:
            print(f"\n{'=' * 62}\n  {source}\n{'=' * 62}")
            progress.start(source)  # zeroes the per-source counters
            started = time.time()

            summary = await scrape_source(
                source,
                progress,
                mongo,
                listing_concurrency,
                detail_concurrency,
                max_pages=max_pages,
                with_details=with_details,
                resume=resume,
            )
            summary["elapsed"] = time.time() - started
            summary["failed"] = progress.failed
            summary["duplicates"] = progress.duplicates
            summary["declared_total"] = progress.total
            summaries.append(summary)

            rate = summary["written"] / max(summary["elapsed"], 1e-9)
            print(
                f"  {summary['written']} written, {summary['failed']} failed, "
                f"{summary['duplicates']} already stored, "
                f"{summary['elapsed']:.0f}s ({rate:.1f}/s)"
            )
            progress.finish("done", f"{source}: {summary['written']} records")
    except AuthExpired as exc:
        progress.finish("needs_login", f"{exc} — run `python run_scraper.py login`.")
        raise
    finally:
        if mongo:
            print("\nMongo collection counts:", await asyncio.to_thread(mongo.counts))
            mongo.close()

    return summaries


def scrape_parallel(
    source: str = "all",
    listing_concurrency: int = LISTING_CONCURRENCY,
    detail_concurrency: int = DETAIL_CONCURRENCY,
    max_pages: int = 0,
    with_details: bool = True,
    resume: bool = True,
    use_mongo: bool = True,
) -> list[dict]:
    """Sync entry point for the CLI."""
    sources = list(SOURCES) if source == "all" else [source]
    return asyncio.run(
        _run(
            sources,
            listing_concurrency,
            detail_concurrency,
            max_pages,
            with_details,
            resume,
            use_mongo,
        )
    )


def sync_jsonl_to_mongo() -> dict[str, int]:
    """Replay the JSONL checkpoint into Mongo.

    For backfilling everything collected before Mongo existed, or after a run
    where Mongo was down.
    """
    mongo = MongoStore()
    mongo.ping()
    mongo.ensure_indexes()

    buckets: dict[str, list[dict]] = {name: [] for name in SOURCES}
    for row in JobStore().read_all():
        source = row.get("source")
        if source in buckets:
            buckets[source].append(row)

    written = {}
    for source, rows in buckets.items():
        count = 0
        for i in range(0, len(rows), MONGO_BATCH):
            count += mongo.upsert_many(source, rows[i : i + MONGO_BATCH])
        written[source] = count
    mongo.close()
    return written
