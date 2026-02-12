// src/server.ts
import "dotenv/config";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";

import type { ClientToServerMessage } from "./types/ClientToServer";
import { PokerRoomManager } from "./rooms/PokerRoomManager";
import { BlackjackRoomManager } from "./rooms/BlackjackRoomManager";
import { TournamentDirector } from "./tournaments/TournamentDirector";

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
const tournaments = new TournamentDirector();

/**
 * ✅ Track tournament lobby sockets so all registered players receive
 * `tournament-start-result` and can auto-route to their assigned table.
 *
 * tournamentId -> (playerId -> socket)
 */
const tournamentSockets = new Map<string, Map<string, WebSocket>>();

function trackTournamentSocket(
  tournamentId: string,
  playerId: string,
  socket: WebSocket
) {
  if (!tournamentId || !playerId) return;
  let byPlayer = tournamentSockets.get(tournamentId);
  if (!byPlayer) {
    byPlayer = new Map();
    tournamentSockets.set(tournamentId, byPlayer);
  }
  byPlayer.set(playerId, socket);
}

function untrackSocket(socket: WebSocket) {
  for (const [tid, byPlayer] of tournamentSockets.entries()) {
    for (const [pid, s] of byPlayer.entries()) {
      if (s === socket) byPlayer.delete(pid);
    }
    if (byPlayer.size === 0) tournamentSockets.delete(tid);
  }
}

function broadcastTournament(tournamentId: string, payload: any) {
  const byPlayer = tournamentSockets.get(tournamentId);
  if (!byPlayer) return;
  for (const s of byPlayer.values()) safeSend(s, payload);
}

/* ──────────────────────────────────────────────────────────────
   Reconnect grace timers (Coordinator-side)
   - Keeps seats on short disconnects (mobile background / wifi flips)
   - Requires PokerRoomManager.removeClient(playerId, reason)
     where reason "disconnect" keeps seat, and "timeout" clears/cashout.
   ────────────────────────────────────────────────────────────── */

const POKER_RECONNECT_GRACE_MS =
  Number(process.env.POKER_RECONNECT_GRACE_MS ?? "") || 120_000; // 2 min
const BJ_RECONNECT_GRACE_MS =
  Number(process.env.BJ_RECONNECT_GRACE_MS ?? "") || 20_000; // optional

// roomId -> playerId -> timeout handle
const pokerDisconnectTimers = new Map<string, Map<string, NodeJS.Timeout>>();
const bjDisconnectTimers = new Map<string, Map<string, NodeJS.Timeout>>();

function scheduleDisconnectRemoval(
  store: Map<string, Map<string, NodeJS.Timeout>>,
  roomId: string,
  playerId: string,
  ms: number,
  fn: () => void
) {
  if (!roomId || !playerId) return;

  let perRoom = store.get(roomId);
  if (!perRoom) {
    perRoom = new Map();
    store.set(roomId, perRoom);
  }

  const existing = perRoom.get(playerId);
  if (existing) clearTimeout(existing);

  const t = setTimeout(() => {
    try {
      fn();
    } finally {
      const pr = store.get(roomId);
      pr?.delete(playerId);
      if (pr && pr.size === 0) store.delete(roomId);
    }
  }, ms);

  perRoom.set(playerId, t);
}

function cancelDisconnectRemoval(
  store: Map<string, Map<string, NodeJS.Timeout>>,
  roomId: string,
  playerId: string
) {
  if (!roomId || !playerId) return;

  const perRoom = store.get(roomId);
  const t = perRoom?.get(playerId);
  if (t) clearTimeout(t);

  perRoom?.delete(playerId);
  if (perRoom && perRoom.size === 0) store.delete(roomId);
}

function schedulePokerDisconnectRemoval(roomId: string, playerId: string) {
  scheduleDisconnectRemoval(
    pokerDisconnectTimers,
    roomId,
    playerId,
    POKER_RECONNECT_GRACE_MS,
    () => {
      const meta = pokerRooms.get(roomId);
      try {
        // ✅ after grace expires: hard remove (clear seat + cashout)
        (meta?.room as any)?.removeClient?.(playerId, "timeout");
      } catch {}
    }
  );
}

function cancelPokerDisconnectRemoval(roomId: string, playerId: string) {
  cancelDisconnectRemoval(pokerDisconnectTimers, roomId, playerId);
}

