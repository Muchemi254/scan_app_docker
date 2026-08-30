import logging
import asyncio
import os
import hashlib
import base64
import shutil
import uuid
from typing import Optional, Callable, Awaitable
from asyncpg.exceptions import UniqueViolationError
from app.core.celery_app import celery_app
from app.services.gemini import extract_receipt_data, extract_receipt_batch
from app.services.task_service import TaskService
from app.services.image_service import BATCH_CHUNK_SIZE, MAX_AI_CONCURRENCY, generate_thumbnail, has_missing_fields, prepare_for_ai
from app.services.data_adapter import DataService
from app.services.audit_service import AuditService
from app.services.error_codes import (
    ErrorCode, ScanError, classify_exception, user_message,
    should_fan_out_to_per_image, should_stop_batch, backoff_seconds,
)
import random
from app.schemas.task import TaskStatus, TaskProgressUpdate

logger = logging.getLogger(__name__)


def _purge_stale_cached_loops() -> None:
    """Drop any cached Redis/Postgres clients whose event loop is closed.

    Celery's ForkPoolWorker reuses worker processes across tasks. Each task
    creates a fresh event loop via `asyncio.run()`; when that loop is GC'd
    its `id()` can be re-used by the next loop. Without a sweep, the module-
    level caches in `batch_service._redis_cache` and `core.database._pool_cache`
    can hand out dead clients to the next task — causing every Redis/Postgres
    call to fail with `RuntimeError: Event loop is closed`.

    Belt-and-braces alongside the identity check in get_redis/get_pool.
    """
    from app.services.batch_service import _redis_cache as r_cache
    from app.core.database import _pool_cache as p_cache
    for cache in (r_cache, p_cache):
        for k in list(cache.keys()):
            entry = cache.get(k)
            loop = entry[0] if isinstance(entry, tuple) else None
            if loop is None or loop.is_closed():
                cache.pop(k, None)


ProgressFn = Callable[[int, str], Awaitable[None]]
ItemResultFn = Callable[[int, Optional[dict]], Awaitable[None]]
# (index, status, receipt_id, message, stage, error_code, chunk_index)
ItemUpdateFn = Callable[
    [int, str, Optional[str], str, Optional[str], Optional[str], Optional[int]],
    Awaitable[None],
]
# (chunk_index, status, error_code, error_message, started, completed, increment_attempts)
ChunkUpdateFn = Callable[
    [int, Optional[str], Optional[str], Optional[str], bool, bool, bool],
    Awaitable[None],
]


# ── Single-receipt task (unchanged) ──────────────────────────────────────────

@celery_app.task(name="tasks.extract_receipt")
def extract_receipt_task(user_id: str, task_id: str, image_base64: str, mime_type: str):
    return asyncio.run(_extract_receipt_sync(user_id, task_id, image_base64, mime_type))


async def _extract_receipt_sync(user_id: str, task_id: str, image_base64: str, mime_type: str):
    _purge_stale_cached_loops()
    try:
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.PROCESSING, percentage=50, message="Processing receipt..."
        ))
        result = await extract_receipt_data(image_base64, mime_type, user_id)
        await TaskService.add_task_result(user_id, task_id, "receipt", result.model_dump())
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.COMPLETED, percentage=100, message="Extraction complete"
        ))
    except Exception as e:
        logger.exception(f"Task {task_id} failed")
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.FAILED, percentage=0, message=str(e), error=str(e)
        ))
        # Durable record so the failure stays reviewable after the task log
        # TTL expires. Best-effort.
        try:
            from app.services.scan_error_service import log_error
            from app.services.error_codes import classify_exception
            scan_error = classify_exception(e)
            await log_error(
                user_id,
                kind="item",
                code=scan_error.code,
                message=f"Single-image extraction failed: {str(e)[:400]}",
                title="Single-image extraction failed",
                data={"task_id": task_id},
            )
        except Exception:
            logger.exception("Failed to record single-image task failure")


# ── Shared helpers ──────────────────────────────────────────────────────────


def _split_into_chunks(entries: list, chunk_size: int) -> list[list]:
    return [entries[i : i + chunk_size] for i in range(0, len(entries), chunk_size)]


