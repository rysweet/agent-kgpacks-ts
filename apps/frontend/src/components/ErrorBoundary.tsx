// apps/frontend/src/components/ErrorBoundary.tsx
//
// Top-level React error boundary. A render-time failure anywhere below it (e.g. a
// backend response that drifts from the typed contract) is caught and shown as a
// recoverable fallback instead of unmounting the whole tree to a blank screen.

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the cause so a crash is diagnosable rather than a silent blank page.
    console.error('UI error boundary caught an error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="app-error" role="alert">
          <h1>Something went wrong</h1>
          <p>The interface hit an unexpected error. Try again, or reload the page.</p>
          <button type="button" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
