# Error Handling & API Configuration

This document explains how the Scan App handles API errors and configuration issues gracefully.

## Overview

The application is designed to:
- ✅ **Keep the UI visible** even when API keys are missing or invalid
- ✅ **Log detailed errors** internally for debugging
- ✅ **Show user-friendly messages** instead of technical error details
- ✅ **Never hard-code API keys** - all keys come from environment variables
- ✅ **Fail gracefully** instead of showing white screens

## Environment Configuration

### Required Environment Variables

Create a `.env.local` file in the frontend directory with the following variables:

```bash
# Firebase Configuration (required for authentication)
VITE_FIREBASE_API_KEY=your_firebase_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id

# Google Gemini API (required for AI receipt scanning)
VITE_GEMINI_API_KEY=your_gemini_api_key

# Backend API URL (optional, defaults to http://localhost:8000/api/v1)
VITE_API_URL=http://localhost:8000/api/v1
```

See `.env.example` for a template.

### Getting API Keys

#### Gemini API Key
1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click "Get API Key"
3. Copy the API key and paste it in `.env.local` as `VITE_GEMINI_API_KEY`

#### Firebase Configuration
1. Create a Firebase project at [Firebase Console](https://console.firebase.google.com)
2. Get your credentials from Project Settings
3. Add them to `.env.local` with the `VITE_FIREBASE_*` prefixes

## How Errors Are Handled

### API Configuration Validation

The `ApiConfigContext` validates all required API configurations during app initialization:

```typescript
// Components can check configuration status
const { config, isLoading, retryValidation } = useApiConfig();

if (!config?.gemini) {
  // Show degraded UI or configuration error
}
```

### Error Handling Architecture

1. **API Services** (`services/gemini.tsx`, `services/api.ts`)
   - Make API calls with proper error handling
   - Throw errors with descriptive messages (logged internally)
   - Return user-friendly error messages to components

2. **Error Handler** (`services/apiErrorHandler.ts`)
   - Categorizes errors (missing_key, invalid_key, network_error, etc.)
   - Logs detailed technical information to console/backend
   - Provides abstracted user messages

3. **Components**
   - Catch errors from API services
   - Display user-friendly messages with `ConfigurationError` component
   - Never expose technical details to end users

4. **Error Boundary** (`components/ErrorBoundary.tsx`)
   - Catches uncaught errors in React components
   - Shows appropriate error message based on error type
   - Provides recovery options (reload, go home)

### Example Error Flow

**Scenario: Missing Gemini API Key**

1. **App Initialization**
   ```
   ApiConfigProvider validates VITE_GEMINI_API_KEY
   → Key is empty/missing
   → Sets config.gemini = false
   ```

2. **Component Renders**
   ```
   ScannerPage checks apiConfig.gemini
   → Shows ConfigurationError
   → UI stays visible and functional
   ```

3. **User Attempts Action**
   ```
   User tries to scan a receipt
   → API call throws "Missing Gemini API key" error
   → handleApiError() catches it
   → Logs: "[API Config Error] extractReceiptData: Missing Gemini API key - VITE_GEMINI_API_KEY not configured"
   → Returns user message: "AI receipt scanning is currently unavailable..."
   → Component displays: ConfigurationError banner
   ```

## Development vs Production

### Development Mode
- Error boundary shows detailed error stack traces
- Console logs include full technical details
- Development-only details are collapsible in error boundaries

### Production Mode
- Error messages are abstracted and user-friendly
- Technical details are logged only to browser console (for support teams)
- No sensitive information is displayed

## Testing Error Handling

### Test Missing API Key
```bash
# Remove VITE_GEMINI_API_KEY from .env.local
# Reload the app
# You should see ConfigurationError banner, not white screen
```

### Test Invalid API Key
```bash
# Set VITE_GEMINI_API_KEY=invalid_key
# Try to scan a receipt
# You should see user-friendly error message, not white screen
```

### Test Network Error
```bash
# Open DevTools → Network tab
# Simulate "Offline" mode
# Try to use any API feature
# Should show graceful network error message
```

## Adding New API Services

When adding new API integrations:

1. **Create validation function**
   ```typescript
   // In services/apiConfig.ts
   export const validateApiConfig = (): ApiConfigStatus => {
     // Check your new API key
     const newKey = import.meta.env.VITE_NEW_API_KEY;
     status.newApi = !!newKey?.trim();
   };
   ```

2. **Update API service**
   ```typescript
   // In services/newApi.ts
   import { handleApiError, getUserMessage } from './apiErrorHandler';
   
   export const callNewApi = async () => {
     if (!apiKey) {
       const error = new Error('Missing New API key...');
       const apiError = handleApiError(error, 'callNewApi');
       throw new Error(getUserMessage(apiError));
     }
     // ... make API call
   };
   ```

3. **Display configuration status in components**
   ```typescript
   // In your page/component
   const { config } = useApiConfig();
   
   if (!config?.newApi) {
     return <ConfigurationError errorMessage="New API is unavailable..." />;
   }
   ```

## Logging & Debugging

### Console Logs
- **Info logs**: `✓ Gemini API key configured`
- **Warning logs**: `✗ Gemini API key missing`
- **Error logs**: `[API Config Error] Context: Full error details`

### Monitoring
All detailed errors are logged with:
- Error type and message
- Stack trace
- Context (which function/operation)
- Timestamp
- User ID (if available)

### For Support Teams
If users report issues:
1. Ask them to check browser console (F12)
2. Look for logs starting with `[API Config Error]`
3. These logs contain all technical details needed for debugging
4. User-facing messages are intentionally generic to avoid confusion

## Best Practices

✅ **Do:**
- Check API configuration before rendering dependent components
- Use `handleApiError()` for consistent error handling
- Show `ConfigurationError` when APIs are unavailable
- Log detailed errors to console for debugging
- Keep UI visible even with degraded functionality

❌ **Don't:**
- Hard-code API keys anywhere
- Show raw error messages to users
- Let missing configs crash the entire app
- Hide errors silently without logging
- Display sensitive information (keys, tokens) in UI

## Support & Troubleshooting

### "White Screen" Issues
- Check browser console (F12 → Console tab)
- Look for error messages
- Verify `.env.local` has all required variables
- Check `.env.example` for correct variable names

### API Not Responding
- Verify backend is running (`http://localhost:8000`)
- Check network tab in DevTools for request/response
- Look for error details in browser console

### Authentication Failed
- Verify Firebase credentials in `.env.local`
- Check Firebase console for project configuration
- Ensure Firebase rules allow your operations

### AI Scanning Not Working
- Verify `VITE_GEMINI_API_KEY` is set in `.env.local`
- Get a new key from [Google AI Studio](https://aistudio.google.com/apikey)
- Check Gemini API quotas in Google Cloud console
