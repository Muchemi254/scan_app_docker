/**
 * Configuration Error Component
 * Displays when required API configurations are missing
 * Keeps UI visible but explains limitation gracefully
 */

interface ConfigurationErrorProps {
  errorMessage: string;
  onRetry?: () => void;
  showDetails?: boolean;
}

export const ConfigurationError = ({
  errorMessage,
  onRetry,
  showDetails = false,
}: ConfigurationErrorProps) => {
  return (
    <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 mb-4">
      <div className="flex gap-3">
        <div className="flex-shrink-0">
          <svg
            className="w-5 h-5 text-amber-600 mt-0.5"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path
              fillRule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
        </div>
        <div className="flex-1">
          <h3 className="font-semibold text-amber-900">Service Unavailable</h3>
          <p className="text-sm text-amber-800 mt-1">{errorMessage}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-3 text-sm text-amber-700 hover:text-amber-900 font-medium hover:underline transition"
            >
              Try Again
            </button>
          )}
          {import.meta.env.DEV && showDetails && (
            <details className="mt-3">
              <summary className="text-xs text-amber-700 cursor-pointer hover:text-amber-900">
                Technical Details
              </summary>
              <p className="text-xs text-amber-700 mt-2 font-mono bg-amber-100 p-2 rounded whitespace-pre-wrap break-words max-h-24 overflow-auto">
                {errorMessage}
              </p>
            </details>
          )}
        </div>
      </div>
    </div>
  );
};
