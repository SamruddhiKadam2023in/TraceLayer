import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { useAuthStore } from '@/stores/auth.store';
import { disconnectRealtime } from '@/services/realtime';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { FakeSocket, fakeSockets } from './fake-socket';

// No real network in tests: the app's socket is a FakeSocket the test can drive.
vi.mock('socket.io-client', () => ({
  io: (options: ConstructorParameters<typeof FakeSocket>[0]) => {
    const socket = new FakeSocket(options);
    fakeSockets.push(socket);
    return socket;
  },
}));

// findBy* queries wait up to 1s by default, which a loaded machine can exceed.
configure({ asyncUtilTimeout: 3_000 });

afterEach(() => {
  cleanup();
  // Stores are module singletons; start every test signed out with nothing cached.
  localStorage.clear();
  useAuthStore.setState({ status: 'unknown', user: null, accessToken: null });
  useWorkspaceStore.getState().reset();
  disconnectRealtime();
  fakeSockets.length = 0;
  useToastStore.setState({ toasts: [] });
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
