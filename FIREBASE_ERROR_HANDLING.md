# Firebase Error Handling & Recovery Guide

## Problem

When Firebase initialization fails (e.g., invalid API key), the entire frontend application crashes with an uncaught error preventing users from accessing the app.

```
FirebaseError: Firebase: Error (auth/invalid-api-key)
  at hx (index-B1DAEMt-.js:25:24522)
  ...
```

## Solution Architecture

The application now includes comprehensive error handling at multiple levels:

### 1. Error Boundary Component
**File**: `frontend/src/components/ErrorBoundary.tsx`

- Catches any React errors (including Firebase initialization)
- Displays user-friendly error messages
- Differentiates between Firebase auth errors and other errors
- Shows development details in dev mode only
- Provides recovery options (Go Home, Refresh Page)

```tsx
<ErrorBoundary>
  <App />
</ErrorBoundary>
```

### 2. Safe Firebase Initialization
**File**: `frontend/src/services/firebaseInit.ts`

- Wraps Firebase initialization in try-catch
- Validates configuration before initializing
- Logs detailed errors without crashing
- Returns null instead of throwing on failure
- Provides fallback to REST API-only mode

```typescript
const isReady = await firebaseManager.initialize(config);
if (!isReady) {
  console.error('Firebase unavailable, using REST API only');
  // App continues without auth
}
```

### 3. Multi-Layer Error Detection

#### Level 1: React Query
- Automatic retry on network errors
- Timeout handling
- Error state in components

#### Level 2: Error Boundary
- Catches unhandled React errors
- Displays graceful fallback UI
- Logs errors for monitoring

#### Level 3: API Service
- Try-catch in all API calls
- Detailed error messages
- Network retry logic

```typescript
try {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
} catch (error) {
  console.error('API request failed:', error);
  throw error; // Let Error Boundary catch
}
```

## Error Types & Handling

### Firebase Authentication Errors

| Error | Cause | Recovery |
|-------|-------|----------|
| `auth/invalid-api-key` | Bad/missing API key in .env | Fix .env, refresh |
| `auth/invalid-domain` | Incorrect Firebase domain | Update console.firebase.google.com |
| `auth/network-error` | Network/CORS issues | Check internet, backend CORS |
| `auth/popup-blocked` | Browser blocked auth popup | Allow popups, retry |

**User-Facing Message:**
```
"Authentication Error: Unable to connect to authentication service. 
This could be due to an invalid API key or network issues. 
Please check your configuration and try refreshing the page."
```

### Network Errors

| Error | Cause | Recovery |
|-------|-------|----------|
| `CORS error` | Frontend/backend origin mismatch | Check backend CORS settings |
| `Timeout` | Backend slow/unresponsive | Check backend logs, retry |
| `Connection refused` | Backend not running | Start backend container |
| `DNS resolution failed` | Network/DNS issue | Check internet, clear DNS cache |

**User-Facing Message:**
```
"Connection Error: Unable to reach the server. 
Please check your internet connection and try again."
```

### Application Errors

**All other runtime errors are caught by Error Boundary and shown with:**
```
"Something went wrong. Please try refreshing the page."
```

## Implementation Checklist

- [x] Error Boundary component created
- [x] Safe Firebase initialization module
- [x] Error logging to console
- [x] User-friendly error messages
- [x] Development error details visible
- [x] Recovery options (refresh, home)
- [x] Backend error logging ready
- [x] No app crash on Firebase failure
- [x] Graceful fallback to REST API
- [x] Task context wrapping

## Testing Error Handling

### Test 1: Invalid Firebase API Key
```bash
# In .env, set invalid key
VITE_FIREBASE_API_KEY=invalid_key_123

# Expected:
1. Error Boundary catches error
2. Shows "Authentication Error" message
3. Offers "Go Home" and "Refresh" buttons
4. Console shows detailed error
5. App doesn't crash
```

### Test 2: Backend Connection Error
```bash
# Stop backend
docker compose down backend

# Expected:
1. API calls fail with connection error
2. React Query shows error state
3. Error Boundary catches if unhandled
4. User sees meaningful error
5. Can retry after restarting backend
```

### Test 3: Network Error Recovery
```bash
# Disable network in DevTools
# Try to load app

# Expected:
1. Network errors caught
2. Fallback UI shown
3. Errors logged
4. Can recover by enabling network
```

### Test 4: Development Error Details
```bash
# Trigger error in development mode
# Check error boundary

# Expected:
1. Error details visible in dev mode
2. Component stack shown
3. Full error message displayed
4. Hidden in production mode
```

## Configuration

