import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { useAuthStore } from '@/stores/auth.store';
import { useWorkspaceStore } from '@/stores/workspace.store';

// findBy* queries wait up to 1s by default, which a loaded machine can exceed.
configure({ asyncUtilTimeout: 3_000 });

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

// jsdom has no layout engine or ResizeObserver; Recharts' ResponsiveContainer needs the latter.
if (!('ResizeObserver' in window)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (window as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}
