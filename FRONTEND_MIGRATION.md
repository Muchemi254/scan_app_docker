# Frontend Migration Guide

This document explains how the React frontend transitions from calling Firebase directly to using the FastAPI backend API.

## 📊 Architecture Shift

### Before (Direct Firebase)
```
React Frontend
  ├─ Firebase Auth (getIdToken())
  ├─ Firestore (addDoc, getDocs, etc.)
  ├─ Storage (uploadBytes)
  └─ Gemini (called from browser - API key exposed)
```

**Problems:**
- Firebase credentials in frontend
- Gemini API key exposed to browser
- Complex Firebase SDK integration
- Harder to migrate databases

### After (Backend API)
```
React Frontend
  ├─ Firebase Auth (getIdToken())
  └─ FastAPI Backend
      ├─ Validates Firebase token
      ├─ Calls Firestore
      ├─ Calls Storage
      └─ Calls Gemini (secure)
```

**Benefits:**
- ✅ Secrets never exposed
- ✅ Easier to migrate
- ✅ Cleaner separation of concerns
- ✅ Better error handling
- ✅ Multi-tenant access control

---

## 🔄 Required Frontend Changes

### 1. Create API Service Layer

**New file**: `src/services/api.ts`

```typescript
/**
 * API service for backend communication
 * 
 * Replaces direct Firebase calls with REST API calls
 */

import { auth } from './firebase';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api/v1';

/**
 * Get authorization header with Firebase token
 */
async function getAuthHeader(): Promise<string> {
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error('No authentication token');
    return `Bearer ${token}`;
  } catch (error) {
    console.error('Failed to get auth token:', error);
    throw new Error('Authentication failed');
  }
}

/**
 * Make API request with authentication
 */
async function apiRequest<T>(
  method: string,
  endpoint: string,
  data?: any,
  file?: File
): Promise<T> {
  const authorization = await getAuthHeader();
  const userId = auth.currentUser?.uid;

  if (!userId) throw new Error('User not authenticated');

  const url = `${API_BASE_URL}/users/${userId}${endpoint}`;

  const options: RequestInit = {
    method,
    headers: {
      'Authorization': authorization,
    },
  };

  // Handle form data (for file uploads)
  if (file) {
    const formData = new FormData();
    formData.append('file', file);
    if (data) {
      Object.entries(data).forEach(([key, value]) => {
        formData.append(key, JSON.stringify(value));
      });
    }
    options.body = formData;
    // Don't set Content-Type for FormData
  } else if (data) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(data);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || `API error: ${response.status}`);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as any;
  }

  return response.json();
}

// ============================================================================
// Receipt API
// ============================================================================

export const receiptApi = {
  /**
   * Extract receipt data from image
   */
  async extract(file: File): Promise<any> {
    const authorization = await getAuthHeader();
    const userId = auth.currentUser?.uid;

    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(
      `${API_BASE_URL}/users/${userId}/receipts/extract`,
      {
        method: 'POST',
        headers: { 'Authorization': authorization },
        body: formData,
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Extraction failed');
    }

    return response.json();
  },

  /**
   * Create receipt
   */
  async create(receipt: any, file?: File): Promise<any> {
    if (file) {
      // With file upload
      const formData = new FormData();
      Object.entries(receipt).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
          formData.append(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
      });
      formData.append('file', file);

      return apiRequest('POST', '/receipts', undefined, file);
    } else {
      // JSON only
      return apiRequest('POST', '/receipts', receipt);
    }
  },

  /**
   * List receipts with pagination
   */
  async list(skip = 0, limit = 50, filters?: any): Promise<any> {
    const params = new URLSearchParams({
      skip: skip.toString(),
      limit: limit.toString(),
    });

    if (filters?.status) params.append('status', filters.status);
    if (filters?.category) params.append('category', filters.category);

    return apiRequest('GET', `/receipts?${params.toString()}`);
  },

  /**
   * Get single receipt
   */
  async get(receiptId: string): Promise<any> {
    return apiRequest('GET', `/receipts/${receiptId}`);
  },

  /**
   * Update receipt
   */
  async update(receiptId: string, updates: any, file?: File): Promise<any> {
    const authorization = await getAuthHeader();
    const userId = auth.currentUser?.uid;

    const url = `${API_BASE_URL}/users/${userId}/receipts/${receiptId}`;

    const options: RequestInit = {
      method: 'PUT',
      headers: { 'Authorization': authorization },
    };

    if (file) {
      const formData = new FormData();
      Object.entries(updates).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
          formData.append(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
      });
      formData.append('file', file);
      options.body = formData;
    } else {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(updates);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Update failed');
    }

    return response.json();
  },

  /**
   * Delete receipt
   */
  async delete(receiptId: string): Promise<void> {
    return apiRequest('DELETE', `/receipts/${receiptId}`);
  },

  /**
   * Search receipts
   */
  async search(filters?: any): Promise<any> {
    const params = new URLSearchParams();

    if (filters?.supplier) params.append('supplier', filters.supplier);
    if (filters?.category) params.append('category', filters.category);
    if (filters?.date_from) params.append('date_from', filters.date_from);
    if (filters?.date_to) params.append('date_to', filters.date_to);

    return apiRequest('POST', `/receipts/search?${params.toString()}`);
  },

  /**
   * Generate spending summary
   */
  async generateSummary(filters?: any): Promise<any> {
    const params = new URLSearchParams();

    if (filters?.status) params.append('status', filters.status);
    if (filters?.category) params.append('category', filters.category);

    return apiRequest('POST', `/receipts/summary?${params.toString()}`);
  },
};
```

