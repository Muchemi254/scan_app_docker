/**
 * Firebase Configuration Debugger
 * Run in browser console: window.debugFirebase() to check configuration
 */

export const debugFirebaseConfig = () => {
  const config = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };

  console.group('🔥 Firebase Configuration Debug');

  console.log('📋 Raw Environment Variables (from .env.local):');
  console.log({
    'VITE_FIREBASE_API_KEY': config.apiKey ? `${config.apiKey.substring(0, 15)}...` : 'NOT FOUND',
    'VITE_FIREBASE_AUTH_DOMAIN': config.authDomain || 'NOT FOUND',
    'VITE_FIREBASE_PROJECT_ID': config.projectId || 'NOT FOUND',
    'VITE_FIREBASE_STORAGE_BUCKET': config.storageBucket || 'NOT FOUND',
    'VITE_FIREBASE_MESSAGING_SENDER_ID': config.messagingSenderId || 'NOT FOUND',
    'VITE_FIREBASE_APP_ID': config.appId ? `${config.appId.substring(0, 20)}...` : 'NOT FOUND',
  });

  console.log('\n✅ Loaded Configuration:');
  console.table({
    'projectId': config.projectId || '❌ MISSING',
    'authDomain': config.authDomain || '❌ MISSING',
    'apiKey': config.apiKey ? '✅ LOADED' : '❌ MISSING',
    'appId': config.appId ? '✅ LOADED' : '❌ MISSING',
    'storageBucket': config.storageBucket || '❌ MISSING',
    'messagingSenderId': config.messagingSenderId || '❌ MISSING',
  });

  console.log('\n✅ Verification Checklist:');
  console.log(
    config.projectId
      ? `✅ Project ID matches your Firebase project: ${config.projectId}`
      : '❌ Project ID missing - check .env.local'
  );
  console.log(
    config.apiKey
      ? '✅ API Key is loaded'
      : '❌ API Key missing - check .env.local VITE_FIREBASE_API_KEY'
  );
  console.log(
    config.authDomain
      ? `✅ Auth Domain: ${config.authDomain}`
      : '❌ Auth Domain missing - check .env.local'
  );

  console.log('\n⚠️  If you see "auth/invalid-api-key" error:');
  console.log('1. Go to Firebase Console → Project Settings → API keys');
  console.log('2. Find your API key and click it to edit');
  console.log('3. Check "Application restrictions" - ensure it allows "Browser keys (HTTP and HTTPS)"');
  console.log('4. Check "API restrictions" - should allow "Cloud Firestore API" and "Cloud Storage API"');
  console.log('5. If not set to "Don\'t restrict key", change to allow all APIs');
  console.log('6. Copy the exact API key (no spaces, no truncation)');
  console.log('7. Paste into frontend/.env.local as VITE_FIREBASE_API_KEY');
  console.log('8. Restart dev server: npm run dev');

  console.log('\n📋 Full Config (for comparison with Firebase Console):');
  console.log(config);

  console.groupEnd();

  return config;
};

// Make available globally in dev
if (import.meta.env.DEV) {
  (window as any).debugFirebase = debugFirebaseConfig;
  console.log('💡 Tip: Run window.debugFirebase() in console to debug Firebase config');
}