async def get_ai_concurrency(user_id: str) -> int:
    """Return the user's saved max_ai_concurrency, falling back to the env default."""
    try:
        if user_id:
            ai_settings = await DataService.get_user_settings(user_id, "ai_config")
            if ai_settings and ai_settings.get("max_ai_concurrency"):
                return int(ai_settings["max_ai_concurrency"])
    except Exception as e:
        logger.error(f"Failed to load concurrency setting, using default {MAX_AI_CONCURRENCY}: {e}")
    return MAX_AI_CONCURRENCY


async def _extract_one_chunk(
    chunk: list,
    batch_dir: str,
    api_key: str,
    model_id: str,
    active_provider: str,
    user_id: str,
):
    """Read files, build provider-native parts (grouped per receipt), call AI.

    Returns (raw_bytes_list, results). Raises ScanError on failure.

    Grouping: each entry (one file = one receipt) becomes its own list of
    parts — a single image, or a whole PDF converted per provider (inline
    PDF part for Gemini, per-page JPEGs for OpenRouter/Qwen, text layer for
    DeepSeek). Multipage PDFs stay one receipt with all pages in context.
    """
    from app.services.gemini import _image_parts, pdf_to_provider_parts

    b64_files = []
    raw_bytes_list = []
    for i, entry in enumerate(chunk):
        fpath = os.path.join(batch_dir, entry["filename"])
        with open(fpath, "rb") as f:
            raw = f.read()
        mime = entry.get("mime") or "image/jpeg"
        if mime == "application/pdf" or entry.get("filename", "").lower().endswith(".pdf"):
            parts = pdf_to_provider_parts(raw, active_provider, label=f"Receipt index {i}")
        else:
            # Stored copy stays high-quality for human review; the AI sees a
            # downscaled version so token cost is unchanged.
            ai_bytes = prepare_for_ai(raw)
            b64 = base64.standard_b64encode(ai_bytes).decode()
            parts = _image_parts(b64, "image/jpeg", active_provider, label=f"Receipt index {i}")
        b64_files.append(parts)
        raw_bytes_list.append(raw)

    try:
        results = await extract_receipt_batch(
            b64_files, api_key, model_id, active_provider, user_id=user_id
        )
    except Exception as e:
        raise classify_exception(e) from e

    return raw_bytes_list, results


