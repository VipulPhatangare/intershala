"""Flask Web Application for Internshala Scraper.

Provides a modern dashboard UI to browse, filter, and search jobs & internships
stored in MongoDB, along with auto-scraper controls and last-36-hours filter.
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request

from scheduler.auto_scrape import get_status, run_scrape_job, start_scheduler
from scraper.mongo import MongoStore

app = Flask(__name__, template_folder="templates", static_folder="static")

# Auto-start scheduler when server runs
start_scheduler(interval_hours=36.0, run_immediately=False)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/jobs/stats", methods=["GET"])
@app.route("/api/stats", methods=["GET"])
def api_stats():
    store = MongoStore()
    try:
        stats = store.get_stats()
        sched_status = get_status()
        stats["scheduler"] = sched_status
        return jsonify({"success": True, "data": stats})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500
    finally:
        store.close()


@app.route("/api/jobs/listings", methods=["GET"])
@app.route("/api/listings", methods=["GET"])
def api_listings():
    source_param = request.args.get("source", "all")
    search_param = request.args.get("search", None)
    location_param = request.args.get("location", None)
    recent_param = request.args.get("recent_hours", None)
    page_param = request.args.get("page", 1, type=int)
    limit_param = request.args.get("limit", 18, type=int)

    recent_hours = None
    if recent_param:
        try:
            recent_hours = float(recent_param)
        except ValueError:
            pass

    if source_param == "jobs":
        sources = ["jobs"]
    elif source_param == "internships":
        sources = ["internships"]
    else:
        sources = ["jobs", "internships"]

    store = MongoStore()
    try:
        data = store.query_listings(
            sources=sources,
            search=search_param,
            location=location_param,
            recent_hours=recent_hours,
            page=page_param,
            limit=limit_param,
        )
        return jsonify({"success": True, "data": data})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500
    finally:
        store.close()


@app.route("/api/jobs/listing/<source>/<job_id>", methods=["GET"])
@app.route("/api/listing/<source>/<job_id>", methods=["GET"])
def api_listing_detail(source, job_id):
    if source not in ["jobs", "internships"]:
        return jsonify({"success": False, "error": "Invalid source"}), 400
    store = MongoStore()
    try:
        coll = store.db[source]
        doc = coll.find_one({"job_id": job_id}, {"_id": 0, "ld_json": 0, "sections_json": 0})
        if not doc:
            return jsonify({"success": False, "error": "Listing not found"}), 404
        if isinstance(doc.get("updated_at"), datetime):
            doc["updated_at"] = doc["updated_at"].isoformat()
        if isinstance(doc.get("first_seen_at"), datetime):
            doc["first_seen_at"] = doc["first_seen_at"].isoformat()
        return jsonify({"success": True, "data": doc})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500
    finally:
        store.close()


@app.route("/api/admin/scrape/trigger", methods=["POST"])
@app.route("/api/scrape/trigger", methods=["POST"])
def api_trigger_scrape():
    req_json = request.get_json(silent=True) or {}
    source = req_json.get("source", "all")

    status = get_status()
    if status.get("running"):
        return jsonify({"success": False, "message": "Scrape is already in progress"}), 400

    def background_worker():
        run_scrape_job(source=source)

    threading.Thread(target=background_worker, daemon=True).start()
    return jsonify({"success": True, "message": f"Scrape triggered for {source} in background"})



if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4000
    app.run(host="0.0.0.0", port=port, debug=True)

