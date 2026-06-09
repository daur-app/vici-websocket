/**
 * Session lifecycle management: attaching/detaching sockets, scheduling
 * cleanup, and finalizing sessions.
 */

import type { Server, Socket } from 'socket.io';
import { Sentry } from '../instrument';
import { redis, createRedisConnection } from '../redis/redis';
import type { SessionMode, SessionType } from '../types/session';
import { isStealthMode, SESSION_RESUME_WINDOW_MS, REDIS_SESSION_KILLED_CHANNEL, REDIS_SESSION_FINALIZED_CHANNEL } from '../types/session';
import {
  activeUsersByRoom,
  activeBySocket,
  getOrCreateRoomMap,
  getSubRoom,
  clearReconnectTimer,
  clearFlushTimer,
  findUserAcrossRooms,
} from './store';
import { flushPathBuffer, pushBreakMarker, startFlushTimer } from './pathBuffer';

// ─── IO reference ────────────────────────────────────────────────────────────
// Set once from index.ts after the Server is created.

let io: Server;

export function setIO(server: Server): void {
  io = server;
}

// ─── Finalize ────────────────────────────────────────────────────────────────

export async function finalizeSession(roomId: string, userId: number): Promise<void> {
  const roomMap = activeUsersByRoom.get(roomId);
  const userData = roomMap?.get(userId);
  if (!roomMap || !userData) return;

  const sessionId = userData.sessionId;

  clearReconnectTimer(userData);
  clearFlushTimer(userData);

  // Final flush — ensure any remaining buffered points are written to Redis
  // Must await so userData is not deleted while a flush is still in-flight
  try {
    await flushPathBuffer(sessionId, userData);
  } catch (err) {
    console.error(`[Flush] Error on finalizeSession for user ${userId}:`, err);
    Sentry.captureException(err, {
      tags: { event: 'finalizeSession', phase: 'flush' },
      extra: { userId, sessionId, roomId },
    });
  }

  for (const socketId of userData.sockets) {
    activeBySocket.delete(socketId);
    io.sockets.sockets.get(socketId)?.leave(getSubRoom(roomId, userData.sessionType));
  }

  Sentry.addBreadcrumb({
    category: 'session.lifecycle',
    message: `finalizeSession: userId=${userId} sessionId=${sessionId} roomId=${roomId} socketsRemoved=${userData.sockets.size}`,
    level: 'info',
  });

  roomMap.delete(userId);
  if (roomMap.size === 0) {
    activeUsersByRoom.delete(roomId);
  }

  if (!isStealthMode(userData.sessionMode)) {
    io.to(getSubRoom(roomId, userData.sessionType)).emit("user:offline", { userId });
  }

  // Notify the backend that this session was finalized by the WS server.
  // The backend should subscribe to this channel and trigger its completion
  // pipeline (area calculation, territory capture, etc.) before Redis data expires.
  try {
    await redis.publish(
      REDIS_SESSION_FINALIZED_CHANNEL,
      JSON.stringify({ sessionId, userId, roomId }),
    );
  } catch (err) {
    console.error(`[PubSub] Failed to publish session:finalized for session ${sessionId}:`, err);
    Sentry.captureException(err, {
      tags: { event: 'finalizeSession', phase: 'publish' },
      extra: { userId, sessionId, roomId },
    });
  }
}

// ─── Cleanup scheduling ─────────────────────────────────────────────────────

export async function scheduleSessionCleanup(
  roomId: string,
  userId: number,
  userData: import('../types/session').ActiveUserSession,
): Promise<void> {
  clearReconnectTimer(userData);
  userData.disconnectedAt = Date.now();

  // Stop the flush timer first — no new timer-driven flushes should fire
  clearFlushTimer(userData);

  // Flush any remaining buffered points before entering grace period
  try {
    await flushPathBuffer(userData.sessionId, userData);
  } catch (err) {
    console.error(`[Flush] Error flushing on disconnect for user ${userId}:`, err);
    Sentry.captureException(err, {
      tags: { event: 'scheduleSessionCleanup', phase: 'flush' },
      extra: { userId, sessionId: userData.sessionId, roomId },
    });
  }

  Sentry.addBreadcrumb({
    category: 'session.lifecycle',
    message: `scheduleSessionCleanup: userId=${userId} sessionId=${userData.sessionId} roomId=${roomId} resumeWindowMs=${SESSION_RESUME_WINDOW_MS}`,
    level: 'info',
  });

  userData.reconnectTimer = setTimeout(() => {
    Sentry.addBreadcrumb({
      category: 'session.lifecycle',
      message: `Resume window expired — finalizing: userId=${userId} sessionId=${userData.sessionId} roomId=${roomId}`,
      level: 'warning',
    });
    finalizeSession(roomId, userId);
  }, SESSION_RESUME_WINDOW_MS);
}

