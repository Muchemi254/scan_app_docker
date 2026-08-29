# PDF Compatibility Implementation Plan

Goal: allow users to upload receipts as PDFs (alongside JPEG/PNG/WebP/HEIC),
extract structured data from them, store the original file, preview it in the
UI, and keep it working end-to-end (single scan, batch scan, review,
approvals, search, export).

## Scope

- Accept `.pdf` uploads everywhere images are accepted today (single extract,
  create/attach, re-scan/update image, batch scan).
- Store the original PDF on disk; render page 1 to a JPEG thumbnail so the
  existing gallery/review thumbnails still work.
- Extract data from PDFs with Gemini (receipt text, tables, totals).
- Serve PDFs to the browser with the correct Content-Type so `<iframe>`/`<embed>`
  preview works, while `/receipt-images/{id}?thumb=1` keeps returning JPEG.
- Add a `hasPdf`-style distinction so search/filter semantics stay honest.
- Tests for upload, storage, serving, extraction, and batch flows.

Out of scope (see Deferred): Firebase-storage parity, PDF export of receipts,
multi-page PDF OCR tuning, and any PDF *generation* features.

## Current State (what exists today)

- Upload allowlist is image-only: `backend/app/api/receipts.py` `/extract`
  rejects anything not in `{image/jpeg, image/png, image/webp, image/heic,
  image/heif}`; `process_image()` in `backend/app/services/image_service.py`
  validates by magic bytes and normalizes to JPEG via Pillow (HEIC handled).
- Storage is JPEG-only: `save_image()` writes `{receipt_id}.jpg`,
  `save_thumbnail()` writes `{receipt_id}_thumb.jpg` in `IMAGE_STORAGE_DIR`
  (`backend/app/services/database_service.py`), and the serving proxy
  `backend/app/api/images.py` returns hardcoded `media_type="image/jpeg"` for
  `/receipt-images/{id}`.
- Receipt rows carry a single `image_filename` column (plus legacy
  `legacy_image_url`); adapters map it to `/receipt-images/{rid}` URLs
  (`database_service.py`, `data_adapter.py`, `receipt_workflow_service.py`).