### Firebase Setup
```bash
# In .env file, must have valid credentials:
VITE_FIREBASE_API_KEY=AIzaSy...
VITE_FIREBASE_AUTH_DOMAIN=project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=project-id
VITE_FIREBASE_STORAGE_BUCKET=project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=1:...

# Get these from Firebase Console:
# https://console.firebase.google.com
# → Project Settings → General
```

### Backend CORS Configuration
```python
# In app/main.py
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://localhost"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

### Environment Variables
```bash
# Frontend (.env in root)
VITE_API_URL=http://localhost:8003/api/v1
VITE_FIREBASE_API_KEY=your_api_key
# ... other Firebase config

# Backend (.env)
FIREBASE_PROJECT_ID=your_project
FIREBASE_PRIVATE_KEY=your_private_key
# ... other Firebase config
```

## Error Logging

### Frontend Logging
Currently logs to browser console:
```typescript
console.error('Error caught by boundary:', error);
console.error('Error info:', errorInfo);
```

### Optional: Backend Logging
Ready for implementation (uncommented in ErrorBoundary):
```typescript
await fetch('/api/v1/logs/errors', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: error.message,
    stack: error.stack,
    componentStack: errorInfo.componentStack,
    timestamp: new Date().toISOString()
  })
});
```

## Production Deployment

### Before Deploying:

- [ ] Validate all .env values exist
- [ ] Test with invalid Firebase key → should show error, not crash
- [ ] Verify backend CORS allows frontend origin
- [ ] Check backend is accessible from frontend
- [ ] Test network error recovery
- [ ] Verify error logging is configured
- [ ] Hide development error details in production
- [ ] Set up error monitoring/alerting
- [ ] Test with real user credentials
- [ ] Document troubleshooting for support

### Production Monitoring:

```typescript
// Recommended: Send errors to monitoring service
if (process.env.NODE_ENV === 'production') {
  // Send to Sentry, LogRocket, etc.
  logError(error, errorInfo);
}
```

## Troubleshooting Guide

### Issue: "Firebase: Error (auth/invalid-api-key)"
**Cause**: Invalid or missing Firebase API key
**Solution**:
1. Open Firebase Console
2. Go to Project Settings → General
3. Copy correct API key
4. Update .env file
5. Restart development server
6. Refresh browser

### Issue: CORS error when calling backend
**Cause**: Backend CORS not configured
**Solution**:
1. Check backend CORS settings in main.py
2. Verify frontend origin is allowed
3. For development: `allow_origins=["*"]`
4. For production: Specific origins
5. Restart backend
6. Clear browser cache

### Issue: "Connection refused" to backend
**Cause**: Backend not running or wrong URL
**Solution**:
1. Verify backend container is running: `docker compose ps`
2. Check VITE_API_URL in .env
3. Default should be `http://localhost:8003/api/v1`
4. Test: `curl http://localhost:8003/health`
5. Restart if needed: `docker compose restart backend`

### Issue: Blank page after Firebase error
**Cause**: Error Boundary not working
**Solution**:
1. Check browser console for errors
2. Verify ErrorBoundary wraps App in index.tsx
3. Check React 16+ is installed
4. Clear browser cache
5. Hard refresh: Ctrl+Shift+R

### Issue: Errors not logging to backend
**Cause**: Error logging endpoint not implemented
**Solution**:
1. Uncomment logging code in ErrorBoundary
2. Implement `/api/v1/logs/errors` endpoint
3. Or use external service (Sentry, etc.)
4. Test by triggering error

## Best Practices

1. **Always wrap app in ErrorBoundary**
   ```tsx
   <ErrorBoundary>
     <App />
   </ErrorBoundary>
   ```

2. **Use safe Firebase methods**
   ```typescript
   const user = getSafeCurrentUser();
   const token = await getSafeAuthToken();
   ```

3. **Handle errors in API calls**
   ```typescript
   try {
     const data = await receiptApi.list();
   } catch (error) {
     // ErrorBoundary or React Query will catch
     // or show error state in component
   }
   ```

4. **Provide recovery options**
   - Refresh button
   - Go Home link
   - Clear local data option

5. **Log errors for debugging**
   - Always log error details
   - Include context info
   - Send to monitoring service

6. **Test error scenarios**
   - Invalid credentials
   - Network failures
   - Backend unavailable
   - CORS issues

## Additional Resources

- **Firebase Console**: https://console.firebase.google.com
- **Error Boundary Code**: `frontend/src/components/ErrorBoundary.tsx`
- **Firebase Init**: `frontend/src/services/firebaseInit.ts`
- **App.tsx**: See ErrorBoundary wrapping App

---

**Last Updated**: 2026-04-14
**Status**: ✅ Complete
