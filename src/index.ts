import dotenv from "dotenv";
import { createServer } from "http";
import { Server, type Socket } from "socket.io";
import socketAuth from "./middelware/authmiddleware";
import { redis } from "./redis/redis";

dotenv.config();

const httpServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Socket server is running");
});

type Location = {
  lat: number;
  lng: number;
  ts: number;
  /** Active-minute counter sent by the frontend (1, 2, 3 …). Only increments while running — pauses don't count. */
  minute?: number;
};

type SessionMode = 'normal' | 'ghost' | 'private';
type SessionType = 'solo' | 'team';

type ActiveUserSession = {
  sessionId: number;
  sockets: Set<string>;
  location: Location | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  disconnectedAt: number | null;
  paused: boolean;
  sessionMode: SessionMode;
  sessionType: SessionType;
  teamId: number | null;
  avatarUrl: string;
  pathBuffer: Location[];
  flushTimer: ReturnType<typeof setInterval> | null;
};

function isStealthMode(mode: SessionMode): boolean {
  return mode === 'ghost' || mode === 'private';
}

const SESSION_RESUME_WINDOW_MS = Number(
  process.env.SESSION_RESUME_WINDOW_MS ?? 172_800_000, // 48 hours
);

const REDIS_TTL_SECONDS = 60 * 60 * 48; // 48 hours
const FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS ?? 10_000); // 10 seconds

const activeUsersByRoom = new Map<string, Map<number, ActiveUserSession>>();
const activeBySocket = new Map<
  string,
  { roomId: string; userId: number; sessionId: number; sessionMode: SessionMode; sessionType: SessionType; teamId: number | null }
>();

/** Derive the Socket.IO sub-room name used for broadcast isolation. */
function getSubRoom(roomId: string, sessionType: SessionType): string {
  return sessionType === 'team' ? `room:${roomId}:team` : `room:${roomId}:solo`;
}

function getOrCreateRoomMap(roomId: string) {
  if (!activeUsersByRoom.has(roomId)) {
    activeUsersByRoom.set(roomId, new Map());
  }
  return activeUsersByRoom.get(roomId)!;
}

function clearReconnectTimer(userData: ActiveUserSession) {
  if (userData.reconnectTimer) {
    clearTimeout(userData.reconnectTimer);
    userData.reconnectTimer = null;
  }
}

function clearFlushTimer(userData: ActiveUserSession) {
  if (userData.flushTimer) {
    clearInterval(userData.flushTimer);
    userData.flushTimer = null;
  }
}

/**
 * Flush the in-memory path buffer to Redis in a single RPUSH.
 * Called by the flush timer (every 10s), on end-session, and on disconnect.
 */
async function flushPathBuffer(sessionId: number, userData: ActiveUserSession) {
  if (userData.pathBuffer.length === 0) return;

  // Drain the buffer into a local copy so new points can accumulate during the flush
  const points = userData.pathBuffer.splice(0);

  try {
    const serialized = points.map((p) => JSON.stringify(p));
    await redis.rpush(`session:${sessionId}:path`, ...serialized);
  } catch (err) {
    console.error(`[Flush] Failed to flush ${points.length} points for session ${sessionId}:`, err);
    // Put points back at the front of the buffer so they aren't lost
    userData.pathBuffer.unshift(...points);
  }
}

/**
 * Start the periodic flush timer for a session.
 * Also sets the Redis key TTL on start (only once, not every flush).
 */
async function startFlushTimer(sessionId: number, userData: ActiveUserSession) {
  if (userData.flushTimer) return; // already running

  // Set TTL once when the timer starts (key may or may not exist yet — EXPIRE is safe either way)
  try {
    await redis.expire(`session:${sessionId}:path`, REDIS_TTL_SECONDS);
  } catch {
    // Non-critical, TTL will be set on next opportunity
  }

  userData.flushTimer = setInterval(async () => {
    await flushPathBuffer(sessionId, userData);

    // Refresh TTL periodically (every flush) to keep the key alive during long sessions
    try {
      await redis.expire(`session:${sessionId}:path`, REDIS_TTL_SECONDS);
    } catch {
      // Non-critical
    }
  }, FLUSH_INTERVAL_MS);
}

