// src/server.ts
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { ClientToServerMessage } from "./types/ClientToServer";
import { PokerRoomManager } from "./rooms/PokerRoomManager";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// Extend ws type to track heartbeat state
type ExtWebSocket = WebSocket & {
  isAlive?: boolean;
};

// Keep one instance per room
const rooms = new Map<string, PokerRoomManager>();

function getRoom(roomId: string): PokerRoomManager {
  let room = rooms.get(roomId);
  if (!room) {
    room = new PokerRoomManager(roomId);
    rooms.set(roomId, room);
  }
  return room;
}

const wss = new WebSocketServer({ port: PORT });

console.log(`[Coordinator] WebSocket server listening on :${PORT}`);

// ───────────────── HEARTBEAT / KEEPALIVE ─────────────────

const HEARTBEAT_INTERVAL_MS = 30_000; // 30s ping to keep Railway/proxy happy

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((client) => {
    const socket = client as ExtWebSocket;

    // If it was already marked dead, terminate it
    if (socket.isAlive === false) {
      console.log("[Coordinator] Terminating stale client");
      return socket.terminate();
    }

    // Mark it as not alive; if we get a pong, we'll flip back to true
    socket.isAlive = false;

    try {
      socket.ping();
    } catch (err) {
      console.error("[Coordinator] Ping error, terminating client:", err);
      socket.terminate();
    }
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

// ───────────────── CONNECTION HANDLER ─────────────────

wss.on("connection", (socketRaw: WebSocket) => {
  const socket = socketRaw as ExtWebSocket;

  console.log("[Coordinator] New WebSocket client connected");

  // Init heartbeat state
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });

  let currentRoomId: string | null = null;
  let currentPlayerId: string | null = null;

  socket.on("message", (rawData: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(rawData.toString()) as ClientToServerMessage;

      // Ignore non-poker messages
      if (msg.kind !== "poker") return;

      const room = getRoom(msg.roomId);

      // First message MUST be join-room
      if (!currentRoomId || !currentPlayerId) {
        if (msg.type !== "join-room") {
          console.warn("[Coordinator] First message must be join-room.");
          return;
        }

        currentRoomId = msg.roomId;
        currentPlayerId = msg.playerId;

        // Register client with the room manager
        room.addClient(currentPlayerId, socket, (msg as any).name);

        // Room manager is responsible for sending any initial state
        return;
      }

      // Forward subsequent messages to the room manager (same signature as before)
      room.handleMessage(msg);
    } catch (err) {
      console.error("[Coordinator] Failed to process message:", err);
    }
  });

  socket.on("close", () => {
    console.log("[Coordinator] Client disconnected");
    if (currentRoomId && currentPlayerId) {
      const room = rooms.get(currentRoomId);
      room?.removeClient(currentPlayerId);
    }
  });

  socket.on("error", (err) => {
    console.error("[Coordinator] Socket error:", err);
  });
});
