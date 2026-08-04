"""Streamlit dashboard: drive a scrape, watch it live, browse what it found.

The dashboard never touches the browser itself. It launches `run_scraper.py`
as a subprocess and reads the two files that run owns — `state.json` for
progress and `jobs.raw.jsonl` for results — so a UI reload can never disturb
a scrape in flight.

    streamlit run dashboard.py
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime

import altair as alt
import pandas as pd
import streamlit as st

from scraper.config import (
    CSV_PATH,
    DATA_DIR,
    DETAIL_CONCURRENCY,
    LISTINGS,
    LOG_PATH,
    PID_PATH,
    ROOT,
    VERSION,
)
from scraper.mongo import MongoStore
from scraper.progress import read_state
from scraper.session import session_status
from scraper.store import JobStore, to_dataframe

# Validated against both the light (#fcfcfb) and dark (#1a1a19) chart
# surfaces — all six checks pass in each, so one value serves both themes.
SERIES = "#3987e5"
MUTED = "#898781"

st.set_page_config(page_title="Internshala Scraper", page_icon="📋", layout="wide")


# --------------------------------------------------------------------------
# Data access
# --------------------------------------------------------------------------
def _mtime(path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


# Multi-KB raw backups on every document. They are the safety net for a site
# redesign, never something the UI shows, and fetching them makes the load
# several times slower.
HEAVY_FIELDS = ("ld_json", "sections_json", "meta_extra_json")

# Search scans these rather than every column. Joining all 47 fields per row
# — including the full description — took seconds per keystroke on 11k rows.
SEARCH_FIELDS = ("title", "company", "location", "skills", "description",
                 "perks", "who_can_apply", "employment_type")


def mongo_counts() -> dict[str, int]:
    """Document counts per collection, or {} when Mongo is unreachable."""
    try:
        store = MongoStore()
        store.ping()
        counts = store.counts()
        store.close()
        return counts
    except Exception:
        return {}


@st.cache_data(show_spinner="Loading listings from MongoDB…")
def load_jobs(_stamp) -> pd.DataFrame:
    """Read every listing. `_stamp` exists purely to bust the cache.

    Mongo first: it is the authoritative store, and it survives the hard kill
    that can leave the append-only JSONL with a torn final line. The JSONL is
    kept as the fallback so the UI still works with Mongo stopped.
    """
    try:
        store = MongoStore()
        store.ping()
        rows = store.read_all(exclude=HEAVY_FIELDS)
        store.close()
        origin = "MongoDB"
    except Exception:
        rows = JobStore().read_all()
        origin = "JSONL fallback (MongoDB unreachable)"

    df = to_dataframe(rows)
    df = df.drop(columns=[c for c in df.columns if c.startswith("raw_")], errors="ignore")
    df = df.drop(columns=[c for c in HEAVY_FIELDS if c in df.columns], errors="ignore")
    df.attrs["origin"] = origin

    # Precomputed once here instead of per keystroke in the search box.
    present = [c for c in SEARCH_FIELDS if c in df.columns]
    df["_haystack"] = (
        df[present].fillna("").astype(str).agg(" ".join, axis=1).str.lower()
        if present else ""
    )
    return df


def is_running() -> bool:
    if not PID_PATH.exists():
        return False
    try:
        pid = int(PID_PATH.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return False
    try:
        os.kill(pid, 0)  # signal 0 = existence check on both POSIX and Windows
        return True
    except OSError:
        return False


def start_scrape(args: list[str]) -> None:
    """Launch the parallel scraper as a detached subprocess.

    `fast`, not `scrape`: the browser path is kept only as a fallback and is
    an order of magnitude slower.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log = LOG_PATH.open("a", encoding="utf-8", buffering=1)
    log.write(f"\n===== run started {datetime.now():%Y-%m-%d %H:%M:%S} =====\n")
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}  # rupee signs in stipends
    subprocess.Popen(
        [sys.executable, "-u", "run_scraper.py", "fast", *args],
        cwd=str(ROOT),
        stdout=log,
        stderr=subprocess.STDOUT,
        env=env,
    )