// ─── Attach socket ───────────────────────────────────────────────────────────

export async function attachSocketToSession(
  socket: Socket,
  roomId: string,
  userId: number,
  sessionId: number,
  sessionMode: SessionMode = 'normal',
  sessionType: SessionType = 'solo',
  teamId: number | null = null,
): Promise<void> {
  const previous = activeBySocket.get(socket.id);
  if (previous) {
    const previousRoomMap = activeUsersByRoom.get(previous.roomId);
    const previousUserData = previousRoomMap?.get(previous.userId);

    if (previousUserData) {
      previousUserData.sockets.delete(socket.id);
      if (previousUserData.sockets.size === 0) {
        scheduleSessionCleanup(
          previous.roomId,
          previous.userId,
          previousUserData,
        );
      }
    }

    // Leave the previous sub-room before switching
    socket.leave(getSubRoom(previous.roomId, previous.sessionType));
    activeBySocket.delete(socket.id);
  }

  // ── BUG-006 FIX: Immediately finalize any stale session for this user ────
  // If the user already has an in-memory session with a DIFFERENT sessionId,
  // finalize it immediately instead of just scheduling cleanup. This prevents
  // ghost sessions that could confuse reconnect-session lookups.
  const existingAcrossRooms = findUserAcrossRooms(userId);
  if (existingAcrossRooms && existingAcrossRooms.userData.sessionId !== sessionId) {
    Sentry.addBreadcrumb({
      category: 'session.lifecycle',
      message: `BUG-006 FIX: Immediately finalizing stale session ${existingAcrossRooms.userData.sessionId} for userId=${userId} (new sessionId=${sessionId})`,
      level: 'warning',
    });
    await finalizeSession(existingAcrossRooms.roomId, userId);
  }

  const roomMap = getOrCreateRoomMap(roomId);
  const existing = roomMap.get(userId);
  const wasDisconnected = existing?.disconnectedAt !== null && existing?.disconnectedAt !== undefined;

  // Only fetch avatar from Redis when creating a NEW session entry
  let avatarUrl = existing?.avatarUrl ?? '';
  if (!existing) {
    try {
      if (sessionType === 'team' && teamId != null) {
        avatarUrl = (await redis.get(`team:${teamId}:avatar`)) ?? (await redis.get(`user:${userId}:avatar`)) ?? '';
      } else {
        avatarUrl = (await redis.get(`user:${userId}:avatar`)) ?? '';
      }
    } catch (err) {
      console.error(`[Avatar] Failed to fetch avatar for user ${userId} (team ${teamId}):`, err);
    }
  }

  const userData = existing ?? {
    sessionId,
    sockets: new Set<string>(),
    location: null,
    reconnectTimer: null,
    disconnectedAt: null,
    paused: false,
    sessionMode,
    sessionType,
    teamId,
    avatarUrl,
    pathBuffer: [],
    flushTimer: null,
  };

  clearReconnectTimer(userData);
  userData.sessionId = sessionId;
  userData.disconnectedAt = null;
  userData.paused = false;
  userData.sessionMode = sessionMode;
  userData.sessionType = sessionType;
  userData.teamId = teamId;
  userData.sockets.add(socket.id);
  roomMap.set(userId, userData);

  const subRoom = getSubRoom(roomId, sessionType);
  socket.join(subRoom);
  activeBySocket.set(socket.id, { roomId, userId, sessionId, sessionMode, sessionType, teamId });

  // Restart the flush timer if it was stopped during disconnect
  await startFlushTimer(sessionId, userData);

  Sentry.addBreadcrumb({
    category: 'session.lifecycle',
    message: `attachSocket: userId=${userId} sessionId=${sessionId} roomId=${roomId} wasDisconnected=${wasDisconnected} existingEntry=${!!existing}`,
    level: 'info',
  });

  // If user was disconnected/offline and is now reconnecting, tell the room they're back
  // Use socket.to() to exclude sender (prevents self-marker), skip for stealth modes
  if (wasDisconnected && userData.location && !isStealthMode(userData.sessionMode)) {
    const onlinePayload: Record<string, unknown> = {
      userId,
      ...userData.location,
      avatarUrl: userData.avatarUrl,
    };
    if (userData.sessionType === 'team' && userData.teamId != null) {
      onlinePayload.teamId = userData.teamId;
    }
    socket.to(subRoom).emit("user:online", onlinePayload);
  }
}

