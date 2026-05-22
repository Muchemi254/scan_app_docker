/**
 * API Configuration Context
 * Provides API configuration status to all components
 * Allows graceful handling of missing API keys
 */

import { createContext, useContext, ReactNode, useState, useEffect } from 'react';
import { validateApiConfig, ApiConfigStatus } from '../services/apiConfig';

interface ApiConfigContextType {
  config: ApiConfigStatus | null;
  isLoading: boolean;
  retryValidation: () => void;
}

const ApiConfigContext = createContext<ApiConfigContextType | null>(null);

export const ApiConfigProvider = ({ children }: { children: ReactNode }) => {
  const [config, setConfig] = useState<ApiConfigStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadConfig = () => {
      try {
        const validatedConfig = validateApiConfig();
        setConfig(validatedConfig);
      } catch (error) {
        console.error('Failed to validate API config:', error);
        // Default to valid on error (frontend config is minimal)
        setConfig({
          allValid: true,
        });
      } finally {
        setIsLoading(false);
      }
    };

    loadConfig();
  }, []);

  const retryValidation = () => {
    setIsLoading(true);
    setTimeout(() => {
      const validatedConfig = validateApiConfig();
      setConfig(validatedConfig);
      setIsLoading(false);
    }, 500);
  };

  return (
    <ApiConfigContext.Provider value={{ config, isLoading, retryValidation }}>
      {children}
    </ApiConfigContext.Provider>
  );
};

export const useApiConfig = () => {
  const context = useContext(ApiConfigContext);
  if (!context) {
    throw new Error('useApiConfig must be used within ApiConfigProvider');
  }
  return context;
};
