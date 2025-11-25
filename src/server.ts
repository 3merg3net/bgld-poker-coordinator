// src/server.ts
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { ClientToServerMessage } from "./types/ClientToServer";
import { PokerRoomManager } from "./rooms/PokerRoomManager";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

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
  console.log("🔌 [Coordinator] New WS client connected");

  let currentRoomId: string | null = null;
  let currentPlayerId: string | null = null;

  socket.on("message", (data: WebSocket.RawData) => {
    try {
      const raw = data.toString();
      const msg = JSON.parse(raw) as ClientToServerMessage;

      console.log("📥 [Coordinator] Incoming message:", msg);

      if (msg.kind !== "poker") return;

      const room = getRoom(msg.roomId);

      // First message MUST be join-room
      if (!currentRoomId || !currentPlayerId) {
        if (msg.type === "join-room") {
          currentRoomId = msg.roomId;
          currentPlayerId = msg.playerId;
          console.log(
            `🪑 [Coordinator] Player joined room: ${currentPlayerId} → ${currentRoomId}`
          );
          room.addClient(currentPlayerId, socket, (msg as any).name);
        } else {
          console.warn(
            "[Coordinator] First message must be join-room. Got:",
            msg.type
          );
          return;
        }
      }

      // Forward all in-room actions
      room.handleMessage(msg);
    } catch (err) {
      console.error("[Coordinator] ERROR parsing/handling message:", err);
    }
  });

  socket.on("close", () => {
    console.log("🔌 [Coordinator] Client disconnected");
    if (currentRoomId && currentPlayerId) {
      const room = rooms.get(currentRoomId);
      if (room) {
        room.removeClient(currentPlayerId);
      }
    }
  });

  socket.on("error", (err) => {
    console.error("[Coordinator] WS Socket Error:", err);
  });
});
