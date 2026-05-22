# Scan App - Docker Deployment

**Receipt scanning and management application** with FastAPI backend and React frontend, fully containerized with Docker Compose.

## 📋 Architecture Overview

```
┌─────────────────────┐
│  React Frontend     │
│  (Vite + React)     │
│  Port: 80           │
└──────────┬──────────┘
           │
           │ API calls
           ▼
┌─────────────────────────────────────┐
│  Nginx Reverse Proxy                │
│  - Static asset serving             │
│  - /api/* → Backend                 │
│  - SPA routing                      │
└──────────┬──────────────────────────┘
           │
           │ HTTP
           ▼
┌─────────────────────────────────────┐
│  FastAPI Backend (Python)           │
│  /api/v1/users/{userId}/receipts    │
│  Port: 8000                         │
└──────────┬──────────────────────────┘
           │
           ├─ Firebase Auth (verify tokens)
           ├─ Firebase Firestore (data)
           ├─ Firebase Storage (images)
           └─ Gemini API (AI extraction)
```

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose installed
- Firebase project with service account
- Gemini API key

### 1. Environment Setup

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your credentials
# Required: FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, etc.
nano .env
```

### 2. Start Services

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Check health
docker-compose ps
```

### 3. Access Application

- **Frontend**: http://localhost
- **API Docs**: http://localhost:8000/docs
- **API Health**: http://localhost:8000/health

## 📁 Project Structure

```
scan_app_docker/
├── backend/                        # FastAPI server
│   ├── app/
│   │   ├── api/
│   │   │   ├── health.py          # Health check endpoints
│   │   │   └── receipts.py        # Receipt CRUD + AI
│   │   ├── services/
│   │   │   ├── firebase_service.py # Firebase wrapper
│   │   │   └── gemini.py          # AI extraction (moved from frontend)
│   │   ├── schemas/
│   │   │   └── receipt.py         # Pydantic models
│   │   ├── core/
│   │   │   ├── config.py          # Settings
│   │   │   └── security.py        # Firebase auth
│   │   └── main.py                # FastAPI app
│   ├── requirements.txt
│   └── Dockerfile
│
├── frontend/                       # React Vite app
│   ├── src/                        # React components
│   ├── index.html
│   ├── vite.config.ts
│   ├── package.json
│   └── Dockerfile
│
├── nginx/
│   └── default.conf               # Nginx reverse proxy config
│
├── docker-compose.yml             # Orchestration
├── .env.example                   # Environment template
└── README.md
```

## 🔌 API Structure

### Multi-Tenant Resource Hierarchy

All endpoints are scoped to the authenticated user:

```
/api/v1/users/{userId}/receipts
├── POST     /extract          Extract data from image
├── POST     /                 Create receipt
├── GET      /                 List receipts (paginated)
├── GET      /{receiptId}      Get single receipt
├── PUT      /{receiptId}      Update receipt
├── DELETE   /{receiptId}      Delete receipt
├── POST     /search           Search with filters
└── POST     /summary          Generate AI spending summary
```

### Authentication

All requests (except `/health`) require Firebase ID token:

```bash
curl -H "Authorization: Bearer <firebase_token>" \
  http://localhost:8000/api/v1/users/uid123/receipts
```

### Example Requests

**Extract receipt from image:**
```bash
curl -X POST http://localhost:8000/api/v1/users/uid123/receipts/extract \
  -H "Authorization: Bearer <token>" \
  -F "file=@receipt.jpg"
```

**Create receipt (after extraction):**
```bash
curl -X POST http://localhost:8000/api/v1/users/uid123/receipts \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "supplier": "Store Name",
    "totalAmount": "1000.00",
    "receiptDate": "12/25/2024",
    "category": "Groceries",
    "items": [{"name": "Item", "quantity": 1, "price": "1000.00"}]
  }'
```

**Generate spending summary:**
```bash
curl -X POST http://localhost:8000/api/v1/users/uid123/receipts/summary \
  -H "Authorization: Bearer <token>"
```

## 🔒 Security Features

### Multi-Tenant Access Control

- Users can only access their own `/users/{userId}` data
- Backend verifies token contains matching `uid`
- All Firestore queries scoped to user ID

### Authentication

- **Current**: Firebase ID tokens (validated server-side)
- **Future**: Can migrate to JWT or custom auth

### API Security

- CORS configured (restrict in production)
- Trusted host middleware
- Request validation with Pydantic
- Secrets in environment variables

## 🛠 Development

### Local Development (Without Docker)

```bash
# Backend
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

### Backend Logs

```bash
# View backend logs
docker-compose logs -f backend

