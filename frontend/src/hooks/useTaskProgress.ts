/**
 * Custom hook for managing task progress and persistence.
 */
import { useEffect, useCallback, useRef } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { auth } from '../services/firebase';

interface UseTaskProgressOptions {
  onProgressUpdate?: (progress: number, index: number, total: number) => void;
  onTaskComplete?: () => void;
  onTaskError?: (error: Error) => void;
}

async function getToken(): Promise<string> {
  if (auth?.currentUser) return await auth.currentUser.getIdToken();
  return '';
}

export const useTaskProgress = (options: UseTaskProgressOptions = {}) => {
  const { onProgressUpdate, onTaskComplete, onTaskError } = options;
  const taskStore = useTaskStore();
  const syncIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const initializeTask = useCallback(
    (files: File[], batchTitle: string) => {
      const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      taskStore.initializeTask(taskId, files, batchTitle);
      return taskId;
    },
    [taskStore]
  );

  const updateProgress = useCallback(
    (index: number, total: number, message?: string) => {
      const percentage = Math.round(((index + 1) / total) * 100);
      taskStore.updateProgress(index, total, percentage);
      onProgressUpdate?.(percentage, index, total);
    },
    [taskStore, onProgressUpdate]
  );

  const updateFileStatus = useCallback(
    (index: number, status: 'pending' | 'processing' | 'done' | 'needs_review' | 'failed', message?: string, receiptId?: string) => {
      taskStore.updateFileStatus(index, status, message, receiptId);
    },
    [taskStore]
  );

  const completeTask = useCallback(async () => {
    taskStore.completeTask();
    onTaskComplete?.();
    if (syncIntervalRef.current) {
      clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }
  }, [taskStore, onTaskComplete]);

  const pauseTask = useCallback(() => { taskStore.pauseTask(); }, [taskStore]);
  const resumeTask = useCallback(() => { taskStore.resumeTask(); }, [taskStore]);
  const getResumeData = useCallback(() => taskStore.getResumeData(), [taskStore]);

  const clearTask = useCallback(() => {
    if (syncIntervalRef.current) {
      clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }
    taskStore.clearTask();
  }, [taskStore]);

  useEffect(() => {
    const backendTaskId = taskStore.backendTaskId;
    if (!backendTaskId || !taskStore.isProcessing) return;

    const pollTask = async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';
        const userId = auth?.currentUser?.uid;
        if (!userId) return;

        const resp = await fetch(`${API_BASE}/users/${userId}/tasks/${backendTaskId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!resp.ok) return;

        const task = await resp.json();
        if (task.completed_items !== undefined && task.total_items) {
          const pct = Math.round((task.completed_items / task.total_items) * 100);
          taskStore.updateProgress(task.completed_items - 1, task.total_items, pct);
        }

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

        if (task.status === 'completed' || task.status === 'failed') {
          taskStore.completeTask();
          if (task.status === 'failed') onTaskError?.(new Error(task.error || 'Task failed'));
          else onTaskComplete?.();
        }
      } catch (e) { /* ignore */ }
    };

    pollTask();
    syncIntervalRef.current = setInterval(pollTask, 3000);
    return () => { if (syncIntervalRef.current) clearInterval(syncIntervalRef.current); };
  }, [taskStore.backendTaskId, taskStore.isProcessing]);

  return {
    activeTaskId: taskStore.activeTaskId,
    batchTitle: taskStore.batchTitle,
    files: taskStore.files,
    isProcessing: taskStore.isProcessing,
    currentProgress: taskStore.currentProgress,
    currentIndex: taskStore.currentIndex,
    totalFiles: taskStore.totalFiles,
    elapsedTime: taskStore.elapsedTime,
    estimatedTimeRemaining: taskStore.estimatedTimeRemaining,
    initializeTask, updateProgress, updateFileStatus, completeTask,
    pauseTask, resumeTask, getResumeData, clearTask,
  };
};
