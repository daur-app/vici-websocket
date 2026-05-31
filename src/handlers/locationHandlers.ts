/**
 * Location-related socket event handlers: location:update, location:sync-buffered.
 */

import type { Server, Socket } from 'socket.io';
import { redis } from '../redis/redis';
import type { Location } from '../types/session';
import { isStealthMode, REDIS_TTL_SECONDS } from '../types/session';
import { activeUsersByRoom, activeBySocket, getSubRoom } from '../session/store';
import { flushPathBuffer } from '../session/pathBuffer';

export function registerLocationHandlers(io: Server, socket: Socket): void {
  // ── Real-time location update ────────────────────────────────────────────

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

  // ── Buffered sync (after reconnect) ──────────────────────────────────────

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
}
