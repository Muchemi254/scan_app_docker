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
        const startTime = get().startTime;
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
          activeTaskId: null,
          isProcessing: false,
          currentProgress: 100
        });
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
        const state = get();
        if (state.activeTaskId && state.files.length > 0) {
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
      version: 1,
      // Only persist certain fields
      partialize: (state) => ({
        activeTaskId: state.activeTaskId,
        batchTitle: state.batchTitle,
        files: state.files,
        currentProgress: state.currentProgress,
        currentIndex: state.currentIndex,
        totalFiles: state.totalFiles,
        startTime: state.startTime,
        elapsedTime: state.elapsedTime,
        estimatedTimeRemaining: state.estimatedTimeRemaining,
      })
    }
  )
);
