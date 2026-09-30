import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { z } from 'zod';
import { REALTIME_PATH, realtimeRedisKey, userRoom, workspaceRoom } from '@tracelayer/shared';
import { env } from '../config/env';
import type { RealtimeServer } from '../lib/realtime';
import { authorizeWorkspace } from '../services/access.service';
import { verifyAccessToken } from '../services/token.service';
import { logger } from '../utils/logger';

const workspaceIdSchema = z.uuid();

export interface RealtimeServerOptions {
  /** Redis clients for the adapter; omit for a single in-memory instance (tests). */
  redis?: { pub: Redis; sub: Redis };
}

/**
 * Socket.IO server (spec §29). Browsers connect with their access token, then subscribe to
 * one workspace at a time; events for that workspace (published by the API or by the worker
 * through Redis) reach them in the workspace's room.
 *
 * Access is re-checked on every subscribe and at least once per access-token lifetime: the
 * socket is disconnected when its token expires, and the client reconnects with a fresh one.
 */
export function createRealtimeServer(
  httpServer: HttpServer,
  options: RealtimeServerOptions = {},
): RealtimeServer {
  const io: RealtimeServer = new Server(httpServer, {
    path: REALTIME_PATH,
    serveClient: false,
    cors: { origin: env.FRONTEND_URL },
    // Only small JSON events flow to clients; nothing large should ever be accepted.
    maxHttpBufferSize: 10_000,
  });
  if (options.redis) {
    io.adapter(
      createAdapter(options.redis.pub, options.redis.sub, {
        key: realtimeRedisKey(env.QUEUE_PREFIX),
      }),
    );
  }

  io.use((socket, next) => {
    const token: unknown = socket.handshake.auth?.token;
    try {
      if (typeof token !== 'string') throw new Error('missing token');
      socket.data.userId = verifyAccessToken(token);
      const { exp } = jwt.decode(token) as { exp: number };
      const timer = setTimeout(() => socket.disconnect(true), Math.max(0, exp * 1000 - Date.now()));
      socket.once('disconnect', () => clearTimeout(timer));
      next();
    } catch {
      // The client reads this message to know it should refresh its token and retry.
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket) => {
    void socket.join(userRoom(socket.data.userId));

    socket.on('subscribe', async (workspaceId, ack) => {
      if (typeof ack !== 'function') return;
      const parsed = workspaceIdSchema.safeParse(workspaceId);
      try {
        if (!parsed.success) throw new Error('invalid id');
        await authorizeWorkspace(socket.data.userId, parsed.data, 'workspace.read');
      } catch {
        ack({ ok: false, error: 'Workspace not found' });
        return;
      }
      for (const room of socket.rooms) {
        if (room.startsWith('workspace:')) await socket.leave(room);
      }
      await socket.join(workspaceRoom(parsed.data));
      ack({ ok: true });
    });
  });

  io.engine.on('connection_error', (err: { message: string }) => {
    logger.debug({ err: err.message }, 'Socket.IO connection error');
  });
  return io;
}