async def _persist_one_item(
    user_id: str,
    entry: dict,
    img_bytes: bytes,
    receipt,
    batch_title: str,
    on_item_update,
    on_item_result,
):
    """Save one extracted receipt (+ image + audit). Updates item status."""
    from app.core.config import settings

    global_idx = entry["index"]

    if receipt is None:
        if on_item_update:
            await on_item_update(
                global_idx, "failed", None,
                user_message(ErrorCode.AI_EMPTY_RESPONSE),
                "done", ErrorCode.AI_EMPTY_RESPONSE.value, None,
            )
        if on_item_result:
            await on_item_result(global_idx, None)
        return

    if on_item_update:
        await on_item_update(global_idx, "processing", None, "Saving...", "saving", None, None)

    receipt_id = str(uuid.uuid4())
    sha256 = None
    try:
        data = receipt.model_dump(exclude_unset=True)
        data["status"] = "needs_review"
        has_missing = has_missing_fields(data)

        img_filename = None
        thumb_filename = None
        if img_bytes and settings.USE_POSTGRES:
            from app.services.database_service import save_image, save_pdf, save_pdf_thumbnail, save_thumbnail
            # Canonical hash of the exact bytes we're about to store. Retries
            # carry no upload-time hash, so derive it here — this is what makes
            # retry dedup / orphan reconciliation work.
            sha256 = entry.get("sha256") or hashlib.sha256(img_bytes).hexdigest()

            # Re-run dedup right before insert: if this image was already saved
            # (a previous attempt stored the receipt but the item was marked
            # failed, or a concurrent batch saved it), link to the existing
            # receipt instead of writing a duplicate.
            existing = await DataService.find_receipts_by_image_hashes(user_id, [sha256])
            if sha256 in existing:
                existing_id = existing[sha256]
                if on_item_update:
                    await on_item_update(
                        global_idx, "duplicate", existing_id,
                        "Already scanned — linked to existing receipt",
                        "done", None, None,
                    )
                if on_item_result:
                    await on_item_result(global_idx, None)
                return

            mime = entry.get("mime") or "image/jpeg"
            if mime == "application/pdf" or entry.get("filename", "").lower().endswith(".pdf"):
                # PDF receipt: store the raw file + page-1 JPEG thumbnail.
                img_filename = save_pdf(receipt_id, img_bytes)
                thumb_filename = save_pdf_thumbnail(receipt_id, img_bytes)
                data["fileType"] = "application/pdf"
                try:
                    from app.services.pdf_service import assert_within_page_cap
                    data["pdfPageCount"] = assert_within_page_cap(img_bytes)
                except Exception:
                    pass  # extraction already validated; best-effort metadata
            else:
                img_filename = save_image(receipt_id, img_bytes)
                thumb = generate_thumbnail(img_bytes, "image/jpeg")
                thumb_filename = save_thumbnail(receipt_id, thumb) if thumb else None
                data["fileType"] = "image/jpeg"

        data["id"] = receipt_id
        data["userId"] = user_id
        if batch_title:
            data["batchTitle"] = batch_title
        if settings.USE_POSTGRES:
            data["image_filename"] = img_filename
            if thumb_filename:
                data["thumbnail_filename"] = thumb_filename
            if sha256:
                data["image_sha256"] = sha256

        await DataService.create_receipt(user_id, data)

        # Audit is a non-critical side effect: a busy/down audit store must NOT
        # flip a successfully-saved receipt into SAVE_FAILED, which would leave
        # an orphaned/duplicate receipt on retry.
        try:
            await AuditService.log_create(user_id, receipt_id, data, user_id)
        except Exception as audit_exc:
            logger.warning("Audit log skipped for receipt %s: %s", receipt_id, audit_exc)

        # Every AI-extracted receipt goes to review regardless of how complete
        # the extraction looks — a scan with all fields filled can still be
        # subtly wrong (misread totals, wrong supplier, swapped batch order).
        saved_data = dict(data)
        saved_data["status"] = "needs_review"

        if on_item_update:
            msg = "Missing fields — saved for review" if has_missing else "Saved for review"
            await on_item_update(global_idx, "needs_review", receipt_id, msg, "done", None, None)
        if on_item_result:
            await on_item_result(global_idx, saved_data)

    except UniqueViolationError:
        # Race lost: another worker saved the same image between our check and
        # insert. Roll back the dangling image files and link to the existing
        # receipt so the batch shows a clean duplicate rather than SAVE_FAILED.
        logger.info(f"Item {global_idx} hit unique-image race — deduping to existing receipt")
        if settings.USE_POSTGRES:
            try:
                from app.services.database_service import delete_receipt_images
                delete_receipt_images(receipt_id)
            except Exception:
                pass
        existing_id = None
        if sha256:
            existing = await DataService.find_receipts_by_image_hashes(user_id, [sha256])
            existing_id = existing.get(sha256)
        if on_item_update:
            await on_item_update(
                global_idx, "duplicate", existing_id or receipt_id,
                "Already scanned — linked to existing receipt",
                "done", None, None,
            )
        if on_item_result:
            await on_item_result(global_idx, None)

    except Exception as item_exc:
        logger.error(f"Item {global_idx} save failed: {item_exc}")
        if settings.USE_POSTGRES:
            from app.services.database_service import delete_receipt_images
            delete_receipt_images(receipt_id)
        if on_item_update:
            await on_item_update(
                global_idx, "failed", receipt_id,
                str(item_exc)[:200], "done", ErrorCode.SAVE_FAILED.value, None,
            )
        if on_item_result:
            await on_item_result(global_idx, None)


MAX_CHUNK_BACKOFF_ATTEMPTS = 2  # initial try + 1 in-task backoff retry


