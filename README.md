# Internshala Scraper & MERN Stack UI

Log in once by hand; everything after that is automated. Every internship and
every job is collected in parallel by Python Playwright & BeautifulSoup, saved to MongoDB, 
and presented on a modern **MERN Stack UI (MongoDB, Express.js, React.js, Node.js)**.

A modern React single-page dashboard with glassmorphism visual styling, real-time KPI metrics, search/filter controls, and a Python scrape trigger back-end powers the Web tier.

## Quick Start (MERN Stack + Python)

### 1. Install Dependencies
```bash
# Python dependencies
pip install -r requirements.txt
python -m playwright install chromium     # only needed for one-time manual login

# MERN Node dependencies
npm install                     # install root dependencies
npm --prefix server install     # install Express backend packages
npm --prefix client install     # install React frontend packages
```

### 2. Run MERN Web Application
```bash
# Option A: Start Express REST Server + React Dev Server concurrently
npm run server:dev     # starts Express API on http://localhost:5000
npm run client         # starts React MERN Dashboard on http://localhost:3000

# Option B: Production Build + Serve
npm run start          # builds React frontend and serves on http://localhost:5000
```


MongoDB is expected on `mongodb://127.0.0.1:27017`. Override with the
`MONGO_URI` / `MONGO_DB` environment variables.

## Use

```bash
python run_scraper.py login                       # one time, opens a real browser
python run_scraper.py fast --source all           # everything, in parallel, into Mongo
python run_scraper.py mongo                       # what's in the database
```

That is the whole workflow. `fast` is the path you want:

```bash
python run_scraper.py fast --source all           # ~11k listings, roughly 15-20 min
python run_scraper.py fast --source jobs          # one section
python run_scraper.py fast --max-pages 3          # a quick slice to sanity-check
python run_scraper.py fast --concurrency 20       # tune the parallelism
python run_scraper.py fast --fresh                # re-fetch instead of resuming
python run_scraper.py fast --no-mongo             # JSONL + CSV only
```

It is resumable: ids already stored with `status="ok"` are skipped, so an
interrupted run is restarted by re-running the same command. Rows that were
stored listing-only or failed are deliberately *not* skipped — a resume goes
back and fills them in.

Inspecting and exporting:

```bash
python run_scraper.py mongo                       # counts + top companies per section
python run_scraper.py mongo --sync                # replay the JSONL into Mongo
python run_scraper.py show --search python --columns title,company,stipend
python run_scraper.py export                      # rebuild the CSV from the JSONL
python run_scraper.py export --from-mongo         # …or from Mongo (authoritative)
python -m streamlit run dashboard.py              # live progress + result browser
```

(`python -m streamlit` rather than plain `streamlit` — pip put the `.exe`
shims in a Scripts directory that isn't on this machine's PATH.)

Output lands in `data/`, plus MongoDB:

| Where | What it is |
|---|---|
| `internshala.internships` | one document per internship, upserted on `job_id` |
| `internshala.jobs` | one document per job, upserted on `job_id` |
| `session.json` | cookies + localStorage — the saved login |
| `jobs.raw.jsonl` | append-only checkpoint, one job per line |
| `jobs.csv` | flat export, deduplicated on `job_id` |
| `state.json` | live run counters, read by the dashboard |

## Pin the selectors before trusting a full run

Every selector in `scraper/config.py` is a starting guess. Check them against
the real markup:

```bash
python run_scraper.py samples
```

That prints how many cards matched and how the first one parsed, and writes the
listing, card and detail HTML to `data/samples/`. If fields come back empty,
open the saved HTML, find the right class, and add it to the relevant candidate
list in `config.py` — the extractors take the first candidate that yields text,
so adding never breaks what already worked.

## How it fits together