# View specific service
docker-compose logs backend --tail=100
```

### Database Inspection

Firebase Firestore is cloud-based, but you can inspect via:
- [Firebase Console](https://console.firebase.google.com)
- Firebase Admin SDK directly

## 📊 Features

### Receipt Management
- 📸 **Extract from Image**: Gemini AI extracts supplier, date, items, amounts
- 📝 **Manual Entry**: Create receipts manually
- ✏️ **Edit**: Update receipt data
- 🗑️ **Delete**: Remove receipts
- 🔍 **Search**: Filter by supplier, category, date range
- 📊 **Summary**: AI-powered spending analysis

### Dashboard
- **Statistics**: Total receipts, processed, needs review
- **Charts**: Spending by category, status breakdown
- **Top Suppliers**: Ranked by spending
- **Batch Management**: Group receipts by batch

### Export
- **Excel**: XLSX format with all fields
- **PDF**: Formatted receipt list
- **Summary**: AI-generated spending report

## 🔄 Migration Roadmap

### Current (Firebase-based)
- ✅ Firebase Authentication
- ✅ Firebase Firestore (Realtime Database)
- ✅ Firebase Storage (Images)

### Future Migrations

**Phase 1: Database**
```
Firebase Firestore → PostgreSQL
- Models already prepared
- Services layer abstracts implementation
```

**Phase 2: Storage**
```
Firebase Storage → Local filesystem or S3
- Abstracted in StorageService
- Easy to swap implementations
```

**Phase 3: Authentication**
```
Firebase Auth → Custom JWT + PostgreSQL users
- Backend already validates tokens
- Can extend with custom user model
```

## 📦 Docker Commands

### Common Operations

```bash
# Start services
docker-compose up -d

# Stop services
docker-compose down

# View logs
docker-compose logs -f [service]

# Rebuild images
docker-compose build --no-cache

# Run command in container
docker-compose exec backend bash

# Check status
docker-compose ps

# Clean up (remove volumes)
docker-compose down -v
```

### Troubleshooting

```bash
# Backend health
curl http://localhost:8000/health

# Backend logs
docker-compose logs backend -f --tail=50

# Frontend logs
docker-compose logs frontend -f --tail=50

# Check container resources
docker stats

# Inspect container
docker inspect scan-app-backend
```

## ⚙️ Configuration

### Environment Variables

See `.env.example` for all available settings.

**Key variables:**
- `FIREBASE_PROJECT_ID`: Firebase project ID
- `FIREBASE_PRIVATE_KEY`: Service account private key
- `GEMINI_API_KEY`: Google Generative AI key
- `BACKEND_CORS_ORIGINS`: Allowed CORS origins

### Nginx Configuration

Edit `nginx/default.conf` to:
- Change cache headers
- Add authentication (basic auth, etc.)
- Modify buffer sizes
- Configure SSL/TLS

### FastAPI Configuration

Edit `backend/app/core/config.py` to:
- Change logging levels
- Modify CORS settings
- Adjust timeouts
- Enable/disable API docs

## 🐛 Troubleshooting

### Backend won't start
```bash
# Check logs
docker-compose logs backend

# Verify Firebase credentials
docker-compose exec backend python -c "from app.services.firebase_service import init_firebase; init_firebase()"

# Check environment variables
docker-compose exec backend env | grep FIREBASE
```

### Frontend shows blank page
```bash
# Check Nginx logs
docker-compose logs frontend

# Verify API connection
curl http://localhost:8000/health

# Check browser console for JavaScript errors
```

### File upload fails
```bash
# Check Nginx buffer size
docker-compose exec frontend cat /etc/nginx/conf.d/default.conf | grep client_max_body_size

# Check backend upload limits in docker-compose.yml
```

### API errors
```bash
# View detailed errors
docker-compose logs backend -f

# Test API endpoint directly
curl -H "Authorization: Bearer <token>" http://localhost:8000/api/v1/users/uid/receipts

# Check Swagger UI for schema errors
# Go to http://localhost:8000/docs
```

## 📈 Performance

### Optimization Tips

1. **Database**: Add indexes in Firestore for common queries
2. **Images**: Compress before upload
3. **Caching**: Leverage Nginx caching headers
4. **API**: Use pagination (limit=50 default)
5. **Frontend**: Lazy load images, code splitting

## 📚 References

- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [Firebase Admin SDK](https://firebase.google.com/docs/admin/setup)
- [Google Generative AI](https://ai.google.dev/)
- [Docker Compose](https://docs.docker.com/compose/)
- [Nginx Reverse Proxy](https://nginx.org/en/docs/)

## 📝 API Documentation

Interactive API docs available at: **http://localhost:8000/docs**

Features:
- Live endpoint testing
- Request/response examples
- Parameter documentation
- Authentication setup

## 🤝 Contributing

When adding new features:

1. **Add service layer**: Add methods to `services/`
2. **Add schemas**: Define Pydantic models in `schemas/`
3. **Add routes**: Create endpoint in `api/receipts.py` or new file
4. **Update frontend**: Modify React components to call new endpoint
5. **Document**: Add docstrings and update API docs

## 📄 License

ISC License - See LICENSE file

## 🚀 Deployment

### Docker Hub

```bash
# Build and tag
docker build -t yourusername/scan-app-backend:1.0.0 ./backend
docker build -t yourusername/scan-app-frontend:1.0.0 ./frontend

# Push
docker push yourusername/scan-app-backend:1.0.0
docker push yourusername/scan-app-frontend:1.0.0
```

### Production Deployment

For production, consider:

1. **Reverse Proxy**: Use Caddy or Traefik for SSL/TLS
2. **Database**: Migrate from Firestore to PostgreSQL
3. **Secrets**: Use Docker secrets or environment variables
4. **Scaling**: Use Kubernetes or Docker Swarm
5. **Monitoring**: Add Prometheus/Grafana
6. **Backup**: Implement database backups
7. **CDN**: Serve static assets from CDN

Example production `docker-compose.yml` with PostgreSQL coming soon...

---

**Questions?** Check logs with `docker-compose logs -f` or review `.env.example` for configuration help.