- Gemini extraction: `extract_receipt_data(image_base64, mime_type, …)` in
  `backend/app/services/gemini.py` sends an inline part
  `{"mime_type": mime_type, "data": base64}` on the Gemini path; the
  DeepSeek/OpenRouter/Qwen paths send `image_url` data-URLs (image/* only).
  The batch worker (`backend/app/tasks/worker.py`) runs every stored file
  through `prepare_for_ai()` (Pillow/JPEG) before base64.
- Frontend file pickers: `frontend/src/pages/ScannerPage.tsx` (batch scan,
  `accept="image/*"`), `frontend/src/components/ReceiptForm.tsx`
  (`accept="image/*"`); all receipt views render `<img>` via
  `/api/images/cached?url=/receipt-images/{id}`.
- `MAX_UPLOAD_SIZE` defaults to 10 MB (`backend/app/core/config.py`).
- Images are backed up as a tarball of `IMAGE_STORAGE_DIR` (`backup` sidecar),
  so PDFs stored in the same directory are covered automatically.

## Design Decisions

1. **Store the raw PDF, thumbnail a preview.** `image_filename` keeps pointing
   at the stored file (now optionally `{receipt_id}.pdf`), and we add a
   `file_type` column (`image/jpeg` | `application/pdf`) plus `pdf_page_count`.
   Page 1 renders to `{receipt_id}_thumb.jpg` through the existing thumbnail
   pipeline so every UI that uses thumbs keeps working unchanged.
2. **Gemini is the PDF extraction path.** Inline PDF parts
   (`mime_type: application/pdf`) are supported on gemini-1.5-pro/flash and
   2.x. DeepSeek stays text-only, and the OpenRouter/Qwen image-URL paths do
   not accept PDFs — so for non-Gemini providers we render PDF pages to JPEGs
   with `pdf2image` (needs `poppler-utils` in the backend image) and feed the
   existing image path. If rendering is unavailable, reject with a clear
   message instead of silently mis-extracting.
3. **Browser preview via iframe/embed.** The serving proxy detects `file_type`
   and returns `application/pdf` for the raw file (plus an extra
   `?render=…`/header-based hint), so `<img>` keeps falling back to the JPEG
   thumbnail while PDF-aware views use `<iframe>`.
4. **Search semantics.** `hasImage` today means "image_filename is set".
   PDFs will satisfy it (they are files with previews). Add an explicit
   `hasPdf` filter (and `fileType` in payloads) so queries can distinguish,
   instead of overloading `hasImage`.
5. **Page/size caps.** Gemini inline-data limit is ~20 MB, well above the
   10 MB upload cap; keep `MAX_UPLOAD_SIZE` as the global cap and add a
   `MAX_PDF_PAGES` (default 10) rejection to bound token cost. Scanned PDFs
   (image-only pages) are processed by vision like images; text PDFs are read
   directly.

## Backend Changes

Phase 1 — accept, store, serve, schema:

- `backend/alembic/versions/019_pdf_support.py` (new): add nullable
  `file_type` (`VARCHAR(32)`) and `pdf_page_count` (`INTEGER`) to `receipts`;
  backfill `file_type='image/jpeg'` for rows with `image_filename`.
- `backend/app/services/pdf_service.py` (new): `is_pdf(bytes)` magic check
  (`%PDF-`), `pdf_page_count(bytes)`, `render_pdf_page(pdf_bytes, page=0) ->
  JPEG bytes` via `pypdf` + `pdf2image`.
- `backend/app/api/receipts.py`: extend the `allowed` sets with
  `application/pdf` (extract, create, update/re-scan, batch); branch on PDF:
  skip `process_image()`, store raw bytes via new `save_pdf()` (same
  `IMAGE_STORAGE_DIR`, `{receipt_id}.pdf`), write `file_type` +
  `pdf_page_count`, thumbnail page 1 with `render_pdf_page`.
- `backend/app/services/database_service.py`: add `save_pdf()` /
  `save_pdf_thumbnail()`; make `read_image()` type-aware; expose
  `file_type`/`pdf_page_count` in receipt rows and adapters.
- `backend/app/api/images.py`: for `/receipt-images/{id}` without `?thumb=1`,
  branch on stored `file_type` — `application/pdf` for `*.pdf`,
  `image/jpeg` otherwise (existing HEIC passthrough untouched).

Phase 2 — AI extraction:

- `backend/app/services/gemini.py`: in `extract_receipt_data()`, for
  provider `gemini` and mime `application/pdf`, send the inline PDF part
  (skip any JPEG-only transforms like `prepare_for_ai`); for other providers,
  render pages to JPEGs via `pdf_service` and run the existing image path.
  Same branching in `extract_receipt_batch()`.
- `backend/app/tasks/worker.py` batch read loop: skip
  `prepare_for_ai()` for PDF entries; keep `{"filename", "mime"}` entries so
  the chunker forwards `application/pdf` intact.
- Caps: enforce `MAX_PDF_PAGES` at upload and again in the worker (defense in
  depth); error messages say "PDF exceeds N pages".

Phase 3 — search & admin parity:

- `backend/app/services/database_service.py` + `receipts.py` search/list:
  add `has_pdf` (and `file_type`) filter next to `has_image`.
- Confirmed unaffected: export totals (data-only), reports, data cleaning,
  `EXPORT` flows — verify `detailed/excel` paths with a PDF-backed receipt in
  tests.
- Firestore path (legacy `AUTH_MODE=firebase`): same `file_type` on the
  Firestore doc or defer (see Deferred).

## Frontend Changes

- File pickers: `ScannerPage.tsx` and `ReceiptForm.tsx` →
  `accept="image/*,.pdf,application/pdf"`; update the "images only" helper
  text; batch scan already streams files generically so mixed batches work
  after backend accepts PDFs.
- Preview: new small `ReceiptMedia` component
  (`frontend/src/components/ReceiptMedia.tsx`) — if `fileType ===
  "application/pdf"` render `<iframe>`/`<embed>` against
  `/api/images/cached?url=/receipt-images/{id}` with a fallback to the page-1
  thumbnail and a "Download PDF" link; otherwise the existing `<img>`.
  Swap it into Gallery, Review, ReviewBatchDetail, Approvals, MyApprovals,
  ViewScans and the detail views.
- Payload types (`frontend/src/services/api.ts` + `export.ts`): include
  `fileType`/`pdfPageCount` in the receipt shape; optional "Has PDF" toggle
  in SearchBar when the API filter is in.
- Badges: "PDF · N pages" chip next to receipts in lists.

## Deployment & Ops

- `backend/Dockerfile` / `docker-compose.yml`: add `poppler-utils` to the
  backend image; add `pypdf` + `pdf2image` to `requirements.txt`; rebuild
  backend (+worker) with `docker-compose build --no-cache`.
- Frontend: `npm run build` for the new bundle (Vite build), rebuild image.
- `docker-compose up -d` applies migration `019` via the existing entrypoint
  migration step; verify `/docs` endpoints accept `application/pdf`.
- Backups need no change (same `IMAGE_STORAGE_DIR` tarball).

## Testing

Backend (in-container pytest, `scanapp_test` DB):

- `tests/test_pdf_service.py`: magic-byte detect, page count, page-1 render
  against a tiny generated PDF.
- `tests/test_pdf_upload.py`: `/extract` with PDF returns extraction (mock
  provider); `POST /receipts` with PDF stores `{id}.pdf`,
  `file_type='application/pdf'`, thumbnail exists; serving returns
  `application/pdf` (and `image/jpeg` for `?thumb=1`); page-cap and
  size-cap rejections.
- `tests/test_pdf_batch.py`: mixed image+PDF batch flows through the mocked
  provider and yields N receipts.
- Search: `hasPdf` filter, and PDF rows satisfy both `hasImage` and `hasPdf`.

Frontend: `npm run build` (typecheck) + `npm run lint`; manual smoke of
upload/preview in the browser at `http://localhost:8081`.

## Rollout Order

1. Phase 1 backend (schema + storage + serving) + tests → commit, push.
2. Phase 2 AI (Gemini PDF + provider fallback) + tests → commit, push.
3. Phase 3 search/admin + frontend (`ReceiptMedia`, pickers, badges) →
   commit, push.
4. Rebuild images, `docker-compose up -d`, run the suite, manual smoke.

## Deferred

- Firebase/Firestore PDF parity (only affects legacy `AUTH_MODE=firebase`).
- PDF page-OCR quality tuning (scanned multi-page receipts), chunked
  page-by-page extraction for very long PDFs.
- Migrating the deprecated `google.generativeai` SDK to `google.genai`
  (surface it when touching the Gemini send path).
- Generating PDF *output* (e.g. receipt export as PDF).