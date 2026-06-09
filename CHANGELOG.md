# Changelog

## [2026-06-07] — Session Reliability Fixes & Architecture Refactor

### 🐛 Bug Fixes

#### BUG-004: Backend → WS Session State Desynchronization

When the backend killed a session (e.g., via `completeActiveSessionsForUser`), the WS server's in-memory state was never updated — leading to ghost sessions that confused reconnect logic.

**Fix:** The WS server now subscribes to a Redis Pub/Sub channel (`session:killed`). When the backend publishes `{ sessionId, userId }`, the WS server immediately finalizes the matching in-memory session.

**Backend action required:** Publish to `session:killed` when programmatically ending sessions:

```typescript
await redis.publish('session:killed', JSON.stringify({ sessionId, userId }));
```

#### BUG-005: Redis TTL Shorter Than Resume Window

Redis path keys had a 48-hour TTL, matching the 48-hour resume window exactly. If a user reconnected near the end of the grace window, their data could have already expired.

**Fix:** Redis TTL increased to **72 hours** (24h safety buffer beyond the 48h resume window).

#### BUG-006: Ghost Sessions from Stale In-Memory State

When `start-session` was called for a user who already had an in-memory session with a *different* `sessionId` (e.g., after a backend restart issued a new session), the old session lingered as a ghost.

**Fix:** `attachSocketToSession` now checks for existing sessions with a mismatched `sessionId` across all rooms and **immediately finalizes** them before attaching the new session.

### 🔧 Changes

#### `session:resume` No Longer Broadcasts `user:online`

Previously, resuming from pause would broadcast `user:online` with the user's pre-pause location. This could show a stale marker kilometers away from their actual position.

**Now:** On resume, the last known location is **cleared**. The user reappears on the map only after sending their first `location:update` post-resume.

#### `session:pause` Now Flushes Buffer + Inserts Break Marker

Pausing now explicitly flushes the in-memory path buffer to Redis and inserts a segment break marker (`{"type":"break","reason":"pause"}`). This ensures:
- No location data is lost on pause
- The backend can split paths at break points to avoid false connecting lines

#### Sentry Error Tracking

Added `@sentry/node` integration for production error reporting. All critical paths (flush failures, Pub/Sub errors, session lifecycle issues) report to Sentry with structured breadcrumbs and context.

New env vars: `SENTRY_DSN`, `NODE_ENV` (set to `production` to enable).

### 🏗️ Architecture Refactor

The monolithic `src/index.ts` has been split into focused modules:

| Module | Responsibility |
|--------|----------------|
| `src/handlers/roomHandlers.ts` | `join-room`, `leave-room` |
| `src/handlers/sessionHandlers.ts` | `start-session`, `reconnect-session`, `end-session`, `discard-session`, `session:pause`, `session:resume` |
| `src/handlers/locationHandlers.ts` | `location:update`, `location:sync-buffered` |
| `src/handlers/socialHandlers.ts` | `user:hype` |
| `src/session/lifecycle.ts` | `attachSocketToSession`, `detachSocket`, `finalizeSession`, `scheduleSessionCleanup`, `initSessionKilledSubscriber` |
| `src/session/store.ts` | In-memory Maps, lookup helpers |
| `src/session/pathBuffer.ts` | Buffer flush, break markers |
| `src/types/session.ts` | Shared types and constants |
| `src/instrument.ts` | Sentry initialization |

### 📱 Frontend Action Required

- No frontend changes required for BUG-004/005/006 fixes — they are all server-side.
- **`session:resume` behavior change:** After resuming, the user's marker will now appear only after their first GPS update (not immediately with stale pre-pause location). Ensure your app restarts location tracking promptly on resume.

---

## [2026-05-23] — Clean Room Departure via `leave-room`

### ✨ New Features

#### `leave-room` Event (Client → Server)

Users can now cleanly exit a room without disconnecting their WebSocket connection using the `leave-room` event. This is useful when leaving a map screen but keeping the app open.

**Emit:**

```typescript
// Solo mode (backward compatible)
socket.emit("leave-room", "downtown");

// Or using an object (Solo mode)
socket.emit("leave-room", { roomId: "downtown" });

// Team mode
socket.emit("leave-room", { roomId: "downtown", teamId: 5 });
```