async def _process_chunk_with_fallback(
    chunk_index: int,
    chunk: list,
    batch_dir: str,
    api_key: str,
    model_id: str,
    active_provider: str,
    user_id: str,
    batch_title: str,
    on_item_update: Optional[ItemUpdateFn],
    on_item_result: Optional[ItemResultFn],
    on_chunk_update: Optional[ChunkUpdateFn],
    *,
    cancel_event: Optional[asyncio.Event] = None,
):
    """
    Extract one chunk via Gemini, then persist each item.

    Failure policy (kept narrow on purpose — see error_codes.py):
      * AI_QUOTA_EXCEEDED / AI_AUTH_FAILED  → hard fail, set cancel_event so
        sibling chunks stop wasting calls.
      * AI_INVALID_JSON                     → fan out to per-image so we
        isolate the one weird receipt that confused the model.
      * AI_RATE_LIMIT / AI_TIMEOUT /
        NETWORK_ERROR / AI_PROVIDER_ERROR   → backoff (with jitter), retry
        the WHOLE chunk once. Do NOT fan out — these failures are about the
        provider/account, not any specific image, and per-image retry would
        multiply the API spend by ~10× for no benefit.
      * other / non-retryable               → hard fail.
    """

    # If a sibling chunk already hit a hard account-level failure, skip work.
    if cancel_event is not None and cancel_event.is_set():
        msg = "Skipped — earlier chunk hit quota or auth failure"
        if on_chunk_update:
            await on_chunk_update(
                chunk_index, "failed", ErrorCode.AI_QUOTA_EXCEEDED.value, msg,
                False, True, False,
            )
        if on_item_update:
            for entry in chunk:
                await on_item_update(
                    entry["index"], "failed", None, msg,
                    "done", ErrorCode.AI_QUOTA_EXCEEDED.value, chunk_index,
                )
        return

    if on_chunk_update:
        await on_chunk_update(chunk_index, "extracting", None, None, True, False, True)
    if on_item_update:
        for entry in chunk:
            await on_item_update(
                entry["index"], "processing", None, "AI extracting…",
                "extracting", None, chunk_index,
            )

    img_bytes_list = None
    results = None
    last_err: Optional[ScanError] = None

    for attempt in range(MAX_CHUNK_BACKOFF_ATTEMPTS):
        try:
            img_bytes_list, results = await _extract_one_chunk(
                chunk, batch_dir, api_key, model_id, active_provider, user_id
            )
            last_err = None
            break
        except ScanError as err:
            last_err = err
            logger.warning(
                f"Chunk {chunk_index} attempt {attempt + 1} failed: "
                f"{err.code.value} — {err.message}"
            )

            if should_stop_batch(err.code):
                if cancel_event is not None:
                    cancel_event.set()
                break
            if not err.retryable:
                break
            if should_fan_out_to_per_image(err.code):
                # The error is plausibly about one specific image — break out
                # of the chunk-retry loop so the fan-out code below runs.
                break

            # Transient infra/rate-limit error — backoff and retry the chunk.
            if attempt < MAX_CHUNK_BACKOFF_ATTEMPTS - 1:
                delay = backoff_seconds(err.code, attempt)
                # Jitter so 4 concurrent rate-limited chunks don't all wake up
                # at the same instant and immediately re-trigger the limit.
                delay = int(delay * (0.8 + random.random() * 0.4))
                if on_chunk_update:
                    await on_chunk_update(
                        chunk_index, "extracting", err.code.value,
                        f"{err.code.value} — waiting {delay}s before retry",
                        False, False, False,
                    )
                await asyncio.sleep(delay)
                # Re-check cancel after the sleep — a sibling chunk may have
                # hit quota while we were waiting.
                if cancel_event is not None and cancel_event.is_set():
                    last_err = ScanError(
                        ErrorCode.AI_QUOTA_EXCEEDED,
                        "Cancelled while waiting to retry — account-level failure",
                        retryable=False,
                    )
                    break
                continue

    # ── Success path ──
    if last_err is None:
        if on_chunk_update:
            await on_chunk_update(chunk_index, "saving", None, None, False, False, False)
        for i, entry in enumerate(chunk):
            receipt = results[i] if i < len(results) else None
            await _persist_one_item(
                user_id, entry, img_bytes_list[i], receipt,
                batch_title, on_item_update, on_item_result,
            )
        if on_chunk_update:
            await on_chunk_update(chunk_index, "done", None, None, False, True, False)
        return

    # ── Failure path: maybe fan out to per-image ──
    if should_fan_out_to_per_image(last_err.code) and len(chunk) > 1:
        logger.info(
            f"Chunk {chunk_index}: {last_err.code.value} — retrying as "
            f"{len(chunk)} size-1 calls (poison-image isolation)"
        )
        if on_chunk_update:
            await on_chunk_update(
                chunk_index, "extracting", None,
                f"{last_err.code.value} — retrying per-image",
                False, False, False,
            )
        any_success = False
        for entry in chunk:
            try:
                img_bytes_list, results = await _extract_one_chunk(
                    [entry], batch_dir, api_key, model_id, active_provider, user_id
                )
                receipt = results[0] if results else None
                await _persist_one_item(
                    user_id, entry, img_bytes_list[0], receipt,
                    batch_title, on_item_update, on_item_result,
                )
                if receipt is not None:
                    any_success = True
            except ScanError as sub_err:
                if on_item_update:
                    await on_item_update(
                        entry["index"], "failed", None,
                        user_message(sub_err.code),
                        "done", sub_err.code.value, chunk_index,
                    )
                if on_item_result:
                    await on_item_result(entry["index"], None)
        if on_chunk_update:
            final = "done" if any_success else "failed"
            await on_chunk_update(
                chunk_index, final,
                None if any_success else last_err.code.value,
                None if any_success else user_message(last_err.code),
                False, True, False,
            )
        return

    # ── Terminal chunk failure: mark every item failed with the same code ──
    if on_item_update:
        for entry in chunk:
            await on_item_update(
                entry["index"], "failed", None,
                user_message(last_err.code),
                "done", last_err.code.value, chunk_index,
            )
    if on_item_result:
        for entry in chunk:
            await on_item_result(entry["index"], None)
    if on_chunk_update:
        await on_chunk_update(
            chunk_index, "failed", last_err.code.value, user_message(last_err.code),
            False, True, False,
        )


