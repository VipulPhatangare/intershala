"""Load every listing on the page and extract each card the moment it appears.

Two details drive the design:

1. Cards are parsed incrementally, not from the final HTML. Long lists get
   recycled out of the DOM as you scroll, so a single end-of-run dump loses
   listings that were genuinely visible earlier.
2. Internshala paginates as well as lazy-loads. When scrolling goes stale we
   look for a "next page" control and keep going, so the same loop covers
   both behaviours.
"""

from __future__ import annotations

import random
import re
from typing import Callable, Iterable
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from playwright.sync_api import Page

from .config import (
    BASE,
    CARD_ICON_FIELDS as ICONS,
    CARD_MOBILE_CLASSES,
    CARD_SKILL_SELECTORS,
    CARD_COMPANY_SELECTORS,
    CARD_DURATION_SELECTORS,
    CARD_HREF_ATTRS,
    CARD_ID_ATTRS,
    CARD_LABEL_SELECTORS,
    CARD_LOCATION_SELECTORS,
    CARD_LOGO_SELECTORS,
    CARD_POSTED_SELECTORS,
    CARD_SELECTOR,
    CARD_STIPEND_SELECTORS,
    CARD_TITLE_SELECTORS,
    PAGE_SETTLE_MS,
    SCROLL_PAUSE_MS,
    SCROLL_STEP_PX,
    STALE_LIMIT,
)
from .progress import Progress

# Internshala's "next page" control is a <div class="arrow next">, not a link,
# and it ships in desktop and mobile copies. Anchors are kept as fallbacks in
# case the markup changes back.
NEXT_PAGE_SELECTORS = [
    "#navigation-forward",
    "#navigation-forward-mobile",
    "a.next_page",
    ".arrow.next.desktop-arrow",
    ".arrow.next",
    "#next",
    "a#next",
    ".next_page",
    "a[rel='next']",
    ".pagination .next",
]

# The listing headline carries the total ("216 Total Internships").
TOTAL_SELECTORS = ["h1.page-heading", ".page-heading", "h1.heading_4_6"]
_TOTAL_RE = re.compile(r"([\d,]+)\s*(?:total\s+)?(?:internship|job)", re.I)

_WS = re.compile(r"\s+")


def _clean(text: str | None) -> str:
    return _WS.sub(" ", text or "").strip()


def _first_text(soup, selectors: Iterable[str]) -> str:
    for sel in selectors:
        node = soup.select_one(sel)
        if node:
            text = _clean(node.get_text(" ", strip=True))
            if text:
                return text
    return ""


def _drop_mobile_twins(soup) -> None:
    """Remove the mobile copy of values the card renders once per breakpoint."""
    for node in soup.find_all(True):
        classes = (getattr(node, "attrs", None) or {}).get("class") or []
        if CARD_MOBILE_CLASSES.intersection(classes):
            node.decompose()


def _icon_text(soup, icon_class: str) -> str:
    """Read the meta row marked by `icon_class` — the icon's parent holds it."""
    icon = soup.select_one(f".{icon_class}")
    if not icon or not icon.parent:
        return ""
    return _clean(icon.parent.get_text(" ", strip=True))


def parse_card(html: str, source: str) -> dict:
    """Turn one card's outerHTML into a listing-level record."""
    # html.parser, not lxml: lxml wraps a fragment in <html><body>, which would
    # make `find(True)` return the wrapper and lose the card's own attributes
    # (its id and data-href live there). The markup comes from a live DOM, so
    # html.parser handles broken attributes gracefully.
    soup = BeautifulSoup(html, "html.parser")
    _drop_mobile_twins(soup)

    root = soup.find(True) or soup
    raw_attrs = getattr(root, "attrs", None) or {}

    # Extract job_id
    job_id = ""
    for attr in CARD_ID_ATTRS:
        val = raw_attrs.get(attr)
        if val:
            job_id = str(val).strip()
            break

    # Extract URL
    url = ""
    for attr in CARD_HREF_ATTRS:
        val = raw_attrs.get(attr)
        if val:
            url = urljoin(BASE, str(val).strip())
            break
    if not url:
        link = soup.select_one("a[href]")
        if link and link.get("href"):
            url = urljoin(BASE, str(link["href"]).strip())

    title = _first_text(soup, CARD_TITLE_SELECTORS)
    company = _first_text(soup, CARD_COMPANY_SELECTORS)
    location = _icon_text(soup, ICONS["location"]) or _first_text(soup, CARD_LOCATION_SELECTORS)
    stipend = _icon_text(soup, ICONS["money"]) or _first_text(soup, CARD_STIPEND_SELECTORS)
    duration = _icon_text(soup, ICONS["duration"]) or _first_text(soup, CARD_DURATION_SELECTORS)
    experience = _icon_text(soup, ICONS["experience"])

    # Flags
    work_from_home = "work from home" in location.lower() or "remote" in location.lower()
    part_time = "part time" in title.lower() or "part-time" in title.lower()

    # Posted / labels / skills
    posted = _first_text(soup, CARD_POSTED_SELECTORS)
    labels = [
        _clean(el.get_text(" ", strip=True))
        for sel in CARD_LABEL_SELECTORS
        for el in soup.select(sel)
        if _clean(el.get_text(" ", strip=True))
    ]
    skills = [
        _clean(el.get_text(" ", strip=True))
        for sel in CARD_SKILL_SELECTORS
        for el in soup.select(sel)
        if _clean(el.get_text(" ", strip=True))
    ]

    logo = ""
    for sel in CARD_LOGO_SELECTORS:
        img = soup.select_one(sel)
        if img and img.get("src"):
            logo = urljoin(BASE, str(img["src"]))
            break

    return {
        "job_id": job_id,
        # The card states its own kind ("internship" / "job"). Worth keeping
        # separately from `source`: a jobs listing can surface an internship.
        "employment_type": _clean(str(raw_attrs.get("employment_type") or "")),
        "title": title,
        "company": company,
        "location": location,
        "work_from_home": work_from_home,
        "part_time": part_time,
        "stipend": stipend if source == "internships" else "",
        "salary": stipend if source == "jobs" else "",
        "duration": duration,
        "experience": experience,
        "posted": posted,
        "url": url,
        "logo": logo,
        "labels": ", ".join(dict.fromkeys(labels)),
        "skills": ", ".join(dict.fromkeys(skills)),
        "source": source,
    }