**What happens internally:**
1. The socket immediately leaves the Socket.IO room (`room:{roomId}:solo` or `room:{roomId}:team`).
2. If there was an active session in that room, the server cleans it up and immediately broadcasts a `user:offline` event to other users in the room (unless in ghost/private mode).
3. The server emits a `room:left` event back to the caller for confirmation.
4. The user's underlying socket connection remains open.

#### `room:left` Event (Server → Client)

Confirmation that the room was successfully left.

**Listen:**

```typescript
socket.on("room:left", (data) => {
  console.log(`Successfully left room ${data.roomId}`);
});
```

**Payload:**

```typescript
interface RoomLeftPayload {
  roomId: string;
}
```

### 📱 Frontend Action Required

- Use `leave-room` when the user navigates away from the map/territory view but you want to keep the WebSocket connection active.

---

## [2026-05-18] — Team Mode: Solo/Team Visibility Isolation

### ✨ New Features

#### Team Mode for Running Sessions

Users can now run in **team mode** or **solo mode**. The two modes are completely isolated — solo runners only see other solo runners, and team runners see all other team runners (across all teams).

**How it works:**

- **Solo mode** (default): No `teamId` provided. The user joins sub-room `room:{roomId}:solo` and only sees other solo runners.
- **Team mode**: `teamId` provided. The user joins sub-room `room:{roomId}:team` and sees **all** team runners (from any team, not just their own). The specific `teamId` is included in broadcast payloads so the frontend can distinguish teams.

**Sub-room isolation:** Instead of one shared Socket.IO room per geographical area, there are now two sub-rooms:
- `room:{roomId}:solo` — solo runners
- `room:{roomId}:team` — all team runners

This means `location:update`, `user:offline`, `user:online`, `location:snapshot`, and `user:hype` events are **isolated by mode**. A solo runner will never see a team runner's marker, and vice versa.

#### Updated `join-room` Event

`join-room` now accepts either a plain string (backward compatible, defaults to solo) or an object:

```typescript
// Solo (backward compatible)
socket.emit("join-room", "downtown");

// Solo (explicit object)
socket.emit("join-room", { roomId: "downtown" });

// Team mode — see all team runners
socket.emit("join-room", { roomId: "downtown", teamId: 5 });
```

#### Updated `start-session` Event

`start-session` now accepts an optional `teamId`:

```typescript
// Solo run
socket.emit("start-session", { roomId: "downtown", sessionId: 123 });

// Team run — broadcasts only to team sub-room
socket.emit("start-session", { roomId: "downtown", sessionId: 123, teamId: 5 });

// Ghost + team — invisible but captures territory for team 5
socket.emit("start-session", { roomId: "downtown", sessionId: 123, sessionMode: "ghost", teamId: 5 });
```

#### `teamId` in Broadcast Payloads

For team-mode runners, all outgoing events (`location:update`, `location:snapshot`, `user:online`) include a `teamId` field so the frontend can render team-specific UI (colors, labels, etc.):

```json
{ "userId": 3, "lat": 40.78, "lng": -73.96, "ts": 1706636270000, "avatarUrl": "...", "teamId": 5 }
```

For solo runners, `teamId` is **not included** in payloads (unchanged behavior).

#### Hype Isolation

`user:hype` is isolated by session type. Solo runners can only hype other solo runners, and team runners can only hype other team runners.

### 📱 Frontend Action Required

1. **Choose mode before joining:** Call `join-room` with `{ roomId, teamId }` for team mode, or plain `roomId` string for solo mode.
2. **Pass `teamId` in `start-session`:** If the user selected a team, include `teamId` in the payload.
3. **Handle `teamId` in events:** `location:snapshot`, `location:update`, and `user:online` payloads now include `teamId` for team runners. Use it for team-specific rendering (colors, labels, etc.).
4. **No changes for solo mode:** Existing solo-mode clients are fully backward compatible.

### 🔧 What Does NOT Change

- **Redis path storage** — `session:{id}:path` is unchanged (team-agnostic)
- **Avatar handling** — same `user:{userId}:avatar` key for both modes
- **Pause / Resume** — same events and logic
- **Reconnect / Grace period** — `sessionType` and `teamId` are preserved in memory
- **Session modes (ghost/private)** — still work identically
- **Buffered sync** — same mechanism

