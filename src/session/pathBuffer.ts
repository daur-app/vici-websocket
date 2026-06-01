/**
 * Path-buffer management: periodic flushing of in-memory location points
 * to Redis, and segment-break marker insertion.
 */

import { redis } from '../redis/redis';
import { Sentry } from '../instrument';
import type { ActiveUserSession } from '../types/session';
import { REDIS_TTL_SECONDS, FLUSH_INTERVAL_MS } from '../types/session';

// ─── Flush ───────────────────────────────────────────────────────────────────

/**
 * Flush the in-memory path buffer to Redis in a single RPUSH.
 * Called by the flush timer (every 10s), on end-session, and on disconnect.
 */
export async function flushPathBuffer(
  sessionId: number,
  userData: ActiveUserSession,
): Promise<void> {
  if (userData.pathBuffer.length === 0) return;

  // Drain the buffer into a local copy so new points can accumulate during the flush
  const points = userData.pathBuffer.splice(0);

  try {
    const serialized = points.map((p) => JSON.stringify(p));
    await redis.rpush(`session:${sessionId}:path`, ...serialized);
  } catch (err) {
    console.error(`[Flush] Failed to flush ${points.length} points for session ${sessionId}:`, err);
    Sentry.captureException(err, {
      tags: { event: 'flushPathBuffer' },
      extra: { sessionId, pointCount: points.length },
    });
    // Put points back at the front of the buffer so they aren't lost
    userData.pathBuffer.unshift(...points);
  }
}

// ─── Flush Timer ─────────────────────────────────────────────────────────────

/**
 * Start the periodic flush timer for a session.
 * Also sets the Redis key TTL on start (only once, not every flush).
 */
export async function startFlushTimer(
  sessionId: number,
  userData: ActiveUserSession,
): Promise<void> {
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

// ─── Break Marker ────────────────────────────────────────────────────────────

/**
 * Insert a segment break marker into the Redis path.
 * The backend splits the path at these markers to get separate segments,
 * preventing false straight lines between pause→resume or disconnect→reconnect gaps.
 */
export async function pushBreakMarker(sessionId: number, reason: "pause" | "disconnect" = "disconnect"): Promise<void> {
  const marker = JSON.stringify({ type: "break", reason, ts: Date.now() });
  await redis
    .multi()
    .rpush(`session:${sessionId}:path`, marker)
    .expire(`session:${sessionId}:path`, REDIS_TTL_SECONDS)
    .exec();
}
