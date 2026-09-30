import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';
import {
  realtimeRedisKey,
  workspaceRoom,
  type RealtimeEventName,
  type RealtimeEvents,
} from '@tracelayer/shared';

/** Sends one real-time event to a workspace's subscribers (spec §29). */
export type RealtimePublish = <E extends RealtimeEventName>(
  workspaceId: string,
  event: E,
  payload: RealtimeEvents[E],
) => void;

/**
 * Publishes through Redis to the API's Socket.IO adapter, so the worker needs no connection to
 * the API and events reach every API instance.
 */
export function createRealtimePublisher(redis: Redis, queuePrefix: string): RealtimePublish {
  const emitter = new Emitter<RealtimeEvents>(redis, { key: realtimeRedisKey(queuePrefix) });
  return (workspaceId, event, payload) => {
    // Socket.IO's emit types need the parameter tuple of the event; this is that, spelled out.
    const room = emitter.to(workspaceRoom(workspaceId)) as unknown as {
      emit: (event: RealtimeEventName, payload: unknown) => boolean;
    };
    room.emit(event, payload);
  };
}
