"""Central configuration: paths, URLs, selectors and timings.

Selectors are candidate lists. Extractors try each in order and keep the first
one that yields text, so when Internshala reshuffles its markup you add a new
candidate here instead of editing the parsers.
"""

import os
from pathlib import Path

VERSION = "1.1.0"

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SAMPLES_DIR = DATA_DIR / "samples"

SESSION_PATH = DATA_DIR / "session.json"
SESSION_DEBUG_PATH = DATA_DIR / "session-check.html"
JSONL_PATH = DATA_DIR / "jobs.raw.jsonl"
CSV_PATH = DATA_DIR / "jobs.csv"
STATE_PATH = DATA_DIR / "state.json"
LOG_PATH = DATA_DIR / "scraper.log"
PID_PATH = DATA_DIR / "scraper.pid"

# --------------------------------------------------------------------------
# URLs
# --------------------------------------------------------------------------
BASE = "https://internshala.com"
LOGIN_URL = f"{BASE}/login/student"

# Tried in order until one gives a confident answer. A single check URL is
# fragile: if that one page 404s or redirects for an unrelated reason, a
# perfectly good session looks expired.
AUTH_CHECK_URLS = [
    f"{BASE}/student/dashboard",
    f"{BASE}/student/applications",
    f"{BASE}/internships/",
]

LISTINGS = {
    "internships": f"{BASE}/internships/",
    "jobs": f"{BASE}/jobs/",
}
SOURCES = ("internships", "jobs")

# The AJAX endpoints behind each listing's infinite scroll. They return JSON
# — 40 cards of markup plus `is_last_page` / `next_page_number` — which means
# pagination can be driven directly instead of by scrolling a browser, and
# every page can be requested at once. Both sections answer with the same
# envelope, so `internship_list_html` is the payload key for jobs too.
LISTING_AJAX = {
    "internships": f"{BASE}/internships_ajax/page-{{page}}/",
    "jobs": f"{BASE}/jobs_ajax/page-{{page}}/",
}
AJAX_LIST_KEY = "internship_list_html"
AJAX_HEADING_KEY = "internship_seo_heading_html"

# --------------------------------------------------------------------------
# MongoDB. Local by default; override with the MONGO_URI env var.
# --------------------------------------------------------------------------
MONGO_URI = os.environ.get("MONGO_URI", "mongodb://127.0.0.1:27017")
MONGO_DB = os.environ.get("MONGO_DB", "internshala")

# --------------------------------------------------------------------------
# Browser
# --------------------------------------------------------------------------
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
VIEWPORT = {"width": 1440, "height": 900}
NAV_TIMEOUT_MS = 45_000

# --------------------------------------------------------------------------
# Pacing. Deliberately unhurried: this runs against your own logged-in
# account, and hammering it is the one thing that reliably gets an account
# rate limited.
# --------------------------------------------------------------------------
SCROLL_STEP_PX = 1200
SCROLL_PAUSE_MS = (700, 1400)
STALE_LIMIT = 4  # consecutive scrolls with no new cards before we stop
PAGE_SETTLE_MS = 1800  # after clicking "next page"
DETAIL_DELAY_S = (1.0, 2.2)
DETAIL_RETRIES = 3
BACKOFF_BASE_S = 2.0

# --------------------------------------------------------------------------
# Parallel (HTTP) pipeline. The browser path above stays sequential on
# purpose; this one is bounded by semaphores instead. Concurrency is the one
# number worth tuning — measured against the live site, 12 detail workers is
# comfortably inside what it serves without a single 429.
# --------------------------------------------------------------------------
LISTING_CONCURRENCY = 8
DETAIL_CONCURRENCY = 12
HTTP_TIMEOUT_S = 45
# A `total` timeout alone is not enough. It is attached to the response, and a
# keep-alive socket that goes quiet mid-body can leave the request parked
# forever — which deadlocked a full run at ~780 records with every worker
# stuck in-flight and zero CPU. sock_read fires on silence, which is the
# condition that actually occurs, and a wait_for backstop covers the rest.
HTTP_SOCK_CONNECT_S = 15
HTTP_SOCK_READ_S = 20
HTTP_RETRIES = 3
MONGO_BATCH = 50  # records per bulk upsert
PAGE_PROBE_BATCH = 8  # listing pages requested per wave

# --------------------------------------------------------------------------
# Selectors
# --------------------------------------------------------------------------
CARD_SELECTORS = [
    "div.individual_internship",
    "div.internship_meta",
    "div[internshipid]",
    "div[jobid]",
    "div.job-internship-card",
]
CARD_SELECTOR = ", ".join(CARD_SELECTORS)

# Attributes that may carry the listing's stable id, in priority order.
CARD_ID_ATTRS = ["internshipid", "jobid", "data-id", "data-internshipid", "id"]
CARD_HREF_ATTRS = ["data-href", "href"]

# The jobs listing marks each meta row with an icon class rather than a
# meaningful one, so the value is found via the icon's parent. This is also
# more stable than positional selectors like ".ic-16-calendar + span".
CARD_ICON_FIELDS = {
    "location": "ic-16-home",
    "money": "ic-16-money",  # stipend on internships, salary on jobs
    "experience": "ic-16-briefcase",
    "duration": "ic-16-calendar",
}

