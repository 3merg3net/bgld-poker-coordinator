// src/index.ts
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { PokerRoomManager } from "./rooms/PokerRoomManager";
import type { ClientToServerMessage } from "./types/ClientToServer";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

const server = http.createServer();
const wss = new WebSocketServer({ server });

const rooms = new Map<string, PokerRoomManager>();

function getRoom(roomId: string): PokerRoomManager {
  let room = rooms.get(roomId);
  if (!room) {
    room = new PokerRoomManager(roomId);
    rooms.set(roomId, room);
  }
  return room;
}

wss.on("connection", (socket: WebSocket) => {
  console.log("[Coordinator] New WebSocket client connected");

  let currentRoomId: string | null = null;
  let currentPlayerId: string | null = null;

  socket.on("message", (data) => {
    try {
      const raw = data.toString();
      const msg = JSON.parse(raw) as ClientToServerMessage;

      if (msg.kind !== "poker") return;

      const room = getRoom(msg.roomId);

      // first message must be join-room to lock in room + player
      if (!currentRoomId || !currentPlayerId) {
        if (msg.type === "join-room") {
          currentRoomId = msg.roomId;
          currentPlayerId = msg.playerId;
          room.addClient(currentPlayerId, socket);
        } else {
          socket.send(
            JSON.stringify({
              kind: "poker",
              roomId: msg.roomId,
              playerId: msg.playerId,
              type: "error",
              message: "Must join-room first",
            })
          );
          return;
        }
      }

      room.handleMessage(msg);
    } catch (err) {
      console.error("[Coordinator] Failed to parse message", err);
      socket.send(
        JSON.stringify({
          kind: "poker",
          roomId: "unknown",
          playerId: "unknown",
          type: "error",
          message: "Invalid message",
        })
      );
    }
  });

  socket.on("close", () => {
    console.log("[Coordinator] WebSocket client disconnected");
    if (currentRoomId && currentPlayerId) {
      const room = rooms.get(currentRoomId);
      room?.removeClient(currentPlayerId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[Coordinator] WebSocket server listening on :${PORT}`);
});
