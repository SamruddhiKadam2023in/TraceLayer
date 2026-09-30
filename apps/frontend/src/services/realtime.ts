import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import {
  REALTIME_EVENT_NAMES,
  REALTIME_PATH,
  type RealtimeClientEvents,
  type RealtimeEventName,
  type RealtimeEvents,
} from '@tracelayer/shared';
import { useAuthStore } from '@/stores/auth.store';
import { refreshSession } from './api';

/**
 * - `live`: connected and subscribed to the current workspace.
 * - `connecting`: (re)connecting, e.g. after a network drop or a token refresh.
 * - `offline`: not connected; pages fall back to their own refresh timers.
 */
export type RealtimeStatus = 'live' | 'connecting' | 'offline';

export const useRealtimeStore = create<{ status: RealtimeStatus }>()(() => ({
  status: 'offline',
}));

/** A server event, or `resync` after a reconnect (events may have been missed meanwhile). */
export type RealtimeMessage =
  | { [E in RealtimeEventName]: { event: E; payload: RealtimeEvents[E] } }[RealtimeEventName]
  | { event: 'resync'; payload: null };

type Listener = (message: RealtimeMessage) => void;

const listeners = new Set<Listener>();
const KNOWN_EVENTS = new Set<string>(REALTIME_EVENT_NAMES);
let socket: Socket<RealtimeEvents, RealtimeClientEvents> | null = null;
let workspaceId: string | null = null;
let connectedBefore = false;

const setStatus = (status: RealtimeStatus) => useRealtimeStore.setState({ status });
const dispatch = (message: RealtimeMessage) => {
  for (const listener of listeners) listener(message);
};

function subscribeCurrent(): void {
  const s = socket;
  const id = workspaceId;
  if (!s?.connected || !id) return;
  s.emit('subscribe', id, (ack) => {
    // Ignore answers for a workspace the user has since switched away from.
    if (s !== socket || id !== workspaceId) return;
    setStatus(ack.ok ? 'live' : 'offline');
  });
}

/** Opens the single connection for this tab (spec §29). Safe to call more than once. */
export function connectRealtime(): void {
  if (socket) return;
  connectedBefore = false;
  setStatus('connecting');
  const s: Socket<RealtimeEvents, RealtimeClientEvents> = io({
    path: REALTIME_PATH,
    transports: ['websocket'],
    // Read on every (re)connect, so a refreshed token is always used.
    auth: (cb) => cb({ token: useAuthStore.getState().accessToken }),
  });
  socket = s;

  s.on('connect', () => {
    if (connectedBefore) dispatch({ event: 'resync', payload: null });
    connectedBefore = true;
    subscribeCurrent();
  });

  s.on('connect_error', async (err) => {
    setStatus('connecting');
    if (err.message !== 'UNAUTHENTICATED') return; // network trouble: Socket.IO retries itself
    // The access token expired or was rejected: renew it, then reconnect by hand
    // (Socket.IO does not retry after a rejection by the server).
    const session = await refreshSession();
    if (s !== socket) return;
    if (!session) {
      disconnectRealtime();
      return;
    }
    window.setTimeout(() => s === socket && s.connect(), 1000);
  });

  s.on('disconnect', (reason) => {
    if (s !== socket) return;
    setStatus('connecting');
    // The server closes sockets whose token expired; reconnect with the current one.
    if (reason === 'io server disconnect') s.connect();
  });

  s.onAny((event: string, payload: unknown) => {
    if (KNOWN_EVENTS.has(event)) dispatch({ event, payload } as RealtimeMessage);
  });
}

/** Switches which workspace's events this tab receives. */
export function setRealtimeWorkspace(id: string | null): void {
  if (id === workspaceId) return;
  workspaceId = id;
  if (socket?.connected) {
    setStatus('connecting');
    subscribeCurrent();
  }
}

export function disconnectRealtime(): void {
  const s = socket;
  socket = null;
  workspaceId = null;
  s?.removeAllListeners();
  s?.disconnect();
  setStatus('offline');
}

/** Listens to every real-time message; returns the unsubscribe function. */
export function onRealtime(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
