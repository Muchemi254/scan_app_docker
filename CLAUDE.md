# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Scan App** is a receipt scanning and management application with a React frontend (Vite + TypeScript) and FastAPI backend (Python). It's fully containerized with Docker Compose.

**Architecture**: Multi-tenant SPA → Nginx reverse proxy → FastAPI backend → Firebase (Auth, Firestore, Storage) + Gemini API

## Common Commands

### Docker Compose (Full Stack)

```bash
# Start all services (backend + frontend + nginx)
docker-compose up -d

# Stop services
docker-compose down

# View logs for specific service
docker-compose logs -f backend    # Backend FastAPI logs
docker-compose logs -f frontend   # Frontend/Nginx logs
docker-compose logs -f backend -n 50  # Last 50 lines

# Rebuild images (after dependency changes)
docker-compose build --no-cache

# Execute commands in running container
docker-compose exec backend bash
docker-compose exec frontend bash

# Check service health
docker-compose ps
```

### Backend Development (Local, without Docker)

```bash
cd backend

# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run development server with auto-reload
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Access API docs: http://localhost:8000/docs
```

### Frontend Development (Local, without Docker)

```bash
cd frontend

# Install dependencies
npm install

# Start development server (Vite with HMR)
npm run dev

# Access at http://localhost:5173

# Build for production
npm run build

# Preview production build
npm run preview

# Lint code
npm run lint
```

### Access Points (With Docker)

- **Frontend**: http://localhost:8081
- **Backend API**: http://localhost:8003
- **API Documentation**: http://localhost:8003/docs
- **API Health Check**: http://localhost:8003/health

Note: Frontend is served through Nginx (port 8081), backend is on port 8003.

## Architecture & Design Patterns

### Multi-Tenant Structure

All API endpoints follow the pattern: `/api/v1/users/{userId}/receipts`

- **URL-based scoping**: User ID in the URL path
- **Authentication**: Firebase ID tokens validated server-side
- **Authorization**: Backend verifies token's `uid` matches the requested user
- **Database**: Firestore queries filtered to user ID

### Backend Structure

```
backend/app/
├── main.py              # FastAPI app setup, middleware, routes
├── api/                 # API endpoints (routers)
│   ├── health.py       # Health checks
│   ├── receipts.py     # Receipt CRUD + AI extraction
│   └── tasks.py        # Background task tracking
├── services/           # Business logic & external integrations
│   ├── firebase_service.py  # Firebase Auth, Firestore, Storage
│   ├── gemini.py            # Gemini API for AI extraction
│   └── task_service.py      # Task status tracking
├── schemas/            # Pydantic models (validation, docs)
│   └── receipt.py
├── core/               # Configuration & security
│   ├── config.py      # Settings from env vars
│   └── security.py    # Firebase token validation
└── models/            # Database models
```

**Key Pattern**: Routes → Services → External APIs
- Routes handle HTTP and validation
- Services contain business logic and external API calls
- Models define data structure

### Frontend Structure

```
frontend/src/
├── pages/            # Full page components (SPA routes)
├── components/       # Reusable UI components
├── services/         # API calls and Firebase SDK
│   ├── api.ts           # HTTP client for backend
│   ├── firebase.tsx     # Firebase SDK initialization
│   ├── gemini.tsx       # Gemini API (client-side or via backend)
│   └── export.ts        # Export functionality (PDF, Excel)
├── contexts/         # React Context for state
├── hooks/            # Custom React hooks
├── stores/           # Zustand stores (task progress, etc)
├── types/            # TypeScript type definitions
└── utils/            # Helper functions
```

**Tools**: Vite (bundler), React 19, TypeScript, Tailwind CSS, Zustand (state), TanStack Query (data fetching)

## Development Workflow

### Adding a New Receipt API Endpoint

1. **Define schema** in `backend/app/schemas/receipt.py` (Pydantic model)
2. **Add service method** in `backend/app/services/firebase_service.py` or new service file
3. **Add route** in `backend/app/api/receipts.py` with proper auth (requires token)
4. **Test with Swagger UI** at `http://localhost:8000/docs` or with curl:
   ```bash
   curl -H "Authorization: Bearer <firebase_token>" \
     http://localhost:8000/api/v1/users/uid123/receipts
   ```
5. **Update frontend** in `frontend/src/services/api.ts` and add React component

### Testing API Endpoints