/**
 * Insert a segment break marker into the Redis path.
 * The backend splits the path at these markers to get separate segments,
 * preventing false straight lines between pause→resume or disconnect→reconnect gaps.
 */
async function pushBreakMarker(sessionId: number) {
  const marker = JSON.stringify({ type: "break", ts: Date.now() });
  await redis
    .multi()
    .rpush(`session:${sessionId}:path`, marker)
    .expire(`session:${sessionId}:path`, REDIS_TTL_SECONDS)
    .exec();
}

async function scheduleSessionCleanup(
  roomId: string,
  userId: number,
  userData: ActiveUserSession,
) {
  clearReconnectTimer(userData);
  userData.disconnectedAt = Date.now();

  // Stop the flush timer first — no new timer-driven flushes should fire
  clearFlushTimer(userData);

  // Flush any remaining buffered points before entering grace period
  try {
    await flushPathBuffer(userData.sessionId, userData);
  } catch (err) {
    console.error(`[Flush] Error flushing on disconnect for user ${userId}:`, err);
  }

  userData.reconnectTimer = setTimeout(() => {
    finalizeSession(roomId, userId);
  }, SESSION_RESUME_WINDOW_MS);
}

async function finalizeSession(roomId: string, userId: number) {
  const roomMap = activeUsersByRoom.get(roomId);
  const userData = roomMap?.get(userId);
  if (!roomMap || !userData) return;

  clearReconnectTimer(userData);
  clearFlushTimer(userData);

  // Final flush — ensure any remaining buffered points are written to Redis
  // Must await so userData is not deleted while a flush is still in-flight
  try {
    await flushPathBuffer(userData.sessionId, userData);
  } catch (err) {
    console.error(`[Flush] Error on finalizeSession for user ${userId}:`, err);
  }

  for (const socketId of userData.sockets) {
    activeBySocket.delete(socketId);
    io.sockets.sockets.get(socketId)?.leave(getSubRoom(roomId, userData.sessionType));
  }

  roomMap.delete(userId);
  if (roomMap.size === 0) {
    activeUsersByRoom.delete(roomId);
  }

  if (!isStealthMode(userData.sessionMode)) {
    io.to(getSubRoom(roomId, userData.sessionType)).emit("user:offline", { userId });
  }
}

async function detachSocket(socketId: string) {
  const active = activeBySocket.get(socketId);
  if (!active) return;

  const roomMap = activeUsersByRoom.get(active.roomId);
  const userData = roomMap?.get(active.userId);

  if (userData) {
    userData.sockets.delete(socketId);
    if (userData.sockets.size === 0) {
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
        }
      }
      scheduleSessionCleanup(active.roomId, active.userId, userData);
    }
  }

  activeBySocket.delete(socketId);
}

