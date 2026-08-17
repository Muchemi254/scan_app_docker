import { useEffect, useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { useScopeStore } from './stores/scopeStore';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TaskProvider } from './contexts/TaskContext';
import { ApiConfigProvider } from './contexts/ApiConfigContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LandingPage from './pages/LandingPage';

// Lazy load pages to avoid circular dependency initialization issues
const ScannerPage = lazy(() => import('./pages/ScannerPage'));
const ScanQueuePage = lazy(() => import('./pages/ScanQueuePage'));
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
const AdminPage = lazy(() => import('./pages/AdminPage'));
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage'));
const MyApprovalsPage = lazy(() => import('./pages/MyApprovalsPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));

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
 * Session error banner - Small non-blocking notification
 */
const AppContent = () => {
  const user = useAuthStore(s => s.user);
  const status = useAuthStore(s => s.status);
  const restore = useAuthStore(s => s.restore);
  const activeScopeUid = useScopeStore(s => s.activeUid);

  useEffect(() => {
    restore();
  }, [restore]);

  // Pages operate on the active user scope: an admin who selected a different
  // user in the Layout scope selector works inside that user's workspace.
  // For normal users this is their own uid. The scope applies only while a
  // real session exists — an orphaned scope (e.g. after logout) must not
  // keep a signed-out user inside a protected page.
  const userId = user ? (activeScopeUid ?? user.uid) : null;
  const authLoading = status === 'loading';

  return (
    <QueryClientProvider client={queryClient}>
      <ApiConfigProvider>
        <TaskProvider userId={userId}>
          <ErrorBoundary>
            <Suspense fallback={<PageLoader />}>
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

                {/* Scans — held/prepared work + dispatch + progress */}
                <Route
                  path="/scans"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <ScanQueuePage userId={userId} />
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

                {/* Admin — user management (admin only, page self-guards) */}
                <Route
                  path="/admin"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <AdminPage userId={userId} />
                    </PrivateRoute>
                  }
                />

                {/* Approvals — global cross-user approval queue (admin only) */}
                <Route
                  path="/approvals"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <ApprovalsPage />
                    </PrivateRoute>
                  }
                />

                {/* My Approvals — user's own pending/approved documents */}
                <Route
                  path="/my-approvals"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <MyApprovalsPage />
                    </PrivateRoute>
                  }
                />

                {/* Reports & exports — every entity, masked by default */}
                <Route
                  path="/reports"
                  element={
                    <PrivateRoute userId={userId} authLoading={authLoading}>
                      <ReportsPage />
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