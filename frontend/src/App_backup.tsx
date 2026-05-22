import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { initAuth, initializeFirebase } from './services/firebase';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';

const TestApp = () => {
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const init = async () => {
      try {
        console.log('Starting app initialization...');
        
        try {
          initializeFirebase();
          console.log('Firebase initialized');
        } catch (e) {
          console.log('Firebase init failed (this is ok):', e);
        }

        unsubscribe = initAuth((uid) => {
          console.log('Auth state changed, uid:', uid);
          setUserId(uid);
          setLoading(false);
        });
      } catch (err) {
        console.error('Init error:', err);
        setError(String(err));
        setLoading(false);
      }
    };

    init();
    return () => unsubscribe?.();
  }, []);

  return (
    <BrowserRouter>
      <div style={{ padding: '20px', fontFamily: 'Arial' }}>
        <p>Status: {loading ? 'Loading...' : 'Ready'}</p>
        {error && <p style={{ color: 'red' }}>Error: {error}</p>}
        <p>User ID: {userId || 'Not logged in'}</p>
        
        <Routes>
          <Route
            path="/"
            element={userId ? <Navigate to="/dashboard" replace /> : <LandingPage />}
          />
          <Route
            path="/login"
            element={userId ? <Navigate to="/dashboard" replace /> : <LoginPage />}
          />
          <Route path="/dashboard" element={<div>Dashboard</div>} />
        </Routes>
      </div>
    </BrowserRouter>
  );
};

export default TestApp;
