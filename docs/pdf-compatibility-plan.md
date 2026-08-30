# PDF Compatibility Implementation Plan

Goal: allow users to upload receipts as PDFs (alongside JPEG/PNG/WebP/HEIC),
extract structured data from them, store the original file, preview it in the
UI, and keep it working end-to-end (single scan, scan-staging batch flow,
Celery batch, review, approvals, search, export) — on **every** AI provider
the app supports (Gemini, OpenRouter, Qwen, DeepSeek).

## Intended Use

This is a receipts app for Kenyan tax documents (KRA PIN, buyerKraPin,
cuInvoice → eTIMS). In practice "PDF receipts" will be:

- **E-mailed e-receipts / eTIMS invoices** — text-based PDFs; cheap and
  accurate to extract.
- **Scanned paper receipts saved/forwarded as PDFs** — image-based PDFs;
  vision OCR needed.
- **Multi-page documents** (utility bills, multi-page invoices) — one
  document, not one page.

Scanning is batch-oriented (users upload several files at once via the
ScannerPage), so PDF support must work in the staging batch flow, not just
single uploads.

## Multipage PDF Semantics

- **One PDF = one receipt.** A 3-page utility bill is one document and must
  produce one receipt. All pages are sent as context:
  - Gemini: the whole PDF inline (native multi-page, text layer + vision).
  - OpenRouter / Qwen: each page rendered to JPEG and sent in page order with
    "page p of N" labels; prompt returns ONE receipt for the whole document.
  - DeepSeek: whole text layer extracted and sent as one text prompt.
- **Page cap:** `MAX_PDF_PAGES` (env, default **15**) enforced at upload and
  again in worker/dispatch; multipage PDFs beyond the cap are rejected with a
  clear message (chunked very-long-PDF processing is deferred).
- **Thumbnail / preview:** page 1 renders to the existing JPEG thumbnail
  pipeline, so every `<img>`-based view keeps working.
- **Cost note:** for image providers each page is a vision part (≈1–2k tokens
  per page); the cap bounds per-call cost. Gemini reads PDF pages as needed.
- **Multiple receipts inside one PDF** (e.g. three scanned receipts merged
  into one file) is deferred — the extractor takes the primary/dominant
  receipt and the limitation is surfaced in the review UI.
