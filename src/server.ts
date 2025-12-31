// src/server.ts
import "dotenv/config";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";

import type { ClientToServerMessage } from "./types/ClientToServer";
import { PokerRoomManager } from "./rooms/PokerRoomManager";
import { BlackjackRoomManager } from "./rooms/BlackjackRoomManager";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// Admin key (required for admin-delete-room OR bj-delete-room with adminKey)
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

/**
 * ✅ Add optional tableName/isPrivate/hostPlayerId at the coordinator layer
 * so lobby can show names cross-device (not just localStorage).
 */
type RoomMeta<T> = {
  room: T;
  lastActiveAt: number;
  tableName?: string;
  isPrivate?: boolean;

  // ✅ host ownership at coordinator layer (needed for blackjack delete)
  hostPlayerId?: string;

  // ✅ optional persisted tier display (server is source-of-truth anyway)
  minBet?: number;
  maxBet?: number;
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
  return Array.from(pokerRooms.entries())
    .map(([roomId, m]) => {
      const r: any = m.room as any;

      // Prefer standardized snapshot if your room has it
      let snap: any = null;
      if (typeof r.getSnapshot === "function") snap = r.getSnapshot();
      else if (typeof r.getLobbySummary === "function") snap = r.getLobbySummary();
      else if (typeof r.getLobbySnapshot === "function") snap = r.getLobbySnapshot();
      else {
        snap = {
          roomId,
          onlineCount: r.clients?.size ?? 0,
          seatedCount: 0,
        };
      }

      // ✅ Coordinator-known fields for cross-device lobby display
      return {
        ...snap,
        roomId: snap.roomId ?? roomId,
        tableName: m.tableName ?? null,
        isPrivate: Boolean(m.isPrivate),
      };
    })
    .filter((x) => x?.roomId && !String(x.roomId).startsWith("__"))
    .sort(
      (a, b) =>
        (b.seatedCount - a.seatedCount) || (b.onlineCount - a.onlineCount)
    );
}

function listBlackjackRooms() {
  return Array.from(blackjackRooms.entries())
    .map(([roomId, m]) => {
      const snap = m.room.getSnapshot(); // { roomId, onlineCount, seatedCount, minBet, maxBet }
      return {
        ...snap,
        roomId: snap.roomId ?? roomId,
        tableName: m.tableName ?? null,
        hostPlayerId: m.hostPlayerId ?? null,
        minBet: snap.minBet ?? m.minBet ?? null,
        maxBet: snap.maxBet ?? m.maxBet ?? null,
        isPrivate: Boolean(m.isPrivate),
      };
    })
    .filter((x) => x?.roomId && !String(x.roomId).startsWith("__"))
    .sort(
      (a, b) =>
        (b.seatedCount - a.seatedCount) || (b.onlineCount - a.onlineCount)
    );
}

