# Firebase Setup Guide

## Overview

The backend now uses Firebase **service account JSON file** for authentication instead of environment variables. This is the recommended approach by Google as it:

- ✅ Avoids exposing private keys in environment variables
- ✅ Follows security best practices
- ✅ Works seamlessly in Docker containers
- ✅ Supports local development without configuration

---

## Setup Instructions

### Step 1: Get Your Service Account JSON

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project
3. Click **Project Settings** (gear icon)
4. Go to **Service Accounts** tab
5. Click **Generate New Private Key**
6. A JSON file will be downloaded

### Step 2: Place the JSON File

Place the downloaded JSON file in the **project root directory** and name it:

```
firebaseservice.json
```

Example path:
```
/home/brian/projects/scan_app_docker/firebaseservice.json
```

### Step 3: Verify File Contents

The JSON file should contain:
```json
{
  "type": "service_account",
  "project_id": "your-project-id",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-xxx@your-project-id.iam.gserviceaccount.com",
  "client_id": "...",
  "auth_uri": "...",
  "token_uri": "...",
  "auth_provider_x509_cert_url": "...",
  "client_x509_cert_url": "..."
}
```

### Step 4: Update .env File

Only the `GEMINI_API_KEY` is needed now. Create/update `.env` file:

```bash
# .env

# Gemini API key (required)
GEMINI_API_KEY=your-gemini-api-key

# Optional: Override Firebase credentials path (defaults to ./firebaseservice.json)
# FIREBASE_CREDENTIALS_PATH=/custom/path/to/firebaseservice.json

# Security (change in production)
SECRET_KEY=your-secret-key-change-in-production
```

---

## How It Works

### Local Development (npm run dev / python runserver)

When you run the backend locally:

1. The backend reads `FIREBASE_CREDENTIALS_PATH` from environment (or uses default)
2. It looks for `firebaseservice.json` in the **current directory** (project root)
3. If found, it loads the credentials from the JSON file
4. Firebase Admin SDK is initialized with these credentials

```bash
# Backend starts in project root
cd /home/brian/projects/scan_app_docker/backend
python -m uvicorn app.main:app --reload

# Looks for: ../firebaseservice.json (one level up)
# Or set explicitly: FIREBASE_CREDENTIALS_PATH=../firebaseservice.json
```

### Docker Compose (docker-compose up)

When you run with Docker:

1. The `firebaseservice.json` is mounted as a volume at `/app/firebaseservice.json`
2. Environment variable `FIREBASE_CREDENTIALS_PATH=/app/firebaseservice.json` is set
3. Backend container reads the mounted file
4. Firebase Admin SDK is initialized

```yaml
backend:
  volumes:
    # Mount Firebase service account JSON
    - ./firebaseservice.json:/app/firebaseservice.json:ro
  environment:
    FIREBASE_CREDENTIALS_PATH: /app/firebaseservice.json
```

---

## Running the Application

### Local Development

```bash
# Start backend (from project root)
cd backend
export FIREBASE_CREDENTIALS_PATH=../firebaseservice.json  # Optional, if not in current dir
python -m uvicorn app.main:app --reload

# In another terminal, start frontend
cd frontend
npm run dev
```

### Docker Compose

```bash
# Start all services
docker-compose up -d

# Verify backend initialized correctly
docker-compose logs backend | grep -i firebase

# Should see: "Firebase initialized successfully for project: your-project-id"
```

---

## Troubleshooting

### Error: "Firebase service account JSON not found"

**Solution**: Ensure `firebaseservice.json` is in the project root:

```bash
# Check file exists
ls -l firebaseservice.json

# Check it's valid JSON
cat firebaseservice.json | python -m json.tool
```

### Error: "Firebase service account JSON missing required fields"

**Solution**: Verify the JSON has all required fields:

```json
{
  "type": "service_account",
  "project_id": "...",
  "private_key": "...",
  "client_email": "..."
}
```

### Error: "No such file or directory: firebaseservice.json"

**Solution**: Make sure you're in the right directory:

```bash
# Should be in project root
pwd
# /home/brian/projects/scan_app_docker

# File should be here:
ls firebaseservice.json
```

### Docker container can't find the file

**Solution**: Check the volume mount:

```bash
# Verify volume is mounted
docker inspect scan-app-backend | grep Mounts

# Should show:
# "Source": ".../firebaseservice.json"
# "Destination": "/app/firebaseservice.json"
```

---

## Security Notes

⚠️ **IMPORTANT**: The `firebaseservice.json` file contains sensitive credentials

- ✋ **Never commit** to Git (already in `.gitignore`)
- ✋ **Never share** or upload publicly
- ✋ **Keep secure** - limit file permissions to 0600 if possible
- ✋ **Rotate** the key periodically from Firebase Console

---

## Environment Variables

### Required

- `GEMINI_API_KEY` — Google Generative AI key (for receipt extraction)

### Optional

- `FIREBASE_CREDENTIALS_PATH` — Override path to service account JSON
  - Default (Docker): `/app/firebaseservice.json`
  - Default (Local): `./firebaseservice.json`
  - Example: `FIREBASE_CREDENTIALS_PATH=/secrets/firebase.json`

### Security

- `SECRET_KEY` — JWT signing key (change in production)
- `BACKEND_CORS_ORIGINS` — CORS allowed origins

---

## Migration from Old Setup

If you were previously using environment variables:

**Old way** (no longer used):
```bash
FIREBASE_PROJECT_ID=...
FIREBASE_PRIVATE_KEY=...
FIREBASE_CLIENT_EMAIL=...
```

**New way**:
```bash
# Just place firebaseservice.json in project root
# That's it!
```

The backend will automatically detect and use the JSON file. No environment variable parsing needed.

---

## Next Steps

1. ✅ Download service account JSON from Firebase Console
2. ✅ Place it as `firebaseservice.json` in project root
3. ✅ Update `.env` with `GEMINI_API_KEY`
4. ✅ Run `docker-compose up -d`
5. ✅ Verify logs: `docker-compose logs backend`

Done! Your Firebase credentials are now securely loaded from the JSON file.
