/**
 * Shared type definitions and constants for the WebSocket session system.
 */

// ─── Location ────────────────────────────────────────────────────────────────

export type Location = {
  lat: number;
  lng: number;
  ts: number;
  /** Active-minute counter sent by the frontend (1, 2, 3 …). Only increments while running — pauses don't count. */
  minute?: number;
};

// ─── Session Modes ───────────────────────────────────────────────────────────

export type SessionMode = 'normal' | 'ghost' | 'private';
export type SessionType = 'solo' | 'team';

export function isStealthMode(mode: SessionMode): boolean {
  return mode === 'ghost' || mode === 'private';
}

// ─── Active User Session (in-memory representation) ──────────────────────────

export type ActiveUserSession = {
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

// ─── Socket-level tracking entry ─────────────────────────────────────────────

export type ActiveSocketEntry = {
  roomId: string;
  userId: number;
  sessionId: number;
  sessionMode: SessionMode;
  sessionType: SessionType;
  teamId: number | null;
};

// ─── Constants ───────────────────────────────────────────────────────────────

/** Grace period before a disconnected session is finalized (default 48 h). */
export const SESSION_RESUME_WINDOW_MS = Number(
  process.env.SESSION_RESUME_WINDOW_MS ?? 172_800_000,
);

/** TTL for session path keys stored in Redis (48 h). */
export const REDIS_TTL_SECONDS = 60 * 60 * 48;

/** How often the in-memory path buffer is flushed to Redis (default 10 s). */
export const FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS ?? 10_000);
