// src/server.ts
import { WebSocketServer } from "ws";
import type WebSocket from "ws";

import type { ClientToServerMessage } from "./types/ClientToServer";
import { PokerRoomManager } from "./rooms/PokerRoomManager";
import { BlackjackRoomManager } from "./rooms/BlackjackRoomManager";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// Admin key (required for admin-delete-room)
const ADMIN_KEY = (process.env.COORDINATOR_ADMIN_KEY ?? "").trim();

// Auto-prune empty rooms (optional)
const PRUNE_EMPTY_ROOMS =
  (process.env.PRUNE_EMPTY_ROOMS ?? "true").toLowerCase() === "true";
const ROOM_IDLE_MS = process.env.ROOM_IDLE_MS
  ? Number(process.env.ROOM_IDLE_MS)
  : 5 * 60_000; // 5 minutes
const PRUNE_TICK_MS = process.env.PRUNE_TICK_MS
  ? Number(process.env.PRUNE_TICK_MS)
  : 30_000; // 30s

type GameKind = "poker" | "blackjack";

type RoomMeta<T> = {
  room: T;
  lastActiveAt: number;
};

const pokerRooms = new Map<string, RoomMeta<PokerRoomManager>>();
const blackjackRooms = new Map<string, RoomMeta<BlackjackRoomManager>>();

function touchRoom(kind: GameKind, roomId: string) {
  const now = Date.now();
  if (kind === "poker") {
    const meta = pokerRooms.get(roomId);
    if (meta) meta.lastActiveAt = now;
  } else {
    const meta = blackjackRooms.get(roomId);
    if (meta) meta.lastActiveAt = now;
  }
}

function getPokerRoom(roomId: string): PokerRoomManager {
  let meta = pokerRooms.get(roomId);
  if (!meta) {
    const room = new PokerRoomManager(roomId);
    meta = { room, lastActiveAt: Date.now() };
    pokerRooms.set(roomId, meta);
  } else {
    meta.lastActiveAt = Date.now();
  }
  return meta.room;
}

function getBlackjackRoom(roomId: string): BlackjackRoomManager {
  let meta = blackjackRooms.get(roomId);
  if (!meta) {
    const room = new BlackjackRoomManager(roomId);
    meta = { room, lastActiveAt: Date.now() };
    blackjackRooms.set(roomId, meta);
  } else {
    meta.lastActiveAt = Date.now();
  }
  return meta.room;
}

function safeSend(socket: WebSocket, payload: any) {
  try {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  } catch (e) {
    console.warn("[Coordinator] send failed", e);
  }
}

function listPokerRooms() {
  return Array.from(pokerRooms.values())
    .map((m) => {
      const r: any = m.room as any;
      // Prefer standardized snapshot if your room has it
      if (typeof r.getSnapshot === "function") return r.getSnapshot();
      if (typeof r.getLobbySummary === "function") return r.getLobbySummary();
      if (typeof r.getLobbySnapshot === "function") return r.getLobbySnapshot();
      // fallback: minimal
      return {
        roomId: r.roomId,
        onlineCount: r.clients?.size ?? 0,
        seatedCount: 0,
      };
    })
    .filter((x) => x?.roomId && !String(x.roomId).startsWith("__"))
    .sort(
      (a, b) =>
        (b.seatedCount - a.seatedCount) ||
        (b.onlineCount - a.onlineCount)
    );
}

function listBlackjackRooms() {
  return Array.from(blackjackRooms.values())
    .map((m) => m.room.getSnapshot())
    .filter((x) => x?.roomId && !String(x.roomId).startsWith("__"))
    .sort(
      (a, b) =>
        (b.seatedCount - a.seatedCount) ||
        (b.onlineCount - a.onlineCount)
    );
}

// Admin delete room (duck-typed shutdown)
function adminDeleteRoom(kind: GameKind, roomId: string) {
  if (kind === "poker") {
    const meta = pokerRooms.get(roomId);
    if (!meta) return { ok: false, error: "Poker room not found" };
    const r: any = meta.room as any;
    try {
      if (typeof r.shutdown === "function") {
        r.shutdown("Room deleted by admin");
      }
    } catch {}
    pokerRooms.delete(roomId);
    return { ok: true };
  }

  const meta = blackjackRooms.get(roomId);
  if (!meta) return { ok: false, error: "Blackjack room not found" };
  try {
    meta.room.shutdown("Room deleted by admin");
  } catch {}
  blackjackRooms.delete(roomId);
  return { ok: true };
}