def stop_scrape() -> bool:
    try:
        pid = int(PID_PATH.read_text(encoding="utf-8").strip())
        os.kill(pid, signal.SIGTERM)
        return True
    except (OSError, ValueError):
        return False


def log_tail(lines: int = 40) -> str:
    try:
        return "".join(LOG_PATH.read_text(encoding="utf-8", errors="replace").splitlines(True)[-lines:])
    except OSError:
        return "No log yet."


# --------------------------------------------------------------------------
# Charts
# --------------------------------------------------------------------------
def ranked_bar(data: pd.DataFrame, label: str, value: str, sort: list[str] | str = "-x"):
    """Single-series horizontal bar: no legend, direct labels, recessive axis."""
    base = alt.Chart(data).encode(
        y=alt.Y(
            f"{label}:N",
            sort=sort,
            title=None,
            axis=alt.Axis(labelColor=MUTED, labelLimit=240, domain=False, ticks=False),
        ),
        x=alt.X(f"{value}:Q", title=None, axis=None),
        tooltip=[alt.Tooltip(f"{label}:N"), alt.Tooltip(f"{value}:Q", title="listings")],
    )
    bars = base.mark_bar(color=SERIES, cornerRadiusEnd=4, size=16)
    labels = base.mark_text(align="left", dx=6, color=MUTED, fontSize=12).encode(
        text=alt.Text(f"{value}:Q")
    )
    return (
        (bars + labels)
        .properties(height=max(120, 30 * len(data)), background="transparent")
        .configure_view(stroke=None)
    )


STIPEND_BANDS = ["Unpaid", "Under ₹5k", "₹5k–10k", "₹10k–20k", "₹20k+", "Not stated"]


def stipend_band(text: str) -> str:
    low = str(text or "").lower()
    if "unpaid" in low:
        return "Unpaid"
    numbers = [int(n.replace(",", "")) for n in re.findall(r"\d[\d,]{2,}", low)]
    if not numbers:
        return "Not stated"
    top = max(numbers)
    if top < 5_000:
        return "Under ₹5k"
    if top < 10_000:
        return "₹5k–10k"
    if top < 20_000:
        return "₹10k–20k"
    return "₹20k+"


# --------------------------------------------------------------------------
# Sidebar — run controls
# --------------------------------------------------------------------------
state = read_state()
running = is_running()

with st.sidebar:
    st.markdown(f"### Scraper `v{VERSION}`")

    if session_status() == "saved":
        st.success("Session saved", icon="✅")
    else:
        st.error("No session saved", icon="🔒")
        st.caption(
            "The login is the one manual step and needs a real browser window, "
            "so it can't run from here. In a terminal:"
        )
        # Inline markdown rather than st.code — a code block would clip this
        # command in the narrow sidebar instead of wrapping it.
        st.markdown("`python` `run_scraper.py` `login`")

    db_counts = mongo_counts()
    if db_counts:
        st.success(f"MongoDB · {sum(db_counts.values()):,} documents", icon="🗄")
        for name, count in db_counts.items():
            st.caption(f"　{name}: {count:,}")
    else:
        st.warning("MongoDB unreachable — showing the JSONL fallback", icon="🗄")

    st.divider()
    source = st.selectbox("Listing", [*sorted(LISTINGS), "all"], index=2)
    max_pages = st.number_input("Max pages", 0, 300, 0, help="0 scrapes every page")
    concurrency = st.slider("Parallel detail fetches", 4, 24, DETAIL_CONCURRENCY)
    with_details = st.toggle("Fetch detail pages", value=True)
    fresh = st.toggle(
        "Re-fetch everything", value=False,
        help="Off resumes: listings already stored with full detail are skipped",
    )

    st.divider()
    col_a, col_b = st.columns(2)
    disabled = running or session_status() != "saved"
    if col_a.button("▶ Start", type="primary", use_container_width=True, disabled=disabled):
        args = [
            "--source", source,
            "--max-pages", str(max_pages),
            "--concurrency", str(concurrency),
        ]
        if not with_details:
            args.append("--no-details")
        if fresh:
            args.append("--fresh")
        start_scrape(args)
        time.sleep(1.5)
        st.rerun()

    if col_b.button("■ Stop", use_container_width=True, disabled=not running):
        stop_scrape()
        time.sleep(1)
        st.rerun()

    if st.button("↻ Reload data", use_container_width=True):
        st.session_state["reload"] = st.session_state.get("reload", 0) + 1
        st.rerun()

    auto = st.checkbox("Auto-refresh", value=running)

