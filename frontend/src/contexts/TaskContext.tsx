/**
 * Task context — lightweight wrapper (no IndexedDB dependency).
 * Task state is managed by Zustand store with localStorage persistence.
 */
import React, { createContext, useContext } from 'react';

interface TaskContextType {
  hasIncompleteTask: boolean;
  incompleteTaskData: any | null;
}

const TaskContext = createContext<TaskContextType>({
  hasIncompleteTask: false,
  incompleteTaskData: null,
});

export const TaskProvider: React.FC<{ children: React.ReactNode; userId?: string }> = ({
  children,
}) => {
  return (
    <TaskContext.Provider value={{ hasIncompleteTask: false, incompleteTaskData: null }}>
      {children}
    </TaskContext.Provider>
  );
};

export const useTask = () => useContext(TaskContext);
