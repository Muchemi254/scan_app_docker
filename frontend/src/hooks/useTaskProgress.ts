/**
 * Custom hook for managing task progress and persistence.
 *
 * Provides:
 * - Task initialization
 * - Progress tracking
 * - Auto-save to storage
 * - Resume functionality
 * - Real-time sync with backend
 */

import { useEffect, useCallback, useRef } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTaskStore } from '../stores/taskStore';
import { indexedDB } from '../utils/indexeddb';
import { receiptApi } from '../services/api';

interface UseTaskProgressOptions {
  onProgressUpdate?: (progress: number, index: number, total: number) => void;
  onTaskComplete?: () => void;
  onTaskError?: (error: Error) => void;
  autoSyncInterval?: number; // ms, default 5000
}

export const useTaskProgress = (options: UseTaskProgressOptions = {}) => {
  const {
    onProgressUpdate,
    onTaskComplete,
    onTaskError,
    autoSyncInterval = 5000
  } = options;

  const taskStore = useTaskStore();
  const syncIntervalRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Initialize a new task
   */
  const initializeTask = useCallback(
    (files: File[], batchTitle: string) => {
      // Generate task ID
      const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Initialize store
      taskStore.initializeTask(taskId, files, batchTitle);

      // Save to IndexedDB
      indexedDB.saveTask({
        id: taskId,
        taskId,
        userId: 'current-user', // Will be set from context
        batchTitle,
        totalItems: files.length,
        completedItems: 0,
        status: 'processing',
        startedAt: Date.now(),
        files: files.map(f => ({
          name: f.name,
          status: 'pending'
        })),
        metadata: {}
      });

      return taskId;
    },
    [taskStore]
  );

  /**
   * Update progress
   */
  const updateProgress = useCallback(
    (index: number, total: number, message?: string) => {
      const percentage = Math.round(((index + 1) / total) * 100);

      taskStore.updateProgress(index, total, percentage);

      // Save history entry
      if (taskStore.activeTaskId) {
        indexedDB.saveTaskHistoryEntry(
          taskStore.activeTaskId,
          'processing',
          percentage
        );
      }

      // Call user's callback
      onProgressUpdate?.(percentage, index, total);
    },
    [taskStore, onProgressUpdate]
  );

  /**
   * Update file status
   */
  const updateFileStatus = useCallback(
    (
      index: number,
      status: 'pending' | 'processing' | 'done' | 'needs_review' | 'failed',
      message?: string,
      receiptId?: string
    ) => {
      taskStore.updateFileStatus(index, status, message, receiptId);
    },
    [taskStore]
  );

  /**
   * Complete task
   */
  const completeTask = useCallback(async () => {
    if (taskStore.activeTaskId) {
      // Save completion to IndexedDB
      await indexedDB.saveTaskHistoryEntry(
        taskStore.activeTaskId,
        'completed',
        100
      );
    }

    taskStore.completeTask();
    onTaskComplete?.();

    // Clean up sync
    if (syncIntervalRef.current) {
      clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }
  }, [taskStore, onTaskComplete]);

  /**
   * Pause task
   */
  const pauseTask = useCallback(() => {
    taskStore.pauseTask();
  }, [taskStore]);

  /**
   * Resume task
   */
  const resumeTask = useCallback(() => {
    taskStore.resumeTask();
  }, [taskStore]);

  /**
   * Get resume data (for browser refresh)
   */
  const getResumeData = useCallback(() => {
    return taskStore.getResumeData();
  }, [taskStore]);

  /**
   * Clear task
   */
  const clearTask = useCallback(() => {
    if (syncIntervalRef.current) {
      clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }
    taskStore.clearTask();
  }, [taskStore]);

  /**
   * Sync with backend periodically
   */
  useEffect(() => {
    if (!taskStore.activeTaskId || !taskStore.isProcessing) {
      return;
    }

    syncIntervalRef.current = setInterval(() => {
      // Sync progress with backend
      // This will be implemented when backend has task tracking
    }, autoSyncInterval);

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
      }
    };
  }, [taskStore.activeTaskId, taskStore.isProcessing, autoSyncInterval]);

  return {
    // State
    activeTaskId: taskStore.activeTaskId,
    batchTitle: taskStore.batchTitle,
    files: taskStore.files,
    isProcessing: taskStore.isProcessing,
    currentProgress: taskStore.currentProgress,
    currentIndex: taskStore.currentIndex,
    totalFiles: taskStore.totalFiles,
    elapsedTime: taskStore.elapsedTime,
    estimatedTimeRemaining: taskStore.estimatedTimeRemaining,

    // Actions
    initializeTask,
    updateProgress,
    updateFileStatus,
    completeTask,
    pauseTask,
    resumeTask,
    getResumeData,
    clearTask
  };
};