def _harvest(
    page: Page,
    seen: set[str],
    known: set[str],
    sink: Callable[[dict], None],
    source: str,
    progress: Progress,
) -> None:
    """Parse every card currently in the DOM, emitting the ones we haven't seen.

    `seen` is this run's working set — a card re-observed on the next scroll
    tick is simply ignored. `known` holds ids already on disk from earlier
    runs; those are counted as duplicates once each, then skipped.
    """
    # One round trip for all cards; grabbing outerHTML immediately means a
    # card that gets recycled a moment later is already safely captured.
    #
    # The filter drops any match nested inside another match. A card is
    # `div.individual_internship` wrapping a `div.internship_meta`, so without
    # this both elements come back and the same job is scraped twice — the
    # inner one has no id attribute, so it dedupes under a different key.
    htmls = page.eval_on_selector_all(
        CARD_SELECTOR,
        "els => els.filter(e => !els.some(o => o !== e && o.contains(e)))"
        "        .map(e => e.outerHTML)",
    )
    for html in htmls:
        job = parse_card(html, source)
        # Match on id *and* url: either alone identifies the listing, and
        # checking both survives a card that is missing one of them.
        keys = {k for k in (job["job_id"], job["url"]) if k}
        if not keys or seen & keys:
            continue
        seen |= keys
        if known & keys:
            progress.duplicates += 1
            continue
        sink(job)


def _first_card_id(page: Page) -> str:
    """Identity of the topmost card — used to tell when a page turn landed."""
    return page.evaluate(
        """(sel) => {
            const el = document.querySelector(sel);
            if (!el) return "";
            return el.getAttribute("internshipid") || el.getAttribute("jobid")
                || el.getAttribute("data-href") || el.textContent.slice(0, 80);
        }""",
        CARD_SELECTOR,
    )


def total_listings(page: Page) -> int:
    """How many listings the page says exist, or 0 if it doesn't say."""
    for sel in TOTAL_SELECTORS:
        node = page.query_selector(sel)
        if not node:
            continue
        match = _TOTAL_RE.search(_clean(node.inner_text()))
        if match:
            return int(match.group(1).replace(",", ""))
    return 0


def _go_next_page(page: Page, next_page_no: int = 2, base_url: str = "") -> bool:
    before = _first_card_id(page)
    for sel in NEXT_PAGE_SELECTORS:
        for node in page.query_selector_all(sel):
            try:
                if not node.is_visible() or not node.is_enabled():
                    continue
                cls = (node.get_attribute("class") or "").lower()
                if "disabled" in cls or "inactive" in cls:
                    continue
                node.click()
                
                deadline = PAGE_SETTLE_MS * 6
                waited = 0
                while waited < deadline:
                    page.wait_for_timeout(300)
                    waited += 300
                    if _first_card_id(page) != before:
                        page.wait_for_timeout(PAGE_SETTLE_MS)
                        return True
            except Exception:
                continue

    if base_url:
        clean_base = base_url.rstrip("/")
        if "/page-" in clean_base:
            clean_base = re.sub(r"/page-\d+", "", clean_base)
        target_url = f"{clean_base}/page-{next_page_no}/"
        try:
            resp = page.goto(target_url, wait_until="domcontentloaded")
            page.wait_for_timeout(PAGE_SETTLE_MS)
            if _first_card_id(page) and _first_card_id(page) != before:
                return True
        except Exception:
            pass

    return False


def collect(
    page: Page,
    url: str,
    source: str,
    progress: Progress,
    known: set[str] | None = None,
    max_pages: int = 0,
    max_jobs: int = 0,
) -> list[dict]:
    """Scroll + paginate through a listing, returning every new card found."""
    jobs: list[dict] = []
    seen: set[str] = set()
    known = known or set()

    progress.phase = "listing"
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(PAGE_SETTLE_MS)

    progress.total = total_listings(page)
    progress.flush(force=True)

    page_no = 1
    while True:
        stale = 0
        while stale < STALE_LIMIT:
            before = len(seen)
            _harvest(page, seen, known, jobs.append, source, progress)

            progress.discovered = len(jobs)
            progress.current = f"page {page_no} — {len(jobs)} new listings"
            progress.flush()

            if max_jobs and len(jobs) >= max_jobs:
                return jobs[:max_jobs]

            page.mouse.wheel(0, SCROLL_STEP_PX)
            page.wait_for_timeout(random.randint(*SCROLL_PAUSE_MS))
            stale = 0 if len(seen) > before else stale + 1

        # Scrolling is exhausted; one last sweep before turning the page.
        _harvest(page, seen, known, jobs.append, source, progress)
        progress.pages_done = page_no
        progress.discovered = len(jobs)
        progress.flush(force=True)

        if max_pages and page_no >= max_pages:
            break
        if not _go_next_page(page, next_page_no=page_no + 1, base_url=url):
            break
        page_no += 1

    return jobs[:max_jobs] if max_jobs else jobs
