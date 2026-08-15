#!/usr/bin/env python3
"""Ensure persistent notification environment settings for production deploys.

This script is intentionally idempotent. A VAPID key pair is created only when
one does not already exist, because rotating the key pair invalidates existing
browser push subscriptions. Existing non-empty .env values are preserved.
"""
from __future__ import annotations

import base64
import os
import pwd
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

APP_DIR = Path(__file__).resolve().parent.parent
ENV_PATH = APP_DIR / ".env"
DEFAULT_PRIVATE_KEY = APP_DIR / "storage" / "vapid_private.pem"
SERVICE_USER = os.environ.get("MOEX_LAB_SERVICE_USER", "moexlab")


def read_env(path: Path) -> tuple[list[str], dict[str, str]]:
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return lines, values


def upsert_missing(lines: list[str], current: dict[str, str], values: dict[str, str]) -> list[str]:
    wanted = {key: value for key, value in values.items() if not current.get(key)}
    if not wanted:
        return lines

    result: list[str] = []
    touched: set[str] = set()
    for line in lines:
        if "=" in line and not line.lstrip().startswith("#"):
            key = line.split("=", 1)[0].strip()
            if key in wanted:
                result.append(f"{key}={wanted[key]}")
                touched.add(key)
                continue
        result.append(line)

    if result and result[-1] != "":
        result.append("")
    if not any(line.strip() == "# Price-alert notifications" for line in result):
        result.append("# Price-alert notifications")
    for key, value in wanted.items():
        if key not in touched:
            result.append(f"{key}={value}")
    return result


def public_key_base64(private_path: Path) -> str:
    private = serialization.load_pem_private_key(private_path.read_bytes(), password=None)
    raw = private.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def generate_private_key(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    private = ec.generate_private_key(ec.SECP256R1())
    pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    )
    path.write_bytes(pem)
    path.chmod(0o600)


def set_service_owner(path: Path) -> None:
    try:
        account = pwd.getpwnam(SERVICE_USER)
    except KeyError:
        return
    os.chown(path, account.pw_uid, account.pw_gid)


def main() -> int:
    lines, env = read_env(ENV_PATH)
    configured_private = env.get("WEB_PUSH_VAPID_PRIVATE_KEY", "").strip()
    configured_public = env.get("WEB_PUSH_VAPID_PUBLIC_KEY", "").strip()

    private_path = Path(configured_private) if configured_private else DEFAULT_PRIVATE_KEY
    if not private_path.is_absolute():
        private_path = (APP_DIR / private_path).resolve()

    if configured_private and not private_path.exists():
        raise SystemExit(f"Configured VAPID private key does not exist: {private_path}")

    if not private_path.exists():
        if configured_public:
            raise SystemExit(
                "WEB_PUSH_VAPID_PUBLIC_KEY exists but the matching private key is missing; "
                "refusing to generate a mismatched key pair."
            )
        generate_private_key(private_path)
        print(f"[notifications] generated persistent VAPID private key: {private_path}")

    private_path.chmod(0o600)
    set_service_owner(private_path)
    derived_public = public_key_base64(private_path)

    if configured_public and configured_public != derived_public:
        raise SystemExit(
            "WEB_PUSH_VAPID_PUBLIC_KEY does not match WEB_PUSH_VAPID_PRIVATE_KEY; "
            "refusing to rotate or overwrite notification credentials."
        )

    defaults = {
        "WEB_PUSH_VAPID_PUBLIC_KEY": derived_public,
        "WEB_PUSH_VAPID_PRIVATE_KEY": str(private_path),
        "WEB_PUSH_VAPID_SUBJECT": "mailto:admin@generationweb.ru",
        "ALERT_WORKER_ENABLED": "true",
        "ALERT_POLL_INTERVAL_SECONDS": "45",
    }
    updated = upsert_missing(lines, env, defaults)
    ENV_PATH.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")
    ENV_PATH.chmod(0o600)

    print("[notifications] Web Push environment ready (VAPID key preserved across deploys)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