# ── Shared batch extraction engine ───────────────────────────────────────────

async def _run_batch_extraction(
    user_id: str,
    batch_dir: str,
    entries: list,
    *,
    batch_title: str = "",
    on_progress: Optional[ProgressFn] = None,
    on_item_update: Optional[ItemUpdateFn] = None,
    on_item_result: Optional[ItemResultFn] = None,
    on_chunk_update: Optional[ChunkUpdateFn] = None,
    chunks_metadata: Optional[list] = None,
    chunk_size: int = BATCH_CHUNK_SIZE,
) -> None:
    """
    Parallel Gemini extraction → save + audit. Tags every item with its
    chunk index, emits per-chunk lifecycle events, and falls back to
    per-image extraction when a whole chunk fails for a retryable reason.

    `entries` items must include an `index` field — the global item index
    within the parent batch — so chunk-level grouping survives partial retries.
    """
    from app.core.database import init_pool
    from app.services.gemini import get_gemini_config

    await init_pool()
    api_key, model_id, active_provider = await get_gemini_config(user_id)
    concurrency = await get_ai_concurrency(user_id)
    total_items = len(entries)

    if on_progress:
        await on_progress(5, f"Starting batch of {total_items} with {active_provider} (concurrency {concurrency})...")

    # Build chunks. `chunks_metadata` lets the caller specify each chunk's
    # global index explicitly (used during retry of a single chunk).
    if chunks_metadata is None:
        local_chunks = _split_into_chunks(entries, chunk_size)
        chunks_with_index = [(ci, chunk) for ci, chunk in enumerate(local_chunks)]
    else:
        chunks_with_index = list(zip(chunks_metadata, _split_into_chunks(entries, chunk_size)))

    semaphore = asyncio.Semaphore(concurrency)
    # Shared signal: any chunk that hits AI_QUOTA_EXCEEDED or AI_AUTH_FAILED
    # sets this, and every other chunk short-circuits instead of burning more
    # API calls against a clearly broken account.
    cancel_event = asyncio.Event()

    async def run_one(ci: int, chunk: list):
        async with semaphore:
            await _process_chunk_with_fallback(
                ci, chunk, batch_dir, api_key, model_id, active_provider,
                user_id, batch_title,
                on_item_update, on_item_result, on_chunk_update,
                cancel_event=cancel_event,
            )

    tasks = [run_one(ci, chunk) for ci, chunk in chunks_with_index]

    if on_progress:
        await on_progress(10, f"AI: {total_items} images in {len(tasks)} chunks...")

    await asyncio.gather(*tasks, return_exceptions=False)

    if on_progress:
        await on_progress(100, "Batch complete")


# ── Batch-extract Celery task (thin wrapper for old tasks API) ───────────────

@celery_app.task(name="tasks.extract_receipt_batch")
def extract_receipt_batch_task(user_id: str, task_id: str, batch_dir: str,
                                image_entries: list, provider: str = "gemini"):
    return asyncio.run(_extract_receipt_batch_sync(user_id, task_id, batch_dir, image_entries, provider))


