from __future__ import annotations

"""Low-level HTTP client for Binance Spot public market-data endpoints.

Every other Binance module (binance_catalog.py, binance_market_data.py,
market_ticker.py) goes through this one client so retry/backoff/rate-limit/
timeout/User-Agent policy lives in exactly one place, and so frontend/
backtest code never has to know Binance's raw JSON shape or HTTP quirks.

No API key is used or required - these are all public market-data endpoints
(https://data-api.binance.vision). Base URL is configurable via
BINANCE_REST_BASE for testing/mocking or a future regional mirror.
"""

import logging
import os
import time

import requests

log = logging.getLogger(__name__)

DEFAULT_REST_BASE = "https://data-api.binance.vision"

MAX_RETRIES = 5
RETRY_BASE_DELAY = 0.5
RETRY_MAX_DELAY = 20.0
DEFAULT_TIMEOUT = 15


def rest_base() -> str:
    return (os.environ.get("BINANCE_REST_BASE") or DEFAULT_REST_BASE).rstrip("/")


class BinanceAPIError(Exception):
    """Raised for a non-retryable (4xx other than 429) or exhausted-retries
    Binance response. Callers should show the user a friendly message, never
    this exception's raw text."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class BinanceRateLimitError(BinanceAPIError):
    """All retries against a 429 were exhausted - the caller should back off
    at a higher level (e.g. skip this sync cycle) rather than hammer again
    immediately."""


_session: requests.Session | None = None
_session_lock_base: str | None = None


def _get_session() -> requests.Session:
    """One shared requests.Session (connection pooling/keep-alive) per
    process, rebuilt only if BINANCE_REST_BASE changes (e.g. between test
    runs that monkeypatch the env var)."""
    global _session, _session_lock_base
    base = rest_base()
    if _session is None or _session_lock_base != base:
        _session = requests.Session()
        _session.headers.update({
            "User-Agent": "strategy-lab/1.0 (+public market data client)",
            "Accept": "application/json",
        })
        _session_lock_base = base
    return _session


def request(path: str, *, params: dict | None = None, timeout: int = DEFAULT_TIMEOUT,
            max_retries: int = MAX_RETRIES) -> object:
    """GET a Binance Spot public endpoint and return parsed JSON.

    Retries on 429 (honoring a Retry-After header if present) and 5xx with
    exponential backoff; raises BinanceAPIError immediately on any other
    4xx (bad request, unknown symbol, etc - retrying those would never
    succeed). Never raises requests' own exception types to callers."""
    session = _get_session()
    url = f"{rest_base()}{path}"
    last_exc: Exception | None = None

    for attempt in range(max_retries):
        try:
            response = session.get(url, params=params, timeout=timeout)
        except requests.RequestException as exc:
            last_exc = exc
            if attempt == max_retries - 1:
                raise BinanceAPIError(f"Не удалось получить данные Binance: {exc}") from exc
            time.sleep(min(RETRY_MAX_DELAY, RETRY_BASE_DELAY * (2 ** attempt)))
            continue

        if response.status_code == 200:
            try:
                return response.json()
            except ValueError as exc:
                raise BinanceAPIError(f"Binance вернул некорректный JSON: {exc}") from exc

        if response.status_code == 429 or response.status_code == 418:
            # 418 = Binance's "IP auto-banned for repeated 429 abuse" code.
            # Both mean "back off"; Retry-After (seconds) takes precedence
            # over our own exponential schedule when Binance sends one.
            retry_after = response.headers.get("Retry-After")
            if attempt == max_retries - 1:
                raise BinanceRateLimitError(
                    "Превышен лимит запросов Binance — повторите позже", status_code=response.status_code
                )
            delay = float(retry_after) if retry_after and retry_after.isdigit() else \
                min(RETRY_MAX_DELAY, RETRY_BASE_DELAY * (2 ** attempt))
            log.warning("Binance rate-limited us (status=%s), sleeping %.1fs", response.status_code, delay)
            time.sleep(delay)
            continue

        if response.status_code >= 500:
            if attempt == max_retries - 1:
                raise BinanceAPIError(
                    f"Binance временно недоступен (status={response.status_code})", status_code=response.status_code
                )
            time.sleep(min(RETRY_MAX_DELAY, RETRY_BASE_DELAY * (2 ** attempt)))
            continue

        # Any other 4xx is not retryable - surface it now with Binance's own
        # error message when available (code/msg JSON body is their standard
        # error shape).
        message = f"Binance error {response.status_code}"
        try:
            body = response.json()
            if isinstance(body, dict) and body.get("msg"):
                message = str(body["msg"])
        except ValueError:
            pass
        raise BinanceAPIError(message, status_code=response.status_code)

    # Unreachable in practice (loop always returns or raises), but keeps
    # type-checkers happy and guards against a future edit breaking the
    # invariant above.
    raise BinanceAPIError(f"Binance request failed: {last_exc}")  # pragma: no cover
