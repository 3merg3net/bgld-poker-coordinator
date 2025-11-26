// src/server.ts
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { ClientToServerMessage } from "./types/ClientToServer";
import { PokerRoomManager } from "./rooms/PokerRoomManager";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

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

wss.on("connection", (socket: WebSocket) => {
  console.log("[Coordinator] New WebSocket client connected");

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

      // Forward subsequent messages to the room manager
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
