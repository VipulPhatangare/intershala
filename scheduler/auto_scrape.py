"""Auto Scraper Scheduler: Runs background scraping every 36 hours.

Saves schedule status, tracks last run, and triggers `scrape_parallel`
from `scraper.fast` or executes CLI command.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from scraper.config import DATA_DIR
from scraper.fast import scrape_parallel

STATUS_FILE = DATA_DIR / "scheduler_status.json"

_scheduler: BackgroundScheduler | None = None
_lock = threading.Lock()


def get_status() -> dict:
    if STATUS_FILE.exists():
        try:
            return json.loads(STATUS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "status": "idle",
        "schedule": "Daily at 04:00 AM IST",
        "last_run": None,
        "next_run": None,
        "last_result": None,
        "running": False,
    }


def save_status(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp = STATUS_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    temp.replace(STATUS_FILE)


def run_scrape_job(source: str = "all") -> dict:
    """Core scrape job invoked by APScheduler or on-demand."""
    status = get_status()
    if status.get("running"):
        print("[Scheduler] Job already in progress. Skipping.")
        return {"status": "skipped", "message": "Scrape already in progress"}

    now_iso = datetime.now(timezone.utc).isoformat()
    status["status"] = "running"
    status["running"] = True
    status["last_run"] = now_iso
    save_status(status)

    print(f"[Scheduler] Starting daily automatic 4:00 AM IST scrape at {now_iso}...")
    try:
        summaries = scrape_parallel(
            source=source,
            listing_concurrency=4,
            detail_concurrency=10,
            max_pages=0,
            with_details=True,
            resume=True,
            use_mongo=True,
        )
        total_written = sum(s.get("written", 0) for s in summaries)
        result_msg = f"Completed successfully. Scraped/updated {total_written} listings across {len(summaries)} sections."
        status["status"] = "idle"
        status["running"] = False
        status["last_result"] = {
            "success": True,
            "written": total_written,
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "message": result_msg,
        }
        print(f"[Scheduler] {result_msg}")
    except Exception as exc:
        err_msg = f"Failed: {exc}"
        print(f"[Scheduler] Error during auto-scrape: {exc}")
        status["status"] = "error"
        status["running"] = False
        status["last_result"] = {
            "success": False,
            "error": str(exc),
            "finished_at": datetime.now(timezone.utc).isoformat(),
        }

    save_status(status)
    return status.get("last_result", {})


def start_scheduler(interval_hours: float = 36.0, run_immediately: bool = False) -> BackgroundScheduler:
    global _scheduler
    with _lock:
        if _scheduler and _scheduler.running:
            return _scheduler

        _scheduler = BackgroundScheduler(timezone="Asia/Kolkata")
        # Run daily at 4:00 AM IST
        _scheduler.add_job(
            func=run_scrape_job,
            trigger=CronTrigger(hour=4, minute=0, timezone="Asia/Kolkata"),
            id="internshala_daily_4am_ist_scrape",
            name="Internshala Daily 4:00 AM IST Auto Scrape",
            replace_existing=True,
        )
        _scheduler.start()

        job = _scheduler.get_job("internshala_daily_4am_ist_scrape")
        next_run = job.next_run_time.isoformat() if job and job.next_run_time else None

        status = get_status()
        status["schedule"] = "Daily at 04:00 AM IST"
        status["next_run"] = next_run
        status["scheduler_active"] = True
        save_status(status)

        print(f"[Scheduler] APScheduler started. Scheduled Daily at 04:00 AM IST. Next run at: {next_run}")

        if run_immediately:
            threading.Thread(target=run_scrape_job, daemon=True).start()

        return _scheduler


def stop_scheduler() -> None:
    global _scheduler
    with _lock:
        if _scheduler and _scheduler.running:
            _scheduler.shutdown(wait=False)
            _scheduler = None
        status = get_status()
        status["scheduler_active"] = False
        save_status(status)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Internshala 36-Hour Auto Scraper Scheduler")
    parser.add_argument("--interval", type=float, default=36.0, help="Interval in hours (default 36)")
    parser.add_argument("--run-now", action="store_true", help="Run a scrape immediately before starting schedule")
    args = parser.parse_args()

    sched = start_scheduler(interval_hours=args.interval, run_immediately=args.run_now)
    print("Scheduler running in background. Press Ctrl+C to exit.")
    try:
        while True:
            time.sleep(1)
    except (KeyboardInterrupt, SystemExit):
        stop_scheduler()
        print("Scheduler stopped.")