// ─── Detach socket ───────────────────────────────────────────────────────────

export async function detachSocket(socketId: string): Promise<void> {
  const active = activeBySocket.get(socketId);
  if (!active) return;

  const roomMap = activeUsersByRoom.get(active.roomId);
  const userData = roomMap?.get(active.userId);

  if (userData) {
    userData.sockets.delete(socketId);
    if (userData.sockets.size === 0) {
      Sentry.addBreadcrumb({
        category: 'session.lifecycle',
        message: `detachSocket (last socket): userId=${active.userId} sessionId=${active.sessionId} roomId=${active.roomId} paused=${userData.paused}`,
        level: 'info',
      });

      // Immediately tell the room this user is offline (marker should be removed)
      if (!isStealthMode(userData.sessionMode)) {
        io.to(getSubRoom(active.roomId, userData.sessionType)).emit("user:offline", { userId: active.userId });
      }
      // Insert a segment break so disconnect→reconnect doesn't draw a false line
      // (skip if already paused — pause handler already inserted a break)
      if (!userData.paused) {
        try {
          // Flush buffered points BEFORE the break marker so pre-disconnect
          // locations don't end up after the break in Redis
          await flushPathBuffer(userData.sessionId, userData);
          await pushBreakMarker(userData.sessionId);
        } catch (err) {
          console.error("Failed to flush/push break marker on disconnect:", err);
          Sentry.captureException(err, {
            tags: { event: 'detachSocket', phase: 'flush-break' },
            extra: { userId: active.userId, sessionId: active.sessionId, roomId: active.roomId },
          });
        }
      }
      scheduleSessionCleanup(active.roomId, active.userId, userData);
    }
  }

  activeBySocket.delete(socketId);
}

// ─── Redis Pub/Sub: Backend → WS session kill notifications (BUG-004 FIX) ───

/**
 * Initialize a Redis Pub/Sub subscriber that listens for session-kill
 * notifications from the backend. When the backend kills a session
 * (e.g., via completeActiveSessionsForUser), it publishes to the
 * 'session:killed' channel. The WS server receives the message and
 * immediately finalizes the session in its in-memory state.
 *
 * This ensures the WS server is never out of sync with the backend's
 * session state — resolving BUG-004.
 */
export function initSessionKilledSubscriber(): void {
  // Use a dedicated Redis connection for subscriptions (required by ioredis)
  const subscriber = createRedisConnection();

  subscriber.subscribe(REDIS_SESSION_KILLED_CHANNEL, (err) => {
    if (err) {
      console.error(`[PubSub] Failed to subscribe to ${REDIS_SESSION_KILLED_CHANNEL}:`, err);
      Sentry.captureException(err, {
        tags: { event: 'initSessionKilledSubscriber' },
      });
      return;
    }
    console.log(`[PubSub] Subscribed to channel: ${REDIS_SESSION_KILLED_CHANNEL}`);
  });

  subscriber.on('message', async (channel, message) => {
    if (channel !== REDIS_SESSION_KILLED_CHANNEL) return;

    try {
      const payload = JSON.parse(message) as { sessionId: number; userId: number };
      const { sessionId, userId } = payload;

      if (!sessionId || !userId) {
        console.warn('[PubSub] Received session:killed with missing sessionId or userId:', message);
        return;
      }

      Sentry.addBreadcrumb({
        category: 'session.pubsub',
        message: `Received session:killed: userId=${userId} sessionId=${sessionId}`,
        level: 'warning',
      });

      // Find the user's active session in memory
      const found = findUserAcrossRooms(userId);
      if (!found) {
        // Session might already be cleaned up or not on this WS instance
        console.log(`[PubSub] session:killed for userId=${userId} sessionId=${sessionId} — not found in memory`);
        return;
      }

      // Only finalize if the sessionId matches (don't kill a newer session)
      if (found.userData.sessionId === sessionId) {
        console.log(`[PubSub] Finalizing killed session ${sessionId} for userId=${userId}`);
        await finalizeSession(found.roomId, userId);
      } else {
        console.log(`[PubSub] session:killed for sessionId=${sessionId} but user has sessionId=${found.userData.sessionId} — ignoring`);
      }
    } catch (err) {
      console.error('[PubSub] Error processing session:killed message:', err);
      Sentry.captureException(err, {
        tags: { event: 'session:killed:handler' },
        extra: { rawMessage: message },
      });
    }
  });

  subscriber.on('error', (err) => {
    console.error('[PubSub] Subscriber error:', err);
    Sentry.captureException(err, {
      tags: { event: 'pubsub:subscriber:error' },
    });
  });
}