| Module | Responsibility |
|---|---|
| `scraper/session.py` | manual login, `storage_state` save/restore, validity check |
| `scraper/httpclient.py` | async HTTP carrying the saved cookies; retries, auth checks |
| `scraper/fast.py` | **the parallel pipeline** — listing sweep, detail pool, writers |
| `scraper/mongo.py` | MongoDB upserts, indexes, resume queries |
| `scraper/listing.py` | card parsing (shared), plus the old browser scroll path |
| `scraper/detail.py` | detail-page parsing (shared), plus the old sequential fetch |
| `scraper/store.py` | JSONL checkpoint, pandas → CSV |
| `scraper/progress.py` | run counters written to `state.json` |
| `scraper/run.py` | the original browser orchestration, kept as a fallback |
| `dashboard.py` | Streamlit UI — reads the files, never touches the browser |

## Why the parallel path is much faster

The browser pipeline in `run.py` paused 1–2s between detail fetches by design
and drove pagination by scrolling, which worked out to well under 1 record/sec
— and it lost everything if interrupted mid-listing. `fast.py` sustains
**~7–13 records/sec** end to end (cold pages; warm ones go faster). Four
changes account for it, and each was measured rather than assumed:

- **No browser.** Internshala serves fully signed-in pages to a plain HTTP
  client carrying the cookies out of `session.json`, so there is no DOM to
  render and no scrolling. Detail pages parse identically even signed out.
- **Pagination is an API call.** The `internships_ajax` / `jobs_ajax`
  endpoints return 40 cards of markup plus `is_last_page`, so pages are
  requested in concurrent waves instead of discovered one click at a time.
- **The phases overlap.** Listing pages feed a bounded queue that detail
  workers drain as it fills. This is also what makes an interrupt cheap: the
  old pipeline collected all 1,847 listings before writing a single row, so a
  Ctrl-C mid-listing lost the lot. Here every record is durable within a
  second or two of being fetched.
- **Parsing runs off the event loop**, in a thread — lxml releases the GIL for
  the parse itself, so it overlaps with the other workers' I/O.

Three client-side traps cost 7x between them, all worth knowing about:

- `resp.text()` runs charset auto-detection over the whole body when the
  response omits a charset. On a 170KB page that is ~0.5s, and it dropped
  throughput from ~14 req/s to under 2. `read()` + explicit `.decode("utf-8")`
  instead.
- Internshala returns an ~11KB `Set-Cookie` block on **every** response.
  aiohttp's default cookie jar parses it through `SimpleCookie` each time,
  which costs more than the request. The fix is `DummyCookieJar` plus a static
  `Cookie` header — a read-only scrape has no use for the server's updates.
  (The same header also exceeds aiohttp's default 8190-byte limit, which fails
  every request outright until `max_field_size` is raised.)
- **Not every listing is an Internshala listing.** Sponsored cards point
  `data-href` at an ad tracker (`click.appcast.io`), which 403s any non-browser
  request. Reading a bare 403 as "session expired" aborts a perfectly healthy
  run, so the auth check is scoped to internshala.com hosts and off-site cards
  are stored with `status="external"` instead of being fetched. Note the host
  test matches the registrable domain — a substring check would accept
  `evil-internshala.com.attacker.net`.

## The deadlock, and how it was found

Worth writing down, because the symptom was so uninformative: the run would
stop dead — every worker idle, **zero CPU**, nothing written, no error, no
exit. It survived adding socket-level timeouts and a `wait_for` backstop.

`py-spy dump` showed the event loop parked in `_poll` with `sched_count: 0` —
no timers pending anywhere, so nothing could ever wake it. But an *asyncio*
watchdog could not report on this, because a wedged loop never runs the
watchdog either. What finally worked was a **plain daemon thread** dumping
`asyncio.all_tasks()` (still in `fast.py`, behind `SCRAPER_DEBUG_STALL=1`).
It printed two live tasks where there should have been fourteen:

```
2 live tasks
  Task-14   sweep_then_signal:393     <- await queue.put(_DONE)
  Task-1    _run:468                  <- await asyncio.gather(*pending)
```

Every detail worker was gone. The chain: an external 403 raised `AuthExpired`,
killing a worker → `asyncio.wait(FIRST_EXCEPTION)` returned → cleanup
cancelled the sweep → the sweep's `finally` tried to push one stop-sentinel
per worker into a **full queue with no consumers left** → that `await` never
returned, and the `gather` waiting on it never returned either.

