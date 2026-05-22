# Quick Start Guide

Get the Scan App up and running in 5 minutes!

## ⚡ TL;DR

```bash
# 1. Setup environment
cp .env.example .env
nano .env  # Add your Firebase & Gemini credentials

# 2. Start services
docker-compose up -d

# 3. Access application
# Frontend: http://localhost
# API Docs: http://localhost:8000/docs
# Health: http://localhost:8000/health
```

---

## 📋 Prerequisites

- **Docker & Docker Compose** installed
- **Firebase Account** with service account
- **Gemini API Key** from Google AI Studio

---

## 🔧 Step-by-Step Setup

### 1. Get Your Credentials

#### Firebase Service Account

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project → Settings (⚙️) → Service Accounts
3. Click "Generate New Private Key"
4. Save the JSON file

Extract these values:
- `FIREBASE_PROJECT_ID`: `"project_id"`
- `FIREBASE_PRIVATE_KEY`: `"private_key"` (keep `\n` literal)
- `FIREBASE_CLIENT_EMAIL`: `"client_email"`
- `FIREBASE_STORAGE_BUCKET`: `"storage_bucket"`

#### Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Create API key
3. Copy to `GEMINI_API_KEY`

### 2. Configure Environment

```bash
# Copy template
cp .env.example .env

# Edit with your credentials
nano .env
```

**Example .env**:
```env
FIREBASE_PROJECT_ID=my-firebase-project
FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@my-project.iam.gserviceaccount.com
FIREBASE_STORAGE_BUCKET=my-project.appspot.com
GEMINI_API_KEY=AIzaSy...
SECRET_KEY=your-secret-key-here
```

⚠️ **Important**: Keep `\n` literal in FIREBASE_PRIVATE_KEY, don't expand to newlines

### 3. Start Services

```bash
# Start all services (backend + frontend)
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f
```

### 4. Verify Setup

```bash
# Check backend health
curl http://localhost:8000/health

# Check frontend
curl http://localhost/

# Check API docs
curl http://localhost:8000/docs
```

---

## 🌐 Access Application

| Component | URL | Purpose |
|-----------|-----|---------|
| Frontend | http://localhost | Receipt scanning app |
| API Docs | http://localhost:8000/docs | Interactive API testing |
| Health Check | http://localhost:8000/health | Service monitoring |

---

## 💡 First Steps

### 1. Login
- Use Firebase authentication (signup on the app)
- Email/password created in Firebase

### 2. Scan Receipt
1. Click "Scanner"
2. Upload receipt image (JPEG, PNG, HEIC)
3. Review extracted data
4. Click "Save Batch"

### 3. View Dashboard
- Click "Dashboard"
- See statistics and charts
- View spending by category

### 4. Review Receipts
- Click "Review" to check pending receipts
- Edit and mark as processed

---

## 🐛 Troubleshooting

### Services won't start

```bash
# Check logs
docker-compose logs backend
docker-compose logs frontend

# Restart
docker-compose down
docker-compose up -d
```

### Backend returns 500 errors

```bash
# Check Firebase credentials
docker-compose exec backend curl -X GET http://localhost:8000/health

# View detailed logs
docker-compose logs -f backend --tail=100
```

### Can't upload images

- File size < 50MB
- Format is JPEG, PNG, WEBP, or HEIC
- Check Nginx logs: `docker-compose logs frontend`

### Frontend shows blank page

```bash
# Check Nginx
docker-compose logs frontend

# Verify API connection
curl http://localhost:8000/api/v1/users/test

# Check browser console (F12) for errors
```

---

## 📚 Next Steps

1. **Read Full Documentation**
   - `README.md` - Complete setup & features
   - `API.md` - All API endpoints
   - `STRUCTURE.md` - Architecture & design

2. **Test API Endpoints**
   - Go to http://localhost:8000/docs
   - Click "Authorize" and paste Firebase token
   - Test endpoints interactively

3. **Migrate Frontend**
   - See `FRONTEND_MIGRATION.md`
   - Switch from Firebase calls to API calls
   - Gradual transition recommended

4. **Plan Database Migration**
   - Currently: Firebase Firestore
   - Future: PostgreSQL (drop-in replacement)
   - Services layer abstracts this

---

## 🛠 Common Commands

```bash
# View logs
docker-compose logs -f backend
docker-compose logs -f frontend

# Restart services
docker-compose restart backend
docker-compose restart frontend

# Stop all
docker-compose down

# Rebuild images
docker-compose build --no-cache

# Execute command in container
docker-compose exec backend bash
docker-compose exec frontend bash

# View environment variables
docker-compose exec backend env | grep FIREBASE
```

---

## 🔗 Important Links

- 📖 **Full README**: `README.md`
- 🔌 **API Reference**: `API.md`
- 🏗️ **Architecture**: `STRUCTURE.md`
- 🔄 **Frontend Migration**: `FRONTEND_MIGRATION.md`
- ⚙️ **Environment Template**: `.env.example`

---

## 💬 Questions?

1. **API not working?** → Check `API.md` for endpoints
2. **Setup issues?** → Check logs with `docker-compose logs`
3. **Want to migrate to PostgreSQL?** → Plan documented in `STRUCTURE.md`
4. **Need to update frontend?** → See `FRONTEND_MIGRATION.md`

---

## ✅ Verification Checklist

- [ ] `.env` file created with credentials
- [ ] `docker-compose up -d` ran successfully
- [ ] `docker-compose ps` shows all services healthy
- [ ] `curl http://localhost:8000/health` returns `{"status":"ok"}`
- [ ] Frontend loads at http://localhost
- [ ] Can login with Firebase credentials
- [ ] Can upload and scan receipts
- [ ] Dashboard shows statistics

---

**You're all set!** 🚀 Start scanning receipts!

For detailed documentation, see `README.md`.
