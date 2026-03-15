// src/rooms/PokerRoomManager.ts
import type WebSocket from "ws";
import type { ClientToServerMessage } from "../types/ClientToServer";
import type { ServerToClientMessage } from "../types/ServerToClient";
import { HoldemGame, SeatView } from "../game/HoldemGame";

// ✅ Supabase-backed PGLD bankroll helpers
import { creditPgld, debitPgld, getPgld } from "../chips/pgldBankroll";

type ClientEntry = {
  socket: WebSocket;
  playerId: string;
  name?: string;
};

type InactivityState = {
  missedTurns: number;
  isSittingOut: boolean;
  lastActionAt: number;
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

  // ✅ Server-owned action timer
  private actionTimer: NodeJS.Timeout | null = null;
  private actionTurnKey: string | null = null;

  private readonly ACTION_BASE_MS =
    Number(process.env.POKER_ACTION_BASE_MS ?? "") || 30_000;

  private readonly ACTION_EXTRA_MS =
    Number(process.env.POKER_ACTION_EXTRA_MS ?? "") || 20_000;

  private readonly AUTO_SIT_OUT_AFTER_MISSES =
    Number(process.env.POKER_AUTO_SIT_OUT_AFTER_MISSES ?? "") || 2;

  private paused = false;
  private pauseUntil: number | null = null;
  private pausedBy: string | null = null;
  private pauseTimer: NodeJS.Timeout | null = null;

  // Disconnect / mobile background grace
  private disconnectTimers = new Map<string, NodeJS.Timeout>();
  private disconnectedAt = new Map<string, number>();
  private readonly DISCONNECT_GRACE_MS =
    Number(process.env.POKER_DISCONNECT_GRACE_MS ?? "") || 45_000;

  // Inactivity / sit-out tracking
  private inactivity = new Map<string, InactivityState>();

  // WSOP-style: HOLD NEXT DEAL (never freezes action mid-hand)
  private dealHeld = false;
  private dealHeldBy: string | null = null;
  private dealHeldAt: number | null = null;

  // ✅ Optional: lightweight bankroll cache to reduce Supabase reads
  private bankrollCache: Map<string, { v: number; ts: number }> = new Map();
  private static readonly BANKROLL_CACHE_TTL_MS = 2_000;

  // ─────────────────────────────────────────────────────────────
  // DEMO FALLBACK (in-memory) — used when Supabase bankroll calls fail
  // ─────────────────────────────────────────────────────────────
  private demoBankroll: Map<string, number> = new Map();

  private mode: "cash" | "tournament" = "cash";

  private tournamentConfig: null | {
    tournamentId: string;
    buyIn: number;
    startingStack: number;
    seatsPerTable: number;
  } = null;

  private tournamentAllowList: Set<string> | null = null;

  constructor(roomId: string, opts?: { mode?: "cash" | "tournament" }) {
    this.roomId = roomId;
    this.mode = opts?.mode ?? "cash";

    for (let i = 0; i < 9; i++) {
      this.seats.push({
        seatIndex: i,
        playerId: null,
        handle: undefined,
        name: undefined,
        chips: 0,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // INACTIVITY HELPERS
  // ─────────────────────────────────────────────────────────────

  private getInactivityState(playerId: string): InactivityState {
    const existing = this.inactivity.get(playerId);
    if (existing) return existing;

    const next: InactivityState = {
      missedTurns: 0,
      isSittingOut: false,
      lastActionAt: Date.now(),
    };
    this.inactivity.set(playerId, next);
    return next;
  }

  private markPlayerActive(playerId: string) {
    if (!playerId) return;
    const cur = this.getInactivityState(playerId);
    cur.missedTurns = 0;
    cur.lastActionAt = Date.now();
    this.inactivity.set(playerId, cur);
  }

  private recordMissedTurn(playerId: string) {
    if (!playerId) return;

    const cur = this.getInactivityState(playerId);
    cur.missedTurns += 1;
    cur.lastActionAt = Date.now();

    let newlySatOut = false;
    if (cur.missedTurns >= this.AUTO_SIT_OUT_AFTER_MISSES && !cur.isSittingOut) {
      cur.isSittingOut = true;
      newlySatOut = true;
    }

    this.inactivity.set(playerId, cur);

    if (newlySatOut) {
      this.broadcast({
        kind: "poker",
        roomId: this.roomId,
        playerId: "server",
        type: "player-sitout-state",
        targetPlayerId: playerId,
        isSittingOut: true,
        missedTurns: cur.missedTurns,
        reason: "inactive",
      } as any);

      const seat = this.seats.find((s) => s.playerId === playerId);
      const label = seat?.handle || seat?.name || "Player";

      this.broadcast({
        kind: "poker",
        roomId: this.roomId,
        playerId: "server",
        type: "chat-broadcast",
        text: `${label} is now sitting out due to inactivity.`,
      } as any);
    }
  }

  private setPlayerSittingOut(playerId: string, sittingOut: boolean, reason = "manual") {
    if (!playerId) return;

    const cur = this.getInactivityState(playerId);
    cur.isSittingOut = sittingOut;
    cur.lastActionAt = Date.now();

    if (!sittingOut) {
      cur.missedTurns = 0;
    }

    this.inactivity.set(playerId, cur);

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "player-sitout-state",
      targetPlayerId: playerId,
      isSittingOut: sittingOut,
      missedTurns: cur.missedTurns,
      reason,
    } as any);
  }

  private isPlayerSittingOut(playerId: string | null | undefined) {
    if (!playerId) return false;
    return this.inactivity.get(playerId)?.isSittingOut === true;
  }

  // ─────────────────────────────────────────────────────────────
  // DISCONNECT HELPERS
  // ─────────────────────────────────────────────────────────────

  private clearDisconnectTimer(playerId: string) {
    const t = this.disconnectTimers.get(playerId);
    if (t) clearTimeout(t);
    this.disconnectTimers.delete(playerId);
  }

  public markDisconnected(playerId: string) {
    if (!playerId) return;

    this.disconnectedAt.set(playerId, Date.now());
    this.clearDisconnectTimer(playerId);

    // detach dead socket but keep seat during grace
    this.clients.delete(playerId);

    const t = setTimeout(() => {
      if (this.clients.has(playerId)) return;
      if (!this.disconnectedAt.has(playerId)) return;
      this.removeClient(playerId, "timeout");
    }, this.DISCONNECT_GRACE_MS);

    this.disconnectTimers.set(playerId, t as any);

    try {
      void this.broadcastSeats();
    } catch {}
  }

  // ─────────────────────────────────────────────────────────────
  // PAUSE / DEAL HOLD
  // ─────────────────────────────────────────────────────────────

  private broadcastPauseState() {
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

    if (!this.handInProgress) {
      const eligible = this.seats.filter(
        (s) => s.playerId && (s.chips ?? 0) > 0 && !this.isPlayerSittingOut(s.playerId)
      );
      if (eligible.length >= 2 && this.clients.size > 0) this.armAutoDeal();
    }
  }

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

    if (!this.handInProgress) {
      const eligible = this.seats.filter(
        (s) => s.playerId && (s.chips ?? 0) > 0 && !this.isPlayerSittingOut(s.playerId)
      );
      if (eligible.length >= 2 && this.clients.size > 0) this.armAutoDeal();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ACTION TIMER
  // ─────────────────────────────────────────────────────────────

  private clearActionTimer() {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    this.actionTurnKey = null;
  }

  private armActionTimer() {
    this.clearActionTimer();

    const betting = this.game.getBettingState();
    if (!betting || betting.street === "done" || betting.currentSeatIndex == null) return;

    const seat = this.seats.find((s) => s.seatIndex === betting.currentSeatIndex);
    const playerId = seat?.playerId;
    if (!playerId) return;

    const turnKey = `${betting.handId}:${betting.street}:${betting.currentSeatIndex}`;
    this.actionTurnKey = turnKey;

    this.actionTimer = setTimeout(() => {
      const live = this.game.getBettingState();
      if (!live || live.street === "done" || live.currentSeatIndex == null) return;

      const liveKey = `${live.handId}:${live.street}:${live.currentSeatIndex}`;
      if (liveKey !== turnKey) return;

      this.actionTimer = setTimeout(() => {
        const again = this.game.getBettingState();
        if (!again || again.street === "done" || again.currentSeatIndex == null) return;

        const againKey = `${again.handId}:${again.street}:${again.currentSeatIndex}`;
        if (againKey !== turnKey) return;

        this.handleServerInactivityTimeout(playerId);
      }, this.ACTION_EXTRA_MS) as any;
    }, this.ACTION_BASE_MS) as any;
  }

  private async handleServerInactivityTimeout(playerId: string) {
    const betting = this.game.getBettingState();
    if (!betting || betting.street === "done") return;

    const p = betting.players.find((x: any) => String(x.playerId) === String(playerId));
    if (!p || p.hasFolded || !p.inHand) return;

    // Always fold inactive players.
// Auto-check causes endless inactive loops when multiple players keep timing out.
const forcedAction: "fold" = "fold";

    this.recordMissedTurn(playerId);

    const seat = this.seats.find((s) => s.playerId === playerId);
    const label = seat?.handle || seat?.name || "Player";

    this.broadcast({
  kind: "poker",
  roomId: this.roomId,
  playerId: "server",
  type: "chat-broadcast",
  text: `${label} auto-folded for inactivity.`,
} as any);

    this.applyResolvedAction(playerId, forcedAction, undefined, { countAsActivity: false });

    const state = this.getInactivityState(playerId);
    if (state.isSittingOut && this.mode === "cash") {
      const latest = this.game.getBettingState();
      if (!latest || latest.street === "done") {
        await this.handleStand(playerId);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // DEMO / BANKROLL HELPERS
  // ─────────────────────────────────────────────────────────────

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
      let cur = this.getDemoBankroll(playerId);

      console.error("[PokerRoom] debitPgld failed (likely Supabase RLS/keys)", e);

      if (cur <= 0) {
        try {
          const fromRead = await getPgld(playerId);
          const seeded = Math.max(0, Math.floor(Number(fromRead) || 0));
          this.setDemoBankroll(playerId, seeded);
          cur = seeded;
        } catch {}
      }

      if (cur < amt) {
        const err: any = new Error("INSUFFICIENT_PGLD");
        err.message = "INSUFFICIENT_PGLD";
        throw err;
      }

      this.setDemoBankroll(playerId, cur - amt);
    }
  }

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
    const ids = new Set<string>();

    for (const pid of this.clients.keys()) ids.add(pid);
    for (const s of this.seats) if (s.playerId) ids.add(s.playerId);

    for (const pid of ids) {
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
      bankrolls,
    } as any);
  }

  // ─────────────────────────────────────────────────────────────
  // TOURNAMENT HELPERS
  // ─────────────────────────────────────────────────────────────

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

      this.setPlayerSittingOut(pid, false, "auto-seat");
    }

    this.syncGameWithSeats("autoSeatTournamentPlayers");
    void this.broadcastSeats();

    if (!this.handInProgress) {
      const eligible = this.seats.filter(
        (s) => s.playerId && (s.chips ?? 0) > 0 && !this.isPlayerSittingOut(s.playerId)
      );
      if (eligible.length >= 2 && this.clients.size > 0) this.armAutoDeal();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // GAME ↔ SEATS SYNC
  // ─────────────────────────────────────────────────────────────

  private syncGameWithSeats(reason: string) {
    const anyGame: any = this.game as any;

    if (typeof anyGame.onSeatsChanged === "function") {
      anyGame.onSeatsChanged(this.seats);
    }

    if (typeof anyGame.maybeRecoverFromStall === "function") {
      anyGame.maybeRecoverFromStall(20_000);
    }

    const b = this.game.getBettingState();
    const t = this.game.getLastState();

    if (!b && !t) {
      if (this.handInProgress) {
        this.handInProgress = false;
      }
      this.broadcastClearTable(reason);
    }
  }

  private broadcastClearTable(reason: string) {
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
  // SNAPSHOTS
  // ─────────────────────────────────────────────────────────────

  public getLobbySnapshot() {
    const seated = this.seats.filter((s) => s.playerId).length;
    const withChips = this.seats.filter((s) => s.playerId && (s.chips ?? 0) > 0).length;

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

  public hasKnownPlayer(playerId: string) {
    if (!playerId) return false;
    if (this.clients.has(playerId)) return true;
    if (this.disconnectedAt.has(playerId)) return true;
    return this.seats.some((s) => s.playerId === playerId);
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

    if (this.mode === "tournament" && this.tournamentAllowList) {
      if (!this.tournamentAllowList.has(playerId)) {
        this.sendTo(playerId, {
          kind: "poker",
          roomId: this.roomId,
          playerId: "server",
          type: "error",
          message: "You are not assigned to this tournament table.",
        } as any);
      }
    }

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

          this.setPlayerSittingOut(playerId, false, "tournament-auto-seat");

          this.syncGameWithSeats("tournament-auto-seat:addClient");
          void this.broadcastSeats();

          if (!this.handInProgress) {
            const eligible = this.seats.filter(
              (s) => s.playerId && (s.chips ?? 0) > 0 && !this.isPlayerSittingOut(s.playerId)
            );
            if (eligible.length >= 2 && this.clients.size > 0) this.armAutoDeal();
          }
        }
      }
    }

    const t = this.game.getLastState();
    const b = this.game.getBettingState();
    if (t && b && b.street !== "done") {
      const cards =
        (this.game as any).getPrivateHoleCards?.(playerId) ??
        this.game.getHoleCardsForPlayer(playerId);
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

    try {
      if (!this.tableName) {
        const raw = typeof meta?.tableName === "string" ? meta.tableName.trim() : "";
        if (raw) this.tableName = raw.slice(0, 24);
      }

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
      const playersForBroadcast =
        this.mode === "tournament"
          ? lastTable.players.map((p) => ({ ...p, holeCards: [] }))
          : lastTable.players;

      this.sendTo(playerId, {
        kind: "poker",
        roomId: this.roomId,
        playerId,
        type: "table-state",
        handId: lastTable.handId,
        board: lastTable.board,
        players: playersForBroadcast,
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

    this.sendTo(playerId, {
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "deal-hold-state",
      held: this.dealHeld,
      heldBy: this.dealHeldBy,
      heldAt: this.dealHeldAt,
    } as any);

    const sitState = this.getInactivityState(playerId);
    this.sendTo(playerId, {
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "player-sitout-state",
      targetPlayerId: playerId,
      isSittingOut: sitState.isSittingOut,
      missedTurns: sitState.missedTurns,
      reason: "join-sync",
    } as any);
  }

  public reconnectClient(
    playerId: string,
    socket: WebSocket,
    name?: string,
    meta?: { tableName?: string; private?: string | boolean | number }
  ) {
    if (!playerId || !socket) return;

    this.clearDisconnectTimer(playerId);
    this.disconnectedAt.delete(playerId);
    this.clients.set(playerId, { socket, playerId, name });

    try {
      if (!this.tableName) {
        const raw = typeof meta?.tableName === "string" ? meta.tableName.trim() : "";
        if (raw) this.tableName = raw.slice(0, 24);
      }
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

    try {
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
        const playersForBroadcast =
          this.mode === "tournament"
            ? lastTable.players.map((p) => ({ ...p, holeCards: [] }))
            : lastTable.players;

        this.sendTo(playerId, {
          kind: "poker",
          roomId: this.roomId,
          playerId,
          type: "table-state",
          handId: lastTable.handId,
          board: lastTable.board,
          players: playersForBroadcast,
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

      const t = this.game.getLastState();
      const b = this.game.getBettingState();
      if (t && b && b.street !== "done") {
        const cards =
          (this.game as any).getPrivateHoleCards?.(playerId) ??
          this.game.getHoleCardsForPlayer(playerId);

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

      this.sendTo(playerId, {
        kind: "poker",
        roomId: this.roomId,
        playerId: "server",
        type: "deal-hold-state",
        held: this.dealHeld,
        heldBy: this.dealHeldBy,
        heldAt: this.dealHeldAt,
      } as any);

      const sitState = this.getInactivityState(playerId);
      this.sendTo(playerId, {
        kind: "poker",
        roomId: this.roomId,
        playerId: "server",
        type: "player-sitout-state",
        targetPlayerId: playerId,
        isSittingOut: sitState.isSittingOut,
        missedTurns: sitState.missedTurns,
        reason: "reconnect-sync",
      } as any);

      void this.broadcastSeats();
    } catch {}
  }

  removeClient(
    playerId: string,
    reason: "disconnect" | "timeout" | "leave" = "disconnect"
  ) {
    this.clearDisconnectTimer(playerId);
    this.disconnectedAt.delete(playerId);

    if (reason === "disconnect") {
      this.markDisconnected(playerId);
      return;
    }

    this.clients.delete(playerId);
    this.inactivity.delete(playerId);

    let changed = false;

    const stackToReturn = (() => {
      const seat = this.seats.find((s) => s.playerId === playerId);
      return Math.max(0, Math.floor(Number(seat?.chips ?? 0)));
    })();

    this.seats = this.seats.map((s) => {
      if (s.playerId === playerId) {
        changed = true;
        return { ...s, playerId: null, name: undefined, handle: undefined, chips: 0 };
      }
      return s;
    });

    this.syncGameWithSeats(reason);

    if (this.mode === "cash" && stackToReturn > 0) {
      (async () => {
        try {
          await this.safeCredit(playerId, stackToReturn, "poker_cashout", this.roomId, {
            reason,
          });
          this.invalidateBankroll(playerId);
          await this.broadcastSeats();
        } catch {}
      })();
    }

    if (changed) {
      void this.broadcastSeats();
    }

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "room-left",
      reason,
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
    if (!playerId) return;

    const t = (msg as any).type as string;

    const isHostCmd =
      t === "host-hold-deal" ||
      t === "host-resume-deal" ||
      t === "host-reset" ||
      t === "host-force-end-hand" ||
      t === "reset-table" ||
      t === "ping" ||
      t === "chat" ||
      t === "sit" ||
      t === "stand";

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

    switch (t) {
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
          (msg as any).name,
          (msg as any).handle
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
        this.handleAction(playerId, (msg as any).action, (msg as any).amount);
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

      case "reset-table":
      case "host-reset": {
        if (!this.isHost(playerId)) return;

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
        return;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // RESET / FORCE END
  // ─────────────────────────────────────────────────────────────

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
    this.clearActionTimer();

    this.broadcastClearTable("HOST_RESET");

    this.cleanupGhostSeats();
    const eligible = this.seats.filter(
      (s) => s.playerId && (s.chips ?? 0) > 0 && !this.isPlayerSittingOut(s.playerId)
    );
    if (eligible.length >= 2 && this.clients.size > 0) {
      this.armAutoDeal();
    }
  }

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
    this.clearActionTimer();

    this.broadcastClearTable(reason);
    this.syncGameWithSeats(`forceEndHand:${reason}`);

    const eligible = this.seats.filter(
      (s) => s.playerId && (s.chips ?? 0) > 0 && !this.isPlayerSittingOut(s.playerId)
    );
    if (eligible.length >= 2 && this.clients.size > 0) this.armAutoDeal();
  }

  // ─────────────────────────────────────────────────────────────
  // SITTING / STANDING
  // ─────────────────────────────────────────────────────────────

  private async handleSit(
    playerId: string,
    buyIn?: number,
    seatIndex?: number,
    name?: string,
    handle?: string
  ) {
    console.log(`[PokerRoom:${this.roomId}] handleSit`, {
      playerId,
      buyIn,
      seatIndex,
      mode: this.mode,
      clients: this.clients.size,
      seated: this.seats.filter((s) => s.playerId).length,
    });

    const already = this.seats.find((s) => s.playerId === playerId);
    if (already) return;

    const h = String(handle ?? "").trim();
    const safeHandle = h ? (h.startsWith("@") ? h : `@${h}`) : undefined;
    const safeName = String(name ?? "").trim() || undefined;

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
          ? {
              ...s,
              playerId,
              handle: safeHandle,
              name: safeName || this.clients.get(playerId)?.name,
              chips: stack,
            }
          : s
      );

      this.setPlayerSittingOut(playerId, false, "sit");

      this.syncGameWithSeats("tournament-sit");
      await this.broadcastSeats();

      if (!this.handInProgress) {
        const eligible = this.seats.filter(
          (s) => s.playerId && (s.chips ?? 0) > 0 && !this.isPlayerSittingOut(s.playerId)
        );
        if (eligible.length >= 2 && this.clients.size > 0) this.armAutoDeal();
      }

      return;
    }

    const desired = Math.max(100, Math.floor(Number(buyIn ?? 0)));
    if (!Number.isFinite(desired) || desired <= 0) return;

    try {
      await this.safeDebit(playerId, desired, "poker_buyin", this.roomId, {
        seatIndex: targetSeat.seatIndex,
      });
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
        ? {
            ...s,
            playerId,
            handle: safeHandle,
            name: safeName || this.clients.get(playerId)?.name,
            chips: desired,
          }
        : s
    );

    this.setPlayerSittingOut(playerId, false, "sit");

    this.syncGameWithSeats("cash-sit");
    await this.broadcastSeats();

    if (!this.handInProgress) {
      const eligible = this.seats.filter(
        (s) => s.playerId && (s.chips ?? 0) > 0 && !this.isPlayerSittingOut(s.playerId)
      );
      if (eligible.length >= 2 && this.clients.size > 0) this.armAutoDeal();
    }
  }

  private async handleStand(playerId: string) {
    const betting = this.game.getBettingState();
    if (betting && betting.street !== "done") return;
    if (this.mode === "tournament") return;

    const seat = this.seats.find((s) => s.playerId === playerId);
    if (!seat) return;

    const stack = Math.max(0, Math.floor(Number(seat.chips ?? 0)));

    this.seats = this.seats.map((s) =>
      s.playerId === playerId
        ? { ...s, playerId: null, name: undefined, handle: undefined, chips: 0 }
        : s
    );

    this.inactivity.delete(playerId);

    this.syncGameWithSeats("stand");

    if (this.mode === "cash" && stack > 0) {
      try {
        await this.safeCredit(playerId, stack, "poker_cashout", this.roomId, {
          seatIndex: seat.seatIndex,
        });
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

    await this.broadcastSeats();
  }

  private async handleRefillStack(playerId: string, amount?: number) {
    const betting = this.game.getBettingState();
    if (betting && betting.street !== "done") return;
    if (this.mode === "tournament") return;

    const seat = this.seats.find((s) => s.playerId === playerId);
    if (!seat) return;

    const requested = Math.max(0, Math.floor(Number(amount ?? 0)));
    if (!Number.isFinite(requested) || requested <= 0) return;

    try {
      await this.safeDebit(playerId, requested, "poker_refill", this.roomId, {
        seatIndex: seat.seatIndex,
      });
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
        (s) => s.playerId && (s.chips ?? 0) > 0 && !this.isPlayerSittingOut(s.playerId)
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

      this.broadcastDealHoldState();

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
      (s) => s.playerId && (s.chips ?? 0) > 0 && !this.isPlayerSittingOut(s.playerId)
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

    const playableSeats: SeatView[] = this.seats.map((s) => {
      if (!s.playerId) return s;
      if (this.isPlayerSittingOut(s.playerId)) {
        return {
          ...s,
          playerId: null,
          handle: undefined,
          name: undefined,
          chips: 0,
        };
      }
      return s;
    });

    const table = this.game.startHand(playableSeats);
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
    this.revealedThisHand.clear();

    const playersForBroadcast =
      this.mode === "tournament"
        ? table.players.map((p) => ({ ...p, holeCards: [] }))
        : table.players;

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "table-state",
      handId: table.handId,
      board: table.board,
      players: playersForBroadcast,
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

    for (const p of table.players) {
      const cards =
        (this.game as any).getPrivateHoleCards?.(p.playerId) ??
        this.game.getHoleCardsForPlayer(p.playerId);

      if (!cards || cards.length < 2) continue;

      this.sendTo(p.playerId, {
        kind: "poker",
        roomId: this.roomId,
        playerId: "server",
        type: "hole-cards",
        handId: table.handId,
        cards: cards.slice(0, 2),
      } as any);
    }

    this.armActionTimer();
    return true;
  }

  // ─────────────────────────────────────────────────────────────
  // ACTIONS
  // ─────────────────────────────────────────────────────────────

  private handleAction(
    playerId: string,
    action: "fold" | "check" | "call" | "bet",
    amount?: number
  ) {
    this.applyResolvedAction(playerId, action, amount, { countAsActivity: true });
  }

  private applyResolvedAction(
    playerId: string,
    action: "fold" | "check" | "call" | "bet",
    amount?: number,
    opts?: { countAsActivity?: boolean }
  ) {
    if (this.mode === "tournament" && this.tournamentAllowList) {
      if (!this.tournamentAllowList.has(playerId)) return;
    }

    if (opts?.countAsActivity !== false) {
      this.markPlayerActive(playerId);
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
      const playersForBroadcast =
        this.mode === "tournament"
          ? table.players.map((p) => ({ ...p, holeCards: [] }))
          : table.players;

      this.broadcast({
        kind: "poker",
        roomId: this.roomId,
        playerId: "server",
        type: "table-state",
        handId: table.handId,
        board: table.board,
        players: playersForBroadcast,
      } as any);
    }

    if (betting.street === "done") {
      const showdown = this.game.computeShowdown();

      const rake = Math.max(
        0,
        Math.floor(Number((betting as any).rake ?? Math.floor((betting.pot * 5) / 100)))
      );

      const pot = Math.max(0, Math.floor(Number(betting.pot ?? 0)));
      const potAfterRake = Math.max(0, pot - rake);

      this.totalFakeRake += rake;

      console.log(
        `[PokerRoom:${this.roomId}] Hand #${betting.handId} complete. Pot=${pot}, Rake (5%)=${rake}, PotAfterRake=${potAfterRake}, Total rake=${this.totalFakeRake}`
      );

      if (showdown) {
        this.broadcast({
          kind: "poker",
          roomId: this.roomId,
          playerId: "server",
          type: "showdown",
          handId: showdown.handId,
          board: showdown.board,
          players: showdown.players as any,
          rake,
          potAfterRake,
        } as any);
      }

      if (this.mode === "cash" && rake > 0) {
        void (async () => {
          try {
            await this.safeCredit("HOUSE", rake, "poker_rake", `${this.roomId}:${betting.handId}`, {
              roomId: this.roomId,
              handId: betting.handId,
              pot,
              rake,
            });
          } catch {}
        })();
      }

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
      this.clearActionTimer();

      // stand up any cash players who were marked sitting out from inactivity
      if (this.mode === "cash") {
        const toStand = this.seats
          .filter((s) => s.playerId && this.isPlayerSittingOut(s.playerId))
          .map((s) => String(s.playerId));

        for (const pid of toStand) {
          void this.handleStand(pid);
        }
      }

      this.cleanupGhostSeats();

      const eligible = this.seats.filter(
        (s) => s.playerId && (s.chips ?? 0) > 0 && !this.isPlayerSittingOut(s.playerId)
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

      return;
    }

    this.armActionTimer();
  }

  private handleShowCards(playerId: string) {
    const betting = this.game.getBettingState();
    if (!betting || betting.street !== "done") return;

    const anyGame: any = this.game as any;

    const payload =
      typeof anyGame.revealPlayerHoleCards === "function"
        ? anyGame.revealPlayerHoleCards(playerId)
        : null;

    const hole =
      payload?.holeCards ??
      (typeof anyGame.getPrivateHoleCards === "function"
        ? (anyGame.getPrivateHoleCards(playerId) as string[] | null)
        : typeof anyGame.getHoleCardsForPlayer === "function"
        ? (anyGame.getHoleCardsForPlayer(playerId) as string[] | null)
        : null);

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
      handId: betting.handId,
    } as any);
  }

  // ─────────────────────────────────────────────────────────────
  // GHOST / RESET HELPERS
  // ─────────────────────────────────────────────────────────────

  private cleanupGhostSeats() {
    const now = Date.now();
    const activeIds = new Set(this.clients.keys());
    let changed = false;

    this.seats = this.seats.map((s) => {
      if (!s.playerId) return s;

      const pid = s.playerId;

      if (activeIds.has(pid)) return s;

      const discAt = this.disconnectedAt.get(pid);
      if (discAt && now - discAt < this.DISCONNECT_GRACE_MS) {
        return s;
      }

      changed = true;
      this.inactivity.delete(pid);
      return { ...s, playerId: null, handle: undefined, name: undefined, chips: 0 };
    });

    if (changed) {
      this.syncGameWithSeats("cleanupGhostSeats");
      void this.broadcastSeats();
    }
  }

  private resetTableState() {
    this.clearAutoDealTimer();
    this.clearActionTimer();
    this.revealedThisHand.clear();

    const freshSeats: SeatView[] = [];
    for (let i = 0; i < 9; i++) {
      freshSeats.push({
        seatIndex: i,
        playerId: null,
        handle: undefined,
        name: undefined,
        chips: 0,
      });
    }

    this.seats = freshSeats;
    this.game = new HoldemGame();
    this.handInProgress = false;
    this.totalFakeRake = 0;

    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    this.disconnectTimers.clear();
    this.disconnectedAt.clear();
    this.inactivity.clear();

    console.log(`[PokerRoom:${this.roomId}] All clients gone. Resetting table state.`);
  }

  public shutdown(reason = "Room shutdown") {
    this.clearAutoDealTimer();
    this.clearActionTimer();
    this.revealedThisHand.clear();

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

    for (const { socket } of this.clients.values()) {
      try {
        socket.close(1000, reason);
      } catch {}
    }

    this.clients.clear();
    this.resetTableState();
  }

  // (unused legacy vars kept if you still reference them elsewhere)
  private dealingHeld = false;
  private holdUntilMs: number | null = null;

  // ─────────────────────────────────────────────────────────────
  // LOW-LEVEL SEND HELPERS
  // ─────────────────────────────────────────────────────────────

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