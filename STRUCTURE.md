# Project Structure & Architecture

Complete breakdown of the scan_app_docker project structure, design decisions, and scalability plan.

## 📁 Directory Tree

```
scan_app_docker/
│
├── docker-compose.yml              ← Orchestrates backend + frontend
├── .env.example                    ← Environment template (copy to .env)
├── .dockerignore                   ← Excludes files from Docker build
├── .gitignore                      ← Git ignore rules
│
├── README.md                       ← Main documentation (START HERE)
├── API.md                          ← Complete API reference
├── STRUCTURE.md                    ← This file
├── FRONTEND_MIGRATION.md           ← Frontend transition guide
│
│
├── backend/                        ← FastAPI Python server
│   ├── Dockerfile                  ← Multi-stage build for backend
│   ├── requirements.txt            ← Python dependencies
│   │
│   └── app/                        ← Application package
│       ├── __init__.py
│       ├── main.py                 ← FastAPI app factory (ENTRY POINT)
│       │
│       ├── api/                    ← API route handlers
│       │   ├── __init__.py
│       │   ├── health.py           ← /health and /readiness endpoints
│       │   └── receipts.py         ← /users/{userId}/receipts/* endpoints
│       │
│       ├── services/               ← Business logic & external integrations
│       │   ├── __init__.py
│       │   ├── gemini.py           ← AI extraction & summarization
│       │   └── firebase_service.py ← Firebase wrapper (for future migration)
│       │
│       ├── schemas/                ← Pydantic request/response models
│       │   ├── __init__.py
│       │   └── receipt.py          ← Receipt data models
│       │
│       └── core/                   ← Core configuration & security
│           ├── __init__.py
│           ├── config.py           ← Settings from environment
│           └── security.py         ← Firebase token validation
│
│
├── frontend/                       ← React Vite application
│   ├── Dockerfile                  ← Multi-stage build + Nginx
│   ├── vite.config.ts              ← Vite bundler config
│   ├── tsconfig.json               ← TypeScript config
│   ├── index.html                  ← HTML entry point
│   ├── package.json                ← NPM dependencies
│   │
│   └── src/                        ← React source code
│       ├── main.tsx                ← React root
│       ├── App.tsx                 ← Main router component
│       ├── index.css               ← Global styles
│       │
│       ├── pages/                  ← Route pages
│       │   ├── LoginPage.tsx
│       │   ├── SignupPage.tsx
│       │   ├── DashboardPage.tsx
│       │   ├── ScannerPage.tsx
│       │   ├── ReviewPage.tsx
│       │   ├── ViewScansPage.tsx
│       │   ├── ReceiptDetailsPage.tsx
│       │   ├── PostReceiptPage.tsx
│       │   └── ExportPage.tsx
│       │
│       ├── components/             ← Reusable React components
│       │   ├── Layout.tsx
│       │   ├── Navbar.tsx
│       │   ├── ReceiptCard.tsx
│       │   ├── ReceiptForm.tsx
│       │   ├── ReviewPanel.tsx
│       │   ├── ImageViewer.tsx
│       │   └── ExportModal.tsx
│       │
│       ├── services/               ← API & external integrations
│       │   ├── firebase.tsx         ← Firebase auth setup (KEEP)
│       │   ├── api.ts              ← ← NEW: REST API client (MIGRATE TO)
│       │   ├── gemini.tsx          ← ← DEPRECATED (moved to backend)
│       │   ├── firestore.tsx       ← ← DEPRECATED (use API instead)
│       │   ├── storage.tsx         ← ← DEPRECATED (backend handles)
│       │   ├── gemini-cache.ts     ← Caching utilities
│       │   └── export.ts           ← Excel/PDF export functions
│       │
│       ├── contexts/               ← React Context providers
│       │   ├── AuthContext.tsx
│       │   ├── PrivateRoute.tsx
│       │   └── ScannerContext.tsx
│       │
│       ├── types/                  ← TypeScript type definitions
│       │   └── gemini.tsx
│       │
│       └── utils/                  ← Utility functions
│           ├── helpers.ts
│           └── loadImageForBrowser.ts
│
│
├── nginx/                          ← Nginx configuration
│   └── default.conf                ← Reverse proxy + SPA config
│
│
└── docs/ (optional future)
    ├── DEPLOYMENT.md               ← Production deployment guide
    ├── DATABASE_MIGRATION.md        ← PostgreSQL migration steps
    └── MONITORING.md               ← Prometheus/Grafana setup
```

