"""Log in once by hand, then reuse the saved session forever after.

Playwright's `storage_state` serialises cookies *and* localStorage into one
JSON file, which is the whole reason this project uses Playwright over
Selenium. The only rule worth remembering: an expired session file still
exists on disk, so validity is always checked behaviourally, never by
looking at the file.

Two things this module deliberately will NOT do:

* delete `session.json`. A false negative from the validity probe would
  otherwise throw away a login the user had to perform by hand.
* prompt for a login when stdin is not a terminal. The prompt would just
  raise EOFError somewhere confusing; a clear NoSession is far better.
"""

from __future__ import annotations

import sys

from playwright.sync_api import (
    Browser,
    BrowserContext,
    Playwright,
    TimeoutError as PWTimeout,
)

from .config import (
    AUTH_CHECK_URLS,
    LOGIN_URL,
    NAV_TIMEOUT_MS,
    SESSION_DEBUG_PATH,
    SESSION_PATH,
    USER_AGENT,
    VIEWPORT,
)
from .errors import NoSession

# Any one of these on the page means we are signed in.
LOGGED_IN_MARKERS = [
    'a[href*="logout"]',
    'a[href*="/student/dashboard"]',
    'a[href*="/student/applications"]',
    'a[href*="/student/profile"]',
    'a[href*="/student/chat"]',
    "#profile_container",
    ".profile_container",
    "#header_dropdown",
    ".student_dashboard",
    "#name_container",
    ".user_name",
]

# Any one of these means we are signed out, even if the page looks fine.
LOGGED_OUT_MARKERS = [
    'input[type="password"]',
    'a[href*="/login/student"]',
    'a[href*="/register/student"]',
    "#login-cta",
    ".login_cta",
]

LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"]

# Parks a real (non-headless) window far off the desktop. Indistinguishable
# from a normal browser to the site, but out of the user's way.
OFFSCREEN_ARGS = ["--window-position=-32000,-32000", "--window-size=1440,900"]


def launch_browser(pw: Playwright, headless: bool = True) -> Browser:
    """Launch a browser that Internshala will treat as signed in.

    Measured against a known-good session file: Playwright's bundled Chromium
    in headless mode is detected and served the signed-out homepage, while
    real Chrome's headless mode is not. So headless means Chrome-the-channel,
    and if Chrome isn't installed we fall back to a genuine window parked
    offscreen rather than silently scraping a logged-out site.
    """
    if not headless:
        return pw.chromium.launch(headless=False, args=LAUNCH_ARGS)
    try:
        return pw.chromium.launch(headless=True, args=LAUNCH_ARGS, channel="chrome")
    except Exception:
        return pw.chromium.launch(headless=False, args=LAUNCH_ARGS + OFFSCREEN_ARGS)


def _new_context(browser: Browser, use_session: bool) -> BrowserContext:
    kwargs = {"user_agent": USER_AGENT, "viewport": VIEWPORT, "locale": "en-IN"}
    if use_session:
        kwargs["storage_state"] = str(SESSION_PATH)
    ctx = browser.new_context(**kwargs)
    ctx.set_default_navigation_timeout(NAV_TIMEOUT_MS)
    ctx.set_default_timeout(NAV_TIMEOUT_MS)
    return ctx


