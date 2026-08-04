"""Async HTTP transport, authenticated from the saved Playwright session.

The browser is only needed to *obtain* a login. Once `session.json` exists,
Internshala serves fully signed-in pages to a plain HTTP client carrying those
cookies — verified against the live site. Dropping the browser is what makes
real concurrency possible: no DOM, no rendering, no scroll loop, just
requests.

`storage_state` is Playwright's format, so cookies are read out of it rather
than maintained separately. One login still serves every code path.
"""

from __future__ import annotations

import asyncio
import json
import random
from pathlib import Path
from urllib.parse import urlparse

import aiohttp

from .config import (
    BACKOFF_BASE_S,
    HTTP_RETRIES,
    HTTP_SOCK_CONNECT_S,
    HTTP_SOCK_READ_S,
    HTTP_TIMEOUT_S,
    SESSION_PATH,
    USER_AGENT,
)
from .errors import AuthExpired, NoSession

# Sent on every request. Internshala's AJAX endpoints key off
# X-Requested-With; without it they return the full HTML page instead of JSON.
BASE_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-IN,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
}
AJAX_HEADERS = {
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json, text/javascript, */*; q=0.01",
}
HTML_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

MAX_HEADER_BYTES = 128 * 1024


def load_cookies(path: Path = SESSION_PATH) -> dict[str, str]:
    """Pull the cookie jar out of Playwright's storage_state file."""
    if not path.exists():
        raise NoSession(
            f"No session at {path}. Run `python run_scraper.py login` once first."
        )
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise NoSession(f"Could not read {path}: {exc}") from exc

    cookies = {
        c["name"]: c["value"]
        for c in state.get("cookies", [])
        if c.get("name") and c.get("value") is not None
    }
    if not cookies:
        raise NoSession(f"{path} has no cookies. Run `python run_scraper.py login`.")
    return cookies


def is_internshala(url: str) -> bool:
    """Is this one of our own pages, or an off-site link from a listing?"""
    host = urlparse(url).hostname or ""
    return host == "internshala.com" or host.endswith(".internshala.com")


def _looks_signed_out(url: str, body: str) -> bool:
    """Detect a session that has stopped working.

    Checked on the landed URL and on markers in the body. A signed-in page can
    still carry a stray footer link, so the body test needs both a positive
    absence and a negative presence to fire.
    """
    # An off-site page bouncing to *its* login says nothing about our session.
    if not is_internshala(url):
        return False
    if "/login" in url.lower() or "/register" in url.lower():
        return True
    if not body:
        return False
    head = body[:6000].lower()
    return 'name="password"' in head and "logout" not in body.lower()


class Fetcher:
    """Bounded-concurrency HTTP client with retry, backoff and auth checks."""

    def __init__(self, concurrency: int, cookies: dict[str, str] | None = None):
        self.concurrency = max(1, concurrency)
        self.cookies = cookies if cookies is not None else load_cookies()
        self._session: aiohttp.ClientSession | None = None
        self.requests = 0
        self.retries = 0

    async def __aenter__(self) -> "Fetcher":
        # limit caps the whole pool; limit_per_host is what actually matters
        # here since every request goes to one origin.
        connector = aiohttp.TCPConnector(
            limit=self.concurrency * 2,
            limit_per_host=self.concurrency,
            ttl_dns_cache=300,
            # Reap sockets the peer closed instead of handing a dead one to
            # the next request out of the keep-alive pool.
            enable_cleanup_closed=True,
        )
        headers = dict(BASE_HEADERS)
        if self.cookies:
            headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())

        self._session = aiohttp.ClientSession(
            connector=connector,
            # DummyCookieJar + a static Cookie header, rather than letting
            # aiohttp manage the jar. Internshala returns an ~11KB Set-Cookie
            # block on every response; parsing that through SimpleCookie each
            # time costs more than the request itself and drops throughput
            # from ~10 req/s to under 2. We want a fixed session anyway — the
            # server's cookie updates are of no use to a read-only scrape.
            cookie_jar=aiohttp.DummyCookieJar(),
            headers=headers,
            timeout=aiohttp.ClientTimeout(
                total=HTTP_TIMEOUT_S,
                sock_connect=HTTP_SOCK_CONNECT_S,
                sock_read=HTTP_SOCK_READ_S,
            ),
            # Internshala answers with a Set-Cookie block well over aiohttp's
            # default 8190-byte header cap, which otherwise fails every single
            # request with "Header value is too long".
            max_line_size=MAX_HEADER_BYTES,
            max_field_size=MAX_HEADER_BYTES,
        )
        return self

    async def __aexit__(self, *exc_info) -> None:
        if self._session:
            await self._session.close()
            # Give aiohttp's transports a tick to unwind, otherwise Windows
            # prints "Event loop is closed" noise on exit.
            await asyncio.sleep(0.1)

    async def _once(self, url: str, headers: dict) -> tuple[str, str]:
        """One request/response cycle. Returns (body, landed_url)."""
        assert self._session is not None
        async with self._session.get(url, headers=headers) as resp:
            # 429/5xx are worth another go; 4xx generally is not.
            if resp.status == 429 or resp.status >= 500:
                raise RuntimeError(f"HTTP {resp.status}")
            if resp.status in (401, 403):
                # Only Internshala can tell us our Internshala session died.
                # Sponsored listings link to ad trackers like appcast.io that
                # 403 every non-browser request; reading that as an expired
                # session aborts an otherwise healthy run.
                if is_internshala(url):
                    raise AuthExpired(f"HTTP {resp.status} for {url}")
                raise RuntimeError(f"HTTP {resp.status} for {url} (external host)")
            if resp.status >= 400:
                raise RuntimeError(f"HTTP {resp.status} for {url}")

            # read()+decode, never resp.text(): text() runs charset
            # auto-detection over the whole body when the Content-Type omits
            # one, which costs ~0.5s on a 170KB detail page and collapses
            # throughput from ~14 req/s to ~1.5. Internshala is UTF-8.
            return (await resp.read()).decode("utf-8", "replace"), str(resp.url)

    async def get_text(self, url: str, referer: str = "", ajax: bool = False) -> str:
        """GET with retries. Raises AuthExpired if the session has died."""
        assert self._session is not None, "use `async with Fetcher(...)`"

        headers = dict(AJAX_HEADERS if ajax else HTML_HEADERS)
        if referer:
            headers["Referer"] = referer

        last: Exception | None = None
        for attempt in range(1, HTTP_RETRIES + 1):
            try:
                # wait_for is the backstop, and deliberately the *only* thing
                # gating a request. There is no semaphore here: TCPConnector's
                # limit/limit_per_host already bounds concurrency, and an
                # asyncio.Semaphore parks a task with no timer attached — so a
                # single lost permit deadlocks every worker silently, which is
                # exactly the failure this pipeline hit twice.
                body, landed = await asyncio.wait_for(
                    self._once(url, headers), timeout=HTTP_TIMEOUT_S + 10
                )

                self.requests += 1
                if _looks_signed_out(landed, body):
                    raise AuthExpired(f"Session rejected while fetching {url}")
                return body

            except AuthExpired:
                raise  # never retry: nothing after this can succeed
            except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError) as exc:
                last = exc
                if attempt < HTTP_RETRIES:
                    self.retries += 1
                    await asyncio.sleep(
                        BACKOFF_BASE_S * 2 ** (attempt - 1) + random.random()
                    )

        raise last if last else RuntimeError(f"failed to fetch {url}")

    async def get_json(self, url: str, referer: str = "") -> dict:
        body = await self.get_text(url, referer=referer, ajax=True)
        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"{url} did not return JSON: {exc}") from exc