---



## [2026-04-27] — Active-Minute Counter for Per-Minute Speed Tracking

### ✨ New Features

#### `minute` field in `location:update`

The `location:update` event now accepts an optional `minute` field — an active-minute counter maintained by the frontend. This enables the backend to compute per-minute average speed for detailed session analytics (speed-over-time charts, pace analysis, etc.).

**How it works:**

1. Frontend starts a counter at `1` when the session begins
2. Counter increments by `1` every 60 seconds of **active running time**
3. Counter **freezes** on pause and **resumes** on unpause
4. Each `location:update` includes the current counter value
5. The WS server passes it through to Redis alongside `lat`, `lng`, `ts`
6. The backend groups path points by `minute` and computes speed per minute

**Emit:**

```typescript
socket.emit("location:update", {
  lat: 40.785091,
  lng: -73.968285,
  minute: 3   // 3rd active minute of the session
});
```

**Redis data shape (unchanged key, new optional field):**

```
session:12345:path → [
  '{"lat":40.785091,"lng":-73.968285,"ts":1706636270000,"minute":1}',
  '{"lat":40.785120,"lng":-73.968300,"ts":1706636332000,"minute":2}',
  ...
]
```

> The `minute` field is optional and backward-compatible. If not sent, path entries look the same as before.

### 📱 Frontend Action Required

1. **Maintain an active-minute counter** — start at `1` on session start, increment every 60s
2. **Freeze on pause** — clear the interval timer when emitting `session:pause`
3. **Resume on unpause** — restart the interval timer when emitting `session:resume`
4. **Include `minute` in every `location:update`** — `socket.emit("location:update", { lat, lng, minute })`

### 🔧 Backend Action Required

- **No changes to Redis keys** — the `minute` field is included in existing `session:{id}:path` entries
- **Add speed computation** — when processing session paths, group points by `minute`, compute haversine distance per group, derive avg speed per minute

---

## [2026-04-13] — Zero-Database WebSocket Authentication

###  Performance Improvements

#### Optimized Token Handshake
- The WebSocket server no longer queries the database via Prisma on every new connection to lookup the user.
- The server now extracts the legacy numeric `userId` directly from a **custom claim** (`userId`) configured inside the Clerk session token payload.
- This entirely eliminates the database dependency during the authentication stage, directly improving connection handshake latency and reducing load.

### ⚙️ Environment Variables Updated
- **Removed:** `DATABASE_URL` is no longer required for WebSocket authentication.

---

## [2026-04-12] — Migration to Clerk Authentication

### ✨ New Features

#### Clerk Auth Integration

The WebSocket server now uses **Clerk** for authentication, replacing the legacy custom JWT implementation.

**Key Changes:**
- Connection requests now expect a valid Clerk JWT token in the `auth` payload or `headers`.
- The server validates these tokens using `@clerk/backend`.
- Instead of extracting a numeric `userId` directly from the token, the server uses the Clerk `sub` (user string ID) to query the database via Prisma and securely resolve the legacy numeric `userId`. This ensures complete compatibility with existing Redis location caching.

### ⚙️ Environment Variables Updated

- **Removed:** `JWT_SECRET` (No longer supported).
- **Added:** `CLERK_SECRET_KEY` — Required to verify the signatures of incoming Clerk tokens.
- **Added:** `DATABASE_URL` — Required by Prisma to perform the `clerkId` -> `id` mapping.

### 📱 Frontend Action Required

1. **Update Connection Payloads** — Replace the old custom JWT token with an active Clerk token when initializing the Socket.IO client.
   ```typescript
   // Connect with Clerk Token
   const socket = io("ws://YOUR_SERVER_HOST:3000", {
     auth: { token: "your-clerk-token" }
   });
   ```

### 📦 Dependency Changes

- **Removed:** `jsonwebtoken`
- **Added:** `@clerk/backend`
- **Added:** `@prisma/client` and `@prisma/adapter-pg`

---

## [2026-04-09] — User Avatar Support via Redis Cache

### ✨ New Features

#### Avatar URLs in Real-Time Events

