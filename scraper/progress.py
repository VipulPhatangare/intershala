"""Run state, written to disk so the dashboard can watch a live scrape.

The scraper and the dashboard share nothing but files: the scraper owns
`state.json` and appends to `jobs.raw.jsonl`, the dashboard only reads them.
That keeps the UI from ever blocking or crashing the run.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

from .config import STATE_PATH, VERSION


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 4:
                try:
                    path.write_text(text, encoding="utf-8")
                except Exception:
                    pass
                return
            time.sleep(0.05 * (2 ** attempt))


@dataclass
class Progress:
    """Counters for one run. Call `flush()` after every meaningful change."""

    status: str = "idle"  # idle | running | done | failed | needs_login
    phase: str = ""  # listing | details | export
    source: str = ""
    started_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    pages_done: int = 0
    total: int = 0  # what the listing page claims exists, 0 if unknown
    discovered: int = 0
    duplicates: int = 0
    processed: int = 0
    failed: int = 0
    skipped_existing: int = 0
    current: str = ""
    message: str = ""
    errors: list[str] = field(default_factory=list)
    version: str = VERSION

    _last_flush: float = field(default=0.0, repr=False)
    _path: Path = field(default=STATE_PATH, repr=False)

    # -- lifecycle ---------------------------------------------------------
    def start(self, source: str) -> None:
        """Begin a run for `source`, zeroing the per-run counters.

        A multi-source run reuses one Progress, so without this the second
        section reports the first section's totals against its own elapsed
        time — which reads as an impossible rate.
        """
        self.status = "running"
        self.source = source
        self.started_at = time.time()
        self.pages_done = 0
        self.total = 0
        self.discovered = 0
        self.duplicates = 0
        self.processed = 0
        self.failed = 0
        self.skipped_existing = 0
        self.current = ""
        self.flush(force=True)

    def finish(self, status: str = "done", message: str = "") -> None:
        self.status = status
        self.phase = ""
        self.current = ""
        self.message = message
        self.flush(force=True)

    def error(self, msg: str) -> None:
        self.errors.append(f"{time.strftime('%H:%M:%S')}  {msg}")
        del self.errors[:-30]  # keep the tail bounded
        self.flush(force=True)

    # -- io ----------------------------------------------------------------
    def snapshot(self) -> dict:
        data = {k: v for k, v in asdict(self).items() if not k.startswith("_")}
        data["elapsed"] = round(time.time() - self.started_at, 1)
        return data

    def flush(self, force: bool = False) -> None:
        """Persist state, throttled to ~2 writes/sec unless forced."""
        now = time.time()
        if not force and now - self._last_flush < 0.5:
            return
        self.updated_at = now
        self._last_flush = now
        self._path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(self._path, json.dumps(self.snapshot(), indent=2))


def read_state(path: Path = STATE_PATH) -> dict:
    """Read the last known run state. Returns {} when nothing has run yet."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