async def _extract_receipt_batch_sync(user_id: str, task_id: str, batch_dir: str,
                                       image_entries: list, provider: str = "gemini"):
    _purge_stale_cached_loops()
    try:
        saved_items: list = []
        failed_chunks: list = []

        async def report(pct, msg):
            await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
                status=TaskStatus.PROCESSING, percentage=pct, message=msg
            ))

        async def store(i, data):
            if data is not None:
                saved_items.append(i)
            await TaskService.add_task_result(user_id, task_id, f"item_{i}", data)

        async def chunk_update(ci, status, error_code, error_message, started, completed, increment_attempts):
            if status == "failed":
                failed_chunks.append(ci)

        # Inject `index` into legacy entries that didn't include one
        for i, e in enumerate(image_entries):
            e.setdefault("index", i)

        await _run_batch_extraction(
            user_id, batch_dir, image_entries,
            on_progress=report,
            on_item_result=store,
            on_chunk_update=chunk_update,
        )

        total = len(image_entries)
        if saved_items and len(saved_items) < total:
            status, pct, msg = (
                TaskStatus.COMPLETED, 100,
                f"Batch complete — {len(saved_items)}/{total} receipts saved",
            )
        elif not saved_items and failed_chunks:
            # Whole batch failed (e.g. AI quota/auth) — don't report success.
            status, pct, msg = (
                TaskStatus.FAILED, 0,
                "Batch extraction failed — no receipts saved",
            )
        else:
            status, pct, msg = (
                TaskStatus.COMPLETED, 100,
                "Batch extraction complete — receipts saved",
            )

        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=status, percentage=pct, message=msg,
            error=msg if status == TaskStatus.FAILED else None,
        ))

    except Exception as e:
        logger.exception(f"Batch task {task_id} failed")
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.FAILED, percentage=0,
            message=str(e), error=str(e)
        ))
        # Durable record so the failure stays reviewable after the task log
        # TTL expires. Best-effort.
        try:
            from app.services.scan_error_service import log_error
            from app.services.error_codes import classify_exception
            scan_error = classify_exception(e)
            await log_error(
                user_id,
                kind="batch",
                code=scan_error.code,
                message=f"Batch extraction failed: {str(e)[:400]}",
                title="Batch extraction failed",
                data={"task_id": task_id},
            )
        except Exception:
            logger.exception("Failed to record batch task failure")
    finally:
        try:
            if os.path.isdir(batch_dir):
                shutil.rmtree(batch_dir)
        except Exception:
            pass


# ── ScannerPage batch Celery task (thin wrapper) ─────────────────────────────

@celery_app.task(name="tasks.process_batch")
def process_batch_task(user_id: str, batch_id: str, batch_dir: str, entries: list, batch_title: str = ""):
    return asyncio.run(_process_batch_sync(user_id, batch_id, batch_dir, entries, batch_title))


def _make_batch_callbacks(user_id: str, batch_id: str):
    """Return (item_update, chunk_update) callbacks bound to batch_service."""
    from app.services import batch_service

    async def item_update(idx, status, receipt_id, message, stage, error_code, chunk_index):
        await batch_service.update_item(
            user_id, batch_id, idx, status,
            receipt_id=receipt_id, message=message,
            stage=stage, error_code=error_code, chunk_index=chunk_index,
        )

    async def chunk_update(ci, status, error_code, error_message, started, completed, increment_attempts):
        await batch_service.update_chunk(
            user_id, batch_id, ci,
            status=status, error_code=error_code, error_message=error_message,
            started=started, completed=completed, increment_attempts=increment_attempts,
        )

    return item_update, chunk_update