---

### 2. Update Gemini Service

**File**: `src/services/gemini.tsx`

**Before**:
```typescript
export const extractReceiptData = async (base64Image: string, mimeType: string) => {
  // Called Gemini directly from frontend
  // API key exposed in client code
}
```

**After**:
```typescript
/**
 * Gemini functions now moved to backend
 * Frontend calls /receipts/extract endpoint instead
 */

// Remove direct Gemini calls
// Use receiptApi.extract() from api.ts instead
```

---

### 3. Update Receipt Components

#### ScannerPage.tsx

**Before**:
```typescript
const extractedData = await extractReceiptData(base64Image, image.type);
const imageUrl = await uploadImageToStorage(userId, image);
const saved = await saveReceipt(userId, extractedData);
```

**After**:
```typescript
// Step 1: Extract (backend does this now)
const extracted = await receiptApi.extract(image);

// Step 2: Create (including image upload)
const saved = await receiptApi.create(extracted, image);
```

**Changes needed**:
```typescript
import { receiptApi } from '../services/api';

// In processImages function:
try {
  // Extract from image via backend
  const extracted = await receiptApi.extract(image);
  
  // Review/edit in UI
  // Then create with confirmed data + image
  const created = await receiptApi.create(extracted, image);
  
  // Update local state
  setReceipts([...receipts, created]);
} catch (error) {
  console.error('Failed to process image:', error);
}
```

#### DashboardPage.tsx

**Before**:
```typescript
const ref = collection(db, `users/${userId}/receipts`);
const unsubscribe = onSnapshot(ref, snapshot => {
  const all = snapshot.docs.map(doc => doc.data());
  // Calculate stats
});
```

**After**:
```typescript
// Option 1: Use REST API with polling (if not needing real-time)
useEffect(() => {
  const fetchReceipts = async () => {
    try {
      const data = await receiptApi.list(0, 1000);
      const all = data.items;
      // Calculate stats
      setTotalCount(all.length);
      // ... rest of calculations
    } catch (error) {
      console.error('Failed to fetch receipts:', error);
    }
  };

  fetchReceipts();
  const interval = setInterval(fetchReceipts, 30000); // Poll every 30s
  return () => clearInterval(interval);
}, [userId]);

// Option 2: Keep Firebase listener for real-time (during transition)
// Once fully migrated, switch to above polling approach
```

#### ReviewPage.tsx

**Before**:
```typescript
const q = query(
  collection(db, `users/${userId}/receipts`),
  where('status', '==', 'needs_review')
);

const unsubscribe = onSnapshot(q, (snapshot) => {
  const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
});
```

**After**:
```typescript
useEffect(() => {
  const fetchReceipts = async () => {
    try {
      const data = await receiptApi.list(0, 1000, { status: 'needs_review' });
      setReceipts(data.items);
    } catch (error) {
      console.error('Failed to fetch receipts:', error);
    }
  };

  fetchReceipts();
}, [userId]);
```

#### ReviewPanel.tsx

**Before**:
```typescript
await updateDoc(doc(db, `users/${userId}/receipts`, receipt.id), updates);
await deleteDoc(doc(db, `users/${userId}/receipts`, receipt.id));
```

**After**:
```typescript
// Update
await receiptApi.update(receipt.id, updates);

// Delete
await receiptApi.delete(receipt.id);
```

#### ExportPage.tsx

**Before**:
```typescript
const snapshot = await getDocs(collection(db, `users/${userId}/receipts`));
const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
const result = await generateSummary(data);
```

**After**:
```typescript
// Fetch receipts
const data = await receiptApi.list(0, 1000);

// Generate summary
const result = await receiptApi.generateSummary();
```

---

### 4. Update Environment Variables

**File**: `.env.local` or `frontend/.env.local`

```env
# Backend API URL (change for production)
VITE_API_URL=http://localhost:8000/api/v1

# Firebase (still needed for auth only)
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...

# Gemini (NO LONGER needed in frontend)
# Remove VITE_GEMINI_API_KEY
```

---

### 5. Error Handling Updates

**Before**:
```typescript
try {
  // Firebase errors
} catch (error: FirebaseError) {
  setError(error.message);
}
```

