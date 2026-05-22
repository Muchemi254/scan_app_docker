# Gemini API Setup - Backend Only

## Overview

The Gemini API key is now **exclusively used on the backend**. The frontend has zero knowledge of Gemini and no longer requires it.

### ✅ What Changed

All Gemini-related code and configuration has been removed from the frontend:
- Removed `VITE_GEMINI_API_KEY` from frontend environment
- Removed Gemini validation from frontend API config
- Removed Gemini error handling from frontend
- Removed Gemini status checks in UI components

---

## Backend Gemini Usage

The backend uses the Gemini API to:
- Extract text from receipt images
- Parse and structure receipt data
- Return structured JSON to the frontend

### Environment Setup

Only one place needs the Gemini key: **the backend `.env` file**

```bash
# Backend .env (only place Gemini key goes)
GEMINI_API_KEY=your-gemini-api-key-here
```

### How It Works

1. **Frontend sends image** to backend `/receipts/extract` endpoint
2. **Backend receives image** and forwards to Gemini API
3. **Gemini processes** the image and returns extracted data
4. **Backend returns** structured JSON to frontend
5. **Frontend displays** the results

---

## Frontend Environment Variables

The frontend **only needs Firebase credentials**:

```bash
# Frontend .env.local
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...

# Backend API URL
VITE_API_URL=http://localhost:8003/api/v1

# ✋ NO Gemini key needed here!
```

---

## Files Cleaned Up

| File | Change |
|------|--------|
| `frontend/.env.local` | Removed `VITE_GEMINI_API_KEY` |
| `frontend/.env.example` | Removed Gemini documentation |
| `frontend/src/services/apiConfig.ts` | Removed Gemini validation |
| `frontend/src/services/apiErrorHandler.ts` | Removed Gemini error handling |
| `frontend/src/contexts/ApiConfigContext.tsx` | Simplified config (no Gemini) |
| `frontend/src/pages/ScannerPage.tsx` | Removed Gemini config check |

---

## Dead Code (Not Used)

The following files still exist but are **not imported anywhere**:
- `frontend/src/services/gemini.tsx` — Old client-side Gemini code (can be deleted)
- `frontend/src/services/gemini-cache.ts` — Old caching logic (can be deleted)

These can safely be deleted in a future cleanup if desired.

---

## API Endpoint (Backend)

To extract data from a receipt image, the frontend calls:

```bash
POST /api/v1/users/{userId}/receipts/extract
Content-Type: multipart/form-data

# Form data:
# - file: <image file>

# Response:
{
  "supplier": "...",
  "receiptDate": "MM/DD/YYYY",
  "totalAmount": "...",
  "items": [...]
}
```

The backend handles all Gemini interaction internally.

---

## Security Benefits

✅ **No API key exposure** — Gemini key never leaves the backend
✅ **Single source of truth** — Only backend has Gemini configuration
✅ **Reduced frontend complexity** — No Gemini-specific error handling needed
✅ **Better error handling** — Backend can retry/handle Gemini failures gracefully

---

## Troubleshooting

### Error: "AI extraction failed"
- Check backend `GEMINI_API_KEY` is set correctly
- Verify Gemini API is enabled in Google Cloud Console
- Check backend logs: `docker-compose logs backend`

### Error: "Invalid API key"
- Verify the Gemini key in backend `.env`
- Regenerate key from https://aistudio.google.com/apikey

### Error: "Request timed out"
- Gemini API is slow with large images
- Try with a smaller image (< 5MB)
- Check internet connection

---

## Summary

```
Before:
├── Frontend: Gemini API key + Firebase
├── Backend: Gemini API key + Firebase
└── ❌ Redundant & insecure

After:
├── Frontend: Firebase only ✓
├── Backend: Gemini API key + Firebase ✓
└── ✅ Clean & secure
```

The project now follows the **correct architecture**: AI processing on the backend, UI on the frontend.
