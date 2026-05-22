/**
 * Task context for managing global task state.
 *
 * Provides:
 * - Active task tracking
 * - Resume detection
 * - Lifecycle management
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { indexedDB } from '../utils/indexeddb';

interface TaskContextType {
  hasIncompleteTask: boolean;
  incompleteTaskData: any | null;
  requestPersistence: () => Promise<void>;
  clearOldTasks: () => Promise<void>;
}

const TaskContext = createContext<TaskContextType | undefined>(undefined);

export const TaskProvider: React.FC<{ children: React.ReactNode; userId?: string }> = ({
  children,
  userId
}) => {
  const [hasIncompleteTask, setHasIncompleteTask] = useState(false);
  const [incompleteTaskData, setIncompleteTaskData] = useState<any | null>(null);

  /**
   * Check for incomplete tasks on mount
   */
  useEffect(() => {
    const checkIncompleteTask = async () => {
      if (!userId) return;

      try {
        const activeTasks = await indexedDB.getActiveTasksForUser(userId);
        if (activeTasks.length > 0) {
          setHasIncompleteTask(true);
          setIncompleteTaskData(activeTasks[0]);
        }
      } catch (err) {
        console.error('Error checking incomplete tasks:', err);
      }
    };

    checkIncompleteTask();
  }, [userId]);

  /**
   * Request persistent storage
   */
  const requestPersistence = async () => {
    try {
      const persisted = await indexedDB.requestPersistence();
      if (persisted) {
        console.log('Persistent storage granted');
      }
    } catch (err) {
      console.error('Failed to request persistent storage:', err);
    }
  };

  /**
   * Clear old tasks
   */
  const clearOldTasks = async () => {
    try {
      const deleted = await indexedDB.clearOldTasks(30);
      console.log(`Cleared ${deleted} old tasks`);
    } catch (err) {
      console.error('Failed to clear old tasks:', err);
    }
  };

  /**
   * Request persistent storage on first load
   */
  useEffect(() => {
    requestPersistence();
  }, []);

  /**
   * Periodically clear old tasks
   */
  useEffect(() => {
    const interval = setInterval(() => {
      clearOldTasks();
    }, 24 * 60 * 60 * 1000); // Daily

    return () => clearInterval(interval);
  }, []);

  return (
    <TaskContext.Provider
      value={{
        hasIncompleteTask,
        incompleteTaskData,
        requestPersistence,
        clearOldTasks
      }}
    >
      {children}
    </TaskContext.Provider>
  );
};

export const useTask = () => {
  const context = useContext(TaskContext);
  if (context === undefined) {
    throw new Error('useTask must be used within TaskProvider');
  }
  return context;
};
