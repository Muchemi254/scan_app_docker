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
import { useTaskStore } from '../stores/taskStore';
import { indexedDB } from '../utils/indexeddb';
import { auth } from '../services/firebase';

interface UseTaskProgressOptions {
  onProgressUpdate?: (progress: number, index: number, total: number) => void;
  onTaskComplete?: () => void;
  onTaskError?: (error: Error) => void;
  autoSyncInterval?: number; // ms, default 5000
}

async function getToken(): Promise<string> {
  if (auth?.currentUser) return await auth.currentUser.getIdToken();
  return '';
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
   * Sync with backend periodically (polls Celery task endpoint)
   */
  useEffect(() => {
    const backendTaskId = taskStore.backendTaskId;
    if (!backendTaskId || !taskStore.isProcessing) {
      return;
    }

    const pollTask = async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';
        const userId = auth?.currentUser?.uid;
        if (!userId) return;

        const resp = await fetch(
          `${API_BASE}/users/${userId}/tasks/${backendTaskId}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!resp.ok) return;

        const task = await resp.json();

        // Update overall progress
        if (task.completed_items !== undefined && task.total_items) {
          const pct = Math.round((task.completed_items / task.total_items) * 100);
          taskStore.updateProgress(task.completed_items - 1, task.total_items, pct);
        }

        // Update per-file status from task results
        if (task.results && typeof task.results === 'object') {
          Object.entries(task.results).forEach(([key, value]) => {
            if (typeof key === 'string' && key.startsWith('item_')) {
              const idx = parseInt(key.replace('item_', ''), 10);
              if (value === null || value === undefined) {
                taskStore.updateFileStatus(idx, 'failed', 'AI extraction failed');
              } else if (value && value.status === 'needs_review') {
                taskStore.updateFileStatus(idx, 'needs_review', 'Saved for review', value.id);
              } else if (value) {
                taskStore.updateFileStatus(idx, 'done', 'Processed successfully', value.id);
              }
            }
          });
        }

        // Check for task completion
        if (task.status === 'completed' || task.status === 'failed') {
          taskStore.completeTask();
          if (task.status === 'failed') {
            onTaskError?.(new Error(task.error || 'Task failed'));
          } else {
            onTaskComplete?.();
          }
        }
      } catch (e) {
        // Silently ignore poll errors
      }
    };

    pollTask();
    syncIntervalRef.current = setInterval(pollTask, 3000);

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }
    };
  }, [taskStore.backendTaskId, taskStore.isProcessing]);

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
