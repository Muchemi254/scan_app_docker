"""Runtime trusted-host registry for the dynamic Host-header check.

The check is served by an in-process set that is seeded at startup from
persisted settings (app_settings.trusted_hosts) — falling back to
settings.ALLOWED_HOSTS — and updated live by the admin API. This keeps the
whitelist configurable per-network without hardcoding IPs.

A host of "*" allows any Host header (disables the check).
Entries are stored hostname-only (port stripped), lower-cased.
"""

import logging
from typing import List, Optional, Set

logger = logging.getLogger(__name__)

_allowed: Set[str] = set()


def set_allowed_hosts(hosts: List[str]) -> None:
    global _allowed
    _allowed = {h.lower().strip() for h in hosts if h and h.strip()}


def get_allowed_hosts() -> List[str]:
    return sorted(_allowed)


def reset() -> None:
    _allowed.clear()


def allows(hostname: str) -> bool:
    if not hostname:
        return False
    hostname = hostname.lower().strip()
    if "*" in _allowed:
        return True
    return hostname in _allowed


def normalize(hosts: List[str]) -> List[str]:
    out: List[str] = []
    for h in hosts:
        h = (h or "").strip().lower()
        if not h:
            continue
        if h == "*":
            out.append("*")
            continue
        if "://" in h or "/" in h or " " in h:
            raise ValueError(f"Invalid host entry: {h!r}")
        out.append(h.split(":")[0])
    return out


async def load_trusted_hosts() -> None:
    from app.core.config import settings
    from app.services.app_settings_service import get_trusted_hosts

    hosts: Optional[List[str]] = None
    try:
        hosts = await get_trusted_hosts()
    except Exception as e:
        logger.warning("Failed to load persisted trusted hosts: %s", e)
    if hosts is None:
        hosts = list(settings.ALLOWED_HOSTS)
    set_allowed_hosts(hosts)
    logger.info("Trusted hosts: %s", ", ".join(hosts) if hosts else "(none)")