The lesson is narrower than "use timeouts": **a cleanup path must never
perform an unbounded `await`.** Cancellation runs `finally` blocks, and a
blocking `put` there deadlocks precisely when the consumers are already dead.
Workers now stop on an `asyncio.Event` — setting a flag cannot block — and
poll the queue through a 1s `wait_for`, so nothing in the pipeline waits
without a timeout.

## The MongoDB shape

Two collections, `internships` and `jobs`, keyed on `job_id` with a unique
index. Writes are upserts, so re-running refreshes rows instead of duplicating
them. There are also indexes on `company`, `status` and `scraped_at`, and a
text index over `title`/`skills`/`description`:

```javascript
use internshala
db.internships.countDocuments()
db.jobs.find({ $text: { $search: "python" } }).limit(5)
db.internships.find({ work_from_home: true, stipend: /₹/ }).limit(5)
db.jobs.aggregate([{ $group: { _id: "$company", n: { $sum: 1 } } },
                   { $sort: { n: -1 } }, { $limit: 10 }])
```

Blank values never overwrite populated ones on re-scrape, so a listing-only
pass followed by a detail pass cannot wipe a description — see `_NEVER_BLANK`
in `mongo.py`. If Mongo is down the run still completes: the JSONL keeps
everything and `python run_scraper.py mongo --sync` replays it.

Two counts that look wrong but are not:

- **`status="external"`.** Sponsored cards link off-site, so there is no
  Internshala page to fetch and only listing fields exist for them. It is rare
  on internships (~0.4%) and common on jobs (~27%), which is a property of the
  jobs section, not a scraper failure.
- **The collections sum to more than the distinct listings.** ~800 listings
  are posted to *both* sections and are stored once per section, exactly as
  the site presents them. The CSV therefore dedupes on `(job_id, source)`, not
  `job_id` alone, so it agrees with the database rather than silently dropping
  the internship copy of each one.

A few decisions worth knowing about:

- **Session validity is checked behaviourally,** across several members-only
  URLs, looking for both signed-in and signed-out markers. `session.json` is
  never deleted automatically — a false negative would otherwise throw away a
  login you had to do by hand. `run_scraper.py check` shows exactly what the
  probe saw and saves the page HTML to `data/session-check.html`.
- **Cards are parsed during scrolling, not at the end.** Long lists get recycled
  out of the DOM, so a single end-of-run HTML dump silently loses listings.
- **Detail pages go through `context.request`,** which shares the cookie jar but
  skips rendering — far faster than a `page.goto` per job, and immune to DOM
  recycling.
- **`<script type="application/ld+json">` is stored verbatim** in the `ld_json`
  column. Structured data survives redesigns that break CSS selectors, so it is
  both a source of fields and a safety net.
- **Unrecognised detail sections still land in `sections_json`,** so a page that
  gains a new section doesn't quietly lose data.
- **Failures are contained per job.** Three attempts with exponential backoff,
  then the row is written with `status="failed"` and the run carries on. Only an
  expired session stops everything, since nothing after it can succeed.
- **Pacing is deliberate** — 1–2s between detail fetches, sequential. This runs
  against your own account, and hammering it is what gets accounts rate limited.

## Extending

`BatchWriter` in `fast.py` is the seam for another sink — it already fans one
record out to both the JSONL and Mongo, and a third sink is a third call in
`_flush`. Schedule `run_scraper.py fast` on a timer and the resume logic
already skips what it has seen, so a daily run only fetches what is new.
Another job board means a new listing/detail module pair plus selector entries
in `config.py`; the queue-and-worker-pool shape in `fast.py` is board-agnostic.

Tuning knobs live in `config.py`: `DETAIL_CONCURRENCY`, `LISTING_CONCURRENCY`,
`PARSE_WORKERS`, `PAGE_PROBE_BATCH`, `MONGO_BATCH`. Pushing concurrency past
~20 measured *slower*, not faster — the site stops rewarding it and retries
start eating the gain.