if (PRUNE_EMPTY_ROOMS) {
  setInterval(() => {
    const now = Date.now();

    // Poker prune
    for (const [roomId, meta] of pokerRooms.entries()) {
      const r: any = meta.room as any;
      const online =
        (typeof r.getCounts === "function" ? r.getCounts().onlineCount : null) ??
        (r.clients?.size ?? 0);

      if (online === 0 && now - meta.lastActiveAt > ROOM_IDLE_MS) {
        try {
          if (typeof r.shutdown === "function") r.shutdown("Room idle pruned");
        } catch {}
        pokerRooms.delete(roomId);
        console.log("[Coordinator] pruned poker room", roomId);
      }
    }

    // Blackjack prune
    for (const [roomId, meta] of blackjackRooms.entries()) {
      const online = meta.room.getCounts().onlineCount;
      if (online === 0 && now - meta.lastActiveAt > ROOM_IDLE_MS) {
        try {
          meta.room.shutdown("Room idle pruned");
        } catch {}
        blackjackRooms.delete(roomId);
        console.log("[Coordinator] pruned blackjack room", roomId);
      }
    }
  }, PRUNE_TICK_MS);
}

console.log(`[Coordinator] Starting WS server on port ${PORT}`);
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (socket: WebSocket) => {
  console.log("[Coordinator] New client connected");

  let currentRoomId: string | null = null;
  let currentPlayerId: string | null = null;
  let currentKind: GameKind | null = null;

  // heartbeat
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
    let msg: any = null;

    try {
      msg = JSON.parse(String(data));
    } catch (err) {
      console.warn("[Coordinator] Failed to parse message:", err);
      return;
    }

    if (!msg) return;

    // ✅ ADMIN: delete rooms (no join required)
    // Message:
    // { type:"admin-delete-room", adminKey:"...", kind:"blackjack"|"poker", roomId:"..." }
    if (msg.type === "admin-delete-room") {
      if (!ADMIN_KEY || msg.adminKey !== ADMIN_KEY) {
        safeSend(socket, {
          type: "admin-delete-room-result",
          ok: false,
          error: "Unauthorized",
        });
        return;
      }

      const kind = msg.kind as GameKind;
      const roomId = String(msg.roomId ?? "");
      if ((kind !== "poker" && kind !== "blackjack") || !roomId) {
        safeSend(socket, {
          type: "admin-delete-room-result",
          ok: false,
          error: "Invalid kind/roomId",
        });
        return;
      }

      const res = adminDeleteRoom(kind, roomId);
      safeSend(socket, { type: "admin-delete-room-result", ...res, kind, roomId });
      return;
    }

    // Only accept poker/blackjack for the normal game protocol
    if (msg.kind !== "poker" && msg.kind !== "blackjack") {
      return;
    }

    const typed = msg as ClientToServerMessage;

    // ✅ LOBBY: list rooms (no join required)
    if (typed.type === "list-rooms") {
      if (typed.kind === "poker") {
        safeSend(socket, {
          kind: "poker",
          type: "rooms-list",
          rooms: listPokerRooms(),
          blinds: "50/100",
          game: "No Limit Texas Gold Hold'em",
        });
        return;
      }

      if (typed.kind === "blackjack") {
        safeSend(socket, {
          kind: "blackjack",
          type: "rooms-list",
          rooms: listBlackjackRooms(),
          game: "Big Nugget 21",
        });
        return;
      }

      return;
    }

    // JOIN ROOM
    if (typed.type === "join-room") {
      const { roomId, playerId, kind } = typed as any;

      if (!roomId || !playerId) {
        console.warn("[Coordinator] join-room missing roomId/playerId");
        return;
      }

      currentRoomId = roomId;
      currentPlayerId = playerId;
      currentKind = kind;

      touchRoom(kind, roomId);

      if (kind === "poker") {
        const room = getPokerRoom(roomId);
        (room as any).addClient(playerId, socket, (typed as any).name);
      } else if (kind === "blackjack") {
        const room = getBlackjackRoom(roomId);
        room.addClient(playerId, socket, (typed as any).name);
      }

      return;
    }

    // Route everything else to the correct room
    if (!currentRoomId || !currentPlayerId || !currentKind) {
      console.warn("[Coordinator] Got message before join-room; ignoring:", typed);
      return;
    }

    touchRoom(currentKind, currentRoomId);

    if (currentKind === "poker") {
      const meta = pokerRooms.get(currentRoomId);
      if (!meta) {
        console.warn("[Coordinator] No poker room found for", currentRoomId);
        return;
      }
      (meta.room as any).handleMessage(typed);
      return;
    }

    const meta = blackjackRooms.get(currentRoomId);
    if (!meta) {
      console.warn("[Coordinator] No blackjack room found for", currentRoomId);
      return;
    }
    meta.room.handleMessage(typed);
  });

  socket.on("close", () => {
    console.log("[Coordinator] Client disconnected");

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    if (currentRoomId && currentPlayerId && currentKind) {
      touchRoom(currentKind, currentRoomId);

      if (currentKind === "poker") {
        const meta = pokerRooms.get(currentRoomId);
        try {
          (meta?.room as any)?.removeClient?.(currentPlayerId);
        } catch {}
      } else {
        const meta = blackjackRooms.get(currentRoomId);
        try {
          meta?.room?.removeClient(currentPlayerId);
        } catch {}
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
