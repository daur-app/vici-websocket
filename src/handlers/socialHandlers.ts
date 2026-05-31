/**
 * Social interaction socket event handlers: user:hype.
 */

import type { Server, Socket } from 'socket.io';
import { isStealthMode } from '../types/session';
import { activeUsersByRoom, activeBySocket, getSubRoom } from '../session/store';

export function registerSocialHandlers(io: Server, socket: Socket): void {
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
}