All location-related events now include the user's `avatarUrl` field. The avatar URL is cached in Redis by the HTTP backend when a session is created, and read by the WS server once at `start-session`. This allows the frontend to render user avatar markers on the map without any additional API calls.

**Affected events (Server → Client):**

| Event | New field |
|-------|-----------|
| `location:snapshot` | `avatarUrl: string` added to each user entry |
| `location:update` | `avatarUrl: string` added to broadcast payload |
| `user:online` | `avatarUrl: string` added to reconnect/resume payload |

**How it works:**

1. HTTP backend writes `user:{userId}:avatar` to Redis when creating a session (48h TTL)
2. WS server reads it once at `start-session` and caches in memory
3. All outgoing events include `avatarUrl` — zero extra API calls for the frontend

**New Redis key:**

| Key Pattern | Type | TTL | Description |
|-------------|------|-----|-------------|
| `user:{userId}:avatar` | String (`SET`) | 48 hours | Written by HTTP backend, read by WS server |

**Cleanup:**

- `discard-session` — explicitly deletes `user:{userId}:avatar` from Redis
- `end-session` / disconnect — key auto-expires via 48h TTL (backend writes fresh on next session)
- In-memory avatar data is always cleaned when `finalizeSession` removes the user from the room map

### 📱 Frontend Action Required

1. **Update event handlers** — `location:snapshot`, `location:update`, and `user:online` now include `avatarUrl`. Use it to render the user's avatar on map markers.
2. **No extra API calls needed** — the avatar URL comes directly with location data.
3. **Handle empty string** — if `avatarUrl` is `""`, render a default/fallback avatar.

### 🔧 Backend Action Required

Add this to your session-start route (after fetching the user from DB):

```typescript
await redis.set(
  `user:${user.id}:avatar`,
  user.avatarUrl ?? '',
  'EX',
  172800  // 48h TTL
);
```

---

## [2026-04-09] — Performance Optimizations: Buffered Writes, Dedup & Cleanup

### ⚡ Performance

#### Buffered Path Writes to Redis

Location points are no longer written to Redis on every `location:update`. They are collected in an **in-memory buffer** and flushed to Redis in a single `RPUSH` every **10 seconds** (configurable via `FLUSH_INTERVAL_MS`).

| Metric | Before | After |
|--------|:------:|:-----:|
| Redis ops per location update | 4 | 0 (buffered) |
| Redis ops per 10 seconds | 40 | ~2 (1 RPUSH + 1 EXPIRE) |
| Redis ops per 1-hour run (1pt/sec) | ~14,400 | ~720 |
| Max simultaneous runners (100 ops/sec Redis) | ~25 | ~250+ |

**Flush triggers:**
- Every 10 seconds (periodic timer)
- On `end-session` (buffer flushed before finalization)
- On `disconnect` (buffer flushed before entering grace period)
- On `discard-session` (buffer **cleared without flushing** — data discarded)

**Real-time broadcasts are NOT affected** — `location:update` events to other users still happen immediately.

#### Removed `last-location` Redis Key

The `session:{sessionId}:user:{userId}:last-location` key has been **removed entirely**. Last known location is now tracked only in memory (`userData.location`). The backend only needs `session:{id}:path` via `LRANGE` at session end.

**Savings:** Eliminates 1 `SET` command per location update.

#### Consecutive Location Deduplication

If a user sends `location:update` with the same `lat`/`lng` as their last position, it is **silently skipped**.

Applied to both:
- `location:update` — single-point check against last position
- `location:sync-buffered` — consecutive duplicate removal across the entire array

**Benefits:** Cleaner path data, smaller Redis lists, more accurate area/territory calculations.

### ⚙️ New Environment Variable

| Variable | Default | Description |
|----------|---------|-------------|
| `FLUSH_INTERVAL_MS` | `10000` (10s) | How often buffered location points are flushed to Redis |

### ⚠️ Breaking Changes

- `session:{sessionId}:user:{userId}:last-location` Redis key no longer exists. If your backend reads this key, switch to reading the last element of `session:{id}:path` instead.

---

## [2026-04-01] — Ghost & Private Session Modes + Self-Marker Bug Fix

### ✨ New Features

#### Session Modes: Ghost & Private

`start-session` now accepts an optional `sessionMode` field: `"normal"` (default), `"ghost"`, or `"private"`.