async def _log_batch_failures(user_id: str, batch_id: str, batch_title: str = ""):
    """Persist a durable scan_error record for any failed chunks in a batch.

    The Redis batch state is ephemeral (24h TTL), so without this a failed
    batch vanishes and the user can't see what went wrong. One record per
    failed chunk, with the failed items embedded in `data`, so the user can
    review what happened even after the batch is dismissed/expired.
    Best-effort — a logging failure must never crash the worker task.
    """
    from app.services.scan_error_service import log_error
    from app.services import batch_service

    try:
        batch = await batch_service.get_batch(user_id, batch_id)
        if not batch:
            return

        failed_chunks = [c for c in (batch.get("chunks") or []) if c["status"] == "failed"]
        failed_items = [i for i in batch["items"] if i["status"] == "failed"]
        if not failed_chunks and not failed_items:
            return

        title = batch_title or batch.get("batchTitle") or "Receipt batch"

        def item_detail(item):
            return {
                "index": item.get("index"),
                "filename": item.get("origFilename") or item.get("filename"),
                "code": item.get("errorCode"),
                "message": item.get("message"),
            }

        covered_indices: set = set()

        # One durable record per failed chunk, with its failed items embedded.
        if failed_chunks:
            for chunk in failed_chunks:
                code = chunk.get("errorCode") or "UNKNOWN"
                chunk_items = [i for i in failed_items if i.get("chunkIndex") == chunk["index"]]
                covered_indices.update(i.get("index") for i in chunk_items)
                await log_error(
                    user_id,
                    kind="chunk",
                    code=code,
                    message=(chunk.get("errorMessage") or "Chunk processing failed")[:400],
                    title=title,
                    batch_id=batch_id,
                    data={
                        "chunk_index": chunk["index"],
                        "attempts": chunk.get("attempts"),
                        "items": [item_detail(i) for i in chunk_items],
                    },
                )

        # Group any failed items not covered by a failed chunk. This catches
        # per-image fan-out failures in otherwise-successful chunks, file-level
        # failures during upload (e.g. IMAGE_INVALID), and item-level retries —
        # so nothing fails silently.
        uncovered = [i for i in failed_items if i.get("index") not in covered_indices]
        if uncovered:
            codes = {i.get("errorCode") or "UNKNOWN" for i in uncovered}
            code = next(iter(codes), "UNKNOWN")
            await log_error(
                user_id,
                kind="item",
                code=code,
                message=f"{len(uncovered)} item(s) failed during extraction",
                title=title,
                batch_id=batch_id,
                data={"items": [item_detail(i) for i in uncovered]},
            )
    except Exception:
        logger.exception("Failed to log scan errors for batch %s", batch_id)


async def _log_error_single(user_id: str, batch_id: str, batch_title: str,
                            code, message: str):
    """Best-effort durable record for one failure (e.g. an unexpected
    exception). Never raises."""
    from app.services.scan_error_service import log_error
    try:
        title = batch_title or "Receipt batch"
        await log_error(
            user_id,
            kind="batch",
            code=code,
            message=message[:400],
            title=title,
            batch_id=batch_id,
        )
    except Exception:
        logger.exception("Failed to log error for batch %s", batch_id)


async def _process_batch_sync(user_id: str, batch_id: str, batch_dir: str,
                               entries: list, batch_title: str = ""):
    _purge_stale_cached_loops()
    from app.core.database import init_pool, close_pool
    from app.services.batch_service import close_redis
    from app.services import batch_service

    await init_pool()
    try:
        await batch_service.set_batch_status(user_id, batch_id, "processing")
        logger.info(f"Batch {batch_id}: processing {len(entries)} images")

        # Register chunk metadata in Redis so the UI can group items by chunk.
        chunk_size = BATCH_CHUNK_SIZE
        chunks = []
        for ci, start in enumerate(range(0, len(entries), chunk_size)):
            chunk_entries = entries[start : start + chunk_size]
            indices = [e["index"] for e in chunk_entries]
            chunks.append({
                "index": ci,
                "itemRange": [min(indices), max(indices)],
                "size": len(chunk_entries),
            })
        await batch_service.init_chunks(user_id, batch_id, chunks)

        item_update, chunk_update = _make_batch_callbacks(user_id, batch_id)

        await _run_batch_extraction(
            user_id, batch_dir, entries,
            batch_title=batch_title,
            on_item_update=item_update,
            on_chunk_update=chunk_update,
            chunk_size=chunk_size,
        )

        # Final status derived from ITEM states, not the dispatched subset —
        # groups still held as `prepared` keep the session dispatchable.
        b = await batch_service.get_batch(user_id, batch_id)
        if b:
            final = batch_service.derive_session_status(b)
            await batch_service.set_batch_status(user_id, batch_id, final)
        logger.info(f"Batch {batch_id}: all items processed ({final})")
        await _log_batch_failures(user_id, batch_id, batch_title)

    except Exception as e:
        logger.exception(f"Batch {batch_id} task failed")
        try:
            await batch_service.set_batch_status(user_id, batch_id, "failed")
        except Exception:
            pass
        # Durable record so the unexpected crash is not invisible to the user.
        try:
            from app.services.error_codes import classify_exception
            scan_error = classify_exception(e)
            await _log_error_single(
                user_id, batch_id, batch_title,
                code=scan_error.code, message=str(e)[:500],
            )
        except Exception:
            logger.exception("Failed to record unexpected batch failure")
        raise
    finally:
        await close_pool()
        await close_redis()
        # Don't tear down batch_dir on the parent task — chunks may be
        # retried later. Cleanup happens on explicit DELETE /batches/{id}.


