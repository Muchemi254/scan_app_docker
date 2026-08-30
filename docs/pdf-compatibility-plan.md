# PDF Compatibility Implementation Plan

Goal: allow users to upload receipts as PDFs (alongside JPEG/PNG/WebP/HEIC),
extract structured data from them, store the original file, preview it in the
UI, and keep it working end-to-end (single scan, scan-staging batch flow,
Celery batch, review, approvals, search, export).

## Intended Use

This is a receipts app for Kenyan tax documents (KRA PIN, buyerKraPin,
cuInvoice → eTIMS). In practice "PDF receipts" will be:

- **E-mailed e-receipts / eTIMS invoices** — text-based PDFs; Gemini reads the
  text directly (cheap, accurate).
- **Scanned paper receipts saved/forwarded as PDFs** — image-based PDFs;
  Gemini OCRs the pages like it does photos today.
- **Multi-page monthly bills** (e.g. utility invoices) — need a sane page cap,
  not a hard one-page assumption.

Scanning is batch-oriented (users upload several files at once via the
ScannerPage), so PDF support must work in the staging batch flow, not just
single uploads.

## Current State (what exists today)

- Upload allowlists are image-only:
  - `backend/app/api/receipts.py` `/extract` (single) and `POST /receipts`
    (create + attach) and `PUT /receipts/{receiptId}` (update/re-upload) —
    `{image/jpeg, image/png, image/webp, image/heic, image/heif}`.
  - `backend/app/api/batches.py` `/batches/{batchId}/process` — the **primary
    scan-staging flow** (durable prep → hold → manual dispatch; per-item
    `image_filename` + `mime` recorded in `scan_session_items`).
  - `backend/app/api/receipts.py` `/batch-extract` (Celery, `_batch_{task}`).
- `process_image()` / `prepare_for_ai()` / `generate_thumbnail()` in
  `backend/app/services/image_service.py` are Pillow-based (JPEG in, JPEG
  out); batch paths funnel everything through them.
- Storage is JPEG-only: `save_image()` writes `{receipt_id}.jpg`,
  `save_thumbnail()` writes `{receipt_id}_thumb.jpg` in `IMAGE_STORAGE_DIR`
  (`backend/app/services/database_service.py`), re-exported through the
  `data_adapter.py` facade; `delete_receipt_images()` removes `.jpg` +
  `_thumb.jpg` only.
- Serving: `backend/app/api/images.py` `/api/images/cached?url=/receipt-images/{id}`
  returns hardcoded `media_type="image/jpeg"` (HEIC passthrough conversion
  exists); thumbnails via `?thumb=1`.
- Receipt rows carry `image_filename` (+ legacy `legacy_image_url`); payload
  mapping to `/receipt-images/{rid}` lives in `database_service.py` and
  `receipt_workflow_service.py` (not `data_adapter.py`, which is only the
  storage-helper facade).
- Dispatch reads files back from `_scan_{batchId}` but **hardcodes
  `fname = f"{i:04d}.jpg"` and `mime = "image/jpeg"`** (`batches.py` ~line
  468) instead of using the recorded per-item values.
