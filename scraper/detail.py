"""Fetch and parse individual job pages.

Detail pages are pulled through `context.request`, which shares the browser's
authenticated cookie jar but skips rendering entirely. That is roughly ten
times faster than a `page.goto` per job and immune to DOM recycling.

Parsing is deliberately generic: rather than hard-coding a field per section,
every heading on the page is harvested and mapped through SECTION_ALIASES.
Unrecognised headings still land in `sections_json`, so a page that gains a
new section does not silently lose data.
"""

from __future__ import annotations

import json
import random
import re
import time
from typing import Any

from bs4 import BeautifulSoup
from playwright.sync_api import BrowserContext

from .config import (
    BACKOFF_BASE_S,
    DETAIL_DELAY_S,
    DETAIL_HEADING_SELECTORS,
    DETAIL_META_ITEM_SELECTORS,
    DETAIL_RETRIES,
    DETAIL_ROOT_SELECTORS,
    DETAIL_TARGETED,
    META_ALIASES,
    RESPONSIVE_DUPLICATE_SUFFIX,
    SECTION_ALIASES,
    SECTION_SKIP_CLASSES,
)
from .errors import AuthExpired

_WS = re.compile(r"\s+")
HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5"}


def _clean(text: str | None) -> str:
    return _WS.sub(" ", text or "").strip()


def _canonical(label: str, aliases: dict[str, str]) -> str | None:
    low = label.lower().strip().rstrip(":")
    if low in aliases:
        return aliases[low]
    for key, val in aliases.items():
        if key in low:
            return val
    return None


def _classes(node) -> list[str]:
    # Read `attrs` directly: NavigableStrings have no `.get`, and bs4 can hand
    # back a Tag whose `attrs` is None, which makes `.get()` raise.
    attrs = getattr(node, "attrs", None) or {}
    value = attrs.get("class") or []
    return value if isinstance(value, list) else [value]


def _is_heading(node) -> bool:
    if getattr(node, "name", None) in HEADING_TAGS:
        return True
    classes = " ".join(_classes(node))
    if "section_heading" in classes or "heading_5_5" in classes:
        return True
    # A wrapper div that contains the next heading also ends this section.
    finder = getattr(node, "select_one", None)
    return bool(finder and finder(".section_heading, .heading_5_5"))


def _is_skippable(node) -> bool:
    return bool(SECTION_SKIP_CLASSES.intersection(_classes(node)))


def _drop_responsive_duplicates(soup) -> None:
    """Remove the mobile twin of values the page renders twice."""
    for node in soup.select(f'[class*="{RESPONSIVE_DUPLICATE_SUFFIX}"]'):
        if any(c.endswith(RESPONSIVE_DUPLICATE_SUFFIX) for c in _classes(node)):
            node.decompose()


# --------------------------------------------------------------------------
# Fetch
# --------------------------------------------------------------------------
def fetch_detail(ctx: BrowserContext, url: str) -> str:
    resp = ctx.request.get(url)
    if resp.status in (401, 403) or "login" in resp.url.lower():
        raise AuthExpired(f"Session rejected while fetching {url}")
    if resp.status >= 400:
        raise RuntimeError(f"HTTP {resp.status} for {url}")
    return resp.text()


# --------------------------------------------------------------------------
# Parse
# --------------------------------------------------------------------------
def _extract_ld_json(soup) -> tuple[str, dict[str, Any]]:
    """Return (raw JSON string, the JobPosting object if one is present).

    Structured data survives redesigns that break CSS selectors, so it is
    kept verbatim as a safety net as well as mined for fields.
    """
    blocks: list[Any] = []
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            blocks.append(json.loads(tag.string or "{}"))
        except (json.JSONDecodeError, TypeError):
            continue

    flat: list[dict] = []
    stack = list(blocks)
    while stack:
        item = stack.pop()
        if isinstance(item, list):
            stack.extend(item)
        elif isinstance(item, dict):
            flat.append(item)
            if "@graph" in item:
                stack.append(item["@graph"])

    posting = next((d for d in flat if d.get("@type") == "JobPosting"), {})
    raw = json.dumps(blocks, ensure_ascii=False) if blocks else ""
    return raw, posting


def _from_posting(posting: dict) -> dict:
    """Pull the reliable bits out of schema.org JobPosting."""
    if not posting:
        return {}
    out: dict[str, Any] = {}
    if desc := posting.get("description"):
        out["ld_description"] = _clean(BeautifulSoup(desc, "lxml").get_text(" ", strip=True))
    org = posting.get("hiringOrganization") or {}
    if isinstance(org, dict) and org.get("name"):
        out["ld_company"] = org["name"]
    if posted := posting.get("datePosted"):
        out["ld_date_posted"] = posted
    if valid := posting.get("validThrough"):
        out["ld_valid_through"] = valid
    if etype := posting.get("employmentType"):
        out["ld_employment_type"] = etype if isinstance(etype, str) else " | ".join(etype)

    salary = posting.get("baseSalary") or {}
    if isinstance(salary, dict):
        value = salary.get("value") or {}
        if isinstance(value, dict):
            parts = [str(value.get(k)) for k in ("minValue", "maxValue", "value") if value.get(k)]
            if parts:
                out["ld_salary"] = " - ".join(dict.fromkeys(parts))
            if unit := value.get("unitText"):
                out["ld_salary_unit"] = unit

    loc = posting.get("jobLocation")
    locs = loc if isinstance(loc, list) else [loc] if loc else []
    names = []
    for entry in locs:
        addr = (entry or {}).get("address") or {}
        if isinstance(addr, dict):
            parts = [v for k, v in addr.items() if isinstance(v, str) and not k.startswith("@")]
            names.append(_clean(" ".join(parts)))
    if names:
        out["ld_location"] = " | ".join(n for n in names if n)
    return out