Without Firebase token (won't work for protected endpoints):
```bash
curl http://localhost:8003/health
```

With Firebase token:
```bash
curl -H "Authorization: Bearer <your-firebase-token>" \
  http://localhost:8003/api/v1/users/your-uid/receipts
```

To get a Firebase token, log in via the frontend and check browser DevTools → Application → IndexedDB or Local Storage.

### Running the Full Stack

**Option 1: Docker Compose (Recommended)**
```bash
# Set environment variables in .env (see .env.example)
docker-compose up -d
# All services start together with proper networking
```

**Option 2: Local Development**
```bash
# Terminal 1: Backend
cd backend && source venv/bin/activate
uvicorn app.main:app --reload --port 8000

# Terminal 2: Frontend  
cd frontend
npm run dev  # Runs on :5173 with proxy to backend

# Vite's dev server proxies /api/* to http://localhost:5000 (check vite.config.ts)
# But for real backend on :8000, update vite.config.ts or use environment variable
```

## Key Configuration Files

### Environment Variables (.env)

Required for running with Docker:
- `FIREBASE_PROJECT_ID`: Your Firebase project
- `FIREBASE_PRIVATE_KEY`: Service account private key (JSON escaped)
- `FIREBASE_CLIENT_EMAIL`: Service account email
- `FIREBASE_STORAGE_BUCKET`: Firebase storage bucket name
- `GEMINI_API_KEY`: Google Generative AI key
- `SECRET_KEY`: For JWT signing (change in production)

See `.env.example` for all available settings.

### Backend Configuration (backend/app/core/config.py)

Uses Pydantic Settings to load environment variables. Add new settings here for any new features.

### Nginx Configuration (frontend/nginx.conf)

- Routes `/api/*` to FastAPI backend (upstream server)
- Serves static assets with aggressive caching
- Handles SPA routing (fallback to index.html)
- Gzip compression enabled

## Important Implementation Details

### Firebase Integration

**Backend** (`backend/app/services/firebase_service.py`):
- Validates Firebase ID tokens in middleware
- Interacts with Firestore (user data, receipts)
- Uploads/retrieves files from Firebase Storage
- Scoped to authenticated user

**Frontend** (`frontend/src/services/firebase.tsx`):
- Firebase SDK for authentication
- Firestore queries (if client-side reads allowed)
- File uploads to Storage

### Gemini AI Extraction

**Backend** (`backend/app/services/gemini.py`):
- Extracts receipt data from images (supplier, items, amounts, date)
- Called via `/extract` endpoint
- Returns structured JSON

**Flow**: Upload image → Extract via Gemini → Return parsed data → User creates/edits receipt

### Multi-Tenant Security

- **Never** query Firestore without filtering by user ID
- Always verify `userId` from URL matches token's `uid`
- Tests should isolate data by user

### Task Progress Tracking

Backend has `/tasks/{taskId}` endpoint for polling long-running operations (e.g., AI extraction).

Frontend uses WebSocket or polling via `useTaskProgress` hook to update UI.

## Code Patterns & Conventions

### Backend (Python/FastAPI)

- **Error handling**: Use `HTTPException` with proper status codes
- **Authentication**: Use `get_current_user()` from security module to inject auth context
- **Response models**: Always define Pydantic schemas for API responses
- **Logging**: Use Python's `logging` module; logs appear in Docker output
- **Async**: All endpoints are async; use `await` for I/O operations

### Frontend (TypeScript/React)

- **State management**: Use Zustand for global state (task progress), Context for app-wide values
- **Data fetching**: Use axios client in `services/api.ts`; React Query (TanStack Query) for caching
- **Error handling**: Use `ErrorBoundary` component and `apiErrorHandler` utility
- **Type safety**: All components and functions should have TypeScript types
- **Styling**: Tailwind CSS classes; custom CSS in `.css` files

## Debugging Tips

### Backend Issues

```bash
# View backend logs
docker-compose logs -f backend

# Check Firebase credentials
docker-compose exec backend python -c "from app.core.config import settings; print(settings.FIREBASE_PROJECT_ID)"

# Test API directly
curl http://localhost:8003/health

# Access FastAPI docs
# http://localhost:8003/docs (or :8000 if running locally)
```

### Frontend Issues

```bash
# View frontend/Nginx logs
docker-compose logs -f frontend

# Check browser console in DevTools
# Check browser Network tab for API calls

# Verify Nginx is proxying correctly
docker-compose exec frontend curl http://backend:8000/health
```

### Common Issues

- **"Backend connection refused"**: Ensure backend service is healthy (`docker-compose ps`)
- **"Unauthorized"**: Token may be expired; re-login in frontend
- **"Firestore permission error"**: Check Firebase rules; ensure `userId` filter is applied
- **"CORS error"**: Check `BACKEND_CORS_ORIGINS` in `.env`; Nginx proxy should handle same-origin

## Testing & Quality

- **Linting**: `npm run lint` (frontend)
- **Type checking**: `npm run build` compiles TypeScript
- **Manual testing**: Use Swagger UI (`/docs`) for backend, browser for frontend
- **Performance**: Profile with browser DevTools; check Firestore indexes if queries are slow

## Deployment Notes

Current setup uses Docker Compose for local development. For production:

1. **Use environment-specific configs** (separate `.env.prod`)
2. **Set `BACKEND_CORS_ORIGINS`** to specific domains (not `*`)
3. **Enable HTTPS** (Nginx SSL config, Caddy, or Traefik)
4. **Database migration path**: Firestore → PostgreSQL (service layer is abstracted)
5. **Storage migration path**: Firebase Storage → Local filesystem or S3
6. **Consider Kubernetes** for scaling beyond Docker Compose

## Useful References

- **FastAPI Docs**: https://fastapi.tiangolo.com/
- **Firebase Admin SDK**: https://firebase.google.com/docs/admin/setup
- **Google Generative AI**: https://ai.google.dev/
- **Vite**: https://vitejs.dev/
- **React**: https://react.dev/
- **Docker Compose**: https://docs.docker.com/compose/
- **Nginx**: https://nginx.org/en/docs/

## Related Documentation

- `README.md` — Full project overview, features, troubleshooting
- `.env.example` — All available environment variables
- `API.md`, `STRUCTURE.md` — Detailed API and structure docs
