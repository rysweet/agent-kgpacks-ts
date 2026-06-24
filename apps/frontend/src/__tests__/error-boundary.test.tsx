// apps/frontend/src/__tests__/error-boundary.test.tsx
//
// The top-level error boundary must turn a render-time crash into a recoverable
// fallback (role="alert") rather than unmounting the tree to a blank screen.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ErrorBoundary } from '../components/ErrorBoundary';

function Boom(): never {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  it('renders a recoverable fallback when a child throws', () => {
    // Suppress the expected React + boundary error logging for this render.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    spy.mockRestore();
  });

  it('renders children unchanged when they do not throw', () => {
    render(
      <ErrorBoundary>
        <div>healthy child</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy child')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
