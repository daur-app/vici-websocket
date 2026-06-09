import "./instrument";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import socketAuth from "./middelware/authmiddleware";
import { setIO } from "./session/lifecycle";
import { detachSocket, initSessionKilledSubscriber } from "./session/lifecycle";
import { registerRoomHandlers } from "./handlers/roomHandlers";
import { registerSessionHandlers } from "./handlers/sessionHandlers";
import { registerLocationHandlers } from "./handlers/locationHandlers";
import { registerSocialHandlers } from "./handlers/socialHandlers";

dotenv.config();

// ─── HTTP server ─────────────────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Socket server is running");
});

// ─── Socket.IO server ───────────────────────────────────────────────────────

const io = new Server(httpServer, {});
io.use(socketAuth);

// Inject the io reference into the session lifecycle module
setIO(io);

// BUG-004 FIX: Start listening for session-kill notifications from the backend
initSessionKilledSubscriber();

// ─── Connection handler ─────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  const userId = socket.data.user?.id;
  if (!userId) {
    socket.disconnect(true);
    return;
  }

  // Register all event handlers for this socket
  registerRoomHandlers(io, socket, userId);
  registerSessionHandlers(io, socket, userId);
  registerLocationHandlers(io, socket);
  registerSocialHandlers(io, socket);

  socket.on("disconnect", () => {
    detachSocket(socket.id);
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

const HOST = "0.0.0.0";
const PORT = 3000;

httpServer.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Access from other devices using your local IP (port:${PORT})`);
});