- Gemini extraction: `extract_receipt_data(image_base64, mime_type, …)` in
  `backend/app/services/gemini.py` sends an inline part
  `{"mime_type": mime_type, "data": base64}` on the Gemini path; the
  DeepSeek/OpenRouter/Qwen paths send `image_url` data-URLs (image/* only).
  Default provider is **Gemini** (`ai_settings.get("provider", "gemini")`).
  The Celery worker (`backend/app/tasks/worker.py`) runs every stored file
  through `prepare_for_ai()` (Pillow) before base64.
- Frontend pickers: `frontend/src/pages/ScannerPage.tsx` (staging batch scan,
  `accept="image/*"`, no pre-upload previews) and
  `frontend/src/components/ReceiptForm.tsx` (`accept="image/*"`). Receipt
  previews render through the shared `frontend/src/components/ImageViewer.tsx`
  (used by GalleryPage, ReceiptDetailsPage, DataCleaningPage, ReviewPanel);
  ApprovalsPage renders `<img>` directly; MessageCenter uses
  `/receipt-images/{id}?thumb=1`.
- `MAX_UPLOAD_SIZE` defaults to 10 MB (`backend/app/core/config.py`).
- Images are backed up as a tarball of `IMAGE_STORAGE_DIR` (`backup` sidecar),
  so PDFs stored in the same directory are covered automatically.

## Design Decisions

1. **Store the raw PDF, thumbnail a preview.** `image_filename` keeps pointing
   at the stored file (now optionally `{receipt_id}.pdf`); add a `file_type`
   column (`image/jpeg` | `application/pdf`) and `pdf_page_count`. Page 1
   renders to `{receipt_id}_thumb.jpg` through the existing thumbnail pipeline
   so every UI that uses thumbs keeps working unchanged.
2. **Gemini is the PDF extraction path.** Inline PDF parts
   (`mime_type: application/pdf`) are supported on gemini-1.5-pro/flash and
   2.x. DeepSeek stays text-only, and OpenRouter/Qwen image-URL paths do not
   accept PDFs — the core plan **rejects PDFs for non-Gemini providers with a
   clear 400** ("PDF extraction requires the Gemini provider"). An optional
   page-rendering fallback for other providers is Phase 3 polish, not core.
3. **Fix the dispatch reconstruction bug while touching batches.** The
   dispatch loop must read the recorded `image_filename`/`mime` per item
   instead of rebuilding `{i:04d}.jpg`/`image/jpeg`, otherwise PDF items break
   at dispatch time.
4. **Browser preview via iframe/embed.** The serving proxy branches on
   `file_type`: `application/pdf` for the raw file (with
   `X-Content-Type-Options: nosniff` + `Content-Disposition: inline`),
   `image/jpeg` for thumbs and image receipts. `<img>` keeps falling back to
   the JPEG thumbnail.
5. **Search semantics.** `hasImage` today means "image_filename is set" —
   PDFs satisfy it (they are files with previews). Add an explicit `hasPdf`
   filter (Phase 3, optional) so queries can distinguish.
6. **Caps.** Keep the 10 MB `MAX_UPLOAD_SIZE` global cap; add
   `MAX_PDF_PAGES` (env-configurable, default **15** — multi-page bills are
   legitimate here) enforced at upload and again in the worker/dispatch.

## Phases

Each phase leaves the system deployable and usable. Phases 1–2 together are
the feature; Phase 3 items are each independently skippable.

### Phase 1 — Backend PDF support (one coherent unit)

*Why one unit: accepting PDFs at upload is not shippable without the AI-side
changes — Pillow would crash on PDF bytes in the worker, and image-URL
providers would receive `data:application/pdf`. Storage + extraction must land
together.*

1. `backend/alembic/versions/019_pdf_support.py` (new): add nullable
   `file_type` (`VARCHAR(32)`) and `pdf_page_count` (`INTEGER`) to `receipts`;
   backfill `file_type='image/jpeg'` for rows with `image_filename`.
2. `backend/app/services/pdf_service.py` (new): `is_pdf(bytes)` magic check
   (`%PDF-`), `pdf_page_count(bytes)` via `pypdf`, `render_pdf_page(pdf_bytes,
   page=0) -> JPEG` via `pdf2image`.
3. Accept PDFs at **all four** upload paths:
   - `/extract`, `POST /receipts`, `PUT /receipts/{receiptId}`
     (`backend/app/api/receipts.py`): add `application/pdf` to the allowlists;
     branch: skip `process_image()`, store raw bytes via `save_pdf()`, write
     `file_type` + `pdf_page_count`, thumbnail page 1.
   - `/batches/{batchId}/process` (`backend/app/api/batches.py`): allow
     `application/pdf`; store `{idx:04d}.pdf` raw (SHA256 of raw bytes keeps
     dedup meaningful); record `mime` per item (already does).
   - `/batch-extract` (`backend/app/api/receipts.py`): same branch as the
     single path; `image_entries` mime entry already carries `application/pdf`.
4. Storage/serving:
   - `database_service.py`: `save_pdf()` / `save_pdf_thumbnail()`; update
     `delete_receipt_images()` to also remove `{id}.pdf`; re-export the new
     helpers in `data_adapter.py`.
   - `images.py`: branch on stored `file_type` — `application/pdf` (with
     nosniff + inline disposition) for `*.pdf`, `image/jpeg` otherwise;
     `?thumb=1` unchanged.
5. AI:
   - `gemini.py` `extract_receipt_data()` / `extract_receipt_batch()`: for
     provider `gemini` and mime `application/pdf`, send the inline PDF part
     (skip any JPEG-only transforms); adjust prompt wording for PDFs ("this
     PDF document") via the existing parameterized `batch_instruction`.
   - `tasks/worker.py`: skip `prepare_for_ai()` for PDF entries.
   - `batches.py` dispatch: use recorded per-item `image_filename`/`mime`
     instead of the hardcoded `{i:04d}.jpg` reconstruction.
   - Non-Gemini providers: explicit 400 "PDF extraction requires the Gemini
     provider" (no silent fallback in core).
   - Caps: `MAX_PDF_PAGES` (env, default 15) at upload + worker/dispatch.
6. Tests (see Testing).

**Exit criteria:** upload a PDF via every endpoint, extract (mocked Gemini),
stored as `{id}.pdf` with `file_type='application/pdf'`, served with the right
content type, thumbnail exists, page-cap and size-cap rejections work, mixed
staging batch dispatches correctly.

### Phase 2 — Frontend PDF UX

*Required: without this the feature is invisible to users.*

1. Pickers: `ScannerPage.tsx` and `ReceiptForm.tsx` →
   `accept="image/*,.pdf,application/pdf"`; update helper text and the
   size-limit hint.
2. `frontend/src/components/ImageViewer.tsx`: PDF-aware — if
   `fileType === "application/pdf"` render `<iframe>`/`<embed>` against
   `/api/images/cached?url=/receipt-images/{id}` with thumbnail fallback and a
   "Download PDF" link; otherwise the existing `<img>`. This single swap covers
   GalleryPage, ReceiptDetailsPage, DataCleaningPage, ReviewPanel.
3. ApprovalsPage direct `<img>` → use ImageViewer; MessageCenter thumb
   fallback stays as-is (thumbnails still JPEG).
4. Payload types (`frontend/src/services/api.ts` + `export.ts`): add
   `fileType` / `pdfPageCount` to the receipt shape.
5. "PDF · N pages" badge next to receipts in lists.
6. Build (`npm run build` = typecheck) + lint + manual smoke.

**Exit criteria:** upload a PDF from ScannerPage and ReceiptForm; preview
renders in gallery/details/review; badge shows; no type errors.

### Phase 3 — Optional polish (each independently skippable)

- (a) `hasPdf` search/list filter (`database_service.py` + `receipts.py`) and
  a SearchBar toggle.
- (b) Non-Gemini PDF fallback: render PDF pages to JPEGs via `pdf2image`
  (adds `poppler-utils` to the backend image) for OpenRouter/Qwen installs
  that want PDF support without switching provider.
- (c) Admin/legacy parity checks (Firestore path stays deferred).

### Phase 4 — Deploy & verify

1. `backend/Dockerfile` / requirements: only if Phase 3(b) is taken — add
   `poppler-utils`, `pypdf` + `pdf2image`; otherwise `pypdf`/`pdf2image` are
   still needed for thumbnails/page-count (pure-Python + poppler only for
   rendering) — confirm the base image has poppler or render via a fallback
   library if not.
2. Rebuild backend (+worker) and frontend images;
   `docker-compose up -d` (migration 019 auto-applies).
3. Run the backend suite in-container; manual smoke at `http://localhost:8081`
   (upload a text PDF and a scanned PDF).
4. Confirm the `backup` sidecar tarball includes `*.pdf` in
   `IMAGE_STORAGE_DIR`.

## Testing

Backend (in-container pytest, `scanapp_test` DB):

- `tests/test_pdf_service.py`: magic-byte detect, page count, page-1 render
  against a tiny generated PDF.
- `tests/test_pdf_upload.py`: `/extract` with PDF returns extraction (mocked
  provider); `POST /receipts` stores `{id}.pdf`,
  `file_type='application/pdf'`, thumbnail exists; serving returns
  `application/pdf` (and `image/jpeg` for `?thumb=1`); page-cap and size-cap
  rejections; non-Gemini provider rejection.
- `tests/test_pdf_batch.py`: mixed image+PDF staging batch dispatches with
  per-item mime; Celery batch with PDF entry works through the mocked
  provider.
- Delete flow: `delete_receipt_images()` removes the PDF too.

Frontend: `npm run build` (typecheck) + `npm run lint`; manual smoke of
upload/preview in the browser.

## Rollout Order

1. Phase 1 backend + tests → commit, push.
2. Phase 2 frontend + build → commit, push.
3. Phase 3 items as wanted (each its own commit).
4. Phase 4 rebuild + `docker-compose up -d` + suite + manual smoke.

## Deferred

- Firebase/Firestore PDF parity (only affects legacy `AUTH_MODE=firebase`).
- PDF page-OCR quality tuning (scanned multi-page receipts), chunked
  page-by-page extraction for very long PDFs.
- Migrating the deprecated `google.generativeai` SDK to `google.genai`
  (surface it when touching the Gemini send path).
- Generating PDF *output* (e.g. receipt export as PDF).
