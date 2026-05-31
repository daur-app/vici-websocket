/**
 * Room-related socket event handlers: join-room, leave-room.
 */

import type { Server, Socket } from 'socket.io';
import type { SessionType } from '../types/session';
import { isStealthMode } from '../types/session';
import { activeUsersByRoom, activeBySocket, getSubRoom } from '../session/store';
import { scheduleSessionCleanup } from '../session/lifecycle';

export function registerRoomHandlers(io: Server, socket: Socket, userId: number): void {
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

  socket.on("leave-room", (payload: string | { roomId: string; teamId?: number }) => {
    const roomId = typeof payload === 'string' ? payload : payload?.roomId;
    const teamId = typeof payload === 'object' ? (payload?.teamId ?? null) : null;
    if (!roomId) return;

    const sessionType: SessionType = teamId != null ? 'team' : 'solo';
    const subRoom = getSubRoom(roomId, sessionType);

    // Leave the Socket.IO sub-room
    socket.leave(subRoom);

    // If this socket has an active session in this room, clean it up
    const active = activeBySocket.get(socket.id);
    if (active && active.roomId === roomId) {
      const roomMap = activeUsersByRoom.get(roomId);
      const userData = roomMap?.get(active.userId);

      if (userData) {
        userData.sockets.delete(socket.id);

        if (userData.sockets.size === 0) {
          // Broadcast offline before cleanup (skip for stealth modes)
          if (!isStealthMode(userData.sessionMode)) {
            io.to(subRoom).emit("user:offline", { userId: active.userId });
          }
          scheduleSessionCleanup(roomId, active.userId, userData);
        }
      }

      activeBySocket.delete(socket.id);
    }

    socket.emit("room:left", { roomId });
  });
}