**After**:
```typescript
try {
  // API errors
} catch (error) {
  const message = error instanceof Error 
    ? error.message 
    : 'Unknown error occurred';
  setError(message);
}
```

---

## 🔄 Transition Strategy

### Option A: Gradual Migration (Recommended)

1. **Keep Firebase listeners running** initially
2. **Add new API calls** alongside Firebase calls
3. **Test thoroughly** with both
4. **Gradually remove Firebase calls** page by page
5. **Remove Firebase dependencies** after full transition

### Option B: Full Cutover

1. **Stop using Firebase** entirely
2. **Switch all pages** to API calls at once
3. **Quick testing** before deploying

**Recommended**: Option A for safer migration

---

## 📋 Checklist

Frontend changes needed:

- [ ] Create `services/api.ts` with `receiptApi` module
- [ ] Update `ScannerPage.tsx` to use `receiptApi.extract()` and `receiptApi.create()`
- [ ] Update `DashboardPage.tsx` to use `receiptApi.list()` with polling
- [ ] Update `ReviewPage.tsx` to use `receiptApi.list()` with status filter
- [ ] Update `ReviewPanel.tsx` to use `receiptApi.update()` and `receiptApi.delete()`
- [ ] Update `ReceiptDetailsPage.tsx` to use API calls
- [ ] Update `ViewScansPage.tsx` to use API calls
- [ ] Update `ExportPage.tsx` to use API calls and `receiptApi.generateSummary()`
- [ ] Update `PostReceiptPage.tsx` to use `receiptApi.create()`
- [ ] Remove `extractReceiptData()` and `generateSummary()` from `services/gemini.tsx`
- [ ] Remove `uploadImageToStorage()` calls
- [ ] Remove `saveReceipt()` calls
- [ ] Update `.env.local` with `VITE_API_URL`
- [ ] Remove `VITE_GEMINI_API_KEY` from environment
- [ ] Test all pages thoroughly
- [ ] Remove Firebase dependencies from `package.json` (later)

---

## 🧪 Testing Changes

### Manual Testing

1. **Scan receipt**:
   - Upload image
   - Verify data extraction
   - Edit and save

2. **List receipts**:
   - Navigate to /receipts
   - Check pagination
   - Verify all receipts load

3. **Review page**:
   - Navigate to /review
   - Edit receipt
   - Mark as processed

4. **Dashboard**:
   - Check statistics
   - Verify charts update
   - Check filtering

5. **Export**:
   - Generate summary
   - Export to Excel/PDF

6. **Search**:
   - Filter by category
   - Filter by supplier
   - Filter by date range

### Console Testing

```javascript
// In browser console, test API calls
await fetch('http://localhost:8000/health')
  .then(r => r.json())
  .then(console.log)

// Test with token
const token = await firebase.auth().currentUser.getIdToken();
await fetch('http://localhost:8000/api/v1/users/uid/receipts', {
  headers: { 'Authorization': `Bearer ${token}` }
})
  .then(r => r.json())
  .then(console.log)
```

---

## 🔧 Troubleshooting

### API returns 401 Unauthorized
- **Check**: Firebase token is valid
- **Check**: Token hasn't expired
- **Check**: `Authorization` header is correct format: `Bearer <token>`

### CORS errors
- **Check**: `BACKEND_CORS_ORIGINS` in backend includes frontend URL
- **Check**: Request has correct `Content-Type` header
- **Check**: Backend is running and accessible

### 404 Not Found
- **Check**: Receipt ID is correct
- **Check**: User ID in URL matches authenticated user
- **Check**: Receipt belongs to this user

### Image upload fails
- **Check**: File size < 50MB (Nginx limit)
- **Check**: File type is JPEG, PNG, WEBP, or HEIC
- **Check**: Nginx buffer settings in docker-compose

---

## 📚 References

- **API Documentation**: See `API.md`
- **Backend Code**: `backend/app/api/receipts.py`
- **Example Implementation**: Check `EXAMPLES.md` (coming soon)

---

## ⚠️ Breaking Changes

When fully migrated:

| Change | Before | After |
|--------|--------|-------|
| Gemini API Key | Frontend (`VITE_GEMINI_API_KEY`) | Backend only |
| Firebase Calls | Direct SDK | REST API |
| Image Upload | Firebase Storage | Backend uploads to Storage |
| Real-time Updates | Firestore listeners | Polling or WebSocket (future) |
| Error Messages | Firebase errors | API error responses |

---

## 🚀 Next Steps

1. **Build API service layer** (api.ts)
2. **Update one page** (e.g., ScannerPage)
3. **Test thoroughly** before moving to next
4. **Document any issues** found
5. **Remove Firebase calls** gradually
6. **Deploy to production** after full migration

Once all pages migrated:

1. **Consider removing Firebase SDK** from frontend
2. **Use only auth token** from Firebase
3. **Switch to pure REST API** client
4. **Plan PostgreSQL migration** on backend

---

**Questions?** Check `API.md` for endpoint documentation or `README.md` for backend setup.
