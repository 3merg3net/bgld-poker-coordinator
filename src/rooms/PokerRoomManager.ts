// src/rooms/PokerRoomManager.ts
import type WebSocket from "ws";
import type { ClientToServerMessage } from "../types/ClientToServer";
import type { ServerToClientMessage } from "../types/ServerToClient";
import { HoldemGame, SeatView } from "../game/HoldemGame";

// ✅ Supabase-backed PGLD bankroll helpers (you said you'll add the new files)
import { creditPgld, debitPgld, getPgld } from "../chips/pgldBankroll";


type ClientEntry = {
  socket: WebSocket;
  playerId: string;
  name?: string;
};

export class PokerRoomManager {
  private roomId: string;
  private clients: Map<string, ClientEntry> = new Map();
  private seats: SeatView[] = [];
  private game: HoldemGame = new HoldemGame();

  // ─────────────────────────────────────────────────────────────
  // ROOM META (for lobby display + sharing)
  // ─────────────────────────────────────────────────────────────
  private tableName: string | null = null;
  private isPrivate: boolean = false;

  private handInProgress = false;

  private totalFakeRake = 0;

  // ✅ Server-owned auto-deal timer + reveal tracking
  private autoDealTimer: NodeJS.Timeout | null = null;
  private revealedThisHand: Set<string> = new Set();
  private static readonly AUTO_DEAL_DELAY_MS = 10_000;

  private paused = false;
  private pauseUntil: number | null = null;
  private pausedBy: string | null = null;

private pauseTimer: NodeJS.Timeout | null = null;


private broadcastPauseState() {
  // Use a lightweight message the client can optionally listen for.
  // "as any" so you don't have to update shared types right now.
  this.broadcast({
    kind: "poker",
    roomId: this.roomId,
    playerId: "server",
    type: "pause-state",
    paused: this.paused,
    pauseUntil: this.pauseUntil,
    pausedBy: this.pausedBy,
  } as any);
}

private setPaused(byPlayerId: string, seconds: number) {
  const secs = Math.max(5, Math.min(600, Math.floor(Number(seconds) || 30)));

  this.paused = true;
  this.pausedBy = byPlayerId;
  this.pauseUntil = Date.now() + secs * 1000;

  if (this.pauseTimer) clearTimeout(this.pauseTimer);
  this.pauseTimer = setTimeout(() => {
    if (this.paused && this.pauseUntil && Date.now() >= this.pauseUntil) {
      this.setResumed("auto");
    }
  }, secs * 1000) as any;

  this.broadcast({
    kind: "poker",
    roomId: this.roomId,
    playerId: "server",
    type: "chat-broadcast",
    text: `⏸ Game paused for ${secs}s`,
  } as any);

  this.broadcastPauseState();
}

private setResumed(by: string) {
  this.paused = false;
  this.pauseUntil = null;
  this.pausedBy = null;

  if (this.pauseTimer) {
    clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
  }

  this.broadcast({
    kind: "poker",
    roomId: this.roomId,
    playerId: "server",
    type: "chat-broadcast",
    text: `▶ Game resumed`,
  } as any);

  this.broadcastPauseState();

  // If no hand in progress, re-arm autodeal
  if (!this.handInProgress) {
    const eligible = this.seats.filter((s) => s.playerId && (s.chips ?? 0) > 0);
    if (eligible.length >= 2 && this.clients.size > 0) this.armAutoDeal();
  }
}

/**
 * Hard emergency end: abort hand + clear UI + allow next hand.
 * This does NOT award pot (emergency only).
 */
private forceEndHand(reason: string) {
  const anyGame: any = this.game as any;

  if (typeof anyGame.abortHand === "function") {
    anyGame.abortHand(reason);
  } else if (typeof anyGame.resetTable === "function") {
    anyGame.resetTable(reason);
  }

  this.handInProgress = false;
  this.revealedThisHand.clear();
  this.clearAutoDealTimer();

  this.broadcastClearTable(reason);

  // re-sync + maybe re-arm
  this.syncGameWithSeats(`forceEndHand:${reason}`);

  const eligible = this.seats.filter((s) => s.playerId && (s.chips ?? 0) > 0);
  if (eligible.length >= 2 && this.clients.size > 0) this.armAutoDeal();
}

// WSOP-style: HOLD NEXT DEAL (never freezes action mid-hand)
private dealHeld = false;
private dealHeldBy: string | null = null;
private dealHeldAt: number | null = null;

private broadcastDealHoldState() {
  this.broadcast({
    kind: "poker",
    roomId: this.roomId,
    playerId: "server",
    type: "deal-hold-state",
    held: this.dealHeld,
    heldBy: this.dealHeldBy,
    heldAt: this.dealHeldAt,
  } as any);
}

private setDealHeld(byPlayerId: string) {
  this.dealHeld = true;
  this.dealHeldBy = byPlayerId;
  this.dealHeldAt = Date.now();

  this.broadcast({
    kind: "poker",
    roomId: this.roomId,
    playerId: "server",
    type: "chat-broadcast",
    text: "⏸ Dealing is ON HOLD (next hand will not start).",
  } as any);

  this.broadcastDealHoldState();
}

private setDealResumed(byPlayerId: string) {
  this.dealHeld = false;
  this.dealHeldBy = null;
  this.dealHeldAt = null;

  this.broadcast({
    kind: "poker",
    roomId: this.roomId,
    playerId: "server",
    type: "chat-broadcast",
    text: "▶ Dealing resumed.",
  } as any);

  this.broadcastDealHoldState();

  // If no hand in progress, re-arm autodeal
  if (!this.handInProgress) {
    const eligible = this.seats.filter((s) => s.playerId && (s.chips ?? 0) > 0);
    if (eligible.length >= 2 && this.clients.size > 0) this.armAutoDeal();
  }
}




