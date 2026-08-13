import { useEffect, useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { initAuth, initError as firebaseInitError } from './services/firebase';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TaskProvider } from './contexts/TaskContext';
import { ApiConfigProvider } from './contexts/ApiConfigContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './utils/firebaseDebug'; // Load Firebase debugger
import LandingPage from './pages/LandingPage';

// Lazy load pages to avoid circular dependency initialization issues
const ScannerPage = lazy(() => import('./pages/ScannerPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ReceiptDetailsPage = lazy(() => import('./pages/ReceiptDetailsPage'));
const ReviewPage = lazy(() => import('./pages/ReviewPage'));
const ExportPage = lazy(() => import('./pages/ExportPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const SignupPage = lazy(() => import('./pages/SignupPage'));
const ViewScansPage = lazy(() => import('./pages/ViewScansPage'));
const GalleryPage = lazy(() => import('./pages/GalleryPage'));
const DataCleaningPage = lazy(() => import('./pages/DataCleaningPage'));
const ReviewBatchListPage = lazy(() => import('./pages/ReviewBatchListPage'));
const ReviewBatchDetailPage = lazy(() => import('./pages/ReviewBatchDetailPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const PostReceiptPage = lazy(() => import('./pages/PostReceiptPage'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'));

import Layout from './components/Layout';
import { ScannerProvider } from './contexts/ScannerContext';
import { ToastContainer } from './components/ToastContainer';
import PrivateRoute from './contexts/PrivateRoute';

// Loading fallback for Suspense
const PageLoader = () => (
  <div className="min-h-screen flex items-center justify-center bg-gray-50">
    <div className="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent" />
  </div>
);

// React Query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 10, // 10 minutes
      retry: 1,
    },
  },
});

/**
 * Firebase Error Banner - Small non-blocking notification
 */
const FirebaseErrorBanner = ({ error, onDismiss }: { error: Error | null; onDismiss: () => void }) => {
  if (!error) return null;

  return (
    <div className="fixed top-0 left-0 right-0 bg-amber-50 border-b border-amber-200 px-4 py-3 shadow-sm z-50">
      <div className="max-w-6xl mx-auto flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 flex-1">
          <svg className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <div className="flex-1">
            <p className="text-sm font-medium text-amber-900">Firebase Configuration Issue</p>
            <p className="text-xs text-amber-800 mt-0.5">Some features may be unavailable. The app will continue to work for basic functions.</p>
          </div>
        </div>
        <button
          onClick={onDismiss}
          className="flex-shrink-0 text-amber-600 hover:text-amber-700 transition"
          aria-label="Dismiss"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
    </div>
  );
};

const AppContent = () => {
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [firebaseError, setFirebaseError] = useState<Error | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let isMounted = true;

    const initializeApp = async () => {
      // Check if Firebase failed to initialize at module load
      if (firebaseInitError) {
        if (isMounted) {
          console.warn('Firebase initialization failed, continuing with REST API:', firebaseInitError);
          setFirebaseError(firebaseInitError);
        }
      }

      try {
        // Initialize auth listener (Firebase already initialized at module load)
        unsubscribe = initAuth((uid) => {
          if (!isMounted) return;
          setUserId(uid);
          setAuthLoading(false);
        });
      } catch (err) {
        if (!isMounted) return;
        const error = err instanceof Error ? err : new Error(String(err));
        console.warn('Firebase auth failed, continuing with REST API:', error);
        setFirebaseError(error);
        setAuthLoading(false);
      }
    };

    initializeApp();

    return () => {
      isMounted = false;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ApiConfigProvider>
        <TaskProvider userId={userId}>
          <ErrorBoundary>
            <Suspense fallback={<PageLoader />}>
              {/* Firebase error banner - non-blocking, dismissible */}
              {!bannerDismissed && (
                <FirebaseErrorBanner
                  error={firebaseError}
                  onDismiss={() => setBannerDismissed(true)}
                />
              )}

              {/* Global toast notifications (top-right) */}
              <ToastContainer />

              <Routes>
              {/* Public routes */}
              <Route
                path="/"
                element={userId ? <Navigate to="/dashboard" replace /> : <LandingPage />}
              />
              <Route
                path="/login"
                element={userId ? <Navigate to="/dashboard" replace /> : <LoginPage />}
              />
              <Route
                path="/signup"
                element={userId ? <Navigate to="/dashboard" replace /> : <SignupPage />}
              />

              {/* Private routes with Layout */}
              <Route element={<Layout />}>
                {/* Dashboard */}
                <Route
                  path="/dashboard"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <DashboardPage userId={userId} />
                    </PrivateRoute>
                  }
                />

                {/* Scanner with Context */}
                <Route
                  path="/scanner"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <ScannerPage userId={userId} />
                    </PrivateRoute>
                  }
                />

                {/* Receipts List */}
                <Route
                  path="/receipts"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <ViewScansPage userId={userId} />
                    </PrivateRoute>
                  }
                />

                {/* Receipt Details */}
                <Route
                  path="/receipts/:id"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <ReceiptDetailsPage userId={userId} />
                    </PrivateRoute>
                  }
                />

                {/* Image Gallery */}
                <Route
                  path="/gallery"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <GalleryPage userId={userId} />
                    </PrivateRoute>
                  }
                />

                {/* Data Cleaning */}
                <Route
                  path="/cleaning"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <DataCleaningPage userId={userId} />
                    </PrivateRoute>
                  }
                />

                {/* Review */}
                <Route
                  path="/review"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <ReviewPage userId={userId} />
                    </PrivateRoute>
                  }
                />

                {/* Export */}
                <Route
                  path="/export"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <ExportPage userId={userId} />
                    </PrivateRoute>
                  }
                />

                {/* Post Receipt */}
                <Route
                  path="/post-receipt"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <PostReceiptPage userId={userId} />
                    </PrivateRoute>
                  }
                />

                {/* Review Batches */}
                <Route
                  path="/review-batches"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <ReviewBatchListPage userId={userId} />
                    </PrivateRoute>
                  }
                />
                <Route
                  path="/review-batches/:batchId"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <ReviewBatchDetailPage userId={userId} />
                    </PrivateRoute>
                  }
                />

                {/* Settings */}
                <Route
                  path="/settings"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <SettingsPage userId={userId} />
                    </PrivateRoute>
                  }
                />

                {/* Notifications (durable scan/error log) */}
                <Route
                  path="/notifications"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <NotificationsPage userId={userId} />
                    </PrivateRoute>
                  }
                />

                {/* 404 Fallback - mobile responsive */}
                <Route
                  path="*"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8">
                        <div className="text-center space-y-4 max-w-md">
                          <h1 className="text-5xl sm:text-6xl font-bold text-gray-300">404</h1>
                          <h2 className="text-xl sm:text-2xl font-semibold text-gray-700">Page Not Found</h2>
                          <p className="text-sm sm:text-base text-gray-500">The page you're looking for doesn't exist.</p>
                          <a
                            href="/dashboard"
                            className="inline-block w-full sm:w-auto px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors text-sm sm:text-base"
                          >
                            Go to Dashboard
                          </a>
                        </div>
                      </div>
                    </PrivateRoute>
                  }
                />
              </Route>
            </Routes>
          </Suspense>
          </ErrorBoundary>
        </TaskProvider>
      </ApiConfigProvider>
    </QueryClientProvider>
  );
};

const App = () => {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
};

export default App;