- Scanned PDFs (no text layer) with the DeepSeek provider → clear error
  "scanned PDF requires a vision provider (Gemini/OpenRouter/Qwen)".

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
- AI extraction: `extract_receipt_data(image_base64, mime_type, …)` in
  `backend/app/services/gemini.py` sends provider-specific parts:
  Gemini → inline part `{"mime_type", "data"}`; DeepSeek / OpenRouter / Qwen →
  `image_url` data-URLs (image/* only). **DeepSeek's chat API is text-only**
  (no vision at all). Default provider is Gemini
  (`ai_settings.get("provider", "gemini")`).
- The Celery worker (`backend/app/tasks/worker.py`) runs every stored file
  through `prepare_for_ai()` (Pillow) before base64, then calls
  `extract_receipt_batch()` with a **flat** list of `(base64, mime)` images
  and a 1:1 "image index → receipt" prompt mapping.
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
2. **Provider-native PDF parts — all four providers supported.** A single
   converter `pdf_to_provider_parts(pdf_bytes, provider, max_pages)` produces
   the right content parts per provider (see Multipage section above):
   Gemini inline PDF part; OpenRouter/Qwen per-page JPEG `image_url` parts;
   DeepSeek text-layer prompt (pypdf). Used by both single and batch
   extraction so behavior is identical everywhere.
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
   `MAX_PDF_PAGES` (env-configurable, default **15**) enforced at upload and
   again in the worker/dispatch.

## Phases

Each phase leaves the system deployable and usable. Phases 1–2 together are
the feature; Phase 3 items are each independently skippable.

### Phase 1 — Backend PDF support (one coherent unit)

*Why one unit: accepting PDFs at upload is not shippable without the AI-side
changes — Pillow would crash on PDF bytes in the worker, and image-URL
providers would receive `data:application/pdf`. Storage + extraction must land
together.*

1. `backend/alembic/versions/021_pdf_support.py` (new — 020 is taken by entry_type): add nullable
   `file_type` (`VARCHAR(32)`) and `pdf_page_count` (`INTEGER`) to `receipts`;
   backfill `file_type='image/jpeg'` for rows with `image_filename`.
2. `backend/app/services/pdf_service.py` (new): `is_pdf(bytes)` magic check
   (`%PDF-`), `pdf_page_count(bytes)`, `extract_text(pdf_bytes)` (pypdf),
   `render_pdf_pages(pdf_bytes, max_pages) -> [JPEG bytes]` (pdf2image,
   page 1..N), `render_first_page(pdf_bytes) -> JPEG` (thumbnail).
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
5. AI — provider-native conversion:
   - `gemini.py`: new `pdf_to_provider_parts(pdf_bytes, provider, max_pages)`
     (Design Decision 2). In `extract_receipt_data()`, for mime
     `application/pdf`, convert first, then hand the parts to the existing
     provider send paths; adjust prompt wording ("this PDF document, page p of
     N") via the parameterized `batch_instruction`.
   - `extract_receipt_batch()`: signature moves from a **flat** image list to
     **grouped per-file parts** (each file = 1 receipt, 1..N page parts).
     Prompt labels pages within a receipt ("Receipt index r, page p") and
     still returns exactly one receipt per file. `BATCH_CHUNK_SIZE` counts
     receipts, not parts; `MAX_PDF_PAGES` bounds parts per file.
   - `tasks/worker.py`: for PDF entries, read raw bytes and convert via
     `pdf_to_provider_parts` (skipping `prepare_for_ai()`); keep grouping.
   - `batches.py` dispatch: use recorded per-item `image_filename`/`mime`
     instead of the hardcoded `{i:04d}.jpg` reconstruction; dispatch path
     converts PDFs the same way the worker does.
   - DeepSeek: text-layer path via `pdf_service.extract_text()`; scanned PDFs
     (no text layer) → clear 400 "scanned PDF requires a vision provider".
   - Caps: `MAX_PDF_PAGES` (env, default 15) at upload + worker/dispatch.
6. Tests (see Testing).

**Exit criteria:** upload a PDF via every endpoint, extract (mocked provider
per provider type), stored as `{id}.pdf` with `file_type='application/pdf'`,
served with the right content type, thumbnail exists, multipage PDF produces
one receipt with all pages in context, page-cap and size-cap rejections work,
mixed staging batch dispatches correctly.

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
- (b) Admin/legacy parity checks (Firestore path stays deferred).

### Phase 4 — Deploy & verify

1. `backend/Dockerfile` / requirements: add **poppler-utils** (required for
   page rendering / thumbnails) plus `pypdf` + `pdf2image` to the backend
   image.
2. Rebuild backend (+worker) and frontend images;
   `docker-compose up -d` (migration 021 auto-applies).
3. Run the backend suite in-container; manual smoke at `http://localhost:8081`
   (upload a text PDF and a scanned PDF; try each provider setting).
4. Confirm the `backup` sidecar tarball includes `*.pdf` in
   `IMAGE_STORAGE_DIR`.

## Testing

Backend (in-container pytest, `scanapp_test` DB):

- `tests/test_pdf_service.py`: magic-byte detect, page count, page-1 render,
  text-layer extraction against a tiny generated PDF.
- `tests/test_pdf_upload.py`: `/extract` with PDF returns extraction (mocked
  provider); `POST /receipts` stores `{id}.pdf`,
  `file_type='application/pdf'`, thumbnail exists; serving returns
  `application/pdf` (and `image/jpeg` for `?thumb=1`); page-cap and size-cap
  rejections.
- `tests/test_pdf_providers.py`: provider conversion matrix — Gemini gets an
  inline PDF part; OpenRouter/Qwen get one `image_url` part per page;
  DeepSeek gets extracted text (and a scanned-PDF rejection when no text
  layer); batch grouping produces one receipt per file with correct page
  labels.
- `tests/test_pdf_batch.py`: mixed image+PDF staging batch dispatches with
  per-item mime; Celery batch with a multipage PDF entry works through the
  mocked provider.
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
- Multiple receipts inside one PDF (extractor returns the primary receipt and
  the limitation is surfaced in review).
- Chunked page-by-page extraction for PDFs longer than `MAX_PDF_PAGES`.
- Migrating the deprecated `google.generativeai` SDK to `google.genai`
  (surface it when touching the Gemini send path).
- Generating PDF *output* (e.g. receipt export as PDF).
