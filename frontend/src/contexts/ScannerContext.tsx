import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode
} from 'react';

type ScanStatus = {
  name: string;
  status: 'pending' | 'processing' | 'done' | 'needs_review' | 'failed';
  message?: string;
};

type ScannerContextType = {
  images: File[];
  logs: ScanStatus[];
  failedImages: File[];
  loading: boolean;
  error: string;
  batchTitle: string;
  setImages: (images: File[]) => void;
  setLogs: (logs: ScanStatus[]) => void;
  setFailedImages: (images: File[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string) => void;
  setBatchTitle: (title: string) => void;
  updateLog: (index: number, update: Partial<ScanStatus>) => void;
  addLog: (log: ScanStatus) => void;
  clearAll: () => void;
  isProcessing: boolean;
  hasActiveSession: boolean;
};

const ScannerContext = createContext<ScannerContextType | undefined>(undefined);

export const useScannerContext = () => {
  const context = useContext(ScannerContext);
  if (!context) {
    throw new Error('useScannerContext must be used within a ScannerProvider');
  }
  return context;
};

type ScannerProviderProps = {
  children: ReactNode;
};

const STORAGE_KEY = 'scanner-context';

type PersistedState = {
  logs: ScanStatus[];
  error: string;
  batchTitle: string;
  sessionId: string;
  lastActivity: number;
};

// Session expires after 30 minutes of inactivity
const SESSION_TIMEOUT = 30 * 60 * 1000;

export const ScannerProvider: React.FC<ScannerProviderProps> = ({ children }) => {
  const [sessionId] = useState(() => Date.now().toString());
  
  // Initialize state from localStorage with validation
  const initializeState = (): PersistedState => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return { logs: [], error: '', batchTitle: '', sessionId: '', lastActivity: 0 };
      
      const parsed = JSON.parse(saved) as PersistedState;
      const now = Date.now();
      
      // Check if session has expired
      if (now - parsed.lastActivity > SESSION_TIMEOUT) {
        localStorage.removeItem(STORAGE_KEY);
        return { logs: [], error: '', batchTitle: '', sessionId: '', lastActivity: 0 };
      }
      
      // Clean up any stale processing states
      const cleanedLogs = parsed.logs.map(log => 
        log.status === 'processing' ? { ...log, status: 'failed' as const, message: 'Session interrupted' } : log
      );
      
      return { 
        logs: cleanedLogs, 
        error: parsed.error || '', 
        batchTitle: parsed.batchTitle || '', 
        sessionId: parsed.sessionId || '', 
        lastActivity: parsed.lastActivity || 0 
      };
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      return { logs: [], error: '', batchTitle: '', sessionId: '', lastActivity: 0 };
    }
  };

  const initialState = initializeState();
  
  const [images, setImages] = useState<File[]>([]);
  const [logs, setLogs] = useState<ScanStatus[]>(initialState.logs);
  const [failedImages, setFailedImages] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialState.error);
  const [batchTitle, setBatchTitle] = useState(initialState.batchTitle);

  const updateLog = (index: number, update: Partial<ScanStatus>) => {
    setLogs(prevLogs =>
      prevLogs.map((log, i) => (i === index ? { ...log, ...update } : log))
    );
  };

  const addLog = (log: ScanStatus) => {
    setLogs(prevLogs => [...prevLogs, log]);
  };

  const clearAll = () => {
    setImages([]);
    setLogs([]);
    setFailedImages([]);
    setLoading(false);
    setError('');
    setBatchTitle('');
    localStorage.removeItem(STORAGE_KEY);
  };

  // Check if there's meaningful work in progress
  const hasActiveSession = logs.length > 0 && logs.some(log => 
    log.status === 'processing' || log.status === 'pending'
  );

  const isProcessing = loading || logs.some(log => log.status === 'processing');

  // Persist state to localStorage
  useEffect(() => {
    // Only persist if there's meaningful state to save
    if (logs.length > 0 || error || batchTitle) {
      const stateToSave: PersistedState = {
        logs,
        error,
        batchTitle,
        sessionId,
        lastActivity: Date.now()
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stateToSave));
    }
  }, [logs, error, batchTitle, sessionId]);

  // Clean up completed sessions periodically
  useEffect(() => {
    const cleanup = () => {
      if (logs.length > 0 && logs.every(log => 
        log.status === 'done' || log.status === 'needs_review' || log.status === 'failed'
      ) && !loading) {
        // Auto-clear completed sessions after 5 minutes
        const timer = setTimeout(() => {
          clearAll();
        }, 5 * 60 * 1000);
        
        return () => clearTimeout(timer);
      }
    };

    return cleanup();
  }, [logs, loading]);

  const value: ScannerContextType = {
    images,
    logs,
    failedImages,
    loading,
    error,
    batchTitle,
    setImages,
    setLogs,
    setFailedImages,
    setLoading,
    setError,
    setBatchTitle,
    updateLog,
    addLog,
    clearAll,
    isProcessing,
    hasActiveSession,
  };

  return (
    <ScannerContext.Provider value={value}>
      {children}
    </ScannerContext.Provider>
  );
};