# ── Per-item retry Celery task ───────────────────────────────────────────────

@celery_app.task(name="tasks.retry_item")
def retry_item_task(user_id: str, batch_id: str, batch_dir: str,
                    entry: dict, batch_title: str = ""):
    """Re-extract a single image. Used when one item failed inside a chunk
    that otherwise succeeded (e.g. Gemini returned null for it)."""
    return asyncio.run(_retry_item_sync(user_id, batch_id, batch_dir, entry, batch_title))


async def _retry_item_sync(user_id: str, batch_id: str, batch_dir: str,
                            entry: dict, batch_title: str = ""):
    _purge_stale_cached_loops()
    from app.core.database import init_pool, close_pool
    from app.services.batch_service import close_redis
    from app.services.gemini import get_gemini_config
    from app.services import batch_service

    await init_pool()
    try:
        api_key, model_id, active_provider = await get_gemini_config(user_id)
        item_update, _ = _make_batch_callbacks(user_id, batch_id)

        # Single-item "chunk" reuses the full classification/backoff/save path.
        # chunk_index is None for synthetic single-item retries — pass the
        # item's existing chunkIndex if it had one, else -1 as a sentinel.
        chunk_index = entry.get("chunkIndex", -1) or -1

        await _process_chunk_with_fallback(
            chunk_index, [entry], batch_dir,
            api_key, model_id, active_provider,
            user_id, batch_title,
            item_update, None, None,   # no chunk-level callbacks for item retry
        )

        # Session status is derived from all item states, so remaining
        # prepared (held) items keep the session dispatchable.
        b = await batch_service.get_batch(user_id, batch_id)
        if b:
            await batch_service.set_batch_status(
                user_id, batch_id, batch_service.derive_session_status(b)
            )
            await _log_batch_failures(user_id, batch_id, batch_title)
    except Exception as e:
        logger.error(f"Retry item {entry.get('index')} of batch {batch_id} failed: {e}")
        try:
            from app.services.error_codes import classify_exception
            scan_error = classify_exception(e)
            await _log_error_single(
                user_id, batch_id, batch_title,
                code=scan_error.code, message=str(e)[:500],
            )
        except Exception:
            logger.exception("Failed to record item retry failure")
        raise
    finally:
        await close_pool()
        await close_redis()


# ── Per-chunk retry Celery task ──────────────────────────────────────────────

@celery_app.task(name="tasks.retry_chunk")
def retry_chunk_task(user_id: str, batch_id: str, batch_dir: str,
                     entries: list, chunk_index: int, batch_title: str = ""):
    return asyncio.run(_retry_chunk_sync(user_id, batch_id, batch_dir, entries, chunk_index, batch_title))


async def _retry_chunk_sync(user_id: str, batch_id: str, batch_dir: str,
                             entries: list, chunk_index: int, batch_title: str = ""):
    _purge_stale_cached_loops()
    from app.core.database import init_pool, close_pool
    from app.services.batch_service import close_redis
    from app.services.gemini import get_gemini_config
    from app.services import batch_service

    await init_pool()
    try:
        api_key, model_id, active_provider = await get_gemini_config(user_id)
        item_update, chunk_update = _make_batch_callbacks(user_id, batch_id)

        await _process_chunk_with_fallback(
            chunk_index, entries, batch_dir,
            api_key, model_id, active_provider,
            user_id, batch_title,
            item_update, None, chunk_update,
        )

        # Session status is derived from all item states, so remaining
        # prepared (held) items keep the session dispatchable.
        b = await batch_service.get_batch(user_id, batch_id)
        if b:
            await batch_service.set_batch_status(
                user_id, batch_id, batch_service.derive_session_status(b)
            )
            await _log_batch_failures(user_id, batch_id, batch_title)
    except Exception as e:
        logger.error(f"Retry chunk {chunk_index} of batch {batch_id} failed: {e}")
        try:
            from app.services.error_codes import classify_exception
            scan_error = classify_exception(e)
            await _log_error_single(
                user_id, batch_id, batch_title,
                code=scan_error.code, message=str(e)[:500],
            )
        except Exception:
            logger.exception("Failed to record chunk retry failure")
        raise
    finally:
        await close_pool()
        await close_redis()
