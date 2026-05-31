/**
 * In-memory session stores and lookup helpers.
 *
 * Two maps are maintained:
 *  - activeUsersByRoom  : roomId  →  userId  →  ActiveUserSession
 *  - activeBySocket     : socketId  →  ActiveSocketEntry
 */

import type { ActiveUserSession, ActiveSocketEntry, SessionType } from '../types/session';

// ─── Primary stores ──────────────────────────────────────────────────────────

export const activeUsersByRoom = new Map<string, Map<number, ActiveUserSession>>();
export const activeBySocket = new Map<string, ActiveSocketEntry>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Derive the Socket.IO sub-room name used for broadcast isolation. */
export function getSubRoom(roomId: string, sessionType: SessionType): string {
  return sessionType === 'team' ? `room:${roomId}:team` : `room:${roomId}:solo`;
}

export function getOrCreateRoomMap(roomId: string): Map<number, ActiveUserSession> {
  if (!activeUsersByRoom.has(roomId)) {
    activeUsersByRoom.set(roomId, new Map());
  }
  return activeUsersByRoom.get(roomId)!;
}

export function getActiveUserSession(roomId: string, userId: number): ActiveUserSession | null {
  return activeUsersByRoom.get(roomId)?.get(userId) ?? null;
}

export function clearReconnectTimer(userData: ActiveUserSession): void {
  if (userData.reconnectTimer) {
    clearTimeout(userData.reconnectTimer);
    userData.reconnectTimer = null;
  }
}

export function clearFlushTimer(userData: ActiveUserSession): void {
  if (userData.flushTimer) {
    clearInterval(userData.flushTimer);
    userData.flushTimer = null;
  }
}