// Admin delete room (duck-typed shutdown)
function adminDeleteRoom(kind: GameKind, roomId: string) {
  if (kind === "poker") {
    const meta = pokerRooms.get(roomId);
    if (!meta) return { ok: false, error: "Poker room not found" };
    const r: any = meta.room as any;
    try {
      if (typeof r.shutdown === "function") r.shutdown("Room deleted by admin");
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

// ---- Blackjack room id helper (matches parseTierFromRoomId in BlackjackRoomManager) ----

function clampInt(n: any, fallback: number) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.floor(v);
}

function makeBjRoomId(minBet: number, maxBet: number) {
  const suffix = Math.random().toString(36).slice(2, 8).toLowerCase();
  return `bj-${minBet}-${maxBet}-${suffix}`;
}

function sanitizeBjTier(minBetRaw: any, maxBetRaw: any) {
  // Reasonable server-side clamps (must match your game design)
  let minBet = clampInt(minBetRaw, 50);
  let maxBet = clampInt(maxBetRaw, 500);

  if (minBet < 1) minBet = 50;
  if (maxBet < minBet) maxBet = Math.max(minBet, 500);
  if (maxBet > 1_000_000) maxBet = 1_000_000;

  return { minBet, maxBet };
}

// ---- pruning ----

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
      safeSend(socket, {
        type: "admin-delete-room-result",
        ...res,
        kind,
        roomId,
      });
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
          displayName: "Texas Gold Room",
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
          displayName: "Big Nugget 21",
          type: "rooms-list",
          rooms: listBlackjackRooms(),
          game: "Big Nugget 21",
        });
        return;
      }

      return;
    }

    // ✅ BLACKJACK: create room (no join required)
    if (typed.kind === "blackjack" && typed.type === "bj-create-room") {
      const playerId = String((typed as any).playerId ?? "").trim();
      if (!playerId) {
        safeSend(socket, {
          kind: "blackjack",
          type: "bj-room-created",
          ok: false,
          error: "Missing playerId",
        });
        return;
      }

      const incomingName = String((typed as any).tableName ?? "").trim().slice(0, 48);
      const incomingPrivate =
        String((typed as any).private ?? "").trim() === "1" ||
        Boolean((typed as any).isPrivate);

      const { minBet, maxBet } = sanitizeBjTier(
        (typed as any).minBet,
        (typed as any).maxBet
      );

      const roomId = makeBjRoomId(minBet, maxBet);

      // Create room + meta
      const room = getBlackjackRoom(roomId);
      const meta = blackjackRooms.get(roomId);
      if (meta) {
        meta.hostPlayerId = playerId;
        meta.tableName = incomingName || "Big Nugget 21";
        meta.isPrivate = incomingPrivate;
        meta.minBet = minBet;
        meta.maxBet = maxBet;
        meta.lastActiveAt = Date.now();
      }

      // respond to creator with created id
      safeSend(socket, {
        kind: "blackjack",
        type: "bj-room-created",
        roomId,
      });

      return;
    }

    // ✅ BLACKJACK: delete room (host OR adminKey)
    if (typed.kind === "blackjack" && typed.type === "bj-delete-room") {
      const playerId = String((typed as any).playerId ?? "").trim();
      const roomId = String((typed as any).roomId ?? "").trim();
      const adminKey = String((typed as any).adminKey ?? "").trim();

      if (!playerId || !roomId) {
        safeSend(socket, {
          kind: "blackjack",
          type: "bj-delete-room-result",
          ok: false,
          roomId,
          error: "Missing playerId/roomId",
        });
        return;
      }

      const meta = blackjackRooms.get(roomId);
      if (!meta) {
        safeSend(socket, {
          kind: "blackjack",
          type: "bj-delete-room-result",
          ok: false,
          roomId,
          error: "Room not found",
        });
        return;
      }

      const isAdmin = !!ADMIN_KEY && adminKey && adminKey === ADMIN_KEY;
      const isHost = !!meta.hostPlayerId && meta.hostPlayerId === playerId;

      if (!isAdmin && !isHost) {
        safeSend(socket, {
          kind: "blackjack",
          type: "bj-delete-room-result",
          ok: false,
          roomId,
          error: "Only host (or admin) can delete this room",
        });
        return;
      }

      try {
        meta.room.shutdown(isAdmin ? "Room deleted by admin" : "Room deleted by host");
      } catch {}

      blackjackRooms.delete(roomId);

      safeSend(socket, {
        kind: "blackjack",
        type: "bj-delete-room-result",
        ok: true,
        roomId,
      });

      return;
    }

    // ✅ CREATOR/HOST: close room (poker only right now)
    if (typed.type === "close-room") {
      if (!currentRoomId || !currentPlayerId || !currentKind) {
        safeSend(socket, {
          kind: typed.kind,
          type: "close-room-result",
          ok: false,
          error: "Must join room first",
        });
        return;
      }

      const kind = currentKind;
      const roomId = currentRoomId;

      if (kind === "poker") {
        const meta = pokerRooms.get(roomId);
        if (!meta) {
          safeSend(socket, {
            kind: "poker",
            type: "close-room-result",
            ok: false,
            error: "Room not found",
          });
          return;
        }

        const r: any = meta.room as any;

        // must be host
        if (typeof r.isHost === "function" && !r.isHost(currentPlayerId)) {
          safeSend(socket, {
            kind: "poker",
            type: "close-room-result",
            ok: false,
            error: "Only the host can close this room",
          });
          return;
        }

        try {
          if (typeof r.shutdown === "function") r.shutdown("Room closed by host");
        } catch {}

        pokerRooms.delete(roomId);

        safeSend(socket, {
          kind: "poker",
          type: "close-room-result",
          ok: true,
          roomId,
        });
        return;
      }

      safeSend(socket, {
        kind: typed.kind,
        type: "close-room-result",
        ok: false,
        error: "Unsupported game",
      });
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
        // ✅ Capture tableName/private from the join message (first joiner sets it)
        const meta = pokerRooms.get(roomId);
        const incomingName = String((typed as any).tableName ?? (typed as any).name ?? "").trim();
        const incomingPrivate =
          String((typed as any).private ?? "").trim() === "1" ||
          Boolean((typed as any).isPrivate);

        if (meta) {
          if (!meta.tableName && incomingName) meta.tableName = incomingName;
          if (incomingPrivate) meta.isPrivate = true;
        }

        const room = getPokerRoom(roomId);

        // Ensure meta exists (getPokerRoom created it if absent)
        const ensured = pokerRooms.get(roomId);
        if (ensured) {
          if (!ensured.tableName && incomingName) ensured.tableName = incomingName;
          if (incomingPrivate) ensured.isPrivate = true;
        }

        (room as any).addClient(playerId, socket, (typed as any).name);
      } else if (kind === "blackjack") {
        // ✅ if someone joins a BJ room that exists, we still keep host/tableName
        const meta = blackjackRooms.get(roomId);
        const incomingName = String((typed as any).tableName ?? (typed as any).name ?? "").trim();
        const incomingPrivate =
          String((typed as any).private ?? "").trim() === "1" ||
          Boolean((typed as any).isPrivate);

        // Create room if absent
        const room = getBlackjackRoom(roomId);

        // Ensure meta exists & set host if missing (first joiner becomes host)
        const ensured = blackjackRooms.get(roomId);
        if (ensured) {
          if (!ensured.hostPlayerId) ensured.hostPlayerId = playerId;
          if (!ensured.tableName && incomingName) ensured.tableName = incomingName;
          if (incomingPrivate) ensured.isPrivate = true;

          // Store tier hint for lobby display (real min/max comes from room snapshot)
          try {
            const snap = room.getSnapshot();
            ensured.minBet = snap.minBet;
            ensured.maxBet = snap.maxBet;
          } catch {}
        }

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
