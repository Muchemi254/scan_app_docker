/**
 * IndexedDB utility for persistent task data storage.
 *
 * Stores:
 * - Task history
 * - Batch metadata
 * - Failed items for retry
 * - Large data that exceeds localStorage limits
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';

interface TaskData {
  id: string;
  taskId: string;
  userId: string;
  batchTitle: string;
  totalItems: number;
  completedItems: number;
  status: 'processing' | 'completed' | 'failed' | 'paused';
  startedAt: number;
  completedAt?: number;
  files: Array<{
    name: string;
    status: string;
    receiptId?: string;
    error?: string;
  }>;
  metadata: Record<string, any>;
}

interface ScanAppDB extends DBSchema {
  tasks: {
    key: string;
    value: TaskData;
    indexes: { 'by-status': string; 'by-user': string; 'by-date': number };
  };
  taskHistory: {
    key: string;
    value: {
      taskId: string;
      timestamp: number;
      status: string;
      progress: number;
    };
    indexes: { 'by-task': string; 'by-date': number };
  };
}

let db: IDBPDatabase<ScanAppDB> | null = null;

const initDB = async (): Promise<IDBPDatabase<ScanAppDB>> => {
  if (db) return db;

  db = await openDB<ScanAppDB>('scan-app-db', 1, {
    upgrade(db) {
      // Tasks store
      if (!db.objectStoreNames.contains('tasks')) {
        const taskStore = db.createObjectStore('tasks', { keyPath: 'id' });
        taskStore.createIndex('by-status', 'status');
        taskStore.createIndex('by-user', 'userId');
        taskStore.createIndex('by-date', 'startedAt');
      }

      // Task history store
      if (!db.objectStoreNames.contains('taskHistory')) {
        const historyStore = db.createObjectStore('taskHistory', { keyPath: 'taskId' });
        historyStore.createIndex('by-task', 'taskId');
        historyStore.createIndex('by-date', 'timestamp');
      }
    }
  });

  return db;
};

export const indexedDB = {
  /**
   * Save task data
   */
  async saveTask(taskData: TaskData): Promise<string> {
    const database = await initDB();
    return database.put('tasks', taskData);
  },

  /**
   * Get task data by ID
   */
  async getTask(taskId: string): Promise<TaskData | undefined> {
    const database = await initDB();
    return database.get('tasks', taskId);
  },

  /**
   * Get all active tasks for user
   */
  async getActiveTasksForUser(userId: string): Promise<TaskData[]> {
    const database = await initDB();
    const allTasks = await database.getAllFromIndex('tasks', 'by-user', userId);
    return allTasks.filter(t => t.status !== 'completed' && t.status !== 'failed');
  },

  /**
   * Get task history
   */
  async getTaskHistory(taskId: string): Promise<any[]> {
    const database = await initDB();
    return database.getAllFromIndex('taskHistory', 'by-task', taskId);
  },

  /**
   * Save task history entry
   */
  async saveTaskHistoryEntry(taskId: string, status: string, progress: number): Promise<void> {
    const database = await initDB();
    await database.add('taskHistory', {
      taskId,
      timestamp: Date.now(),
      status,
      progress
    });
  },

  /**
   * Delete task
   */
  async deleteTask(taskId: string): Promise<void> {
    const database = await initDB();
    await database.delete('tasks', taskId);
  },

  /**
   * Clear old tasks (older than 30 days)
   */
  async clearOldTasks(daysOld: number = 30): Promise<number> {
    const database = await initDB();
    const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
    const allTasks = await database.getAll('tasks');

    let deletedCount = 0;
    for (const task of allTasks) {
      if (task.startedAt < cutoffTime) {
        await database.delete('tasks', task.id);
        deletedCount++;
      }
    }

    return deletedCount;
  },

  /**
   * Get database size
   */
  async getDatabaseSize(): Promise<{ usage: number; quota: number }> {
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      return {
        usage: estimate.usage || 0,
        quota: estimate.quota || 0
      };
    }
    return { usage: 0, quota: 0 };
  },

  /**
   * Request persistent storage
   */
  async requestPersistence(): Promise<boolean> {
    if (navigator.storage && navigator.storage.persist) {
      return navigator.storage.persist();
    }
    return false;
  }
};
