from __future__ import annotations

import json
import logging
import os
import time
import uuid
from pathlib import Path

import requests

log = logging.getLogger(__name__)

CATALOG_URL = (
    "https://iss.moex.com/iss/engines/stock/markets/shares/"
    "boards/{board}/securities.json"
)

# Safety net only: MOEX's board-securities endpoint returns the full list in a
# single response and does not honor cursor-style "start" pagination for this
# block (unlike the candles endpoint). A previous version assumed pagination
# here, causing an infinite loop that eventually surfaced as a 500. We still
# guard with a bounded, dedup-aware loop in case a board ever needs paging.
MAX_PAGES = 20


def fetch_securities(board: str = "TQBR") -> list[dict]:
    """Load all securities for a MOEX board with their official lot sizes."""
    session = requests.Session()
    session.headers.update({"User-Agent": "MOEX-Strategy-Lab/3.0"})
    wanted = "SECID,SHORTNAME,LOTSIZE,ISIN,STATUS,DECIMALS,PREVPRICE"

    rows: list[dict] = []
    seen_secids: set[str] = set()
    start = 0

    for _ in range(MAX_PAGES):
        response = session.get(
            CATALOG_URL.format(board=board),
            params={
                "iss.meta": "off",
                "iss.only": "securities",
                "securities.columns": wanted,
                "start": start,
            },
            timeout=30,
        )
        response.raise_for_status()
        block = response.json().get("securities", {})
        columns = block.get("columns", [])
        data = block.get("data", [])
        if not data:
            break

        new_rows = 0
        for values in data:
            item = dict(zip(columns, values))
            secid = str(item.get("SECID") or "")
            if not secid or secid in seen_secids:
                continue
            seen_secids.add(secid)
            item["LOTSIZE"] = int(item.get("LOTSIZE") or 1)
            rows.append(item)
            new_rows += 1

        # MOEX returned the same page again (no pagination for this board) or
        # a short final page: nothing new arrived, so we are done.
        if new_rows == 0 or len(data) < 100:
            break

        start += len(data)
        time.sleep(0.05)

    rows.sort(key=lambda x: (str(x.get("SHORTNAME") or ""), str(x.get("SECID"))))
    return rows


def save_catalog(path: Path, board: str = "TQBR") -> list[dict]:
    items = fetch_securities(board)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write atomically so a crash/error mid-write never corrupts the existing
    # cache file that other requests may be reading concurrently.
    tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    tmp_path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp_path, path)
    return items


def load_catalog(path: Path, board: str = "TQBR", refresh: bool = False) -> list[dict]:
    if not refresh and path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("Catalog cache at %s unreadable (%s), refetching", path, exc)

    try:
        return save_catalog(path, board)
    except Exception:
        log.exception("Failed to refresh MOEX catalog for board %s", board)
        if path.exists():
            try:
                stale = json.loads(path.read_text(encoding="utf-8"))
                log.warning("Serving stale cached catalog for board %s after refresh failure", board)
                return stale
            except (json.JSONDecodeError, OSError):
                pass
        raise


def security_by_ticker(items: list[dict], ticker: str) -> dict:
    ticker = ticker.upper()
    for item in items:
        if str(item.get("SECID", "")).upper() == ticker:
            return item
    return {"SECID": ticker, "SHORTNAME": ticker, "LOTSIZE": 1}