In **ghost** or **private** mode, the user is completely invisible to other room members:

- `location:update` is **not** broadcast to the room
- `user:offline` is **not** broadcast on pause, disconnect, or session end
- `user:online` is **not** broadcast on resume or reconnect
- The user is **excluded** from `location:snapshot` results
- **Data persistence is unchanged** — path and last-location are still saved to Redis normally

**Emit:**

```typescript
socket.emit("start-session", {
  roomId: "central-park-runners",
  sessionId: 12345,
  sessionMode: "ghost"    // or "private"
});
```

Both modes suppress live socket broadcasts identically, but the backend treats their session endings differently:
- **Ghost:** The user captures standard territory and area at the end of the session, but is invisible to others live.
- **Private:** The user calculates their total area but explicitly **skips** territory capture.### 🐛 Bug Fix

#### Self-marker appearing on pause/resume/reconnect

Previously, `session:pause`, `session:resume`, and reconnect logic used `io.to(room)` to broadcast `user:offline` / `user:online` events. Since `io.to()` sends to **all** sockets in the room including the sender, the user received their own events — causing the frontend to display a marker for the user on themselves after resume.

**Fix:** Changed to `socket.to(room)` which excludes the sender socket. The `user:offline` / `user:online` events are now only received by **other** users in the room.

Affected handlers:
- `session:pause` — `user:offline` no longer sent to self
- `session:resume` — `user:online` no longer sent to self
- `attachSocketToSession` (reconnect) — `user:online` no longer sent to self

> Note: `detachSocket` and `finalizeSession` still use `io.to()` — this is correct because the user's socket is already disconnected/removed at that point.

### 📱 Frontend Action Required

1. **Update `start-session` call** — pass `sessionMode` if you want ghost/private mode:
   ```typescript
   socket.emit("start-session", { roomId, sessionId, sessionMode: "ghost" });
   ```
2. **No changes needed for self-marker fix** — the server now correctly excludes the sender from `user:online` / `user:offline` broadcasts.

---

## [2026-03-23] — Session Discard Capability

### ✨ New Features

#### `discard-session` (and `discard-sesion`) Event

Users can now completely cancel and delete their session data if they choose. Sending the `"discard-session"` event clears all tracked metrics from the server.

**Emit:**

```typescript
socket.emit("discard-session"); // Or socket.emit("discard-sesion");
// No payload required
```

**What happens internally:**
1. All Redis path history for the active session (`session:{sessionId}:path`) is immediately **deleted**.
2. The user's last known location (`session:{sessionId}:user:{userId}:last-location`) is **deleted**.
3. The session ends essentially mirroring `end-session`, dropping them from the socket trackers and immediately invoking a `user:offline` trigger across the room.

---

## [2026-03-17] — Fix Ghost Locations & Immediate Offline/Online Events

### 🐛 Bug Fix

#### Disconnected users appearing in `location:snapshot`

Users who disconnected (but were within the 48-hour reconnect window) were still included in the `location:snapshot` sent to newly joining users. This caused the frontend to show "ghost" markers for users who were no longer actively connected.

**Fix:** The snapshot now filters to only include users with `sockets.size > 0` and `disconnectedAt === null` (i.e., currently connected users).

### 🔧 Changes

#### `user:offline` now fires immediately on disconnect

Previously, `user:offline` was only broadcast when the 48-hour reconnect timer expired or when a user explicitly ended their session. Now it is broadcast **immediately** when a user's last socket disconnects, so the frontend can remove the marker right away.

The session data still stays alive for the 48h reconnect window — only the visibility to other users changes.

#### New `user:online` event on reconnect

When a disconnected user reconnects within the grace period, `user:online` is broadcast to the room with their last known location:

```typescript
socket.on("user:online", (data) => {
  // data: { userId, lat, lng, ts }
  // → Re-add user marker on the map
});
```

### 📱 Frontend Action Required

1. **Listen for `user:offline`** — When received, **remove** that user's marker from the map immediately
2. **Listen for `user:online`** — When received, **re-add** that user's marker on the map at the given location
3. The `location:snapshot` (from `join-room`) now only contains currently connected users, so no frontend changes needed for that

---

## [2026-03-16] — Buffered Location Sync & Extended Reconnect Window

