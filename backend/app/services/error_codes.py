"""
Structured error codes for batch scanning.

Replaces ad-hoc string slicing (e.g. f"AI chunk error: {str(e)[:100]}") with
typed codes so the frontend can render specific recovery hints and so we can
distinguish retry-worthy errors (rate-limit, timeout) from terminal ones
(bad image, invalid key).
"""

from enum import Enum
from typing import Optional


class ErrorCode(str, Enum):
    # Gemini / AI provider
    AI_RATE_LIMIT = "AI_RATE_LIMIT"
    AI_QUOTA_EXCEEDED = "AI_QUOTA_EXCEEDED"
    AI_AUTH_FAILED = "AI_AUTH_FAILED"
    AI_TIMEOUT = "AI_TIMEOUT"
    AI_INVALID_JSON = "AI_INVALID_JSON"
    AI_EMPTY_RESPONSE = "AI_EMPTY_RESPONSE"
    AI_PROVIDER_ERROR = "AI_PROVIDER_ERROR"

    # Network
    NETWORK_ERROR = "NETWORK_ERROR"

    # Image / input
    IMAGE_INVALID = "IMAGE_INVALID"
    IMAGE_TOO_LARGE = "IMAGE_TOO_LARGE"

    # Persistence
    SAVE_FAILED = "SAVE_FAILED"

    # Catch-all
    UNKNOWN = "UNKNOWN"


class ScanError(Exception):
    """Exception with a structured error code."""

    def __init__(self, code: ErrorCode, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def classify_exception(exc: BaseException) -> ScanError:
    """
    Best-effort mapping of an arbitrary exception to a ScanError.

    Used at the chunk-failure boundary so we never just stuff a string
    into the UI — every failure has a code the frontend can branch on.
    """
    if isinstance(exc, ScanError):
        return exc

    msg = str(exc)
    low = msg.lower()

    # Rate-limit / quota signals from Gemini, DeepSeek, generic HTTP
    if "rate limit" in low or "rate_limit" in low or "429" in low or "too many requests" in low:
        return ScanError(ErrorCode.AI_RATE_LIMIT, "AI provider rate-limited the request", retryable=True)
    if "quota" in low or "billing" in low or "insufficient balance" in low or "402" in low:
        return ScanError(ErrorCode.AI_QUOTA_EXCEEDED, "AI provider quota or balance exhausted", retryable=False)
    if "api key" in low or "unauthorized" in low or "401" in low or "permission denied" in low or "invalid key" in low:
        return ScanError(ErrorCode.AI_AUTH_FAILED, "AI provider rejected the API key", retryable=False)
    if "timeout" in low or "timed out" in low or "deadline exceeded" in low:
        return ScanError(ErrorCode.AI_TIMEOUT, "AI provider timed out", retryable=True)
    if "json" in low and ("decode" in low or "parse" in low or "expecting" in low):
        return ScanError(ErrorCode.AI_INVALID_JSON, "AI returned malformed JSON", retryable=True)
    if "connection" in low or "network" in low or "dns" in low or "connection reset" in low:
        return ScanError(ErrorCode.NETWORK_ERROR, "Network error reaching AI provider", retryable=True)
    if "503" in low or "overloaded" in low or "server error" in low or "500" in low:
        return ScanError(ErrorCode.AI_PROVIDER_ERROR, "AI provider returned a server error", retryable=True)

    return ScanError(ErrorCode.UNKNOWN, msg or "Unknown error", retryable=True)


def should_fan_out_to_per_image(code: ErrorCode) -> bool:
    """
    Whether a chunk-wide failure should be retried by splitting into per-image
    calls. ONLY true for errors plausibly caused by one specific image; never
    for errors that are about the whole account (rate-limit, quota, auth) or
    transient infrastructure issues (timeout, 5xx, network) where retrying
    harder makes things worse, not better.
    """
    return code == ErrorCode.AI_INVALID_JSON


def should_stop_batch(code: ErrorCode) -> bool:
    """
    Whether seeing this error in one chunk should cancel all sibling chunks in
    the same batch. Used for hard account-level failures where running more
    chunks is pure waste.
    """
    return code in (ErrorCode.AI_QUOTA_EXCEEDED, ErrorCode.AI_AUTH_FAILED)


def backoff_seconds(code: ErrorCode, attempt: int) -> int:
    """
    Seconds to wait before the next chunk-level retry. attempt is 0-indexed
    (i.e. attempt=0 is the wait BEFORE the first retry, after the initial
    failure). Capped at 5 minutes.
    """
    if code == ErrorCode.AI_RATE_LIMIT:
        # Rate-limit windows are usually 60s — wait that long, with jitter
        # added by the caller to de-sync parallel chunks.
        base = 60
    else:
        base = 15  # generic transient backoff
    return min(base * (2 ** attempt), 300)


def user_message(code: ErrorCode) -> str:
    """Human-readable message for an error code (also mirrored in the frontend)."""
    return {
        ErrorCode.AI_RATE_LIMIT: "AI rate-limited — will retry automatically.",
        ErrorCode.AI_QUOTA_EXCEEDED: "AI quota exhausted — check your API plan.",
        ErrorCode.AI_AUTH_FAILED: "AI API key was rejected — update it in Settings.",
        ErrorCode.AI_TIMEOUT: "AI timed out — will retry.",
        ErrorCode.AI_INVALID_JSON: "AI returned malformed data — retrying per-image.",
        ErrorCode.AI_EMPTY_RESPONSE: "AI returned no data for this image.",
        ErrorCode.AI_PROVIDER_ERROR: "AI provider error — will retry.",
        ErrorCode.NETWORK_ERROR: "Network error — will retry.",
        ErrorCode.IMAGE_INVALID: "Image could not be read.",
        ErrorCode.IMAGE_TOO_LARGE: "Image is too large to process.",
        ErrorCode.SAVE_FAILED: "Failed to save receipt to database.",
        ErrorCode.UNKNOWN: "Unexpected error.",
    }.get(code, "Unexpected error.")
