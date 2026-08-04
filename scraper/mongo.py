"""MongoDB sink: one collection per section, upserted by listing id.

The JSONL checkpoint stays as the crash-proof append log; Mongo is the
queryable copy. Writes are upserts keyed on `job_id`, so re-running a scrape
refreshes rows instead of duplicating them, and an interrupted run costs
nothing but the batch in flight.

pymongo is synchronous. Rather than take on a second driver, the async
pipeline calls these methods through `asyncio.to_thread` — writes are batched
and Mongo is on localhost, so they never become the bottleneck.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Iterable

from pymongo import MongoClient, UpdateOne
from pymongo.errors import BulkWriteError, PyMongoError

from .config import MONGO_DB, MONGO_URI, SOURCES

# Fields that must never overwrite an existing value with a blank one. A
# listing-only pass writes an empty `description`; a later detail pass fills
# it in. Without this, running the two in either order could clear good data.
_NEVER_BLANK = {
    "description",
    "responsibilities",
    "skills",
    "perks",
    "who_can_apply",
    "company_description",
    "ld_json",
    "sections_json",
}


class MongoStore:
    """Upserting writer over `internshala.{internships,jobs}`."""

    def __init__(self, uri: str = MONGO_URI, db_name: str = MONGO_DB):
        self.uri = uri
        self.db_name = db_name
        # serverSelectionTimeoutMS keeps a missing mongod to a 3s failure
        # instead of the 30s default, so the CLI can report it and move on.
        self.client: MongoClient = MongoClient(uri, serverSelectionTimeoutMS=3000)
        self.db = self.client[db_name]

    # -- setup -------------------------------------------------------------
    def ping(self) -> str:
        info = self.client.server_info()
        return info.get("version", "?")

    def ensure_indexes(self) -> None:
        """Idempotent; safe to call on every run."""
        for name in SOURCES:
            coll = self.db[name]
            coll.create_index("job_id", unique=True, name="job_id_unique")
            coll.create_index("company", name="company_idx")
            coll.create_index("status", name="status_idx")
            coll.create_index("scraped_at", name="scraped_at_idx")
            # Powers "find me every remote python internship" without a scan.
            coll.create_index(
                [("title", "text"), ("skills", "text"), ("description", "text")],
                name="text_idx",
            )

    # -- read --------------------------------------------------------------
    def existing_ids(self, source: str, complete_only: bool = True) -> set[str]:
        """Ids already stored for `source`.

        `complete_only` skips rows that were written listing-only or failed,
        so a resumed run goes back and fills in the details they are missing
        rather than treating them as finished.
        """
        query = {"status": "ok"} if complete_only else {}
        try:
            return {
                doc["job_id"]
                for doc in self.db[source].find(query, {"job_id": 1})
                if doc.get("job_id")
            }
        except PyMongoError:
            return set()

    def counts(self) -> dict[str, int]:
        out = {}
        for name in SOURCES:
            try:
                out[name] = self.db[name].count_documents({})
            except PyMongoError:
                out[name] = -1
        return out

    # -- write -------------------------------------------------------------
    def upsert_many(self, source: str, records: Iterable[dict]) -> int:
        """Upsert a batch by job_id. Returns how many were written."""
        ops: list[UpdateOne] = []
        now = datetime.now(timezone.utc)

        for record in records:
            job_id = str(record.get("job_id") or "").strip()
            if not job_id:
                continue  # nothing stable to key on; the JSONL still has it

            doc = {k: v for k, v in record.items() if v not in (None, "")}
            doc["job_id"] = job_id
            doc["source"] = source
            doc["updated_at"] = now

            blanks = {
                k: v
                for k, v in record.items()
                if v in (None, "") and k not in _NEVER_BLANK
            }

            update: dict = {"$set": {**blanks, **doc}, "$setOnInsert": {"first_seen_at": now}}
            ops.append(UpdateOne({"job_id": job_id}, update, upsert=True))

        if not ops:
            return 0

        try:
            result = self.db[source].bulk_write(ops, ordered=False)
            return result.upserted_count + result.modified_count
        except BulkWriteError as exc:
            # A duplicate-key race between concurrent workers is expected and
            # harmless: the row is there either way. Anything else re-raises.
            errors = exc.details.get("writeErrors", [])
            if all(e.get("code") == 11000 for e in errors):
                return len(ops) - len(errors)
            raise

    def query_listings(
        self,
        sources: Iterable[str] = SOURCES,
        search: str | None = None,
        location: str | None = None,
        recent_hours: float | None = None,
        page: int = 1,
        limit: int = 20,
        exclude: Iterable[str] = _NEVER_BLANK,
    ) -> dict:
        """Query listings with filters, text search, date cutoff, and pagination."""
        from datetime import datetime, timedelta, timezone

        projection = {"_id": 0}
        projection.update({field: 0 for field in exclude})

        query: dict = {}
        if search and search.strip():
            stext = search.strip()
            query["$or"] = [
                {"title": {"$regex": stext, "$options": "i"}},
                {"company": {"$regex": stext, "$options": "i"}},
                {"skills": {"$regex": stext, "$options": "i"}},
                {"location": {"$regex": stext, "$options": "i"}},
            ]

        if location and location.strip():
            loc = location.strip()
            query["location"] = {"$regex": loc, "$options": "i"}

        if recent_hours and recent_hours > 0:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=recent_hours)
            query["$or"] = [
                {"updated_at": {"$gte": cutoff}},
                {"first_seen_at": {"$gte": cutoff}},
            ]

        selected_sources = [s for s in sources if s in SOURCES]
        if not selected_sources:
            selected_sources = list(SOURCES)

        results = []
        total_count = 0

        for name in selected_sources:
            try:
                coll = self.db[name]
                total_count += coll.count_documents(query)
                cursor = coll.find(query, projection).sort("updated_at", -1)
                for doc in cursor:
                    if isinstance(doc.get("updated_at"), datetime):
                        doc["updated_at"] = doc["updated_at"].isoformat()
                    if isinstance(doc.get("first_seen_at"), datetime):
                        doc["first_seen_at"] = doc["first_seen_at"].isoformat()
                    if isinstance(doc.get("scraped_at"), datetime):
                        doc["scraped_at"] = doc["scraped_at"].isoformat()
                    results.append(doc)
            except PyMongoError:
                pass

        # Sort combined results by updated_at descending
        results.sort(key=lambda x: str(x.get("updated_at") or x.get("first_seen_at") or ""), reverse=True)

        skip = (page - 1) * limit
        paginated_items = results[skip : skip + limit]

        return {
            "total": total_count,
            "page": page,
            "limit": limit,
            "total_pages": (total_count + limit - 1) // limit if limit > 0 else 1,
            "items": paginated_items,
        }

    def get_stats(self) -> dict:
        """Summary metrics across all MongoDB collections."""
        from datetime import datetime, timedelta, timezone

        now = datetime.now(timezone.utc)
        cutoff_36h = now - timedelta(hours=36)
        
        stats = {
            "jobs_total": 0,
            "internships_total": 0,
            "recent_36h_total": 0,
            "last_updated": None,
        }

        for source in SOURCES:
            try:
                coll = self.db[source]
                count = coll.count_documents({})
                if source == "jobs":
                    stats["jobs_total"] = count
                else:
                    stats["internships_total"] = count

                recent = coll.count_documents({
                    "$or": [
                        {"updated_at": {"$gte": cutoff_36h}},
                        {"first_seen_at": {"$gte": cutoff_36h}},
                    ]
                })
                stats["recent_36h_total"] += recent

                latest = coll.find_one({}, sort=[("updated_at", -1)], projection={"updated_at": 1})
                if latest and latest.get("updated_at"):
                    dt = latest["updated_at"]
                    if isinstance(dt, datetime):
                        dt_iso = dt.isoformat()
                        if not stats["last_updated"] or dt_iso > stats["last_updated"]:
                            stats["last_updated"] = dt_iso
            except PyMongoError:
                pass

        stats["grand_total"] = stats["jobs_total"] + stats["internships_total"]
        return stats

    def read_all(
        self,
        sources: Iterable[str] = SOURCES,
        exclude: Iterable[str] = (),
    ) -> list[dict]:
        """Every stored document, for rebuilding the CSV or feeding external scripts."""
        projection = {"_id": 0}
        projection.update({field: 0 for field in exclude})
        rows: list[dict] = []
        for name in sources:
            rows.extend(self.db[name].find({}, projection))
        return rows

    def close(self) -> None:
        try:
            self.client.close()
        except Exception:
            pass