### ✨ New Features

#### `location:sync-buffered` Event (Client → Server)

When the WebSocket disconnects while a user is running, the frontend should buffer location updates locally. After reconnecting and resuming the session, the frontend sends the buffered array to the server.

**Emit:**

```typescript
socket.emit("location:sync-buffered", {
  locations: [
    { lat: 40.785091, lng: -73.968285, ts: 1706636270000 },
    { lat: 40.785120, lng: -73.968300, ts: 1706636272000 },
    { lat: 40.785150, lng: -73.968320, ts: 1706636274000 }
  ]
});
```

| Parameter   | Type                                    | Required | Description                                       |
|-------------|-----------------------------------------|----------|---------------------------------------------------|
| `locations` | `Array<{ lat, lng, ts }>` | ✅       | Buffered location points with client-side timestamps |

**Server behavior:**
1. Validates the socket has an active session
2. Validates `locations` is a non-empty array
3. **Deduplicates** — filters out any points with `ts <= lastKnownTimestamp` (locations the server already received before the disconnect)
4. Uses a single Redis pipeline to `RPUSH` only the new points into `session:{sessionId}:path`
5. Updates `last-location` key with the final point
6. Updates in-memory location state
7. Emits `location:sync-ack` with `{ count }` — the number of **new** points actually stored (may be less than what was sent)
8. Broadcasts the latest position to the room

> ⚠️ Buffered points use the **frontend's `ts`** (historical timestamps), unlike normal `location:update` which uses server-side `Date.now()`.

---

#### `location:sync-ack` Event (Server → Client)

Confirmation that the buffered locations were stored successfully.

**Listen:**

```typescript
socket.on("location:sync-ack", (data) => {
  console.log(`${data.count} buffered points synced`);
  // Safe to clear the local buffer now
});
```

**Payload:**

```typescript
interface SyncAckPayload {
  count: number;  // Number of buffered points that were stored
}
```

---

### 🔧 Changes

#### Reconnect Window: 30 seconds → 48 hours

The `SESSION_RESUME_WINDOW_MS` default has been changed from `30,000` (30 seconds) to `172,800,000` (48 hours). Users can now reconnect and resume a running session up to **48 hours** after disconnection.

This can still be overridden via the `SESSION_RESUME_WINDOW_MS` environment variable.

#### Redis TTL: 6 hours → 48 hours

All Redis key TTLs have been updated from 6 hours to 48 hours to match the extended reconnect window:

| Key Pattern | Old TTL | New TTL |
|-------------|---------|---------|
| `session:{sessionId}:path` | 6 hours | **48 hours** |
| `session:{sessionId}:user:{userId}:last-location` | 6 hours | **48 hours** |

---

### 📱 Frontend Reconnection Flow (Updated)

After the socket reconnects:

```
1. Socket connects (auto by Socket.IO)
2. Emit "reconnect-session" → receive "session:resumed"
3. Emit "location:sync-buffered" with buffered array → receive "location:sync-ack"
4. Clear local buffer
5. Resume normal "location:update" flow
```

**Example:**

```typescript
socket.on("session:resumed", (data) => {
  // Session restored — now sync buffered locations
  if (bufferedLocations.length > 0) {
    socket.emit("location:sync-buffered", { locations: bufferedLocations });
  }
});

socket.on("location:sync-ack", ({ count }) => {
  console.log(`Synced ${count} buffered points`);
  bufferedLocations = [];  // Clear the buffer
  // Resume normal location:update flow
});
```

---

### 📋 Updated Events Summary

| Event | Direction | Payload | Response | When to Use |
|-------|-----------|---------|----------|-------------|
| `location:sync-buffered` | Client → Server | `{ locations: [{ lat, lng, ts }, ...] }` | `location:sync-ack` → caller | After reconnect, send buffered locations |
| `location:sync-ack` | Server → Client | — | `{ count }` | Confirmation of buffered sync |

### 📋 Updated TypeScript Types

```typescript
// location:sync-buffered (sending)
interface SyncBufferedPayload {
  locations: Array<{
    lat: number;
    lng: number;
    ts: number;  // Client-side timestamp (ms)
  }>;
}

// location:sync-ack (receiving)
interface SyncAckPayload {
  count: number;
}
```
