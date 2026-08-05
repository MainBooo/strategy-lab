from __future__ import annotations

import time
from pathlib import Path

import pandas as pd
import requests


BASE_URL = (
    "https://iss.moex.com/iss/engines/stock/markets/shares/"
    "boards/{board}/securities/{ticker}/candles.json"
)

MAX_RETRIES = 5
RETRY_BASE_DELAY = 1.0
RETRY_MAX_DELAY = 30.0


def _get_page(session, *, board, ticker, from_date, till_date, interval, start):
    """Same retry-with-backoff policy as market_data_sync._fetch_page: MOEX
    rate-limit (429) and 5xx responses are transient, worth retrying instead
    of failing the whole portfolio build over one bad round trip."""
    last_exc = None
    for attempt in range(MAX_RETRIES):
        try:
            response = session.get(
                BASE_URL.format(board=board, ticker=ticker),
                params={
                    "from": from_date, "till": till_date, "interval": interval,
                    "start": start, "iss.only": "candles", "iss.meta": "off",
                },
                timeout=60,
            )
            if response.status_code == 429 or response.status_code >= 500:
                raise requests.HTTPError(f"MOEX temporary error {response.status_code}", response=response)
            response.raise_for_status()
            return response.json().get("candles", {})
        except requests.RequestException as exc:
            last_exc = exc
            if attempt == MAX_RETRIES - 1:
                raise
            time.sleep(min(RETRY_MAX_DELAY, RETRY_BASE_DELAY * (2 ** attempt)))
    raise last_exc  # pragma: no cover - unreachable, loop always returns or raises


def download_moex_candles(
    ticker: str,
    board: str,
    interval: int,
    from_date: str,
    till_date: str,
    output_path: Path,
) -> dict:
    session = requests.Session()
    session.headers.update({
        "User-Agent": "MOEX-Strategy-Lab/1.0",
        "Accept": "application/json",
    })

    rows = []
    columns = None
    start = 0

    while True:
        candles = _get_page(session, board=board, ticker=ticker, from_date=from_date,
                             till_date=till_date, interval=interval, start=start)

        if columns is None:
            columns = candles.get("columns", [])

        batch = candles.get("data", [])
        if not batch:
            break

        rows.extend(batch)
        start += len(batch)
        time.sleep(0.08)

    if not rows or not columns:
        raise RuntimeError(
            "MOEX не вернул свечи. Проверьте тикер, торговую доску, даты и интервал."
        )

    df = pd.DataFrame(rows, columns=columns)
    for col in ["open", "close", "high", "low", "value", "volume"]:
        if col in df:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    for col in ["begin", "end"]:
        if col in df:
            df[col] = pd.to_datetime(df[col], errors="coerce")

    df = (
        df.dropna(subset=["open", "high", "low", "close", "begin"])
        .drop_duplicates("begin")
        .sort_values("begin")
        .reset_index(drop=True)
    )
    df.to_csv(output_path, index=False)

    return {
        "rows": len(df),
        "first_bar": str(df["begin"].min()),
        "last_bar": str(df["begin"].max()),
    }