# Cards render some values twice, once per breakpoint ("₹ 2,50,000 - 8,50,000"
# then "₹ 2,50,000 - 8,50,000 /year"). Drop the mobile copy before reading text.
CARD_MOBILE_CLASSES = {"mobile", "mobile_only", "visible-xs"}

CARD_SKILL_SELECTORS = [".job_skill", ".round_tabs", ".skill_tag"]

CARD_TITLE_SELECTORS = [
    ".job-internship-name",
    ".job-title-href",
    "h3.job-internship-name a",
    ".profile h3 a",
    ".profile a",
    "h3.heading_4_5 a",
    "h3 a",
]
CARD_COMPANY_SELECTORS = [
    ".company-name",
    ".company_name",
    "p.company-name",
    ".company h4",
    ".company_and_premium",
]
CARD_LOCATION_SELECTORS = [
    "#location_names",
    ".locations",
    ".location_link",
    ".row-1-item.locations",
]
CARD_STIPEND_SELECTORS = [
    ".stipend",
    ".salary",
    ".stipend_container .stipend",
]
CARD_DURATION_SELECTORS = [
    ".ic-16-calendar + span",
    ".row-1-item .ic-16-calendar ~ span",
]
CARD_POSTED_SELECTORS = [
    ".status-inactive",
    ".status-success",
    ".posted_by_container",
]
CARD_LABEL_SELECTORS = [
    ".status",
    ".label",
    ".early_applicant_wrapper",
    ".status-success",
]
CARD_LOGO_SELECTORS = [
    ".internship_logo img",
    ".company_logo img",
    "img.logo",
    "img",
]

# Detail page
DETAIL_ROOT_SELECTORS = [
    ".detail_view",
    ".internship_details",
    "#details_container",
    ".individual_internship_details",
]
DETAIL_META_ITEM_SELECTORS = [
    ".other_detail_item",
    ".item_body_container",
    ".internship_other_details_container .item",
]
DETAIL_HEADING_SELECTORS = [
    ".section_heading",
    "h3.section_heading",
    ".heading_5_5",
    ".detail_title",
]

# Blocks that sit between a heading and the next one but are not part of that
# section's content. Without this, the "Earn certifications in these skills"
# upsell gets swallowed into the `skills` field. Each is captured separately
# by DETAIL_TARGETED below, so nothing is lost — only moved to its own column.
SECTION_SKIP_CLASSES = {
    "training_skills_container",
    "activity_section",
    "company_info",
    "similar_internships",
    "apply_button_container",
}

# Precise selectors that beat the generic heading walk when they match.
DETAIL_TARGETED = {
    "company_description": ".about_company_text_container",
    "company_location": ".company_info",
    "hiring_activity": ".activity_section",
    "certifications": ".training_skills_container",
    "skills": ".round_tabs_container",
}

# Internshala ships both a mobile and a desktop copy of some values in the
# markup, so a naive text grab returns "Starts immediately Immediately".
RESPONSIVE_DUPLICATE_SUFFIX = "_mobile"

# Heading text on the detail page -> canonical column name. Matching is
# case-insensitive substring, so "About the internship" hits "about".
SECTION_ALIASES = {
    "about the internship": "description",
    "about the job": "description",
    "about the work from home": "description",
    "responsibilities": "responsibilities",
    "selected intern's day-to-day responsibilities include": "responsibilities",
    "skill(s) required": "skills",
    "skills required": "skills",
    "who can apply": "who_can_apply",
    "perks": "perks",
    "additional information": "additional_information",
    "number of openings": "openings",
    "about company": "company_description",
    "about the company": "company_description",
    "activity on internshala": "hiring_activity",
    "earn certifications": "certifications",
    "salary": "salary_detail",
    "stipend": "stipend_detail",
    "eligibility": "eligibility",
    "annual ctc": "annual_ctc",
}

# Meta-item labels on the detail page -> canonical column name.
META_ALIASES = {
    "start date": "start_date",
    "duration": "duration",
    "stipend": "stipend",
    "salary": "salary",
    "ctc": "annual_ctc",
    "apply by": "apply_by",
    "experience": "experience",
    "location": "location",
    "posted": "posted",
    "openings": "openings",
    "job offered": "job_offered",
    "probation": "probation",
}

# --------------------------------------------------------------------------
# CSV shape: these columns lead, everything else follows alphabetically.
# --------------------------------------------------------------------------
CORE_COLUMNS = [
    "job_id",
    "title",
    "company",
    "location",
    "work_from_home",
    "part_time",
    "stipend",
    "salary",
    "annual_ctc",
    "experience",
    "duration",
    "start_date",
    "apply_by",
    "openings",
    "posted",
    "actively_hiring",
    "skills",
    "perks",
    "description",
    "responsibilities",
    "who_can_apply",
    "company_description",
    "company_location",
    "certifications",
    "hiring_activity",
    "applicants",
    "url",
    "logo",
    "labels",
    "status",
    "error",
    "source",
    "scraped_at",
    "scraper_version",
]
