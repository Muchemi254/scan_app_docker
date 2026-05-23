"""
Image utility endpoints.

POST /api/convert-heic  — convert a HEIC image URL to JPEG for browser display

Conversion results are cached in Redis (24h TTL) so the same HEIC URL is
only fetched and converted once.  Falls back to an in-process LRU cache if
Redis is unavailable.
"""

import asyncio
import ipaddress
import logging
import socket
import httpx
from collections import OrderedDict
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# ── SSRF Protection ───────────────────────────────────────────────────────────

BLOCKED_CIDRS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]

BLOCKED_HOSTNAMES = {
    "metadata.google.internal",  # GCP metadata
    "169.254.169.254",           # common metadata IP
}


def _validate_image_url(url: str) -> None:
    """Validate that a URL is safe to fetch (SSRF protection)."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only http/https URLs are allowed")

    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise HTTPException(status_code=400, detail="Invalid URL: no hostname")

    if hostname in BLOCKED_HOSTNAMES:
        raise HTTPException(status_code=400, detail="URL is not allowed")

    # Resolve hostname and check against blocked IP ranges
    try:
        addr_info = socket.getaddrinfo(hostname, None)
        for family, _, _, _, sockaddr in addr_info:
            ip_str = sockaddr[0]
            try:
                ip = ipaddress.ip_address(ip_str)
                for cidr in BLOCKED_CIDRS:
                    if ip in cidr:
                        raise HTTPException(status_code=400, detail="URL is not allowed")
            except ValueError:
                pass
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="Could not resolve hostname")

router = APIRouter(tags=["images"])

# ── Cache ───────────────────────────────────────────────────────────────────
# Primary: Redis with 24h TTL (survives restarts, shared across workers).
# Fallback: in-process LRU (max 200 entries) when Redis is unavailable.

_CACHE_TTL = 86400  # 24 hours
_MAX_LRU = 200
_lru_cache: OrderedDict[str, bytes] = OrderedDict()

REDIS_KEY_PREFIX = "heic:img:"


def _lru_get(key: str) -> bytes | None:
    if key not in _lru_cache:
        return None
    _lru_cache.move_to_end(key)
    return _lru_cache[key]


def _lru_set(key: str, value: bytes) -> None:
    if key in _lru_cache:
        _lru_cache.move_to_end(key)
    _lru_cache[key] = value
    if len(_lru_cache) > _MAX_LRU:
        _lru_cache.popitem(last=False)


async def _redis_get_conn():
    try:
        from app.services.batch_service import get_redis
        return await get_redis()
    except Exception:
        return None


async def _cache_get(key: str) -> bytes | None:
    r = await _redis_get_conn()
    if r:
        try:
            val = await asyncio.wait_for(r.get(REDIS_KEY_PREFIX + key), timeout=2)
            return val
        except Exception:
            pass
    return _lru_get(key)


async def _cache_set(key: str, value: bytes) -> None:
    r = await _redis_get_conn()
    if r:
        try:
            await asyncio.wait_for(
                r.setex(REDIS_KEY_PREFIX + key, _CACHE_TTL, value), timeout=2,
            )
            return
        except Exception:
            pass
    _lru_set(key, value)


# ── Endpoint ────────────────────────────────────────────────────────────────

class ConvertHeicRequest(BaseModel):
    imageUrl: str


# ── Generic image proxy with Redis cache ──────────────────────────────────


@router.get("/api/images/cached")
async def get_cached_image(url: str):
    """
    Proxy an image through the server, caching it in Redis.

    GET /api/images/cached?url=<encoded-image-url>

    Two modes:
    - Local files:  url starts with "/receipt-images/" → read from disk
    - External URLs: fetches from source → caches in Redis → returns
    """
    # ── Local filesystem path (PostgreSQL-backed receipts) ────────────────
    #
    # NOTE: Image requests via <img> tags cannot carry auth headers.
    # Defense: receipt IDs are opaque UUIDs/strings — unguessable URLs.
    # For production, add signed URL tokens or short-lived proxy links.
    if url.startswith("/receipt-images/"):
        from app.services.database_service import read_image
        parts = url.rstrip("/").split("/")
        raw_id = parts[-1]
        thumb = "?thumb=1" in url or url.endswith("?thumb=1")
        receipt_id = raw_id.split("?")[0]
        img_bytes = read_image(receipt_id, thumb=thumb)
        if img_bytes:
            # Detect and convert HEIC/HEIF to JPEG on-the-fly
            if img_bytes[:12] and img_bytes[4:8] == b'ftyp' and (b'heic' in img_bytes[:32] or b'heif' in img_bytes[:32] or b'mif1' in img_bytes[:32]):
                try:
                    from app.services.image_service import process_image
                    img_bytes, _ = process_image(img_bytes, 'image/heic')
                except Exception:
                    pass  # serve as-is if conversion fails
            return Response(
                content=img_bytes, media_type="image/jpeg",
                headers={"Cache-Control": "public, max-age=86400"},
            )
        raise HTTPException(status_code=404, detail="Image not found")

    # ── External URL proxy (Firebase Storage, legacy images) ──────────────
    _validate_image_url(url)

    cached = await _cache_get(url)
    if cached:
        return Response(
            content=cached, media_type="image/jpeg",
            headers={"X-Cache": "HIT", "Cache-Control": "public, max-age=86400"},
        )

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            raw_bytes = resp.content
            content_type = resp.headers.get("content-type", "image/jpeg")

        # If HEIC, convert; otherwise store as-is
        if "heic" in content_type.lower() or "heif" in content_type.lower():
            from app.services.image_service import process_image
            jpeg_bytes, _ = process_image(raw_bytes, content_type)
        else:
            jpeg_bytes = raw_bytes

        await _cache_set(url, jpeg_bytes)
        logger.info(f"Image cached ({len(jpeg_bytes)//1024} KB)")

        return Response(
            content=jpeg_bytes, media_type="image/jpeg",
            headers={"X-Cache": "MISS", "Cache-Control": "public, max-age=86400"},
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except httpx.HTTPError as e:
        logger.error(f"Failed to fetch image: {e}")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not fetch the image from storage")


@router.post("/api/convert-heic")
async def convert_heic(body: ConvertHeicRequest):
    """
    Fetch a HEIC image from a URL and return it as JPEG.

    Cached in Redis (24h TTL) with in-process LRU fallback.
    """
    url = body.imageUrl
    _validate_image_url(url)

    # ── Cache HIT ──
    cached = await _cache_get(url)
    if cached:
        logger.info(f"HEIC cache HIT for {url[:80]}")
        return Response(
            content=cached, media_type="image/jpeg",
            headers={"X-Cache": "HIT", "Cache-Control": "public, max-age=86400"},
        )

    # ── Cache MISS ──
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            raw_bytes = resp.content
            content_type = resp.headers.get("content-type", "image/heic")

        from app.services.image_service import process_image
        jpeg_bytes, _ = process_image(raw_bytes, content_type)

        await _cache_set(url, jpeg_bytes)
        logger.info(f"HEIC converted and cached ({len(jpeg_bytes)//1024} KB)")

        return Response(
            content=jpeg_bytes, media_type="image/jpeg",
            headers={"X-Cache": "MISS", "Cache-Control": "public, max-age=86400"},
        )

    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except httpx.HTTPError as e:
        logger.error(f"Failed to fetch image for HEIC conversion: {e}")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not fetch the image from storage")
    except Exception as e:
        logger.error(f"HEIC conversion failed: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="HEIC conversion failed")
