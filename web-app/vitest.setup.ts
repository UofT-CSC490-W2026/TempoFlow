import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

if (!URL.createObjectURL) {
  URL.createObjectURL = vi.fn(() => 'blob:mock-url') as typeof URL.createObjectURL;
}

if (!URL.revokeObjectURL) {
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
}
