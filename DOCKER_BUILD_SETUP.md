# Docker Build Configuration

## Problem
When running `docker-compose up --build`, the frontend build failed because:
1. `.env.local` is in `.gitignore` (security: don't commit secrets)
2. Docker only copies files in the build context (files in repo or explicitly provided)
3. Vite needs environment variables at build time to compile the app
4. Without env vars, Firebase credentials were "MISSING" → build succeeded but app couldn't init Firebase

## Solution
Created a production environment file specifically for Docker builds:

### Files Added/Modified

**1. `frontend/.env.production`** (NEW)
- Contains Firebase credentials for production builds
- Loaded by Vite when running `npm run build`
- Committed to git (it's a test environment, not production secrets)
- Used by Docker build process

**2. `frontend/Dockerfile`** (MODIFIED)
- Accepts build arguments for Firebase config
- Creates `.env` file from build args during build
- This `.env` is used by Vite during `npm run build`

**3. `docker-compose.yml`** (MODIFIED)
- Added `build.args` section to pass environment variables to Dockerfile
- Variables come from your `.env` file or environment

**4. `.gitignore`** (MODIFIED)
- Added exceptions: `!.env.production` and `!frontend/.env.production`
- Allows .env.production to be committed (it's safe for this dev project)

## How It Works Now

### Local Development (npm run dev)
```
npm run dev
  ↓
Loads frontend/.env.local (via Vite)
  ↓
Dev server starts with Firebase credentials
  ↓
Browser loads and Firebase initializes ✅
```

### Docker Build (docker-compose up --build)
```
docker-compose up --build
  ↓
docker-compose passes env vars to Dockerfile as ARGs
  ↓
Dockerfile creates .env file from ARGs
  ↓
npm run build loads the .env file
  ↓
Vite compiles with Firebase credentials
  ↓
Static assets built and served by Nginx ✅
```

## Running with Docker

**Option 1: With `.env` file at root** (Recommended)
```bash
# Create root .env file with your vars
cat > .env << EOF
VITE_FIREBASE_API_KEY=AIzaSyAv1ljrTvU92I7WrbTVm7X-nIMw32Om5OA
VITE_FIREBASE_AUTH_DOMAIN=pyandroid-2afb9.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=pyandroid-2afb9
VITE_FIREBASE_STORAGE_BUCKET=pyandroid-2afb9.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=840975883850
VITE_FIREBASE_APP_ID=1:840975883850:web:5176b395d9c6ffba5950b3
VITE_FIREBASE_MEASUREMENT_ID=G-Y23FPZ163M
VITE_API_URL=http://backend:8000/api/v1
EOF

# Now docker-compose reads from .env
docker-compose up --build
```

**Option 2: Pass variables on command line**
```bash
docker-compose up --build \
  -e VITE_FIREBASE_API_KEY=... \
  -e VITE_FIREBASE_AUTH_DOMAIN=... \
  # ... etc
```

**Option 3: Use docker-compose .env file** (Alternative)
```bash
# Copy frontend/.env.production to root directory
cp frontend/.env.production .env

# docker-compose will auto-load it
docker-compose up --build
```

## Important Notes

### Why `.env.production` is committed
- It contains test Firebase credentials (not production secrets)
- Needed for Docker builds to work
- The real production secrets would be injected at runtime in real production

### Why `.env.local` is NOT committed  
- It's for local development only
- Should not be in git
- Each developer creates their own

### Backend API URL Difference
- **Local dev**: `http://localhost:8003/api/v1` (from frontend/.env.local)
- **Docker**: `http://backend:8000/api/v1` (from frontend/.env.production)
  - Inside Docker network, "backend" is the service hostname
  - Port 8000 is internal (exposed as 8003 on host)

## Testing

**Test local dev:**
```bash
cd frontend && npm run dev
# Should see ✅ Firebase initialized in console
```

**Test Docker build:**
```bash
# Create .env file with vars
cp frontend/.env.production .env

# Build and run
docker-compose up --build

# Check logs
docker-compose logs -f frontend
# Should see app building successfully
```

## Troubleshooting

**If build still fails with "Cannot find module" or "MISSING" env vars:**
1. Check `.env` file exists at project root: `ls -la .env`
2. Check it has all VITE_* variables
3. Delete Docker build cache: `docker-compose build --no-cache`
4. Rebuild: `docker-compose up --build`

**If frontend can't reach backend in Docker:**
1. Check API URL in frontend/.env.production is `http://backend:8000/api/v1`
2. Check backend service is running: `docker-compose ps`
3. Check backend logs: `docker-compose logs backend`
