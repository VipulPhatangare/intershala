"""Append-only JSONL checkpoint, plus the pandas -> CSV export.

Every finished job is written the moment it is finished. A crash at job 400
of 500 therefore costs nothing, and a rerun can skip ids already on disk.
The CSV is a pure derivation of the JSONL, so it can be rebuilt any time.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from .config import CORE_COLUMNS, CSV_PATH, JSONL_PATH


class JobStore:
    def __init__(self, path: Path = JSONL_PATH):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    # -- write -------------------------------------------------------------
    def append(self, record: dict) -> None:
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    # -- read --------------------------------------------------------------
    def read_all(self) -> list[dict]:
        if not self.path.exists():
            return []
        rows = []
        with self.path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue  # a torn final line from a hard kill
        return rows

    def existing_ids(self) -> set[str]:
        """Both the id and the url of every stored job.

        The listing dedupe checks each card against this set on either key,
        so a card missing one of them is still recognised.
        """
        keys: set[str] = set()
        for row in self.read_all():
            keys.update(k for k in (row.get("job_id"), row.get("url")) if k)
        return keys

    def clear(self) -> None:
        if self.path.exists():
            self.path.unlink()


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------
def _flatten(value):
    """Make a cell CSV-safe: lists join with ' | ', dicts become JSON."""
    if isinstance(value, list):
        return " | ".join(str(v) for v in value if v not in (None, ""))
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return value


def to_dataframe(rows: list[dict]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(columns=CORE_COLUMNS)

    df = pd.json_normalize(rows, sep="_")
    for col in df.columns:
        df[col] = df[col].map(_flatten)

    # The JSONL is append-only, so a re-scrape leaves several rows per job.
    # Mongo collapses those on upsert; the CSV has to do it here. Last wins,
    # matching "the most recent scrape is the truth".
    #
    # The key is (job_id, source), not job_id alone: ~800 listings are posted
    # to both sections, and Mongo keeps one document per section. Deduping on
    # job_id alone would silently drop the internship copy of every one of
    # them and leave the CSV disagreeing with the database.
    if "job_id" in df.columns:
        keyed = df["job_id"].astype(str).str.strip()
        subset = ["job_id", "source"] if "source" in df.columns else ["job_id"]
        df = pd.concat([
            df[keyed == ""],  # rows with no stable id can't be deduped
            df[keyed != ""].drop_duplicates(subset=subset, keep="last"),
        ])

    # Core columns first (only the ones that exist), then the rest sorted.
    lead = [c for c in CORE_COLUMNS if c in df.columns]
    rest = sorted(c for c in df.columns if c not in lead)
    return df[lead + rest]


def export_csv(
    rows: list[dict] | None = None,
    out: Path = CSV_PATH,
    include_raw: bool = False,
) -> tuple[Path, int]:
    """Write the CSV and return (path, row_count)."""
    rows = JobStore().read_all() if rows is None else rows
    df = to_dataframe(rows)

    if not include_raw:
        df = df.drop(columns=[c for c in df.columns if c.startswith("raw_")])

    out.parent.mkdir(parents=True, exist_ok=True)
    # utf-8-sig: without the BOM Excel mangles the rupee sign in stipends.
    df.to_csv(out, index=False, encoding="utf-8-sig")
    return out, len(df)
