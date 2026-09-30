import type { Server } from 'socket.io';
import {
  userRoom,
  workspaceRoom,
  type RealtimeClientEvents,
  type RealtimeEventName,
  type RealtimeEvents,
} from '@tracelayer/shared';

export interface SocketData {
  userId: string;
}

export type RealtimeServer = Server<
  RealtimeClientEvents,
  RealtimeEvents,
  Record<string, never>,
  SocketData
>;

let io: RealtimeServer | null = null;

/** Set by server.ts once the Socket.IO server exists; tests and scripts run without one. */
export function setRealtimeServer(server: RealtimeServer | null): void {
  io = server;
}

/**
 * Sends an event to everyone subscribed to the workspace, on every API instance (through the
 * Redis adapter). Fire-and-forget: a real-time hiccup must never fail the request that caused it.
 */
export function publish<E extends RealtimeEventName>(
  workspaceId: string,
  event: E,
  payload: RealtimeEvents[E],
): void {
  if (!io) return;
  // Socket.IO's emit types need the parameter tuple of the event; this is that, spelled out.
  const room = io.to(workspaceRoom(workspaceId)) as unknown as {
    emit: (event: E, payload: RealtimeEvents[E]) => boolean;
  };
  room.emit(event, payload);
}

/** Removes a user's open sockets from a workspace they just lost access to. */
export function revokeWorkspaceAccess(userId: string, workspaceId: string): void {
  io?.in(userRoom(userId)).socketsLeave(workspaceRoom(workspaceId));
}

/** Removes every open socket from a deleted workspace. */
export function closeWorkspaceRoom(workspaceId: string): void {
  io?.in(workspaceRoom(workspaceId)).socketsLeave(workspaceRoom(workspaceId));
}