  // ✅ Optional: lightweight bankroll cache to reduce Supabase reads
  private bankrollCache: Map<string, { v: number; ts: number }> = new Map();
  private static readonly BANKROLL_CACHE_TTL_MS = 2_000;

    // ─────────────────────────────────────────────────────────────
  // DEMO FALLBACK (in-memory) — used when Supabase bankroll calls fail
  // ─────────────────────────────────────────────────────────────
  private demoBankroll: Map<string, number> = new Map();

  private getDemoBankroll(playerId: string) {
    return Math.max(0, Math.floor(this.demoBankroll.get(playerId) ?? 0));
  }

  private setDemoBankroll(playerId: string, v: number) {
    this.demoBankroll.set(playerId, Math.max(0, Math.floor(v)));
  }

  private async safeGetBankroll(playerId: string): Promise<number> {
    try {
      return await getPgld(playerId);
    } catch {
      // Supabase down / not configured → fallback
      return this.getDemoBankroll(playerId);
    }
  }

  private async safeCredit(playerId: string, amount: number, txType: string, ref?: any, meta?: any) {
    const amt = Math.max(0, Math.floor(amount));
    if (amt <= 0) return;

    try {
      await creditPgld({ playerId, amount: amt, txType: txType as any, ref, meta });
      return;
    } catch {
      // fallback
      this.setDemoBankroll(playerId, this.getDemoBankroll(playerId) + amt);
    }
  }

  private async safeDebit(playerId: string, amount: number, txType: string, ref?: any, meta?: any) {
    const amt = Math.max(0, Math.floor(amount));
    if (amt <= 0) return;

    try {
      await debitPgld({ playerId, amount: amt, txType: txType as any, ref, meta });
      return;
    } catch (e: any) {
      // fallback
      const cur = this.getDemoBankroll(playerId);
      if (cur < amt) {
        const err: any = new Error("INSUFFICIENT_PGLD");
        err.message = "INSUFFICIENT_PGLD";
        throw err;
      }
      this.setDemoBankroll(playerId, cur - amt);
    }
  }
private mode: "cash" | "tournament" = "cash";
  

  constructor(roomId: string, opts?: { mode?: "cash" | "tournament" }) {
  this.roomId = roomId;
  this.mode = opts?.mode ?? "cash";

    for (let i = 0; i < 9; i++) {
      this.seats.push({
        seatIndex: i,
        playerId: null,
        name: undefined,
        chips: 0,
      });
    }
  }
private tournamentConfig: null | {
  tournamentId: string;
  buyIn: number;
  startingStack: number;
  seatsPerTable: number;
} = null;

public setTournamentConfig(cfg: {
  tournamentId: string;
  buyIn: number;
  startingStack: number;
  seatsPerTable: number;
}) {
  if (this.mode !== "tournament") return;
  if (!cfg) return;

  this.tournamentConfig = {
    tournamentId: String(cfg.tournamentId ?? ""),
    buyIn: Math.max(0, Math.floor(Number(cfg.buyIn ?? 0))),
    startingStack: Math.max(0, Math.floor(Number(cfg.startingStack ?? 0))),
    seatsPerTable: Math.max(2, Math.min(9, Math.floor(Number(cfg.seatsPerTable ?? 9)))),
  };
}

private tournamentAllowList: Set<string> | null = null;

public setTournamentAllowList(players: string[]) {
  if (this.mode !== "tournament") return;
  const arr = Array.isArray(players) ? players : [];
  this.tournamentAllowList = new Set(arr.map((x) => String(x)));
}

public autoSeatTournamentPlayers(players: string[]) {
  if (this.mode !== "tournament") return;

  const stack = Math.max(1, Math.floor(Number(this.tournamentConfig?.startingStack ?? 0)));
  if (!stack) return;

  const arr = Array.isArray(players) ? players : [];
  for (const pid of arr) {
    if (!pid) continue;
    if (this.seats.some((s) => s.playerId === pid)) continue;

    const open = this.seats.find((s) => !s.playerId);
    if (!open) break;

    this.seats = this.seats.map((s) =>
      s.seatIndex === open.seatIndex
        ? { ...s, playerId: pid, name: this.clients.get(pid)?.name, chips: stack }
        : s
    );
  }

  this.syncGameWithSeats("autoSeatTournamentPlayers");
  void this.broadcastSeats();

  // arm hand if eligible
  if (!this.handInProgress) {
    const eligible = this.seats.filter((s) => s.playerId && (s.chips ?? 0) > 0);
    if (eligible.length >= 2 && this.clients.size > 0) this.armAutoDeal();
  }
}

  

  // ─────────────────────────────────────────────────────────────
  // BANKROLL HELPERS (single source of truth = Supabase)
  // ─────────────────────────────────────────────────────────────

  private invalidateBankroll(playerId: string) {
    this.bankrollCache.delete(playerId);
  }

    private async getBankroll(playerId: string): Promise<number> {
    const cached = this.bankrollCache.get(playerId);
    const now = Date.now();
    if (cached && now - cached.ts <= PokerRoomManager.BANKROLL_CACHE_TTL_MS) {
      return cached.v;
    }

    const v = await this.safeGetBankroll(playerId);
    const amt = Math.max(0, Math.floor(Number(v) || 0));
    this.bankrollCache.set(playerId, { v: amt, ts: now });
    return amt;
  }