def probe_session(ctx: BrowserContext, save_debug: bool = False) -> tuple[bool, dict]:
    """Check whether `ctx` is signed in, and report what the evidence was.

    Returns (logged_in, details). `details` is what you need to pin the
    markers when the answer is wrong — see `run_scraper.py check`.
    """
    page = ctx.new_page()
    details: dict = {"attempts": []}
    try:
        for url in AUTH_CHECK_URLS:
            attempt: dict = {"requested": url}
            try:
                page.goto(url, wait_until="domcontentloaded")
                page.wait_for_timeout(1200)
            except PWTimeout:
                attempt["error"] = "timeout"
                details["attempts"].append(attempt)
                continue

            attempt["landed"] = page.url
            attempt["title"] = page.title()
            attempt["in"] = [s for s in LOGGED_IN_MARKERS if page.query_selector(s)]
            attempt["out"] = [s for s in LOGGED_OUT_MARKERS if page.query_selector(s)]
            redirected = "/login" in page.url.lower() or "/register" in page.url.lower()
            attempt["redirected_to_login"] = redirected
            details["attempts"].append(attempt)

            # A positive marker wins outright — logged-in pages sometimes
            # still carry a stray "register" link in the footer.
            if attempt["in"]:
                details["verdict"] = f"signed in ({url})"
                return True, details
            if redirected or attempt["out"]:
                details["verdict"] = f"signed out ({url})"
                if save_debug:
                    SESSION_DEBUG_PATH.parent.mkdir(parents=True, exist_ok=True)
                    SESSION_DEBUG_PATH.write_text(page.content(), encoding="utf-8")
                    details["debug_html"] = str(SESSION_DEBUG_PATH)
                return False, details
            # Inconclusive — try the next URL.

        details["verdict"] = "inconclusive on every check URL"
        if save_debug:
            SESSION_DEBUG_PATH.parent.mkdir(parents=True, exist_ok=True)
            SESSION_DEBUG_PATH.write_text(page.content(), encoding="utf-8")
            details["debug_html"] = str(SESSION_DEBUG_PATH)
        return False, details
    finally:
        page.close()


def is_logged_in(ctx: BrowserContext) -> bool:
    return probe_session(ctx)[0]


def manual_login(ctx: BrowserContext) -> None:
    """Open the login page and block until the user says they are done."""
    if not sys.stdin.isatty():
        raise NoSession(
            "A login needs a terminal to wait on. Run `python run_scraper.py login` "
            "yourself in PowerShell."
        )

    page = ctx.new_page()
    page.goto(LOGIN_URL, wait_until="domcontentloaded")
    print("\n" + "=" * 68)
    print("  A browser window is open on the Internshala login page.")
    print("  Sign in there — including any OTP or verification step.")
    print("  When you land on your dashboard, come back here.")
    print("=" * 68)
    input("\nPress Enter once you are logged in... ")

    ok, details = probe_session(ctx, save_debug=True)
    if not ok:
        # Save anyway. The probe is a heuristic; the cookies are real, and
        # throwing them away would force another manual login for nothing.
        SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
        ctx.storage_state(path=str(SESSION_PATH))
        print(f"\nSaved the session to {SESSION_PATH}, but the check was not convinced:")
        print(f"  {details.get('verdict')}")
        print("  Run `python run_scraper.py check` to see what it saw.")
        page.close()
        return

    SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
    ctx.storage_state(path=str(SESSION_PATH))
    print(f"Session saved to {SESSION_PATH}")
    page.close()


def open_context(
    pw: Playwright,
    headless: bool = True,
    allow_login: bool = True,
) -> tuple[Browser, BrowserContext]:
    """Return a browser + authenticated context, logging in if necessary."""
    if SESSION_PATH.exists():
        browser = launch_browser(pw, headless=headless)
        ctx = _new_context(browser, use_session=True)
        ok, details = probe_session(ctx, save_debug=True)
        if ok:
            return browser, ctx

        ctx.close()
        browser.close()
        # The file is left alone on purpose: see the module docstring.
        if not allow_login or not sys.stdin.isatty():
            raise NoSession(
                f"Saved session did not pass the check ({details.get('verdict')}). "
                "Run `python run_scraper.py check` to inspect it, or "
                "`python run_scraper.py login` to sign in again."
            )

    if not allow_login or not sys.stdin.isatty():
        raise NoSession(
            "No usable session. Run `python run_scraper.py login` in a terminal first."
        )

    browser = launch_browser(pw, headless=False)  # login needs a real window
    ctx = _new_context(browser, use_session=False)
    manual_login(ctx)
    return browser, ctx


def session_status() -> str:
    """Cheap, non-launching status for the dashboard sidebar."""
    return "saved" if SESSION_PATH.exists() else "missing"
