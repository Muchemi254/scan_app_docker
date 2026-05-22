# Firebase Error Handling - Complete Fix

## Issue Fixed
When Firebase initialization failed (auth/invalid-api-key), the app crashed with:
```
TypeError: Cannot read properties of undefined (reading 'onAuthStateChanged')
```

This happened because:
1. Firebase init failed → `auth` is `null`
2. `initAuth()` tried to call `onAuthStateChanged(auth, ...)` without checking if `auth` exists
3. Crash when trying to call method on `null`

## Solution Implemented

### 1. `firebase.tsx` - Added null guards

**`initAuth()` function:**
```typescript
export const initAuth = (callback: (userId: string | null) => void) => {
  // If Firebase failed to initialize, proceed without auth
  if (!auth) {
    console.warn('Firebase auth not available, proceeding with REST API only');
    callback(null);
    return () => {}; // Return no-op unsubscribe function
  }
  
  return onAuthStateChanged(auth, (user) => { ... });
};
```

**Authentication functions:**
```typescript
export const loginWithEmail = async (email: string, password: string) => {
  if (!auth) {
    throw new Error('Firebase authentication not available');
  }
  return signInWithEmailAndPassword(auth, email, password);
};

export const signupWithEmail = async (email: string, password: string) => {
  if (!auth) {
    throw new Error('Firebase authentication not available');
  }
  return createUserWithEmailAndPassword(auth, email, password);
};

export const logout = async () => {
  if (!auth) {
    throw new Error('Firebase authentication not available');
  }
  return signOut(auth);
};
```

### 2. Error Handling Flow

**When Firebase fails to initialize:**

```
Module Load
  ↓
try: initializeApp(firebaseConfig)
  ↓ (fails due to invalid key)
catch: initError = error
  ↓
App.tsx mounts
  ↓
Checks if initError exists
  ↓ (yes, it does)
Sets firebaseError state
  ↓
Renders FirebaseErrorBanner
  ↓
Calls initAuth()
  ↓
initAuth checks if auth is null
  ↓ (yes, it is)
Calls callback(null) immediately
  ↓
User not logged in
  ↓
Landing page renders
  ↓
User can see amber banner explaining Firebase config issue
```

**If user tries to log in without Firebase:**

```
User clicks "Sign In"
  ↓
LoginPage.tsx: await loginWithEmail(email, password)
  ↓ (in try block)
firebase.tsx: loginWithEmail() checks if auth is null
  ↓ (yes, it is)
Throws: "Firebase authentication not available"
  ↓ (caught by catch block)
setError(err.message)
  ↓
Error displayed to user
```

### 3. All Call Sites Already Protected

The following components call Firebase functions and have try/catch:

| File | Function | Handler |
|------|----------|---------|
| `LoginPage.tsx` | `loginWithEmail()` | ✅ try/catch + setError |
| `SignupPage.tsx` | `signupWithEmail()` | ✅ try/catch + setError |
| `Layout.tsx` | `logout()` | ✅ try/catch + console.error |

When Firebase is unavailable, errors are shown to user.

## Result

**Now with Firebase init error:**
- ✅ App renders (no white screen)
- ✅ Landing page visible
- ✅ Amber error banner shown
- ✅ User can see what's wrong
- ✅ No console crashes
- ✅ Clear error messages

**If user tries to use Firebase without init:**
- ✅ Clear error: "Firebase authentication not available"
- ✅ Error displayed in UI
- ✅ App doesn't crash
- ✅ User guided to fix config

## Testing

1. **Start dev server:**
   ```bash
   npm run dev
   ```

2. **Check console logs:**
   - Should see: "Firebase auth not available, proceeding with REST API only"
   - Should NOT see: "Cannot read properties of undefined"

3. **UI should show:**
   - ✅ Landing page (no white screen)
   - ✅ Amber banner at top with "Firebase Configuration Issue"
   - ✅ Login/signup pages accessible
   - ✅ All routes available

4. **Try to log in without Firebase:**
   - Should see: "Firebase authentication not available"
   - Error shown in login form
   - App doesn't crash

## Architecture

The app now has proper graceful degradation:

```
Firebase Available
  ↓
Full functionality (auth via Firebase, data via REST API)

Firebase Unavailable
  ↓
Partial functionality (REST API only, no auth)
  ↓
User sees banner explaining issue
  ↓
If tries to authenticate → Clear error message
```

This matches the design goal: **"user is notified silently, app continues to work"**