---

## 🏗️ Architecture Layers

### Layer 1: Frontend (React)

**Responsibility**: User interface and local state

**Technology Stack**:
- React 19 with Hooks
- Vite for bundling
- Tailwind CSS for styling
- React Router for navigation
- Firebase Auth SDK (auth only)
- Chart.js for dashboards
- XLSX/jsPDF for export

**Key Components**:
- Pages: 9 route pages
- Components: 7 reusable components
- Services: API client + utilities
- Contexts: Auth + Scanner state

**Communication**:
- Calls `/api/v1/*` endpoints
- Sends Firebase ID tokens
- Receives JSON responses

### Layer 2: API Gateway (Nginx)

**Responsibility**: Routing, static serving, SSL termination

**Features**:
- ✅ Reverse proxy to backend
- ✅ Static file serving (React build)
- ✅ SPA routing (try_files)
- ✅ Request/response buffering
- ✅ Gzip compression
- ✅ Cache headers

**Routing**:
```
/              → frontend (React)
/api/*         → backend (FastAPI)
/health        → backend health check
/docs          → backend Swagger UI
```

### Layer 3: Backend API (FastAPI)

**Responsibility**: Business logic, data access, security

**Technology Stack**:
- FastAPI (Python web framework)
- Pydantic (data validation)
- Firebase Admin SDK
- Google Generative AI

**Layers**:
```
┌─ API Layer ─────────────────────────┐
│ receipts.py (routes)                │
│ health.py (monitoring)              │
├─ Services Layer ────────────────────┤
│ gemini.py (AI)                      │
│ firebase_service.py (data access)   │
├─ Models Layer ──────────────────────┤
│ receipt.py (Pydantic schemas)       │
├─ Core Layer ────────────────────────┤
│ config.py (settings)                │
│ security.py (authentication)        │
└─────────────────────────────────────┘
```

**Key Features**:
- ✅ Multi-tenant (user-scoped endpoints)
- ✅ Firebase token validation
- ✅ Request/response validation
- ✅ Error handling & logging
- ✅ File upload handling
- ✅ AI integration (Gemini)
- ✅ Ready for database migration

### Layer 4: Data Access (Firebase)

**Current**: Firebase Firestore + Storage

**Abstraction**: `FirestoreService` + `StorageService`

**Structure**:
- Collection: `users/{userId}/receipts`
- Documents: Receipt data
- Storage: `receipts/{userId}/{filename}`

**Future Migration Path**:
```
Firebase → PostgreSQL (drop-in replacement)
  - Models: SQLAlchemy ORM
  - Queries: Same interface
  - No API changes needed
```

---

## 🔐 Security Architecture

### Authentication Flow

