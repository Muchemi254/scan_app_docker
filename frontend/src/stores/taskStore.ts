/**
 * Zustand store for task state management.
 *
 * Manages:
 * - Current active task
 * - Task history and metadata
 * - Persistence across browser refresh
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface TaskFile {
  name: string;
  status: 'pending' | 'processing' | 'done' | 'needs_review' | 'failed';
  message?: string;
  receiptId?: string;
}

export interface TaskState {
  // Current active task
  activeTaskId: string | null;
  backendTaskId: string | null;  // Celery task ID from backend
  batchTitle: string;
  files: TaskFile[];
  isProcessing: boolean;

  // Progress tracking
  currentProgress: number; // 0-100
  currentIndex: number;
  totalFiles: number;
  elapsedTime: number; // seconds
  estimatedTimeRemaining: number; // seconds

  // Session metadata
  startTime: number | null;
  failedFiles: File[];

  // Actions
  initializeTask: (taskId: string, files: File[], batchTitle: string) => void;
  updateProgress: (index: number, total: number, percentage: number) => void;
  updateFileStatus: (index: number, status: TaskFile['status'], message?: string, receiptId?: string) => void;
  setProcessing: (processing: boolean) => void;
  setBackendTaskId: (id: string) => void;
  pauseTask: () => void;
  resumeTask: () => void;
  completeTask: () => void;
  clearTask: () => void;
  getResumeData: () => { taskId: string; currentIndex: number; files: TaskFile[] } | null;
}

export const useTaskStore = create<TaskState>()(
  persist(
    (set, get) => ({
      activeTaskId: null,
      backendTaskId: null,
      batchTitle: '',
      files: [],
      isProcessing: false,
      currentProgress: 0,
      currentIndex: 0,
      totalFiles: 0,
      elapsedTime: 0,
      estimatedTimeRemaining: 0,
      startTime: null,
      failedFiles: [],

      initializeTask: (taskId: string, files: File[], batchTitle: string) => {
        set({
          activeTaskId: taskId,
          batchTitle,
          files: files.map(f => ({
            name: f.name,
            status: 'pending',
            message: 'Waiting to process'
          })),
          totalFiles: files.length,
          currentIndex: 0,
          currentProgress: 0,
          startTime: Date.now(),
          isProcessing: true,
          failedFiles: []
        });
      },

      updateProgress: (index: number, total: number, percentage: number) => {
        const startTime = (get() as any)?.startTime ?? null;
        const elapsedSeconds = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;

        // Calculate estimated time remaining
        let estimatedTimeRemaining = 0;
        if (index > 0 && elapsedSeconds > 0) {
          const avgTimePerFile = elapsedSeconds / (index + 1);
          const remainingFiles = total - (index + 1);
          estimatedTimeRemaining = Math.ceil(avgTimePerFile * remainingFiles);
        }

        set({
          currentIndex: index,
          totalFiles: total,
          currentProgress: percentage,
          elapsedTime: elapsedSeconds,
          estimatedTimeRemaining
        });
      },

      updateFileStatus: (index: number, status: TaskFile['status'], message?: string, receiptId?: string) => {
        set(state => {
          const updatedFiles = [...state.files];
          if (updatedFiles[index]) {
            updatedFiles[index] = {
              ...updatedFiles[index],
              status,
              message,
              receiptId
            };
          }
          return { files: updatedFiles };
        });
      },

      setProcessing: (processing: boolean) => {
        set({ isProcessing: processing });
      },

      pauseTask: () => {
        set({ isProcessing: false });
      },

      resumeTask: () => {
        set({ isProcessing: true });
      },

      completeTask: () => {
        set({
          isProcessing: false,
        });
      },

      setBackendTaskId: (id: string) => {
        set({ backendTaskId: id });
      },

      clearTask: () => {
        set({
          activeTaskId: null,
          batchTitle: '',
          files: [],
          isProcessing: false,
          currentProgress: 0,
          currentIndex: 0,
          totalFiles: 0,
          elapsedTime: 0,
          estimatedTimeRemaining: 0,
          startTime: null,
          failedFiles: []
        });
      },

      getResumeData: () => {
        const state: any = get() as any;
        if (state?.activeTaskId && state?.files?.length > 0) {
          return {
            taskId: state.activeTaskId,
            currentIndex: state.currentIndex,
            files: state.files
          };
        }
        return null;
      }
    }),
    {
      name: 'scan-app-task-store', // localStorage key
      version: 2,
      migrate: (persisted: any, _version: number) => {
        try {
          if (!persisted || typeof persisted !== 'object') return persisted;
          const s: any = (persisted as any).state ?? persisted;
          if (s && s.startTime !== undefined && typeof s.startTime !== 'number' && s.startTime !== null) s.startTime = null;
          if ((persisted as any).state) (persisted as any).state.startTime = s.startTime;
          else if (persisted.startTime !== undefined) persisted.startTime = null;
        } catch {}
        return persisted as any;
      },
      onRehydrateStorage: () => (state, error) => {
        try {
          if (error || !state) { try { localStorage.removeItem('scan-app-task-store'); } catch { void 0; } return; }
          if ((state as any).startTime !== null && typeof (state as any).startTime !== 'number') (state as any).startTime = null;
        } catch {}
      },
      partialize: (state) => ({
        activeTaskId: (state as any)?.activeTaskId,
        batchTitle: (state as any)?.batchTitle,
        files: (state as any)?.files,
        currentProgress: (state as any)?.currentProgress,
        currentIndex: (state as any)?.currentIndex,
        totalFiles: (state as any)?.totalFiles,
        startTime: (state as any)?.startTime ?? null,
        elapsedTime: (state as any)?.elapsedTime,
        estimatedTimeRemaining: (state as any)?.estimatedTimeRemaining,
      })
    }
  )
);