# --------------------------------------------------------------------------
# Header
# --------------------------------------------------------------------------
st.title("Internshala Scraper")

status = state.get("status", "idle")
badge = {
    "running": ("🟢", "Running"),
    "done": ("✅", "Done"),
    "failed": ("🔴", "Failed"),
    "needs_login": ("🔒", "Session expired"),
}.get(status, ("⚪", "Idle"))
phase = state.get("phase") or "—"
st.caption(f"{badge[0]} {badge[1]} · phase: {phase} · {state.get('current', '')}")

if status == "needs_login":
    st.warning(state.get("message", "Run `python run_scraper.py login` to sign in again."))

cols = st.columns(6)
cols[0].metric(
    "Discovered",
    state.get("discovered", 0),
    help=f"Listing page reports {state['total']} available" if state.get("total") else None,
)
cols[1].metric("Processed", state.get("processed", 0))
cols[2].metric("Failed", state.get("failed", 0))
cols[3].metric("Duplicates", state.get("duplicates", 0))
cols[4].metric("Pages", state.get("pages_done", 0))
cols[5].metric("Elapsed", f"{state.get('elapsed', 0):.0f}s")

discovered = state.get("discovered", 0)
if status == "running" and discovered:
    done = state.get("processed", 0) + state.get("failed", 0)
    st.progress(min(done / discovered, 1.0), text=f"{done} / {discovered} jobs")

# Stamp on the collection counts, so finishing a scrape refreshes the view;
# the Reload button in the sidebar covers in-place updates to existing rows.
df = load_jobs((tuple(sorted(mongo_counts().items())), st.session_state.get("reload", 0)))

tab_jobs, tab_insights, tab_log = st.tabs(["Jobs", "Insights", "Run log"])

# --------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------
with tab_jobs:
    if df.empty:
        st.info("Nothing collected yet. Configure a run in the sidebar and press Start.")
    else:
        f1, f2, f3 = st.columns([3, 2, 2])
        query = f1.text_input("Search", placeholder="title, company, skills, description…")
        section = f2.radio(
            "Section", ["Both", "Internships", "Jobs"], horizontal=True,
            help="The two listings Internshala publishes, stored as two collections",
        )
        detail_only = f3.toggle(
            "Full detail only", value=False,
            help="Hide sponsored cards that link off-site, which have listing "
                 "fields but no description",
        )

        view = df
        if query:
            view = view[view["_haystack"].str.contains(query.lower(), regex=False)]
        if section != "Both":
            view = view[view["source"] == section.lower()]
        if detail_only and "status" in view.columns:
            view = view[view["status"] == "ok"]

        g1, g2 = st.columns([2, 2])
        companies = g1.multiselect(
            "Company", sorted(view.get("company", pd.Series(dtype=str)).dropna().unique())
        )
        if companies:
            view = view[view["company"].isin(companies)]
        if g2.toggle("Work from home only") and "work_from_home" in view.columns:
            view = view[view["work_from_home"].astype(str).str.lower() == "true"]

        st.caption(
            f"{len(view):,} of {len(df):,} listings · source: {df.attrs.get('origin', '?')}"
        )
        preferred = [
            c
            for c in ["title", "company", "source", "location", "stipend", "salary",
                      "duration", "experience", "start_date", "apply_by", "skills",
                      "status", "url"]
            if c in view.columns
        ]
        rest = [c for c in view.columns if c not in preferred and c != "_haystack"]
        st.dataframe(
            view[preferred + rest],
            use_container_width=True,
            hide_index=True,
            height=420,
            column_config={"url": st.column_config.LinkColumn("url", display_text="open")},
        )

        if not view.empty:
            # Capped: building a label per row is fine for a page of results
            # and painfully slow across every listing. Narrow with the filters
            # above to reach one that isn't in the first slice.
            INSPECT_CAP = 300
            head = view.head(INSPECT_CAP)
            labels = (head.get("title", "").astype(str) + " — "
                      + head.get("company", "").astype(str)).tolist()
            pick = st.selectbox(
                f"Inspect one listing (first {min(len(view), INSPECT_CAP):,} shown)",
                range(len(labels)), format_func=lambda i: labels[i],
            )
            row = head.iloc[pick]
            if row.get("status") == "external":
                st.info(
                    "Sponsored listing — it links off-site, so only the listing "
                    "fields exist for it."
                )
            for field in ["description", "responsibilities", "skills", "perks",
                          "who_can_apply", "company_description", "hiring_activity"]:
                value = row.get(field)
                if isinstance(value, str) and value.strip():
                    with st.expander(field.replace("_", " ").title(), expanded=(field == "description")):
                        st.write(value)

        st.divider()
        # Only offer to build a download for a filtered slice. Serialising all
        # 11k rows costs ~100MB and would run on every single rerun.
        DOWNLOAD_CAP = 5000
        if len(view) <= DOWNLOAD_CAP:
            st.download_button(
                f"⬇ Download these {len(view):,} rows as CSV",
                data=view.drop(columns=["_haystack"], errors="ignore")
                        .to_csv(index=False).encode("utf-8-sig"),
                file_name="internshala_filtered.csv",
                mime="text/csv",
            )
        else:
            st.caption(
                f"Filter below {DOWNLOAD_CAP:,} rows to download a slice — "
                f"the complete export is already on disk at `{CSV_PATH}` "
                "(rebuild it with `python run_scraper.py export --from-mongo`)."
            )

