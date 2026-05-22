/**
 * API Error Handler
 * Provides centralized error handling for API calls
 * Logs detailed errors internally, returns abstracted user messages
 */

export interface ApiError {
  type: 'missing_key' | 'invalid_key' | 'api_error' | 'network_error' | 'unknown';
  userMessage: string;
  detailedMessage: string;
  originalError?: Error;
  context?: string;
}

/**
 * Determine error type and create appropriate ApiError
 */
const createApiError = (
  error: Error | unknown,
  context: string
): ApiError => {
  const errorObj = error instanceof Error ? error : new Error(String(error));
  const message = errorObj.message;

  // Determine error type and appropriate user message
  let type: ApiError['type'] = 'unknown';
  let userMessage = 'An error occurred while processing your request. Please try again.';

  if (
    message.includes('invalid') ||
    message.includes('unauthorized') ||
    message.includes('401') ||
    message.includes('403')
  ) {
    type = 'invalid_key';
    userMessage =
      'Authentication failed. Please try again or contact support.';
  } else if (message.includes('fetch') || message.includes('network')) {
    type = 'network_error';
    userMessage =
      'Network error. Please check your connection and try again.';
  } else if (message.includes('timeout')) {
    type = 'api_error';
    userMessage =
      'Request took too long. Please try again.';
  }

  // Log full error details for debugging
  console.error(`[${context}] API Error:`, {
    type,
    originalMessage: message,
    stack: errorObj.stack,
    timestamp: new Date().toISOString(),
    context,
  });

  return {
    type,
    userMessage,
    detailedMessage: message,
    originalError: errorObj,
    context,
  };
};

/**
 * Wraps API calls with error handling
 * Logs detailed errors, returns abstracted user messages
 */
export const handleApiError = (
  error: Error | unknown,
  context: string = 'API Call'
): ApiError => {
  return createApiError(error, context);
};

/**
 * Get user-friendly message from API error
 */
export const getUserMessage = (apiError: ApiError): string => {
  return apiError.userMessage;
};

/**
 * Get detailed message (for development/logging only)
 */
export const getDetailedMessage = (apiError: ApiError): string => {
  return apiError.detailedMessage;
};
