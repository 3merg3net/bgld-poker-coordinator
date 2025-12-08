// src/server.ts
import { WebSocketServer } from "ws";
import type WebSocket from "ws";

import type { ClientToServerMessage } from "./types/ClientToServer";
import { PokerRoomManager } from "./rooms/PokerRoomManager";
import { BlackjackRoomManager } from "./rooms/BlackjackRoomManager";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// Separate maps for each game type
const pokerRooms = new Map<string, PokerRoomManager>();
const blackjackRooms = new Map<string, BlackjackRoomManager>();

function getPokerRoom(roomId: string): PokerRoomManager {
  let room = pokerRooms.get(roomId);
  if (!room) {
    room = new PokerRoomManager(roomId);
    pokerRooms.set(roomId, room);
  }
  return room;
}

function getBlackjackRoom(roomId: string): BlackjackRoomManager {
  let room = blackjackRooms.get(roomId);
  if (!room) {
    room = new BlackjackRoomManager(roomId);
    blackjackRooms.set(roomId, room);
  }
  return room;
}

console.log(`[Coordinator] Starting WS server on port ${PORT}`);
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (socket: WebSocket) => {
  console.log("[Coordinator] New client connected");

  let currentRoomId: string | null = null;
  let currentPlayerId: string | null = null;
  let currentKind: "poker" | "blackjack" | null = null;

  // (optional) heartbeat – keep for now
  let heartbeatTimer: NodeJS.Timeout | null = setInterval(() => {
    if (socket.readyState === socket.OPEN) {
      try {
        socket.ping();
      } catch (err) {
        console.warn("[Coordinator] ping error:", err);
      }
    }
  }, 30_000);

  socket.on("message", (data: WebSocket.RawData) => {
    let msg: ClientToServerMessage | null = null;

    try {
      msg = JSON.parse(String(data)) as ClientToServerMessage;
    } catch (err) {
      console.warn("[Coordinator] Failed to parse message:", err);
      return;
    }

    if (!msg) return;

    // We now support both poker + blackjack kinds
    if (msg.kind !== "poker" && msg.kind !== "blackjack") {
      // ignore unknown game kinds
      return;
    }

    console.log("[Coordinator] Incoming message:", msg);

    // JOIN ROOM – same shape for both games
    if (msg.type === "join-room") {
      const { roomId, playerId, kind } = msg;

      if (!roomId || !playerId) {
        console.warn("[Coordinator] join-room missing roomId/playerId");
        return;
      }

      // track what this socket belongs to
      currentRoomId = roomId;
      currentPlayerId = playerId;
      currentKind = kind;

      if (kind === "poker") {
        const room = getPokerRoom(roomId);
        room.addClient(playerId, socket, (msg as any).name);
      } else if (kind === "blackjack") {
        const room = getBlackjackRoom(roomId);
        room.addClient(playerId, socket, (msg as any).name);
      }

      return;
    }

    // Everything else gets routed to the appropriate room manager
    if (!currentRoomId || !currentPlayerId || !currentKind) {
      console.warn(
        "[Coordinator] Got message before join-room; ignoring:",
        msg
      );
      return;
    }

    if (currentKind === "poker") {
      const room = pokerRooms.get(currentRoomId);
      if (!room) {
        console.warn(
          "[Coordinator] No poker room found for",
          currentRoomId,
          "message:",
          msg
        );
        return;
      }
      room.handleMessage(msg);
    } else if (currentKind === "blackjack") {
      const room = blackjackRooms.get(currentRoomId);
      if (!room) {
        console.warn(
          "[Coordinator] No blackjack room found for",
          currentRoomId,
          "message:",
          msg
        );
        return;
      }
      room.handleMessage(msg);
    }
  });

  socket.on("close", () => {
    console.log("[Coordinator] Client disconnected");

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    if (currentRoomId && currentPlayerId && currentKind) {
      if (currentKind === "poker") {
        const room = pokerRooms.get(currentRoomId);
        room?.removeClient(currentPlayerId);
      } else if (currentKind === "blackjack") {
        const room = blackjackRooms.get(currentRoomId);
        room?.removeClient(currentPlayerId);
      }
    }
  });

  socket.on("error", (err) => {
    console.error("[Coordinator] Socket error:", err);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  });
});
