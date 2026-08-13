# GEMINI.md - Scan App Project Context

## Project Overview

**Scan App** is a multi-tenant receipt scanning and management application. It allows users to upload receipt images, extract structured data using AI (Gemini/DeepSeek), manage their receipt history, and view spending analytics.

### Architecture
- **Frontend**: React (19+) with Vite, TypeScript, Tailwind CSS, Zustand (state), and TanStack Query (data fetching).
- **Backend**: FastAPI (Python 3.10+), Pydantic (validation), and asynchronous service layers.
- **Database**: 
    - **Primary**: Migrating from Firebase Firestore to **PostgreSQL** (via `asyncpg` and SQLAlchemy).
    - **Transitional**: SQLite for review batch tracking.
    - **Cache/Task Queue**: Redis and Celery for asynchronous batch processing.
- **AI Extraction**: Google Gemini API and DeepSeek (via OpenAI-compatible API).
- **Authentication**: Firebase Auth (ID tokens validated server-side).
- **Storage**: Migrating from Firebase Storage to **local filesystem** (or S3-compatible in the future).
- **Deployment**: Fully containerized with **Docker Compose**, using Nginx as a reverse proxy.

## Project Structure

- `backend/`: FastAPI source code.
    - `app/api/`: RESTful endpoints.
    - `app/core/`: Configuration, security, and database setup.
    - `app/services/`: Business logic and external integrations (Firebase, Gemini, etc.).
    - `app/schemas/`: Pydantic models for request/response validation.
    - `app/tasks/`: Celery worker and task definitions.
- `frontend/`: React source code.
    - `src/components/`: Reusable UI components.
    - `src/pages/`: Main page components.
    - `src/services/`: API clients and SDK initializations.
    - `src/stores/`: Zustand state stores.
- `nginx/`: Configuration for the Nginx reverse proxy.
- `docker-compose.yml`: Service orchestration and environment configuration.

## Common Commands

### Full Stack (Docker)
```bash
# Start all services
docker-compose up -d

# View logs for backend
docker-compose logs -f backend

# Rebuild images
docker-compose build --no-cache

# Run backend migrations (Alembic)
docker-compose exec backend alembic upgrade head
```

### Backend Development (Local)
```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Frontend Development (Local)
```bash
cd frontend
npm install
npm run dev
```

## Engineering Standards & Conventions

### Multi-Tenancy & Security
- **Strict Data Isolation**: All API endpoints must include `userId` in the path: `/api/v1/users/{userId}/...`.
- **Token Validation**: Backend must verify that the Firebase ID token `uid` matches the `userId` in the request path.
- **Database Queries**: Never query the database without filtering by `userId`.
- **Secrets**: Use environment variables for all sensitive data (API keys, DB credentials). Never commit `.env` files.

### Backend (Python/FastAPI)
- **Async First**: Use `async/await` for all I/O-bound operations (DB calls, API requests).
- **Service Layer**: Business logic should reside in `app/services/`, not in routers.
- **Type Safety**: Use Pydantic schemas for all request bodies and response models.
- **Concurrency**: Use `asyncio.Lock` when modifying global state or interacting with non-thread-safe SDKs (e.g., `genai.configure`).

### Frontend (TypeScript/React)
- **Component Design**: Prefer functional components and custom hooks for logic.
- **State Management**: Use Zustand for global state (e.g., task progress) and React Context for scoped context.
- **Data Fetching**: Use TanStack Query (React Query) for managing server state and caching.
- **Styling**: Use Tailwind CSS utility classes. Avoid complex custom CSS where possible.

### Testing
- **Manual Verification**: Use the FastAPI Swagger UI at `http://localhost:8000/docs` to test endpoints.
- **Reproduce Bugs**: Before fixing a bug, create a reproduction script or test case.

## Deployment Details
- **Nginx**: Handles `/api/*` proxying to the backend and serves the frontend SPA with routing fallback to `index.html`.
- **Ports**:
    - Frontend: `8081` (via Nginx)
    - Backend API: `8003` (Docker mapping) / `8000` (Container internal)
    - PostgreSQL: `5432`
    - Redis: `6379`

## Migration Roadmap (Active)
1. **Database**: Moving from Firestore to PostgreSQL. Use the `DataService` and `DatabaseService` abstractions to facilitate this transition.
2. **Storage**: Moving from Firebase Storage to local volume-mounted storage in `/app/data/images`.
3. **Auth**: Currently relying on Firebase Auth; potential future migration to custom JWT.
