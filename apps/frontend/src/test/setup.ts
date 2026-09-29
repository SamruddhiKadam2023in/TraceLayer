import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { useAuthStore } from '@/stores/auth.store';
import { useWorkspaceStore } from '@/stores/workspace.store';

afterEach(() => {
  cleanup();
  // Stores are module singletons; start every test signed out with nothing cached.
  localStorage.clear();
  useAuthStore.setState({ status: 'unknown', user: null, accessToken: null });
  useWorkspaceStore.getState().reset();
});

// jsdom does not implement matchMedia.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