# --------------------------------------------------------------------------
# Insights
# --------------------------------------------------------------------------
with tab_insights:
    if df.empty:
        st.info("Charts appear once the first jobs are collected.")
    else:
        m = st.columns(5)
        m[0].metric("Listings", f"{len(df):,}")
        if "source" in df:
            counts = df["source"].value_counts()
            m[1].metric("Internships", f"{counts.get('internships', 0):,}")
            m[2].metric("Jobs", f"{counts.get('jobs', 0):,}")
        m[3].metric("Companies", f"{df['company'].nunique():,}" if "company" in df else 0)
        if "status" in df:
            full = int((df["status"] == "ok").sum())
            m[4].metric(
                "With full detail", f"{full:,}",
                help="The rest are sponsored cards linking off-site, which have "
                     "listing fields but no detail page to fetch.",
            )

        left, right = st.columns(2)

        if "company" in df:
            top = df["company"].replace("", pd.NA).dropna().value_counts().head(10)
            if not top.empty:
                left.subheader("Most listings")
                left.altair_chart(
                    ranked_bar(top.rename_axis("company").reset_index(name="listings"),
                               "company", "listings"),
                    use_container_width=True,
                )

        if "location" in df:
            places = (
                df["location"].fillna("").str.split(r",|\|", regex=True).explode().str.strip()
            )
            places = places[places.ne("") & places.notna()].value_counts().head(10)
            if not places.empty:
                right.subheader("Most common locations")
                right.altair_chart(
                    ranked_bar(places.rename_axis("location").reset_index(name="listings"),
                               "location", "listings"),
                    use_container_width=True,
                )

        pay_col = "stipend" if "stipend" in df else ("salary" if "salary" in df else None)
        if pay_col:
            bands = df[pay_col].map(stipend_band).value_counts()
            bands = bands.reindex([b for b in STIPEND_BANDS if b in bands.index])
            st.subheader(f"{pay_col.title()} bands")
            st.altair_chart(
                ranked_bar(
                    bands.rename_axis("band").reset_index(name="listings"),
                    "band",
                    "listings",
                    sort=STIPEND_BANDS,
                ),
                use_container_width=True,
            )
            st.caption(
                f"Banded on the largest figure found in the {pay_col} text. "
                "Listings with no parseable figure are counted under “Not stated”."
            )

# --------------------------------------------------------------------------
# Log
# --------------------------------------------------------------------------
with tab_log:
    st.code(log_tail(60), language="text")
    errors = state.get("errors") or []
    if errors:
        st.subheader("Recent errors")
        for line in reversed(errors):
            st.text(line)

if auto and (running or status == "running"):
    time.sleep(2)
    st.rerun()
