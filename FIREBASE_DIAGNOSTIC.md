# Firebase Configuration Diagnostic

## Issue Summary

You're seeing two Firebase errors:

1. **Frontend**: `400 Bad Request` from Firebase sign-in endpoint
2. **Backend**: `"The default Firebase app does not exist"`

## Root Causes

### Backend Issue - FIXED
- **Problem**: Backend was not initializing Firebase on startup; it only initialized lazily when the first API request came in
- **Fix**: Updated `backend/app/main.py` lifespan event to call `init_firebase()` during startup
- **Action**: Rebuild Docker image: `docker-compose build --no-cache`

### Frontend Issue - Needs Investigation
- **Problem**: `400 Bad Request` from `identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`
- **Possible Causes**:
  1. Wrong Firebase API key in `.env.local`
  2. Firebase project doesn't have Email/Password authentication enabled
  3. User credentials (email/password) are invalid
  4. Firebase project configuration doesn't match the API key

## Steps to Fix

### 1. Verify Backend Firebase Credentials

Check if the firebaseservice.json file is valid:

```bash
# Check file exists and is readable
ls -la firebaseservice.json

# Check file is valid JSON
python3 -c "import json; json.load(open('firebaseservice.json'))" && echo "✅ Valid JSON"

# Check required fields
python3 << 'EOF'
import json
with open('firebaseservice.json') as f:
    creds = json.load(f)
    required = ['type', 'project_id', 'private_key', 'client_email', 'storage_bucket']
    missing = [k for k in required if k not in creds]
    if missing:
        print(f"❌ Missing fields: {missing}")
    else:
        print(f"✅ All required fields present")
        print(f"   Project: {creds['project_id']}")
        print(f"   Email: {creds['client_email']}")
        print(f"   Storage Bucket: {creds.get('storage_bucket', 'NOT SET')}")
EOF
```

### 2. Verify Frontend API Key

The frontend API key must match the Firebase project in `firebaseservice.json`:

```bash
# Check frontend .env.local
grep "VITE_FIREBASE_PROJECT_ID" frontend/.env.local

# Check backend firebaseservice.json project_id
python3 -c "import json; print('Backend project:', json.load(open('firebaseservice.json'))['project_id'])"
```

They **must** be the same project.

### 3. Enable Email/Password Auth in Firebase

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select the project matching `VITE_FIREBASE_PROJECT_ID`
3. Go to **Authentication** → **Sign-in method**
4. Enable **Email/Password** provider
5. Make sure **Email enumeration protection** is set (prevents user enumeration attacks)

### 4. Check Test User Credentials

If you have a test user in Firebase:

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select the project
3. Go to **Authentication** → **Users**
4. Verify the test user exists
5. If not, create one: click **Add user**

### 5. Rebuild and Restart

After making any changes:

```bash
# Stop current services
docker-compose down

# Rebuild backend with new Firebase initialization
docker-compose build --no-cache

# Start services
docker-compose up -d

# Check logs
docker-compose logs -f backend   # Should see "Firebase initialized successfully"
docker-compose logs -f frontend  # Check for errors
```

### 6. Test the Flow

1. Open browser to `http://localhost:8080`
2. Click **Sign Up**
3. Create an account with test email and password
4. Check browser console (F12 → Console) for errors
5. Check backend logs for authorization errors

## Debugging Commands

```bash
# 1. Verify backend can read Firebase credentials
docker-compose exec backend python3 -c \
  "from app.services.firebase_service import init_firebase; init_firebase(); print('✅ Firebase initialized')"

# 2. Check if user is created in Firebase
# (Must be done manually in Firebase Console - can't query from Docker)

# 3. Monitor backend logs in real-time
docker-compose logs -f backend

# 4. Monitor frontend logs (Nginx)
docker-compose logs -f frontend

# 5. Test API directly (replace TOKEN with your Firebase ID token)
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:8003/api/v1/users/YOUR_UID/receipts

# To get a token:
# 1. Log in via frontend
# 2. Open browser DevTools → Application → Local Storage
# 3. Look for firebase:authUser key containing the token
```

## Environment Variables Checklist

### Frontend (.env.local)
```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_MEASUREMENT_ID=...
VITE_API_URL=http://localhost:8003/api/v1
```

### Backend (firebaseservice.json)
```json
{
  "type": "service_account",
  "project_id": "YOUR_PROJECT_ID",
  "private_key": "-----BEGIN PRIVATE KEY-----...",
  "client_email": "firebase-adminsdk-...@YOUR_PROJECT_ID.iam.gserviceaccount.com",
  "client_id": "...",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "storage_bucket": "YOUR_PROJECT_ID.appspot.com"
}
```

## Common Issues

### 400 Bad Request from Firebase Sign-In
- Cause: Wrong API key or Firebase project doesn't have Email/Password auth enabled
- Fix: Double-check API key matches `project_id` in firebaseservice.json; enable Email/Password in Firebase Console

### "The default Firebase app does not exist"
- Cause: Backend couldn't load firebaseservice.json
- Fix: Verify file exists at `/app/firebaseservice.json` inside container; rebuild image

### 401 Unauthorized on API calls
- Cause: Token is invalid or expired
- Fix: Log out and log back in; check token in browser DevTools

### Frontend can't reach backend
- Cause: Wrong API URL or backend service not healthy
- Fix: Check `VITE_API_URL=http://localhost:8003/api/v1` (or `http://backend:8000/api/v1` in Docker); verify `docker-compose ps` shows backend as healthy
