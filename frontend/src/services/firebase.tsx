// src/services/firebase.ts
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// Debug: Log config on load
console.log('🔥 Firebase Module Loading...');
console.log('📋 Config values:', {
  apiKey: firebaseConfig.apiKey ? `${firebaseConfig.apiKey.substring(0, 10)}...` : 'MISSING',
  authDomain: firebaseConfig.authDomain || 'MISSING',
  projectId: firebaseConfig.projectId || 'MISSING',
  appId: firebaseConfig.appId ? `${firebaseConfig.appId.substring(0, 10)}...` : 'MISSING',
});

// Initialize Firebase immediately
let app;
let auth;
let db;
let storage;
let initError: Error | null = null;

try {
  console.log('🚀 Initializing Firebase App...');
  app = initializeApp(firebaseConfig);
  console.log('✅ Firebase App initialized:', app.name);

  console.log('🔐 Getting Auth instance...');
  auth = getAuth(app);
  // Use localStorage instead of default IndexedDB (avoids TDZ crash in some SDK versions)
  setPersistence(auth, browserLocalPersistence).catch(e => console.warn('Auth persistence:', e));
  console.log('✅ Auth instance ready:', !!auth);

  console.log('📊 Getting Firestore instance...');
  db = getFirestore(app);
  console.log('✅ Firestore ready:', !!db);

  console.log('📦 Getting Storage instance...');
  storage = getStorage(app);
  console.log('✅ Storage ready:', !!storage);

  console.log('✨ Firebase fully initialized successfully');
} catch (error) {
  initError = error instanceof Error ? error : new Error(String(error));
  console.error('❌ Firebase initialization failed:', initError.message);
  console.error('Full error:', error);
}

export { app, auth, db, storage, initError };

export const initAuth = (callback: (userId: string | null) => void) => {
  // If Firebase failed to initialize, proceed without auth
  if (!auth) {
    console.warn('Firebase auth not available, proceeding with REST API only');
    callback(null);
    return () => {}; // Return no-op unsubscribe function
  }

  return onAuthStateChanged(auth, (user) => {
    if (user) {
      callback(user.uid);
    } else {
      callback(null);
    }
  });
};

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