// optional: if you also want BJ to be forgiving on mobile
function scheduleBjDisconnectRemoval(roomId: string, playerId: string) {
  scheduleDisconnectRemoval(
    bjDisconnectTimers,
    roomId,
    playerId,
    BJ_RECONNECT_GRACE_MS,
    () => {
      const meta = blackjackRooms.get(roomId);
      try {
        // if your BJ supports reason, keep it; else it will be ignored
        (meta?.room as any)?.removeClient?.(playerId, "timeout");
      } catch {
        try {
          meta?.room?.removeClient?.(playerId);
        } catch {}
      }
    }
  );
}

function cancelBjDisconnectRemoval(roomId: string, playerId: string) {
  cancelDisconnectRemoval(bjDisconnectTimers, roomId, playerId);
}

/* ────────────────────────────────────────────────────────────── */

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

function isTournamentRoomId(roomId: string) {
  return String(roomId).startsWith("tourn-"); // matches TournamentDirector tableRoomId ids
}

function getPokerRoom(roomId: string): PokerRoomManager {
  let meta = pokerRooms.get(roomId);
  if (!meta) {
    const room = new PokerRoomManager(roomId, {
      mode: isTournamentRoomId(roomId) ? "tournament" : "cash",
    });
    meta = { room, lastActiveAt: Date.now() };
    pokerRooms.set(roomId, meta);
  } else {
    meta.lastActiveAt = Date.now();
  }
  return meta.room;
}

function isTournamentTableRoomId(roomId: string) {
  const id = String(roomId || "");
  // TournamentDirector tables are `${tournId}-t${n}`
  return id.startsWith("tourn-") && /-t\d+$/.test(id);
}