def _harvest_meta(root) -> dict:
    """The label/value strip near the top of the page (stipend, duration…)."""
    out: dict[str, str] = {}
    extras: dict[str, str] = {}
    for sel in DETAIL_META_ITEM_SELECTORS:
        for item in root.select(sel):
            heading = item.select_one(".item_heading, .heading, .other_detail_item_heading")
            body = item.select_one(".item_body, .body, .other_detail_item_body")
            label = _clean(heading.get_text(" ", strip=True)) if heading else ""
            value = _clean(body.get_text(" ", strip=True)) if body else ""
            if not label or not value:
                continue
            key = _canonical(label, META_ALIASES)
            if key:
                out.setdefault(key, value)
            else:
                extras.setdefault(label, value)
    if extras:
        out["meta_extra_json"] = json.dumps(extras, ensure_ascii=False)
    return out


def _harvest_sections(root) -> dict:
    """Every heading on the page, paired with the text that follows it."""
    out: dict[str, str] = {}
    sections: dict[str, str] = {}

    heading_nodes = []
    for sel in DETAIL_HEADING_SELECTORS:
        heading_nodes.extend(root.select(sel))
    heading_nodes.extend(root.find_all(list(HEADING_TAGS)))

    seen_ids = set()
    for heading in heading_nodes:
        if id(heading) in seen_ids:
            continue
        seen_ids.add(id(heading))

        label = _clean(heading.get_text(" ", strip=True))
        if not label or len(label) > 90:
            continue

        chunks = []
        for sib in heading.find_next_siblings():
            if _is_heading(sib):
                break
            if _is_skippable(sib):
                continue  # captured separately by DETAIL_TARGETED
            text = _clean(sib.get_text(" ", strip=True))
            if text:
                chunks.append(text)
        body = " ".join(chunks).strip()
        if not body:
            continue

        sections.setdefault(label, body)
        key = _canonical(label, SECTION_ALIASES)
        if not key and label.lower().startswith("about"):
            # The company section is headed "About <Company Name>", so it can
            # only be recognised by shape. Anything "About the internship/job"
            # already matched an alias above.
            key = "company_description"
        if key:
            out.setdefault(key, body)

    if sections:
        out["sections_json"] = json.dumps(sections, ensure_ascii=False)
    return out


def parse_detail(html: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    raw_ld, posting = _extract_ld_json(soup)
    _drop_responsive_duplicates(soup)

    root = None
    for sel in DETAIL_ROOT_SELECTORS:
        root = soup.select_one(sel)
        if root:
            break
    root = root or soup

    record: dict[str, Any] = {}
    record.update(_from_posting(posting))
    record.update(_harvest_meta(root))
    record.update(_harvest_sections(root))

    # Precise selectors win over whatever the generic heading walk produced.
    for field, selector in DETAIL_TARGETED.items():
        node = root.select_one(selector)
        if node:
            text = _clean(node.get_text(" ", strip=True))
            if text:
                record[field] = text

    if raw_ld:
        record["ld_json"] = raw_ld
    if h1 := soup.select_one("h1"):
        record["detail_title"] = _clean(h1.get_text(" ", strip=True))

    # Applicant / activity numbers appear in a few different wrappers.
    for sel in (".applications_message", ".activity_container", ".hiring_since"):
        node = root.select_one(sel)
        if node:
            record.setdefault("hiring_activity", _clean(node.get_text(" ", strip=True)))
            break

    # Fall back to the structured description when the section harvest missed.
    if not record.get("description") and record.get("ld_description"):
        record["description"] = record["ld_description"]

    return record


# --------------------------------------------------------------------------
# Orchestration for one job
# --------------------------------------------------------------------------
def enrich(ctx: BrowserContext, url: str) -> dict:
    """Fetch + parse one detail page, retrying transient failures."""
    last: Exception | None = None
    for attempt in range(1, DETAIL_RETRIES + 1):
        try:
            return parse_detail(fetch_detail(ctx, url))
        except AuthExpired:
            raise  # never retry: the whole run needs to stop
        except Exception as exc:  # network blip, timeout, 5xx
            last = exc
            if attempt < DETAIL_RETRIES:
                time.sleep(BACKOFF_BASE_S * 2 ** (attempt - 1) + random.random())
    raise last if last else RuntimeError("detail fetch failed")


def polite_pause() -> None:
    time.sleep(random.uniform(*DETAIL_DELAY_S))