```
1. Frontend
   ├─ User enters email/password
   └─ Firebase Auth handles login
      ↓
2. Frontend receives Firebase ID Token
   ├─ Token stored securely
   └─ Included in API requests: Authorization: Bearer <token>
      ↓
3. Backend
   ├─ Validates token signature
   ├─ Checks token expiration
   ├─ Extracts uid from token
   └─ Uses uid for data access control
      ↓
4. Services
   ├─ Firestore: `users/{uid}/receipts`
   ├─ Storage: `receipts/{uid}/*`
   └─ Gemini: All user-specific context
```

### Multi-Tenant Access Control

**Principle**: Users can only access their own data

**Implementation**:
```typescript
@router.get("/{userId}/receipts")
async def list_receipts(userId: str, current_user_id: str = Depends(verify_firebase_token)):
    // Verify access
    if userId != current_user_id:
        raise HTTPException(403, "Access denied")
    
    // Query user's data only
    receipts = firestore.query(f"users/{userId}/receipts")
```

**Enforced at**:
- ✅ API route level (verify path param matches token)
- ✅ Database level (scoped collections)
- ✅ File level (scoped storage paths)

---

## 🔄 Data Flow Examples

### Example 1: Scan Receipt

```
Frontend                    Backend                 External
  │                            │                        │
  ├─ User uploads image        │                        │
  │                            │                        │
  ├─ POST /extract ────────────>                        │
  │   (multipart file)         │                        │
  │                            ├─ Parse image           │
  │                            ├─ Call Gemini API ─────────>
  │                            │   (vision extraction)  │
  │                            │                    <────
  │                            ├─ Return structured data
  │<─ 200 OK ─────────────────│   (ReceiptCreate)
  │   (extracted data)         │                        │
  │                            │                        │
  ├─ User reviews/edits        │                        │
  │                            │                        │
  ├─ POST / (create) ─────────>│                        │
  │   (with extracted data)    │                        │
  │                            ├─ Validate schema       │
  │                            ├─ Upload image ───────────>
  │                            │   to Firebase Storage  │
  │                            │<─ URL ─────────────────
  │                            ├─ Save to Firestore
  │<─ 201 CREATED ────────────│   (users/{uid}/receipts)
  │   (Receipt with ID)        │                        │
```

### Example 2: Review & Update

```
Frontend                    Backend                 Firestore
  │                            │                        │
  ├─ GET /receipts ───────────>│                        │
  │                            ├─ Query Firestore ─────────>
  │                            │   WHERE status='needs_review'
  │                            │<─ Return docs ──────────
  │<─ 200 OK ─────────────────│   (ReceiptList)
  │   (list of receipts)       │                        │
  │                            │                        │
  ├─ User edits receipt        │                        │
  │                            │                        │
  ├─ PUT /receipts/{id} ──────>│                        │
  │   (partial updates)        │                        │
  │                            ├─ Validate schema       │
  │                            ├─ Update document ─────────>
  │                            │   (merge with existing) │
  │                            │<─ Success ──────────────
  │<─ 200 OK ─────────────────│   (updated Receipt)
  │   (updated receipt)        │                        │
```

### Example 3: Generate Summary

```
Frontend                    Backend                 Gemini
  │                            │                        │
  ├─ POST /summary ───────────>│                        │
  │   (?status=processed)      │                        │
  │                            ├─ Fetch receipts        │
  │                            │   (Firebase query)     │
  │                            │                        │
  │                            ├─ Send to Gemini ──────────>
  │                            │   (optimized prompt)   │
  │                            │   (prompt cached)      │
  │                            │<─ AI analysis ──────────
  │                            │   (summary + stats)    │
  │                            │                        │
  │<─ 200 OK ─────────────────│   (ReceiptSummary)
  │   (summary + analysis)     │                        │
```

---

## 📊 API Endpoint Map

```
GET /health
  └─ Monitoring (no auth)

/api/v1/
├─ /users/{userId}/receipts
│  ├─ POST /extract          Image → Structured data (Gemini)
│  ├─ POST /                 Create receipt
│  ├─ GET /                  List receipts (paginated)
│  ├─ GET /{id}              Get single receipt
│  ├─ PUT /{id}              Update receipt
│  ├─ DELETE /{id}           Delete receipt
│  ├─ POST /search           Advanced search
│  └─ POST /summary          Generate AI summary (Gemini)
```

---

## 🚀 Scalability Considerations

### Current Design (Firebase)

**Strengths**:
- ✅ No database maintenance
- ✅ Built-in replication
- ✅ Auto-scaling
- ✅ Real-time listeners

**Limitations**:
- ❌ Limited query capabilities
- ❌ Vendor lock-in
- ❌ Pricing per document read
- ❌ Query consistency

### Future: PostgreSQL Migration

**Benefits**:
- ✅ Complex queries
- ✅ Open source
- ✅ Better performance
- ✅ Lower costs at scale
- ✅ Full control

**Path**:
```
Current:  Firebase + Abstractions
          ↓ (no API changes)
Future:   PostgreSQL + Same API
          ↓ (drop-in replacement)
End:      Any database
```

**Migration Steps**:
1. Add PostgreSQL to docker-compose
2. Create SQLAlchemy models (mirror Firestore structure)
3. Update `FirestoreService` → `DatabaseService`
4. No changes to API routes needed
5. Deploy with database migration

### Horizontal Scaling

**Today** (Single container):
```
docker-compose up -d
```

**Tomorrow** (Docker Swarm):
```
docker service create scan-app-backend --replicas 3
docker service create scan-app-frontend --replicas 2
```

**Future** (Kubernetes):
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: scan-app-backend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: backend
  # ... horizontal pod autoscaling
```

---

## 🔧 Configuration Management

### Environment Variables

**Backend** (app/core/config.py):
```python
FIREBASE_PROJECT_ID        # Firebase project
FIREBASE_PRIVATE_KEY       # Service account key
GEMINI_API_KEY            # AI extraction
SECRET_KEY                # JWT signing (future)
ENABLE_DOCS               # Swagger UI
```

**Frontend** (import.meta.env):
```
VITE_API_URL              # Backend URL
VITE_FIREBASE_*           # Auth credentials
```

### Feature Flags

Ready for feature flags via environment:
```
ENABLE_SUMMARY_GENERATION  # Toggle AI features
ENABLE_REAL_TIME_UPDATES   # WebSocket support
ENABLE_BATCH_PROCESSING    # Async jobs
```

---

## 📈 Performance Metrics

### API Response Times (Target)

| Endpoint | Target | Current |
|----------|--------|---------|
| `/health` | <10ms | ✅ |
| `/extract` | <5s | ✅ (Gemini API) |
| `GET /` | <100ms | ✅ |
| `POST /` | <500ms | ✅ (Firebase) |
| `/summary` | <3s | ✅ (Gemini + caching) |

### Database Queries

- **List receipts**: Indexed on userId, status
- **Search**: Indexed on userId, category, date
- **Aggregations**: Calculate client-side (for now)

### Caching Strategy

**Frontend**:
- Browser cache: 1 year (assets)
- Conditional fetch: 30s (receipts)

**Backend**:
- Gemini prompt cache: 5 min (reusable)
- No internal caching (Firebase is cached)

**Nginx**:
- Static assets: 1 year
- API: No caching (dynamic)

---

## 🧪 Testing Strategy

### Unit Tests
```
backend/
├─ tests/
│  ├─ test_gemini.py
│  ├─ test_firebase_service.py
│  └─ test_schemas.py
```

### Integration Tests
```
backend/
└─ tests/
   └─ test_api_receipts.py
```

### E2E Tests (Frontend)
```
frontend/
└─ e2e/
   ├─ scan.test.ts
   ├─ review.test.ts
   └─ export.test.ts
```

---

## 📚 Documentation Files

| File | Purpose |
|------|---------|
| `README.md` | **START HERE** - Setup & overview |
| `API.md` | Complete endpoint reference |
| `STRUCTURE.md` | This file - architecture & design |
| `FRONTEND_MIGRATION.md` | Transition from Firebase to API |
| `.env.example` | Required environment variables |

---

## 🎯 Design Principles

1. **Separation of Concerns**
   - Frontend: UI only
   - Backend: Business logic
   - Services: External integrations

2. **Multi-Tenancy**
   - User ID in URL
   - Verified by token
   - Scoped data access

3. **Abstraction Layers**
   - Services hide implementations
   - Easy to swap Firebase → PostgreSQL
   - No API changes needed

4. **Scalability-First**
   - Stateless services
   - Horizontal scaling ready
   - Database agnostic

5. **Security**
   - Tokens validated server-side
   - Secrets in environment
   - Request validation
   - Error information hiding

---

## 🔮 Future Enhancements

### Phase 1: Improvements (Now)
- [ ] WebSocket for real-time updates
- [ ] Batch processing for bulk operations
- [ ] Rate limiting

### Phase 2: Database (Next Quarter)
- [ ] PostgreSQL migration
- [ ] Advanced queries
- [ ] Full-text search
- [ ] Analytics

### Phase 3: Features
- [ ] Category suggestions
- [ ] Receipt templates
- [ ] Recurring receipts
- [ ] Team/shared receipts
- [ ] Custom fields

### Phase 4: Infrastructure
- [ ] Kubernetes deployment
- [ ] Monitoring (Prometheus)
- [ ] Logging (ELK Stack)
- [ ] CDN integration
- [ ] Load testing

---

**Last Updated**: 2024-12-27  
**Version**: 1.0.0  
**Status**: Production-ready
