/**
 * API Configuration Validator
 *
 * NOTE: Gemini API key is now handled entirely on the backend.
 * The frontend does NOT need Gemini configuration.
 * All AI-powered receipt extraction is done server-side.
 */

export interface ApiConfigStatus {
  allValid: boolean;
}

/**
 * Validates API configurations
 * Currently all validation is on the backend side
 */
export const validateApiConfig = (): ApiConfigStatus => {
  const status: ApiConfigStatus = {
    allValid: true, // Frontend config is minimal
  };

  // Backend handles all Gemini API configuration
  // Frontend just needs to call the API endpoints

  return status;
};

/**
 * Get user-friendly error message for API issues
 * Abstracted from actual error names for security
 */
export const getApiConfigErrorMessage = (_config: ApiConfigStatus): string => {
  return (
    'Unable to connect to the service. ' +
    'Please check your internet connection and try again.'
  );
};

/**
 * Log detailed error information (for backend/console only)
 * This is called internally and not shown to users
 */
export const logApiConfigError = (error: Error, context: string = ''): void => {
  console.error(`[API Config Error] ${context}:`, {
    message: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString(),
  });
};