    private async bankrollsSnapshot(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const pid of this.clients.keys()) {
      // never drop the key — default to 0 if anything goes wrong
      try {
        out[pid] = await this.getBankroll(pid);
      } catch {
        out[pid] = 0;
      }
    }
    return out;
  }


  private async broadcastSeats() {
    const bankrolls = await this.bankrollsSnapshot();
    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "seats-update",
      seats: this.seats,
      bankrolls, // ✅ extra field (non-breaking)
    } as any);
  }

    // ─────────────────────────────────────────────────────────────
  // GAME ↔ SEATS SYNC (fix: dealer hand sticking after table empties)
  // ─────────────────────────────────────────────────────────────

  private syncGameWithSeats(reason: string) {
    const anyGame: any = this.game as any;

    // Tell engine seats changed (so it can abort if <2 active players)
    if (typeof anyGame.onSeatsChanged === "function") {
      anyGame.onSeatsChanged(this.seats);
    }

    // Optional stall watchdog (if you added maybeRecoverFromStall)
    if (typeof anyGame.maybeRecoverFromStall === "function") {
      anyGame.maybeRecoverFromStall(20_000);
    }

    // If engine now has no active hand, release manager lock
    const b = this.game.getBettingState();
    const t = this.game.getLastState();

    if (!b && !t) {
      if (this.handInProgress) {
        this.handInProgress = false;
      }
      // Clear client UI so dealer/board disappear immediately
      this.broadcastClearTable(reason);
    }
  }

  private broadcastClearTable(reason: string) {
    // These messages are "as any" so you don't have to update shared types yet.
    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "table-state",
      handId: 0,
      board: [],
      players: [],
      reason,
    } as any);

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "betting-state",
      handId: 0,
      street: "done",
      pot: 0,
      buttonSeatIndex: 0,
      currentSeatIndex: null,
      bigBlind: 0,
      smallBlind: 0,
      maxCommitted: 0,
      players: [],
      reason,
    } as any);
  }


  // ─────────────────────────────────────────────────────────────
  // HOST RULE
  // host = lowest occupied seatIndex
  // ─────────────────────────────────────────────────────────────

  private getHostSeatIndex(): number | null {
    let min: number | null = null;
    for (const s of this.seats) {
      if (!s.playerId) continue;
      if (min === null || s.seatIndex < min) min = s.seatIndex;
    }
    return min;
  }

  public isHost(playerId: string): boolean {
    const seat = this.seats.find((s) => s.playerId === playerId);
    if (!seat) return false;
    const hostIdx = this.getHostSeatIndex();
    return hostIdx !== null && seat.seatIndex === hostIdx;
  }

  // ─────────────────────────────────────────────────────────────
  // SNAPSHOTS (used by lobby pages etc.)
  // ─────────────────────────────────────────────────────────────

  public getLobbySnapshot() {
    const seated = this.seats.filter((s) => s.playerId).length;
    const withChips = this.seats.filter(
      (s) => s.playerId && (s.chips ?? 0) > 0
    ).length;

    return {
      roomId: this.roomId,
      online: this.clients.size,
      seated,
      withChips,
    };
  }

  public getSnapshot() {
  const seatedCount = this.seats.filter((s) => !!s.playerId).length;
  return {
    roomId: this.roomId,
    tableName: this.tableName,
    private: this.isPrivate ? "1" : "0",
    onlineCount: this.clients.size,
    seatedCount,
  };
}


  public getCounts() {
    const onlineCount = this.clients.size;
    const seatedCount = this.seats.filter((s) => !!s.playerId).length;
    return { onlineCount, seatedCount };
  }

  // ─────────────────────────────────────────────────────────────
  // CLIENT JOIN/LEAVE
  // ─────────────────────────────────────────────────────────────

  addClient(
  playerId: string,
  socket: WebSocket,
  name?: string,
  meta?: { tableName?: string; private?: string | boolean | number }
) {
  this.clients.set(playerId, { socket, playerId, name });

  // ✅ tournament allowlist: kick non-assigned spectators (or keep them as spectators if you want)
if (this.mode === "tournament" && this.tournamentAllowList) {
  if (!this.tournamentAllowList.has(playerId)) {
    // let them connect but prevent sit/actions; OR hard reject:
    this.sendTo(playerId, {
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "error",
      message: "You are not assigned to this tournament table.",
    } as any);
  }
}

// ✅ Tournament auto-seat safety net: seat assigned players on connect
if (this.mode === "tournament" && this.tournamentAllowList?.has(playerId)) {
  const alreadySeated = this.seats.some((s) => s.playerId === playerId);
  const stack = Math.max(0, Math.floor(Number(this.tournamentConfig?.startingStack ?? 0)));

  if (!alreadySeated && stack > 0) {
    const open = this.seats.find((s) => !s.playerId);
    if (open) {
      this.seats = this.seats.map((s) =>
        s.seatIndex === open.seatIndex
          ? { ...s, playerId, name: name || this.clients.get(playerId)?.name, chips: stack }
          : s
      );

      this.syncGameWithSeats("tournament-auto-seat:addClient");
      void this.broadcastSeats();

      if (!this.handInProgress) {
        const eligible = this.seats.filter((s) => s.playerId && (s.chips ?? 0) > 0);
        if (eligible.length >= 2 && this.clients.size > 0) this.armAutoDeal();
      }
    }
  }
}
const t = this.game.getLastState();
const b = this.game.getBettingState();

if (t && b && b.street !== "done") {
  const cards = this.game.getHoleCardsForPlayer(playerId);
  if (cards && cards.length >= 2) {
    this.sendTo(playerId, {
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "hole-cards",
      handId: t.handId,
      cards: cards.slice(0, 2),
    } as any);
  }
}



  // Capture room meta once (first writer wins)
  // This is what the lobby uses to show the human table name.
  try {
    if (!this.tableName) {
      const raw =
        typeof meta?.tableName === "string" ? meta.tableName.trim() : "";
      if (raw) this.tableName = raw.slice(0, 24);
    }

    // Accept: "1", true, 1, "true"
    if (!this.isPrivate) {
      const p = meta?.private;
      const isP =
        p === "1" ||
        p === 1 ||
        p === true ||
        (typeof p === "string" && p.toLowerCase() === "true");
      if (isP) this.isPrivate = true;
    }
  } catch {}

  this.cleanupGhostSeats();

  this.broadcast({
    kind: "poker",
    roomId: this.roomId,
    playerId,
    type: "room-joined",
    onlineCount: this.clients.size,
  } as any);


    // send seats + bankrolls to the joining client
    // (fire-and-forget so join isn't blocked by Supabase latency)
    (async () => {
      const bankrolls = await this.bankrollsSnapshot();
      this.sendTo(playerId, {
        kind: "poker",
        roomId: this.roomId,
        playerId,
        type: "seats-update",
        seats: this.seats,
        bankrolls,
      } as any);
    })();

    const lastTable = this.game.getLastState();
    if (lastTable) {
      this.sendTo(playerId, {
        kind: "poker",
        roomId: this.roomId,
        playerId,
        type: "table-state",
        handId: lastTable.handId,
        board: lastTable.board,
        players: lastTable.players,
      } as any);
    }

    const betting = this.game.getBettingState();
    if (betting) {
      this.sendTo(playerId, {
        kind: "poker",
        roomId: this.roomId,
        playerId,
        type: "betting-state",
        handId: betting.handId,
        street: betting.street,
        pot: betting.pot,
        buttonSeatIndex: betting.buttonSeatIndex,
        currentSeatIndex: betting.currentSeatIndex,
        bigBlind: betting.bigBlind,
        smallBlind: betting.smallBlind,
        maxCommitted: betting.maxCommitted,
        players: betting.players,
        smallBlindSeatIndex: (betting as any).smallBlindSeatIndex ?? null,
        bigBlindSeatIndex: (betting as any).bigBlindSeatIndex ?? null,
      } as any);
    }

    // ✅ tell joining client current pause state
this.sendTo(playerId, {
  kind: "poker",
  roomId: this.roomId,
  playerId: "server",
  type: "deal-hold-state",
  held: this.dealHeld,
  heldBy: this.dealHeldBy,
  heldAt: this.dealHeldAt,
} as any);


  }

  removeClient(playerId: string) {
    if (!this.clients.has(playerId)) return;
    this.clients.delete(playerId);

    // If disconnect while seated, return stack to bankroll, then clear seat
    let changed = false;
    const stackToReturn = (() => {
  const seat = this.seats.find((s) => s.playerId === playerId);
  const stack = Math.max(0, Math.floor(Number(seat?.chips ?? 0)));
  return stack;
})();

    this.seats = this.seats.map((s) => {
      if (s.playerId === playerId) {
        changed = true;
        return { ...s, playerId: null, name: undefined, chips: 0 };
      }
      return s;
    });
        this.syncGameWithSeats("disconnect");


       // Return stack asynchronously (cash mode only)
    if (this.mode === "cash" && stackToReturn > 0) {
      (async () => {
        try {
          await this.safeCredit(
            playerId,
            stackToReturn,
            "poker_cashout",
            this.roomId,
            { reason: "disconnect" }
          );
          this.invalidateBankroll(playerId);
          await this.broadcastSeats();
        } catch {}
      })();
    }


    if (changed) {
      // broadcast immediately (seat cleared), bankroll update follows when credit completes
      void this.broadcastSeats();
    }

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "room-left",
    } as any);

    if (this.clients.size === 0) {
      this.resetTableState();
    }
   
  }

  

  // ─────────────────────────────────────────────────────────────
  // MAIN ENTRY: Client → Server messages
  // ─────────────────────────────────────────────────────────────

  handleMessage(msg: ClientToServerMessage) {
    if (!msg || typeof (msg as any).type !== "string") return;

    const playerId = (msg as any).playerId as string | undefined;
    if (!playerId) return; // envelope should include playerId

    const t = (msg as any).type as string;

const isHostCmd =
  t === "host-hold-deal" ||
  t === "host-resume-deal" ||
  t === "host-reset" ||
  t === "host-force-end-hand" ||
  t === "ping" ||
  t === "chat" ||
  t === "sit" ||
  t === "stand";

// NOTE: we do NOT block actions mid-hand anymore via "pause".
// If you still want your old paused system, keep it separate.
// WSOP-style is: never freeze action, only hold next deal.



// ✅ Block gameplay commands while paused (everyone sees it frozen)
if (this.paused && !isHostCmd) {
  this.sendTo(playerId, {
    kind: "poker",
    roomId: this.roomId,
    playerId: "server",
    type: "toast",
    message: "Game is paused.",
  } as any);
  return;
}


    switch ((msg as any).type) {
      case "ping":
        this.sendTo(playerId, {
          kind: "poker",
          roomId: this.roomId,
          playerId: "server",
          type: "pong",
        } as any);
        return;

      case "chat":
        this.broadcast({
          kind: "poker",
          roomId: this.roomId,
          playerId,
          type: "chat-broadcast",
          text: String((msg as any).text ?? "").slice(0, 280),
        } as any);
        return;

      case "sit":
        void this.handleSit(
          playerId,
          (msg as any).buyIn,
          (msg as any).seatIndex,
          (msg as any).name
        );
        return;

      case "stand":
        void this.handleStand(playerId);
        return;

      case "refill-stack":
        void this.handleRefillStack(playerId, (msg as any).amount);
        return;

      case "demo-topup":
        void this.handleDemoTopup(playerId, (msg as any).target);
        return;

      case "action":
        this.handleAction(
          playerId,
          (msg as any).action,
          (msg as any).amount
        );
        return;

      case "show-cards":
        this.handleShowCards(playerId);
        return;

      case "start-game":
      case "start-hand":
        this.handleStartHand(playerId);
        return;

        case "host-hold-deal": {
  if (!this.isHost(playerId)) return;
  this.setDealHeld(playerId);
  return;
}

case "host-resume-deal": {
  if (!this.isHost(playerId)) return;
  this.setDealResumed(playerId);
  return;
}




case "host-reset": {
  if (!this.isHost(playerId)) return;

  // Guardrail: if a hand is running, require pause first
  if (this.handInProgress && !this.paused) {
    this.sendTo(playerId, {
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "toast",
      message: "Pause first to reset.",
    } as any);
    return;
  }

  // Use your existing reset helper (it calls HoldemGame.resetTable/abortHand)
  this.handleResetTable(playerId);

  this.broadcast({
    kind: "poker",
    roomId: this.roomId,
    playerId: "server",
    type: "toast",
    message: "🔄 Table reset by host",
  } as any);

  return;
}

case "host-force-end-hand": {
  if (!this.isHost(playerId)) return;

  if (!this.handInProgress) {
    this.sendTo(playerId, {
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "toast",
      message: "No hand to end.",
    } as any);
    return;
  }

  // Emergency only: abort current hand and clear table.
  this.forceEndHand("HOST_FORCE_END");

  this.broadcast({
    kind: "poker",
    roomId: this.roomId,
    playerId: "server",
    type: "toast",
    message: "⚠ Hand ended by host",
  } as any);

  return;
}




      default:
        // ignore unknowns to keep cross-game compatibility
        return;
    }

    
    
  }
    private handleResetTable(requesterId: string) {
    if (!this.isHost(requesterId)) {
      this.sendTo(requesterId, {
        kind: "poker",
        roomId: this.roomId,
        playerId: requesterId,
        type: "error",
        message: "Only the host can reset the table.",
      } as any);
      return;
    }

    const anyGame: any = this.game as any;
    if (typeof anyGame.resetTable === "function") {
      anyGame.resetTable("HOST_RESET");
    } else if (typeof anyGame.abortHand === "function") {
      anyGame.abortHand("HOST_RESET");
    }

    this.handInProgress = false;
    this.revealedThisHand.clear();
    this.clearAutoDealTimer();

    this.broadcastClearTable("HOST_RESET");

    // Re-arm if eligible
    this.cleanupGhostSeats();
    const eligible = this.seats.filter((s) => s.playerId && (s.chips ?? 0) > 0);
    if (eligible.length >= 2 && this.clients.size > 0) {
      this.armAutoDeal();
    }
  }


  // ─────────────────────────────────────────────────────────────
  // SITTING / STANDING
  // ─────────────────────────────────────────────────────────────

  private async handleSit(
  playerId: string,
  buyIn?: number,
  seatIndex?: number,
  name?: string
) {
  const already = this.seats.find((s) => s.playerId === playerId);
  if (already) return;

  // ✅ tournament allowlist enforcement
  if (this.mode === "tournament" && this.tournamentAllowList) {
    if (!this.tournamentAllowList.has(playerId)) {
      this.sendTo(playerId, {
        kind: "poker",
        roomId: this.roomId,
        playerId,
        type: "error",
        message: "You are not assigned to this tournament table.",
      } as any);
      return;
    }
  }

  // pick seat
  let targetSeat: SeatView | undefined;
  if (typeof seatIndex === "number") {
    targetSeat = this.seats.find((s) => s.seatIndex === seatIndex && !s.playerId);
  } else {
    targetSeat = this.seats.find((s) => !s.playerId);
  }

  if (!targetSeat) {
    this.sendTo(playerId, {
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "error",
      message: "No seat available",
    } as any);
    return;
  }

  if (this.mode === "tournament") {
  if (!this.tournamentConfig?.startingStack) {
    console.log(`[PokerRoom:${this.roomId}] TOURNAMENT sit blocked: missing tournamentConfig`, this.tournamentConfig);
  }
}


  // ───────────────────────────────────────────────
  // ✅ TOURNAMENT MODE: NO BANKROLL DEBIT, fixed stack
  // ───────────────────────────────────────────────
  if (this.mode === "tournament") {
    const stack = Math.max(1, Math.floor(Number(this.tournamentConfig?.startingStack ?? 0)));
    if (!stack) {
      this.sendTo(playerId, {
        kind: "poker",
        roomId: this.roomId,
        playerId,
        type: "error",
        message: "Tournament table not ready (missing startingStack).",
      } as any);
      return;
    }

    this.seats = this.seats.map((s) =>
      s.seatIndex === targetSeat!.seatIndex
        ? { ...s, playerId, name: name || this.clients.get(playerId)?.name, chips: stack }
        : s
    );

    this.syncGameWithSeats("tournament-sit");
    await this.broadcastSeats();

    if (!this.handInProgress) {
      const eligible = this.seats.filter((s) => s.playerId && (s.chips ?? 0) > 0);
      if (eligible.length >= 2 && this.clients.size > 0) this.armAutoDeal();
    }

    return;
  }

  // ───────────────────────────────────────────────
  // ✅ CASH MODE: bankroll debit then seat
  // ───────────────────────────────────────────────
  const desired = Math.max(100, Math.floor(Number(buyIn ?? 0)));
  if (!Number.isFinite(desired) || desired <= 0) return;

  try {
    await this.safeDebit(
      playerId,
      desired,
      "poker_buyin",
      this.roomId,
      { seatIndex: targetSeat.seatIndex }
    );
    this.invalidateBankroll(playerId);
  } catch (e: any) {
    const msg =
      e?.message === "INSUFFICIENT_PGLD"
        ? `Not enough PGLD bankroll to buy in for ${desired}.`
        : "Buy-in failed.";
    this.sendTo(playerId, {
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "error",
      message: msg,
    } as any);
    return;
  }

  this.seats = this.seats.map((s) =>
    s.seatIndex === targetSeat!.seatIndex
      ? { ...s, playerId, name: name || this.clients.get(playerId)?.name, chips: desired }
      : s
  );

  this.syncGameWithSeats("cash-sit");
  await this.broadcastSeats();

  if (!this.handInProgress) {
    const eligible = this.seats.filter((s) => s.playerId && (s.chips ?? 0) > 0);
    if (eligible.length >= 2 && this.clients.size > 0) this.armAutoDeal();
  }
}


    private async handleStand(playerId: string) {
    // only allow stand between hands
    const betting = this.game.getBettingState();
    if (betting && betting.street !== "done") return;
        if (this.mode === "tournament") return;


    const seat = this.seats.find((s) => s.playerId === playerId);
    if (!seat) return;

    const stack = Math.max(0, Math.floor(Number(seat.chips ?? 0)));

    // Clear seat first (prevents duplicate cashouts if client spams)
    this.seats = this.seats.map((s) =>
      s.playerId === playerId
        ? { ...s, playerId: null, name: undefined, chips: 0 }
        : s
    );

    this.syncGameWithSeats("stand");

    if (this.mode === "cash") {
      if (stack > 0) {
        try {
          await this.safeCredit(
            playerId,
            stack,
            "poker_cashout",
            this.roomId,
            { seatIndex: seat.seatIndex }
          );
          this.invalidateBankroll(playerId);
        } catch {
          this.sendTo(playerId, {
            kind: "poker",
            roomId: this.roomId,
            playerId,
            type: "error",
            message: "Cashout failed.",
          } as any);
        }
      }
    } else {
      // tournament mode: no auto-cashout (optional: mark sitout later)
    }

    await this.broadcastSeats();
  }




  private async handleRefillStack(playerId: string, amount?: number) {
    // only between hands
    const betting = this.game.getBettingState();
    if (betting && betting.street !== "done") return;
        if (this.mode === "tournament") return;


    const seat = this.seats.find((s) => s.playerId === playerId);
    if (!seat) return;

    const requested = Math.max(0, Math.floor(Number(amount ?? 0)));
    if (!Number.isFinite(requested) || requested <= 0) return;

    // ✅ Debit Supabase bankroll
       try {
      await this.safeDebit(
        playerId,
        requested,
        "poker_refill",
        this.roomId,
        { seatIndex: seat.seatIndex }
      );
      this.invalidateBankroll(playerId);
    } catch (e: any) {
      const msg =
        e?.message === "INSUFFICIENT_PGLD"
          ? `Not enough PGLD bankroll to refill ${requested}.`
          : "Refill failed.";
      this.sendTo(playerId, {
        kind: "poker",
        roomId: this.roomId,
        playerId,
        type: "error",
        message: msg,
      } as any);
      return;
    }


    this.seats = this.seats.map((s) => {
      if (s.playerId !== playerId) return s;
      return { ...s, chips: (s.chips ?? 0) + requested };
    });

    await this.broadcastSeats();

    if (!this.handInProgress) {
      const eligible = this.seats.filter(
        (s) => s.playerId && (s.chips ?? 0) > 0
      );
      if (eligible.length >= 2 && this.clients.size > 0) {
        this.armAutoDeal();
      }
    }
  }

    private async handleDemoTopup(playerId: string, target?: number) {
    const tgt = Math.max(0, Math.floor(Number(target ?? 5_000)));
    if (!Number.isFinite(tgt)) return;

    let cur = 0;
    try {
      cur = await this.getBankroll(playerId);
    } catch {
      cur = this.getDemoBankroll(playerId);
    }

    if (cur >= tgt) {
      await this.broadcastSeats();
      return;
    }

    const delta = tgt - cur;

    try {
      await this.safeCredit(playerId, delta, "demo_topup", this.roomId, { target: tgt });
      this.invalidateBankroll(playerId);
    } catch {
      this.sendTo(playerId, {
        kind: "poker",
        roomId: this.roomId,
        playerId,
        type: "error",
        message: "Demo topup failed.",
      } as any);
      return;
    }

    this.sendTo(playerId, {
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "chat-broadcast",
      text: `Demo bankroll topped up to ${tgt.toLocaleString()} PGLD.`,
    } as any);

    await this.broadcastSeats();
  }


  // ─────────────────────────────────────────────────────────────
  // HAND LIFECYCLE
  // ─────────────────────────────────────────────────────────────

  private clearAutoDealTimer() {
    if (this.autoDealTimer) {
      clearTimeout(this.autoDealTimer);
      this.autoDealTimer = null;
    }
  }

  private armAutoDeal() {
    this.clearAutoDealTimer();

    this.autoDealTimer = setTimeout(() => {
      if (this.clients.size === 0) return;

      const started = this.tryStartHand(true);

      if (!started && this.clients.size > 0) {
        this.clearAutoDealTimer();
        this.autoDealTimer = setTimeout(() => {
          if (this.clients.size === 0) return;
          this.tryStartHand(true);
        }, 5_000) as any;
      }
    }, PokerRoomManager.AUTO_DEAL_DELAY_MS) as any;
  }

  private handleStartHand(requesterId: string) {
    if (!this.isHost(requesterId)) {
      this.sendTo(requesterId, {
        kind: "poker",
        roomId: this.roomId,
        playerId: requesterId,
        type: "error",
        message: "Only the host can start the hand.",
      } as any);
      return;
    }

    this.tryStartHand(false, requesterId);
  }

  private tryStartHand(auto: boolean, requesterId?: string): boolean {
    // Re-sync handInProgress with actual betting state
    const currentBetting = this.game.getBettingState();
    if (!currentBetting || currentBetting.street === "done") {
      this.handInProgress = false;
    }

    if (this.handInProgress) {
      if (!auto && requesterId) {
        this.sendTo(requesterId, {
          kind: "poker",
          roomId: this.roomId,
          playerId: requesterId,
          type: "error",
          message: "A hand is already in progress.",
        } as any);
      }
      return false;
    }

    // WSOP-style: if dealing is held, do NOT start the next hand
if (this.dealHeld) {
  if (!auto && requesterId) {
    this.sendTo(requesterId, {
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "toast",
      message: "Dealing is on hold (next hand).",
    } as any);
  }

  // keep the table informed
  this.broadcastDealHoldState();

  // keep attempting later (so when host resumes it naturally starts)
  if (this.clients.size > 0) {
    this.clearAutoDealTimer();
    this.autoDealTimer = setTimeout(() => {
      if (this.clients.size === 0) return;
      this.tryStartHand(true);
    }, 2_000) as any;
  }

  return false;
}


    this.cleanupGhostSeats();

    const seatedPlayers = this.seats.filter(
      (s) => s.playerId && (s.chips ?? 0) > 0
    );

    if (seatedPlayers.length < 2) {
      if (!auto && requesterId) {
        this.sendTo(requesterId, {
          kind: "poker",
          roomId: this.roomId,
          playerId: requesterId,
          type: "error",
          message: "At least 2 seated players are required to start a hand.",
        } as any);
      }
      return false;
    }

    this.clearAutoDealTimer();

    const table = this.game.startHand(this.seats);
    if (!table) {
      if (!auto && requesterId) {
        this.sendTo(requesterId, {
          kind: "poker",
          roomId: this.roomId,
          playerId: requesterId,
          type: "error",
          message: "No seated players to start a hand",
        } as any);
      }
      return false;
    }

    this.handInProgress = true;

    // New hand: reset reveal tracking
    this.revealedThisHand.clear();

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "table-state",
      handId: table.handId,
      board: table.board,
      players: table.players,
    } as any);

    const betting = this.game.getBettingState();
    if (betting) {
      this.broadcast({
        kind: "poker",
        roomId: this.roomId,
        playerId: "server",
        type: "betting-state",
        handId: betting.handId,
        street: betting.street,
        pot: betting.pot,
        buttonSeatIndex: betting.buttonSeatIndex,
        currentSeatIndex: betting.currentSeatIndex,
        bigBlind: betting.bigBlind,
        smallBlind: betting.smallBlind,
        maxCommitted: betting.maxCommitted,
        players: betting.players,
        smallBlindSeatIndex: (betting as any).smallBlindSeatIndex ?? null,
        bigBlindSeatIndex: (betting as any).bigBlindSeatIndex ?? null,
      } as any);
    }
    
