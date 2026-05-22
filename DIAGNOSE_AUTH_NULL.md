# Diagnosing Why auth is Null

If `auth` is null even though you have the correct configuration, use these steps to find the issue.

## Step 1: Check Console Logs on Page Load

Open browser DevTools Console and look for these logs:

**Good - Firebase initialized:**
```
🔥 Firebase Module Loading...
📋 Config values: {apiKey: "AIzaSyA...", authDomain: "pyandroid-2af...", ...}
🚀 Initializing Firebase App...
✅ Firebase App initialized: [DEFAULT]
🔐 Getting Auth instance...
✅ Auth instance ready: true
📊 Getting Firestore instance...
✅ Firestore ready: true
📦 Getting Storage instance...
✅ Storage ready: true
✨ Firebase fully initialized successfully
```

**Bad - Firebase failed to initialize:**
```
❌ Firebase initialization failed: [error message]
Full error: [detailed error]
```

## Step 2: Run Debug Command

In browser console, run:
```javascript
window.debugFirebase()
```

This shows exactly what environment variables were loaded from `.env.local`.

**What to look for:**
- Is `VITE_FIREBASE_API_KEY` showing "NOT FOUND"? → .env.local not loaded
- Is `VITE_FIREBASE_PROJECT_ID` showing "NOT FOUND"? → .env.local not loaded
- Do all values show but auth is still null? → Config might be incomplete

## Step 3: Common Issues & Solutions

### Issue 1: "NOT FOUND" for Environment Variables

**Problem:** Variables show as "NOT FOUND" in debugFirebase()

**Causes:**
1. `.env.local` file doesn't exist in `frontend/` directory
2. Dev server wasn't restarted after creating `.env.local`
3. Wrong file location (should be `frontend/.env.local`, not `./frontend/.env.local` from project root)

**Solution:**
```bash
# 1. Verify file exists in correct location
ls -la frontend/.env.local

# 2. Stop dev server (Ctrl+C)
cd frontend
npm run dev

# 3. Check browser console for logs
# Should see ✅ Firebase App initialized
```

### Issue 2: Config Values Show But Firebase Fails

**Problem:** debugFirebase() shows all values loaded, but console shows "Firebase initialization failed"

**Causes:**
1. API key is invalid for this project
2. API key has restrictions preventing initialization
3. One of the config values is malformed

**Solution - Verify Each Value:**

```javascript
// Run in console:
window.debugFirebase()

// Then check these match your Firebase Console:
// 1. projectId should be: pyandroid-2afb9
// 2. authDomain should be: pyandroid-2afb9.firebaseapp.com  
// 3. storageBucket should be: pyandroid-2afb9.appspot.com
// 4. apiKey should start with: AIzaSyA...
```

If they match but still fails → API key restrictions issue.

### Issue 3: Firebase Initializes But auth is Still Null

**Problem:** Console shows ✅ Firebase App initialized, but auth is null

**This shouldn't happen**, but if it does:

```javascript
// Get the initialization error
import { initError } from './services/firebase';
console.log('Firebase Init Error:', initError);

// Check auth object directly
import { auth } from './services/firebase';
console.log('Auth object:', auth);
```

If `auth` is still null after successful init, this is a Firebase SDK bug. Try:
```bash
cd frontend
npm install firebase@latest
npm run dev
```

## Step 4: Check DevTools Network Tab

Sometimes the issue is environment variables not being sent by the dev server.

**Check:**
1. Open DevTools → Network tab
2. Reload page
3. Click on the HTML file request
4. Look for headers (dev servers don't send env vars, but Vite should inject them into HTML)
5. Open DevTools → Sources → check for `.env.local` in file tree (it shouldn't be exposed, that's correct)

## Step 5: Check .env.local Format

Your `.env.local` should look EXACTLY like this:

```bash
# Frontend Firebase Web Config (from Firebase Console → Project Settings)
VITE_FIREBASE_API_KEY=AIzaSyAv1ljrTvU92I7WrbTVm7X-nIMw32Om5OA
VITE_FIREBASE_AUTH_DOMAIN=pyandroid-2afb9.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=pyandroid-2afb9
VITE_FIREBASE_STORAGE_BUCKET=pyandroid-2afb9.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=840975883850
VITE_FIREBASE_APP_ID=1:840975883850:web:5176b395d9c6ffba5950b3

# Backend API
VITE_API_URL=http://localhost:8003/api/v1
```

**Check these specific things:**
- No spaces around `=`
- Each line is a separate variable
- No quotes around values
- No trailing spaces
- CRLF line endings? (Use LF instead on Mac/Linux)

To check for line ending issues:
```bash
file frontend/.env.local
# Should show: "ASCII text" not "ASCII text, with CRLF line terminators"
```

If it says CRLF, convert to LF:
```bash
dos2unix frontend/.env.local
# or if dos2unix not available:
sed -i 's/\r$//' frontend/.env.local
```

## Step 6: Verify Same Config Works Elsewhere

Test with the working project:
```bash
cd ../scan_app
npm run dev
# Open console, should show Firebase initialized
```

If that works but scan_app_docker doesn't, the issue is:
1. Different `.env.local` content → copy from working project
2. Different vite.config.ts → check if they're the same
3. Different node_modules → try `npm install` in scan_app_docker/frontend

## Quick Checklist

- [ ] `ls -la frontend/.env.local` shows file exists
- [ ] `cat frontend/.env.local` shows all VITE_FIREBASE_* variables
- [ ] Dev server restarted after .env.local created
- [ ] Browser console shows ✅ Firebase App initialized (not ❌ failed)
- [ ] `window.debugFirebase()` shows all values loaded (not "NOT FOUND")
- [ ] All projectId, authDomain match your Firebase project
- [ ] No trailing spaces or CRLF line endings in .env.local