// ✅ Force-create with explicit mode (used for assigned tableRoomId)
function getPokerRoomWithMode(
  roomId: string,
  mode: "cash" | "tournament"
): PokerRoomManager {
  let meta = pokerRooms.get(roomId);
  if (!meta) {
    const room = new PokerRoomManager(roomId, { mode });
    meta = { room, lastActiveAt: Date.now() };
    pokerRooms.set(roomId, meta);
  } else {
    meta.lastActiveAt = Date.now();
    // NOTE: we do NOT hot-switch existing room mode.
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

function listPokerRoomsCash() {
  return Array.from(pokerRooms.entries())
    .map(([roomId, m]) => {
      const r: any = m.room as any;

      let snap: any = null;
      if (typeof r.getSnapshot === "function") snap = r.getSnapshot();
      else snap = { roomId, onlineCount: r.clients?.size ?? 0, seatedCount: 0 };

      return {
        ...snap,
        roomId: snap.roomId ?? roomId,
        tableName: m.tableName ?? null,
        isPrivate: Boolean(m.isPrivate),
      };
    })
    .filter((x) => {
      const id = String(x?.roomId ?? "");
      if (!id || id.startsWith("__")) return false;
      // ✅ cash = NOT tournament id and NOT tournament table
      if (id.startsWith("tourn-")) return false;
      return true;
    })
    .sort((a, b) => b.seatedCount - a.seatedCount || b.onlineCount - a.onlineCount);
}

function listPokerRoomsTournamentTables() {
  return Array.from(pokerRooms.entries())
    .map(([roomId, m]) => {
      const r: any = m.room as any;

      let snap: any = null;
      if (typeof r.getSnapshot === "function") snap = r.getSnapshot();
      else snap = { roomId, onlineCount: r.clients?.size ?? 0, seatedCount: 0 };

      return {
        ...snap,
        roomId: snap.roomId ?? roomId,
        tableName: m.tableName ?? null,
        isPrivate: Boolean(m.isPrivate),
      };
    })
    .filter((x) => {
      const id = String(x?.roomId ?? "");
      if (!id || id.startsWith("__")) return false;
      // ✅ tournament tables only
      return isTournamentTableRoomId(id);
    })
    .sort((a, b) => b.seatedCount - a.seatedCount || b.onlineCount - a.onlineCount);
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
    .sort((a, b) => b.seatedCount - a.seatedCount || b.onlineCount - a.onlineCount);
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
    const raw = msg as any; // ✅ avoids TS union narrowing for new message types

    // ✅ LOBBY: list rooms (no join required)
    if (typed.type === "list-rooms") {
      if (typed.kind === "poker") {
        const cashRooms = listPokerRoomsCash();
        const tourneyTables = listPokerRoomsTournamentTables();

        safeSend(socket, {
          kind: "poker",
          displayName: "Texas Gold Room",
          type: "rooms-list",
          rooms: cashRooms, // ✅ cash only
          tournamentTables: tourneyTables, // ✅ tournament tables only
          blinds: "50/100",
          game: "No Limit Texas Gold Hold'em",
        });

        return;
      }

      if (typed.kind === "blackjack") {
        safeSend(socket, {
          kind: "blackjack",
          displayName: "Blackjack",
          type: "rooms-list",
          rooms: listBlackjackRooms(),
        });
        return;
      }
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
      getBlackjackRoom(roomId);
      const meta = blackjackRooms.get(roomId);
      if (meta) {
        meta.hostPlayerId = playerId;
        meta.tableName = incomingName || "Big Nugget 21";
        meta.isPrivate = incomingPrivate;
        meta.minBet = minBet;
        meta.maxBet = maxBet;
        meta.lastActiveAt = Date.now();
      }

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

    // ✅ TOURNAMENT: create (no join required)
    if (raw.kind === "poker" && raw.type === "tournament-create") {
      const playerId = String(raw.playerId ?? "").trim();
      if (!playerId) {
        safeSend(socket, {
          kind: "poker",
          type: "tournament-created",
          ok: false,
          error: "Missing playerId",
        });
        return;
      }

      const buyIn = Number(raw.buyIn ?? 0);
      const startingStack = Number(raw.startingStack ?? 0);
      const seatsPerTable = Number(raw.seatsPerTable ?? 9);
      const isPrivate = Boolean(raw.isPrivate);
      const minPlayers = Number(raw.minPlayers ?? 2);

      if (
        !Number.isFinite(buyIn) ||
        buyIn <= 0 ||
        !Number.isFinite(startingStack) ||
        startingStack <= 0
      ) {
        safeSend(socket, {
          kind: "poker",
          type: "tournament-created",
          ok: false,
          error: "Invalid buyIn/startingStack",
        });
        return;
      }

      const { tournamentId } = tournaments.createTournament({
        hostPlayerId: playerId,
        tournamentName: String(raw.tournamentName ?? "Tournament"),
        buyIn,
        startingStack,
        seatsPerTable,
        isPrivate,
        minPlayers,
        maxTables: Number(raw.maxTables ?? 5),
      } as any);

      // auto-register creator
      tournaments.registerPlayer(tournamentId, playerId);

      // ✅ track creator socket for start routing
      trackTournamentSocket(tournamentId, playerId, socket);

      safeSend(socket, {
        kind: "poker",
        type: "tournament-created",
        ok: true,
        tournamentId,
      });

      return;
    }

    // ✅ TOURNAMENT: join (register only; no join-room required)
    if (raw.kind === "poker" && raw.type === "tournament-join") {
      const playerId = String(raw.playerId ?? "").trim();
      const tournamentId = String(raw.tournamentId ?? "").trim();

      if (!playerId || !tournamentId) {
        safeSend(socket, {
          kind: "poker",
          type: "tournament-join-result",
          ok: false,
          tournamentId: tournamentId || "unknown",
          error: "Missing playerId/tournamentId",
        });
        return;
      }

      const res = tournaments.registerPlayer(tournamentId, playerId);
      if (!res.ok) {
        safeSend(socket, {
          kind: "poker",
          type: "tournament-join-result",
          ok: false,
          tournamentId,
          error: res.error,
        });
        return;
      }

      // ✅ track joiner socket for start routing
      trackTournamentSocket(tournamentId, playerId, socket);

      const cfg = tournaments.getTournamentConfig(tournamentId);

      safeSend(socket, {
        kind: "poker",
        type: "tournament-join-result",
        ok: true,
        tournamentId,

        // surface join outcome
        registeredCount: (res as any).registeredCount ?? null,
        waitlistedCount: (res as any).waitlistedCount ?? 0,
        cap: (res as any).cap ?? null,
        isRegistered: (res as any).isRegistered ?? true,
        isWaitlisted: (res as any).isWaitlisted ?? false,

        // keep config
        config: cfg,
      } as any);

      return;
    }

    // ✅ TOURNAMENT: start (host only)
    if (raw.kind === "poker" && raw.type === "tournament-start") {
      const playerId = String(raw.playerId ?? "").trim();
      const tournamentId = String(raw.tournamentId ?? "").trim();
      if (!playerId || !tournamentId) return;

      const res = tournaments.startTournament(tournamentId, playerId) as any;
      if (!res.ok) {
        safeSend(socket, {
          kind: "poker",
          type: "tournament-start-result",
          ok: false,
          tournamentId,
          error: res.error,
        });
        return;
      }

      const cfg = tournaments.getTournamentConfig(tournamentId);
      const assignments = (res.assignments ?? []) as Array<{
        tableRoomId: string;
        players: string[];
      }>;

      // ✅ ensure all rooms exist + set config + allowlist
      for (const a of assignments) {
        const room = getPokerRoomWithMode(a.tableRoomId, "tournament");
        (room as any).setTournamentConfig?.(cfg);
        (room as any).setTournamentAllowList?.(a.players);
      }

      const payload = {
        kind: "poker",
        type: "tournament-start-result",
        ok: true,
        tournamentId,
        assignments,
        config: cfg,
      } as any;

      safeSend(socket, payload);
      broadcastTournament(tournamentId, payload);

      return;
    }

    // ✅ TOURNAMENT: list (for tournament lobby page)
    if (raw.kind === "poker" && raw.type === "tournament-list") {
      safeSend(socket, {
        kind: "poker",
        type: "tournament-list-result",
        tournaments: tournaments.listTournaments(),
      } as any);
      return;
    }

    // ✅ POKER: create room (no join required)
    if (typed.kind === "poker" && typed.type === "poker-create-room") {
      const roomId = String((typed as any).roomId ?? "").trim();
      const tableName = String((typed as any).tableName ?? "").trim().slice(0, 48);
      const incomingPrivate =
        String((typed as any).private ?? "").trim() === "1" ||
        Boolean((typed as any).isPrivate);

      if (!roomId) {
        safeSend(socket, {
          kind: "poker",
          type: "poker-create-room-result",
          ok: false,
          error: "Missing roomId",
        });
        return;
      }

      const inferredMode: "cash" | "tournament" = isTournamentTableRoomId(roomId)
        ? "tournament"
        : "cash";

      getPokerRoomWithMode(roomId, inferredMode);

      const meta = pokerRooms.get(roomId);
      if (meta) {
        meta.tableName = tableName || meta.tableName || "Gold Table";
        meta.isPrivate = incomingPrivate;
        meta.lastActiveAt = Date.now();
      }

      safeSend(socket, {
        kind: "poker",
        type: "poker-create-room-result",
        ok: true,
        roomId,
        tableName: meta?.tableName ?? null,
        isPrivate: Boolean(meta?.isPrivate),
      });

      return;
    }

    // JOIN ROOM (explicit)
    if (typed.type === "join-room") {
      const { roomId, playerId, kind } = typed as any;

      if (!roomId || !playerId) {
        console.warn("[Coordinator] join-room missing roomId/playerId");
        return;
      }

      // ✅ cancel pending grace cleanup now that they’re back
      if (kind === "poker") cancelPokerDisconnectRemoval(String(roomId), String(playerId));
      if (kind === "blackjack") cancelBjDisconnectRemoval(String(roomId), String(playerId));

      currentRoomId = roomId;
      currentPlayerId = playerId;
      currentKind = kind;

      touchRoom(kind, roomId);

      if (kind === "poker") {
        // Capture tableName/private from the join message (first joiner sets it)
        const meta = pokerRooms.get(roomId);
        const incomingName = String(
          (typed as any).tableName ?? (typed as any).name ?? ""
        )
          .trim()
          .slice(0, 48);

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

        // ✅ reconnect path (don’t overwrite seats / identity)
        try {
          const known =
            typeof (room as any).hasKnownPlayer === "function"
              ? (room as any).hasKnownPlayer(playerId)
              : false;

          if (known && typeof (room as any).reconnectClient === "function") {
            (room as any).reconnectClient(playerId, socket, (typed as any).name, {
              tableName: (typed as any).tableName,
              private: (typed as any).private ?? (typed as any).isPrivate,
            });
            return;
          }
        } catch {}

        // ✅ Normal first-time join
        (room as any).addClient(playerId, socket, (typed as any).name, {
          tableName: (typed as any).tableName,
          private: (typed as any).private ?? (typed as any).isPrivate,
        });

        return;
      }

      // blackjack join
      if (kind === "blackjack") {
        const incomingName = String(
          (typed as any).tableName ?? (typed as any).name ?? ""
        )
          .trim()
          .slice(0, 48);

        const incomingPrivate =
          String((typed as any).private ?? "").trim() === "1" ||
          Boolean((typed as any).isPrivate);

        const room = getBlackjackRoom(roomId);

        const ensured = blackjackRooms.get(roomId);
        if (ensured) {
          if (!ensured.hostPlayerId) ensured.hostPlayerId = playerId;
          if (!ensured.tableName && incomingName) ensured.tableName = incomingName;
          if (incomingPrivate) ensured.isPrivate = true;

          try {
            const snap = room.getSnapshot();
            ensured.minBet = snap.minBet;
            ensured.maxBet = snap.maxBet;
          } catch {}
        }

        // if your BJ supports reconnectClient, you can add it here similarly.
        room.addClient(playerId, socket, (typed as any).name);
        return;
      }

      return;
    }

    // ✅ AUTO-JOIN SAFETY NET (fixes "sit/demo-topup before join-room" on Railway)
    if (!currentRoomId || !currentPlayerId || !currentKind) {
      const kind = (typed as any).kind as GameKind | undefined;
      const roomId = String((typed as any).roomId ?? "").trim();
      const playerId = String((typed as any).playerId ?? "").trim();

      console.warn("[Coordinator] PRE-JOIN DROP CHECK", {
        type: (typed as any).type,
        kind,
        roomId,
        playerId,
      });

      if ((kind === "poker" || kind === "blackjack") && roomId && playerId) {
        // cancel any pending disconnect cleanup if we’re auto-joining on reconnect
        if (kind === "poker") cancelPokerDisconnectRemoval(roomId, playerId);
        if (kind === "blackjack") cancelBjDisconnectRemoval(roomId, playerId);

        console.log("[Coordinator] Auto-joining from first message", {
          kind,
          roomId,
          playerId,
        });

        currentRoomId = roomId;
        currentPlayerId = playerId;
        currentKind = kind;

        touchRoom(kind, roomId);

        if (kind === "poker") {
          const room = getPokerRoom(roomId);

          // if they’re known, reconnect; otherwise addClient
          try {
            const known =
              typeof (room as any).hasKnownPlayer === "function"
                ? (room as any).hasKnownPlayer(playerId)
                : false;

            if (known && typeof (room as any).reconnectClient === "function") {
              (room as any).reconnectClient(playerId, socket, (typed as any).name, {});
            } else {
              (room as any).addClient(playerId, socket, (typed as any).name, {});
            }
          } catch {
            (room as any).addClient(playerId, socket, (typed as any).name, {});
          }
        } else {
          const room = getBlackjackRoom(roomId);
          room.addClient(playerId, socket, (typed as any).name);
        }
      } else {
        console.warn("[Coordinator] Got message before join-room; ignoring:", typed);
        return;
      }
    }

    // Route everything else to the correct room
    touchRoom(currentKind!, currentRoomId!);

    if (currentKind === "poker") {
      const meta = pokerRooms.get(currentRoomId!);
      if (!meta) {
        console.warn("[Coordinator] No poker room found for", currentRoomId);
        return;
      }
      (meta.room as any).handleMessage(typed);
      return;
    }

    const meta = blackjackRooms.get(currentRoomId!);
    if (!meta) {
      console.warn("[Coordinator] No blackjack room found for", currentRoomId);
      return;
    }
    meta.room.handleMessage(typed);
  });

  socket.on("close", () => {
    console.log("[Coordinator] Client disconnected");

    untrackSocket(socket);

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    if (currentRoomId && currentPlayerId && currentKind) {
      touchRoom(currentKind, currentRoomId);

      if (currentKind === "poker") {
        // ✅ start grace timer (so 10s app switch doesn't stand them up)
        schedulePokerDisconnectRemoval(currentRoomId, currentPlayerId);

        const meta = pokerRooms.get(currentRoomId);
        try {
          // ✅ detach routing / mark disconnected (keeps seat)
          (meta?.room as any)?.removeClient?.(currentPlayerId, "disconnect");
        } catch {
          // fallback if you still have markDisconnected in some builds
          try {
            (meta?.room as any)?.markDisconnected?.(currentPlayerId);
          } catch {}
        }
      } else {
        // optional: BJ grace too
        scheduleBjDisconnectRemoval(currentRoomId, currentPlayerId);

        const meta = blackjackRooms.get(currentRoomId);
        try {
          (meta?.room as any)?.removeClient?.(currentPlayerId, "disconnect");
        } catch {
          try {
            meta?.room?.removeClient?.(currentPlayerId);
          } catch {}
        }
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