// ✅ Send PRIVATE hole cards to each seated player (tournament UI needs this)
// Place here: after broadcasting table-state + betting-state, before return true
for (const s of this.seats) {
  if (!s.playerId) continue;

  const cards = this.game.getHoleCardsForPlayer(s.playerId);
  if (!cards || cards.length < 2) continue;

  this.sendTo(s.playerId, {
    kind: "poker",
    roomId: this.roomId,
    playerId: "server",
    type: "hole-cards",
    handId: table.handId,
    cards: cards.slice(0, 2),
  } as any);
}

    return true;
  }

  private handleAction(
    playerId: string,
    action: "fold" | "check" | "call" | "bet",
    amount?: number
  ) {
    if (this.mode === "tournament" && this.tournamentAllowList) {
  if (!this.tournamentAllowList.has(playerId)) return;
}

const betting = this.game.applyAction(playerId, action, amount);
if (!betting) return;



    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "betting-state",
      handId: betting.handId,
      street: betting.street,
      pot: betting.pot,
      buttonSeatIndex: betting.buttonSeatIndex,
      currentSeatIndex: betting.currentSeatIndex,
      bigBlind: betting.bigBlind,
      smallBlind: betting.smallBlind,
      maxCommitted: betting.maxCommitted,
      players: betting.players,
      smallBlindSeatIndex: (betting as any).smallBlindSeatIndex ?? null,
      bigBlindSeatIndex: (betting as any).bigBlindSeatIndex ?? null,
    } as any);

    const table = this.game.getLastState();
    if (table) {
      this.broadcast({
        kind: "poker",
        roomId: this.roomId,
        playerId: "server",
        type: "table-state",
        handId: table.handId,
        board: table.board,
        players: table.players,
      } as any);
    }

    if (betting.street === "done") {
      const fakeRake = Math.floor((betting.pot * 5) / 100);
      this.totalFakeRake += fakeRake;

      console.log(
        `[PokerRoom:${this.roomId}] Hand #${betting.handId} complete. Pot=${betting.pot}, Fake rake (5%)=${fakeRake}, Total fake rake=${this.totalFakeRake}`
      );

      const showdown = this.game.computeShowdown();
      if (showdown) {
        this.broadcast({
          kind: "poker",
          roomId: this.roomId,
          playerId: "server",
          type: "showdown",
          handId: showdown.handId,
          board: showdown.board,
          players: showdown.players as any,
        } as any);
      }

      // Sync seat chip stacks from final betting state
      const stacksBySeat: Record<number, number> = {};
      for (const p of betting.players as any[]) {
        const seatIdx = p.seatIndex;
        const stack = typeof p.stack === "number" ? p.stack : 0;
        if (typeof seatIdx === "number") stacksBySeat[seatIdx] = stack;
      }

      this.seats = this.seats.map((s) => {
        if (!s.playerId) return s;
        const newStack = stacksBySeat[s.seatIndex];
        if (typeof newStack === "number") return { ...s, chips: newStack };
        return s;
      });

      void this.broadcastSeats();

      this.handInProgress = false;

      // Arm next hand only if 2+ seated players with chips
      this.cleanupGhostSeats();
      const eligible = this.seats.filter(
        (s) => s.playerId && (s.chips ?? 0) > 0
      );

      if (eligible.length >= 2 && this.clients.size > 0) {
        console.log(
          `[PokerRoom:${this.roomId}] Auto-deal armed: next hand in ${PokerRoomManager.AUTO_DEAL_DELAY_MS}ms`
        );
        this.armAutoDeal();
      } else {
        console.log(
          `[PokerRoom:${this.roomId}] Auto-deal paused; need 2 seated players with chips (>0) and at least 1 connected.`
        );

        this.broadcast({
          kind: "poker",
          roomId: this.roomId,
          playerId: "server",
          type: "chat-broadcast",
          text: "Auto-deal paused: need 2+ seated players with chips. Refill your stack to keep playing.",
        } as any);
      }
    }
  }

  private handleShowCards(playerId: string) {
    const betting = this.game.getBettingState();
    if (!betting || betting.street !== "done") return;

    const anyGame: any = this.game as any;
    if (typeof anyGame.getHoleCardsForPlayer !== "function") return;

    const hole = anyGame.getHoleCardsForPlayer(playerId) as string[] | null;
    if (!hole || hole.length !== 2) return;

    const key = `${betting.handId}:${playerId}`;
    if (this.revealedThisHand.has(key)) return;
    this.revealedThisHand.add(key);

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "player-show-cards",
      cards: hole,
      reason: "voluntary",
    } as any);
  }

  // ─────────────────────────────────────────────────────────────
  // GHOST / RESET HELPERS
  // ─────────────────────────────────────────────────────────────

  private cleanupGhostSeats() {
    const activeIds = new Set(this.clients.keys());
    let changed = false;

    this.seats = this.seats.map((s) => {
      if (s.playerId && !activeIds.has(s.playerId)) {
        changed = true;
        return { ...s, playerId: null, name: undefined, chips: 0 };
      }
      return s;
    });

        if (changed) {
      this.syncGameWithSeats("cleanupGhostSeats");
      void this.broadcastSeats();
    }

  }

  private resetTableState() {
    this.clearAutoDealTimer();
    this.revealedThisHand.clear();

    const freshSeats: SeatView[] = [];
    for (let i = 0; i < 9; i++) {
      freshSeats.push({
        seatIndex: i,
        playerId: null,
        name: undefined,
        chips: 0,
      });
    }

    this.seats = freshSeats;
    this.game = new HoldemGame();
    this.handInProgress = false;
    this.totalFakeRake = 0;

    console.log(
      `[PokerRoom:${this.roomId}] All clients gone. Resetting table state.`
    );
  }

  public shutdown(reason = "Room shutdown") {
  // stop timers
  this.clearAutoDealTimer();
  this.revealedThisHand.clear();

  // tell clients
  try {
    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "chat-broadcast",
      text: reason,
    } as any);

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "room-closed",
      reason,
    } as any);
  } catch {}

  // force close sockets
  for (const { socket } of this.clients.values()) {
    try {
      socket.close(1000, reason);
    } catch {}
  }

  // wipe
  this.clients.clear();
  this.resetTableState();
}

private dealingHeld = false;         // "Hold dealing" active
private holdUntilMs: number | null = null; // optional timed hold


  // ─────────────────────────────────────────────────────────────
  // LOW-LEVEL SEND HELPERS
  // ─────────────────────────────────────────────────────────────
  // ✅ Public broadcast helper for coordinator-level events (tournament lobby fanout)
  public broadcastToRoom(payload: any) {
    this.broadcast(payload as any);
  }

  private broadcast(message: ServerToClientMessage) {
    const raw = JSON.stringify(message);
    for (const { socket } of this.clients.values()) {
      if (socket.readyState === socket.OPEN) socket.send(raw);
    }
  }

  private sendTo(playerId: string, message: ServerToClientMessage) {
    const entry = this.clients.get(playerId);
    if (!entry) return;
    if (entry.socket.readyState !== entry.socket.OPEN) return;
    entry.socket.send(JSON.stringify(message));
  }
}
