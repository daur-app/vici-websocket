/**
 * Session-control socket event handlers: start-session, reconnect-session,
 * end-session, discard-session, session:pause, session:resume.
 */

import type { Server, Socket } from 'socket.io';
import { Sentry } from '../instrument';
import { redis } from '../redis/redis';
import type { SessionMode, SessionType } from '../types/session';
import { activeUsersByRoom, activeBySocket, getActiveUserSession } from '../session/store';
import { clearFlushTimer } from '../session/store';
import { flushPathBuffer, pushBreakMarker } from '../session/pathBuffer';
import { attachSocketToSession, finalizeSession } from '../session/lifecycle';
import { isStealthMode } from '../types/session';
import { getSubRoom } from '../session/store';

export function registerSessionHandlers(io: Server, socket: Socket, userId: number): void {
  // ── Start ────────────────────────────────────────────────────────────────

  socket.on("start-session", ({ roomId, sessionId, sessionMode, teamId }: { roomId: string; sessionId: number; sessionMode?: string; teamId?: number }) => {
    if (!roomId || !sessionId) return;
    const mode: SessionMode = (sessionMode === 'ghost' || sessionMode === 'private') ? sessionMode : 'normal';
    const type: SessionType = teamId != null ? 'team' : 'solo';

    Sentry.addBreadcrumb({
      category: 'session',
      message: `start-session: userId=${userId} sessionId=${sessionId} roomId=${roomId} mode=${mode} type=${type}`,
      level: 'info',
    });

    attachSocketToSession(socket, roomId, userId, Number(sessionId), mode, type, teamId ?? null);
  });

  // ── Reconnect ────────────────────────────────────────────────────────────

  socket.on("reconnect-session", async ({ roomId, sessionId }) => {
    if (!roomId) {
      Sentry.addBreadcrumb({
        category: 'session.reconnect',
        message: `reconnect-session FAILED: userId=${userId} reason=room-missing`,
        level: 'warning',
      });
      socket.emit("session:resume-failed", { reason: "room-missing" });
      return;
    }

    const userData = getActiveUserSession(roomId, userId);

    if (!userData) {
      // ── This is the critical failure point — log everything for debugging ──
      const allRooms = Array.from(activeUsersByRoom.keys());
      const userFoundInRooms: string[] = [];
      for (const [rid, roomMap] of activeUsersByRoom) {
        if (roomMap.has(userId)) userFoundInRooms.push(rid);
      }

      Sentry.captureMessage('reconnect-session: user not found in activeUsersByRoom', {
        level: 'warning',
        tags: {
          event: 'reconnect-session',
          reason: 'not-active',
        },
        extra: {
          userId,
          requestedRoomId: roomId,
          requestedSessionId: sessionId ?? null,
          totalRoomsTracked: allRooms.length,
          userFoundInRooms,   // shows if the user is in a DIFFERENT room
          totalActiveUsers: Array.from(activeUsersByRoom.values()).reduce((sum, m) => sum + m.size, 0),
        },
      });

      socket.emit("session:resume-failed", { reason: "not-active" });
      return;
    }

    if (sessionId && Number(sessionId) !== userData.sessionId) {
      Sentry.captureMessage('reconnect-session: session-mismatch', {
        level: 'warning',
        tags: {
          event: 'reconnect-session',
          reason: 'session-mismatch',
        },
        extra: {
          userId,
          roomId,
          requestedSessionId: Number(sessionId),
          actualSessionId: userData.sessionId,
        },
      });

      socket.emit("session:resume-failed", { reason: "session-mismatch" });
      return;
    }

    Sentry.addBreadcrumb({
      category: 'session.reconnect',
      message: `reconnect-session OK: userId=${userId} sessionId=${userData.sessionId} roomId=${roomId}`,
      level: 'info',
    });

    attachSocketToSession(socket, roomId, userId, userData.sessionId, userData.sessionMode, userData.sessionType, userData.teamId);

    socket.emit("session:resumed", {
      roomId,
      sessionId: userData.sessionId,
      location: userData.location,
      disconnectedAt: userData.disconnectedAt,
    });
  });

  // ── Pause ────────────────────────────────────────────────────────────────

  socket.on("session:pause", async () => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;

    const roomMap = activeUsersByRoom.get(active.roomId);
    if (!roomMap) return;

    const userData = roomMap.get(active.userId);
    if (!userData) return;

    // Already paused — no-op, but still acknowledge
    if (userData.paused) {
      socket.emit("session:paused", { sessionId: active.sessionId });
      return;
    }

    userData.paused = true;

    // Flush buffered points BEFORE the break marker so pre-pause
    // locations don't end up after the break in Redis
    try {
      await flushPathBuffer(active.sessionId, userData);
    } catch (err) {
      console.error("Failed to flush path buffer on pause:", err);
      Sentry.captureException(err, {
        tags: { event: 'session:pause', phase: 'flush' },
        extra: { userId, sessionId: active.sessionId },
      });
    }

    // Insert a segment break so pause→resume doesn't draw a false connecting line
    try {
      await pushBreakMarker(active.sessionId);
    } catch (err) {
      console.error("Failed to push break marker on pause:", err);
      Sentry.captureException(err, {
        tags: { event: 'session:pause', phase: 'break-marker' },
        extra: { userId, sessionId: active.sessionId },
      });
    }

    // Broadcast offline to the room so markers are removed (skip for stealth modes)
    // Use socket.to() to exclude sender (prevents self receiving user:offline)
    if (!isStealthMode(userData.sessionMode)) {
      socket.to(getSubRoom(active.roomId, userData.sessionType)).emit("user:offline", { userId: active.userId });
    }

    // Acknowledge back to the user
    socket.emit("session:paused", { sessionId: active.sessionId });
  });

  // ── Resume ───────────────────────────────────────────────────────────────

  socket.on("session:resume", () => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;

    const roomMap = activeUsersByRoom.get(active.roomId);
    if (!roomMap) return;

    const userData = roomMap.get(active.userId);
    if (!userData) return;

    // Not paused — no-op, but still acknowledge
    if (!userData.paused) {
      socket.emit("session:resumed-active", { sessionId: active.sessionId });
      return;
    }

    userData.paused = false;

    // Clear stale pre-pause location — the user may have moved km away.
    // They will reappear on the map once they send their first fresh location:update.
    userData.location = null;

    // Acknowledge back to the user
    socket.emit("session:resumed-active", { sessionId: active.sessionId });
  });

  // ── End ──────────────────────────────────────────────────────────────────

  socket.on("end-session", async () => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;

    Sentry.addBreadcrumb({
      category: 'session',
      message: `end-session: userId=${userId} sessionId=${active.sessionId} roomId=${active.roomId}`,
      level: 'info',
    });

    // Flush buffered points to Redis before finalizing
    const roomMap = activeUsersByRoom.get(active.roomId);
    const userData = roomMap?.get(active.userId);
    if (userData) {
      await flushPathBuffer(active.sessionId, userData);
      clearFlushTimer(userData);
    }

    finalizeSession(active.roomId, active.userId);
  });

  // ── Discard ──────────────────────────────────────────────────────────────

  const handleDiscardSession = async () => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;

    Sentry.addBreadcrumb({
      category: 'session',
      message: `discard-session: userId=${userId} sessionId=${active.sessionId}`,
      level: 'info',
    });

    // Clear the buffer WITHOUT flushing — data is being thrown away
    const roomMap = activeUsersByRoom.get(active.roomId);
    const userData = roomMap?.get(active.userId);
    if (userData) {
      userData.pathBuffer.length = 0;
      clearFlushTimer(userData);
    }

    try {
      await redis
        .multi()
        .del(`session:${active.sessionId}:path`)
        .del(`user:${active.userId}:avatar`)
        .exec();
    } catch (error) {
      console.error("Error deleting session data from Redis:", error);
      Sentry.captureException(error, {
        tags: { event: 'discard-session' },
        extra: { userId, sessionId: active.sessionId },
      });
    }

    // Remove the user from active tracking and notify others
    finalizeSession(active.roomId, active.userId);
  };

  socket.on("discard-session", handleDiscardSession);
  socket.on("discard-sesion", handleDiscardSession);
}
