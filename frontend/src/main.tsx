try {
  const raw = localStorage.getItem('scan-app-task-store');
  if (raw) {
    const p = JSON.parse(raw);
    const s: any = p?.state ?? p;
    if (!s || (s.startTime !== null && typeof s.startTime !== 'number')) localStorage.removeItem('scan-app-task-store');
  }
} catch { try { localStorage.removeItem('scan-app-task-store'); } catch {} }
try {
  const raw2 = localStorage.getItem('scan-app-task-store');
  if (raw2 && raw2.length > 50000) localStorage.removeItem('scan-app-task-store');
} catch {}

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
