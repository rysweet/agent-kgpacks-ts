// Vitest global setup: registers @testing-library/jest-dom matchers and unmounts
// React trees between tests so jsdom state never leaks across cases.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
