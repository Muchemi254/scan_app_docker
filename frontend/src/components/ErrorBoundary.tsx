/**
 * Error Boundary component for catching and handling errors gracefully.
 *
 * Catches:
 * - Firebase initialization errors
 * - Authentication errors
 * - Runtime errors
 */

import React, { Component } from 'react';
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log error to backend
    this.logErrorToBackend(error, errorInfo);

    this.setState({
      error,
      errorInfo
    });

    // Stale-deployment recovery: a long-open tab still runs the previous
    // bundle, which lazy-loads chunk files with the OLD content-hash. After a
    // redeploy those files are gone (404), so reloading once serves index.html
    // fresh and every import resolves. The flag is reset on the next app boot
    // (componentDidMount), so a later deploy can still auto-recover.
    const msg = error?.message || '';
    if (
      msg.includes('Failed to fetch dynamically imported module') ||
      msg.includes('Importing a module script failed') ||
      msg.includes('Unable to preload CSS')
    ) {
      if (!sessionStorage.getItem('chunk-reload-attempted')) {
        sessionStorage.setItem('chunk-reload-attempted', '1');
        window.location.reload();
      }
    }
  }

  componentDidMount() {
    sessionStorage.removeItem('chunk-reload-attempted');
  }

  logErrorToBackend = async (error: Error, errorInfo: React.ErrorInfo) => {
    try {
      // Log to browser console
      console.error('Error caught by boundary:', error);
      console.error('Error info:', errorInfo);

      // Optionally send to backend for monitoring
      // await fetch('/api/v1/logs/errors', {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({
      //     message: error.message,
      //     stack: error.stack,
      //     componentStack: errorInfo.componentStack,
      //     timestamp: new Date().toISOString()
      //   })
      // });
    } catch (err) {
      console.error('Failed to log error:', err);
    }
  };

  render() {
    if (this.state.hasError) {
      const errorMessage = this.state.error?.message || '';
      const isAuthError = errorMessage.includes('Firebase') || errorMessage.includes('auth');
      const isApiKeyError = errorMessage.includes('API key') || errorMessage.includes('configuration');

      return (
        this.props.fallback || (
          <div className="min-h-screen flex items-center justify-center bg-gray-50">
            <div className="max-w-md w-full space-y-8">
              <div className="rounded-lg bg-white shadow-md p-8">
                <h1 className="text-2xl font-bold text-gray-900 mb-4">
                  ⚠️ Something went wrong
                </h1>

                {isApiKeyError ? (
                  <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded">
                    <p className="text-sm text-amber-800 mb-2">
                      <strong>Configuration Error:</strong>
                    </p>
                    <p className="text-sm text-amber-700 mb-3">
                      An API configuration issue was detected. This is a server-side issue that needs to be resolved by an administrator.
                    </p>
                    <p className="text-sm text-amber-700">
                      The application will continue running with limited features. Please contact support if you need assistance.
                    </p>
                  </div>
                ) : isAuthError ? (
                  <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded">
                    <p className="text-sm text-yellow-800 mb-2">
                      <strong>Authentication Error:</strong>
                    </p>
                    <p className="text-sm text-yellow-700 mb-3">
                      Unable to connect to authentication service. This could be due to:
                    </p>
                    <ul className="text-sm text-yellow-700 space-y-1 ml-4 list-disc">
                      <li>Invalid API key or configuration</li>
                      <li>Network connectivity issues</li>
                      <li>Server is temporarily unavailable</li>
                    </ul>
                    <p className="text-sm text-yellow-700 mt-3">
                      Please check your configuration and try refreshing the page.
                    </p>
                  </div>
                ) : (
                  <p className="text-gray-600 mb-4">
                    An unexpected error occurred. Please try refreshing the page.
                  </p>
                )}

                {import.meta.env.DEV && (
                  <details className="mb-4 p-4 bg-gray-100 rounded text-sm">
                    <summary className="cursor-pointer font-medium text-gray-900 mb-2">
                      Error Details (Development Only)
                    </summary>
                    <pre className="overflow-auto text-xs text-gray-700 whitespace-pre-wrap">
                      {this.state.error?.toString()}
                      {this.state.errorInfo?.componentStack}
                    </pre>
                  </details>
                )}

                <div className="flex gap-4">
                  <button
                    onClick={() => window.location.href = '/'}
                    className="flex-1 py-2 px-4 bg-indigo-600 text-white rounded hover:bg-indigo-700 transition"
                  >
                    Go Home
                  </button>
                  <button
                    onClick={() => window.location.reload()}
                    className="flex-1 py-2 px-4 bg-gray-300 text-gray-800 rounded hover:bg-gray-400 transition"
                  >
                    Refresh Page
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