async function attachSocketToSession(
  socket: Socket,
  roomId: string,
  userId: number,
  sessionId: number,
  sessionMode: SessionMode = 'normal',
  sessionType: SessionType = 'solo',
  teamId: number | null = null,
) {
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

function getActiveUserSession(roomId: string, userId: number) {
  return activeUsersByRoom.get(roomId)?.get(userId) ?? null;
}

const io = new Server(httpServer, {});
io.use(socketAuth);

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  const userId = socket.data.user?.id;
  if (!userId) {
    socket.disconnect(true);
    return;
  }

  socket.on("join-room", (payload: string | { roomId: string; teamId?: number }) => {
    // Backward compatible: accept plain string (solo) or object (with optional teamId)
    const roomId = typeof payload === 'string' ? payload : payload?.roomId;
    const teamId = typeof payload === 'object' ? (payload?.teamId ?? null) : null;
    if (!roomId) return;

    const sessionType: SessionType = teamId != null ? 'team' : 'solo';
    const subRoom = getSubRoom(roomId, sessionType);
    socket.join(subRoom);

    const roomMap = activeUsersByRoom.get(roomId);
    const snapshot = roomMap
      ? Array.from(roomMap.entries())
        .filter(([, data]) =>
          data.sockets.size > 0 &&
          data.disconnectedAt === null &&
          !data.paused &&
          !isStealthMode(data.sessionMode) &&
          data.sessionType === sessionType
        )
        .map(([uid, data]) => {
          if (!data.location) return null;
          const entry: Record<string, unknown> = { userId: uid, ...data.location, avatarUrl: data.avatarUrl };
          if (data.sessionType === 'team' && data.teamId != null) {
            entry.teamId = data.teamId;
          }
          return entry;
        })
        .filter(Boolean)
      : [];

    socket.emit("location:snapshot", snapshot);
  });

  socket.on("start-session", ({ roomId, sessionId, sessionMode, teamId }: { roomId: string; sessionId: number; sessionMode?: string; teamId?: number }) => {
    if (!roomId || !sessionId) return;
    const mode: SessionMode = (sessionMode === 'ghost' || sessionMode === 'private') ? sessionMode : 'normal';
    const type: SessionType = teamId != null ? 'team' : 'solo';
    attachSocketToSession(socket, roomId, userId, Number(sessionId), mode, type, teamId ?? null);
  });

  // Frontend reconnect event: verify user is still active in room, then rebind socket and restore location state.
  socket.on("reconnect-session", async ({ roomId, sessionId }) => {
    if (!roomId) {
      socket.emit("session:resume-failed", { reason: "room-missing" });
      return;
    }

    const userData = getActiveUserSession(roomId, userId);
    if (!userData) {
      socket.emit("session:resume-failed", { reason: "not-active" });
      return;
    }

    if (sessionId && Number(sessionId) !== userData.sessionId) {
      socket.emit("session:resume-failed", { reason: "session-mismatch" });
      return;
    }

    attachSocketToSession(socket, roomId, userId, userData.sessionId, userData.sessionMode, userData.sessionType, userData.teamId);

    socket.emit("session:resumed", {
      roomId,
      sessionId: userData.sessionId,
      location: userData.location,
      disconnectedAt: userData.disconnectedAt,
    });
  });

  // Frontend sends buffered locations collected while disconnected
  socket.on(
    "location:sync-buffered",
    async ({ locations }: { locations: Array<{ lat: number; lng: number; ts: number }> }) => {
      const active = activeBySocket.get(socket.id);
      if (!active) return;

      if (!Array.isArray(locations) || locations.length === 0) return;

      const roomMap = activeUsersByRoom.get(active.roomId);
      if (!roomMap) return;

      const userData = roomMap.get(active.userId);
      if (!userData) return;

      // Filter out locations the server already has (deduplicate by timestamp)
      const lastKnownTs = userData.location?.ts ?? 0;
      const newLocations = locations.filter((loc) => loc.ts > lastKnownTs);
      if (newLocations.length === 0) {
        socket.emit("location:sync-ack", { count: 0 });
        return;
      }

      // Remove consecutive duplicates (same lat/lng as previous point)
      const deduped: typeof newLocations = [];
      let prevLat = userData.location?.lat;
      let prevLng = userData.location?.lng;
      for (const loc of newLocations) {
        if (loc.lat !== prevLat || loc.lng !== prevLng) {
          deduped.push(loc);
          prevLat = loc.lat;
          prevLng = loc.lng;
        }
      }
      if (deduped.length === 0) {
        socket.emit("location:sync-ack", { count: 0 });
        return;
      }

      // Flush any existing buffered points first so we preserve chronological order
      // (buffered points are older than the sync-buffered batch arriving now)
      await flushPathBuffer(active.sessionId, userData);

      // Sync-buffered writes directly to Redis (already a single batch from the frontend)
      const pipeline = redis.multi();
      for (const loc of deduped) {
        const point: Location = { lat: loc.lat, lng: loc.lng, ts: loc.ts };
        pipeline.rpush(`session:${active.sessionId}:path`, JSON.stringify(point));
      }
      pipeline.expire(`session:${active.sessionId}:path`, REDIS_TTL_SECONDS);

      await pipeline.exec();

      // Update in-memory last location with the final deduplicated point
      const lastPoint = deduped[deduped.length - 1]!;
      userData.location = {
        lat: lastPoint.lat,
        lng: lastPoint.lng,
        ts: lastPoint.ts,
      };
      socket.emit("location:sync-ack", { count: deduped.length });
      if (!isStealthMode(active.sessionMode)) {
        const syncPayload: Record<string, unknown> = {
          userId: active.userId,
          ...userData.location,
          avatarUrl: userData.avatarUrl,
        };
        if (active.sessionType === 'team' && active.teamId != null) {
          syncPayload.teamId = active.teamId;
        }
        socket.to(getSubRoom(active.roomId, active.sessionType)).emit("location:update", syncPayload);
      }
    },
  );

  socket.on("location:update", ({ lat, lng, minute }: { lat: number; lng: number; minute?: number }) => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;

    const roomMap = activeUsersByRoom.get(active.roomId);
    if (!roomMap) return;

    const userData = roomMap.get(active.userId);
    if (!userData) return;

    if (userData.paused) return;

    // Skip if location is identical to the last known position
    if (userData.location && userData.location.lat === lat && userData.location.lng === lng) return;

    const point: Location = { lat, lng, ts: Date.now() };
    if (minute != null) point.minute = minute;

    userData.location = point;

    // Push to in-memory buffer (flushed to Redis every FLUSH_INTERVAL_MS)
    userData.pathBuffer.push(point);

    // Broadcast to sub-room immediately (real-time markers are unaffected by buffering)
    if (!isStealthMode(active.sessionMode)) {
      const locPayload: Record<string, unknown> = {
        userId: active.userId,
        ...point,
        avatarUrl: userData.avatarUrl,
      };
      if (active.sessionType === 'team' && active.teamId != null) {
        locPayload.teamId = active.teamId;
      }
      socket.to(getSubRoom(active.roomId, active.sessionType)).emit("location:update", locPayload);
    }
  });

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
    }

    // Insert a segment break so pause→resume doesn't draw a false connecting line
    try {
      await pushBreakMarker(active.sessionId);
    } catch (err) {
      console.error("Failed to push break marker on pause:", err);
    }

    // Broadcast offline to the room so markers are removed (skip for stealth modes)
    // Use socket.to() to exclude sender (prevents self receiving user:offline)
    if (!isStealthMode(userData.sessionMode)) {
      socket.to(getSubRoom(active.roomId, userData.sessionType)).emit("user:offline", { userId: active.userId });
    }

    // Acknowledge back to the user
    socket.emit("session:paused", { sessionId: active.sessionId });
  });

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

  socket.on("end-session", async () => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;

    // Flush buffered points to Redis before finalizing
    const roomMap = activeUsersByRoom.get(active.roomId);
    const userData = roomMap?.get(active.userId);
    if (userData) {
      await flushPathBuffer(active.sessionId, userData);
      clearFlushTimer(userData);
    }

    finalizeSession(active.roomId, active.userId);
  });

  const handleDiscardSession = async () => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;

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
    }

    // Remove the user from active tracking and notify others
    finalizeSession(active.roomId, active.userId);
  };

  socket.on("discard-session", handleDiscardSession);
  socket.on("discard-sesion", handleDiscardSession);

  socket.on("user:hype", ({ targetUserId }: { targetUserId: number }) => {
    const active = activeBySocket.get(socket.id);
    if (!active) return;

    if (!isStealthMode(active.sessionMode)) {
      const roomMap = activeUsersByRoom.get(active.roomId);
      const targetUser = roomMap?.get(targetUserId);

      // Only allow if target is actively in the room, in normal mode, and in the same session type
      if (targetUser && !isStealthMode(targetUser.sessionMode) && targetUser.sessionType === active.sessionType) {
        socket.to(getSubRoom(active.roomId, active.sessionType)).emit("user:hype", {
          senderId: active.userId,
          targetUserId,
        });
      }
    }
  });


  socket.on("disconnect", () => {
    detachSocket(socket.id);
  });
});

const HOST = "0.0.0.0";
const PORT = 3000;

httpServer.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Access from other devices using your local IP (port:${PORT})`);
});
