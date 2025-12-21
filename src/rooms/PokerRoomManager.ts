// src/rooms/PokerRoomManager.ts
import type WebSocket from "ws";
import type { ClientToServerMessage } from "../types/ClientToServer";
import type { ServerToClientMessage } from "../types/ServerToClient";
import { HoldemGame, SeatView } from "../game/HoldemGame";

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

  private handInProgress = false;
  private totalFakeRake = 0;

  // ✅ Server-owned PGLD bankroll (off-table)
  private bankrolls: Map<string, number> = new Map();
  private static readonly DEMO_BANKROLL_DEFAULT = 5_000;

  // ✅ Server-owned auto-deal timer + reveal tracking
  private autoDealTimer: NodeJS.Timeout | null = null;
  private revealedThisHand: Set<string> = new Set();
  private static readonly AUTO_DEAL_DELAY_MS = 10_000;

  constructor(roomId: string) {
    this.roomId = roomId;

    for (let i = 0; i < 9; i++) {
      this.seats.push({
        seatIndex: i,
        playerId: null,
        name: undefined,
        chips: 0,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // BANKROLL HELPERS (single source of truth)
  // ─────────────────────────────────────────────────────────────

  private getBankroll(playerId: string): number {
    if (!this.bankrolls.has(playerId)) {
      this.bankrolls.set(playerId, PokerRoomManager.DEMO_BANKROLL_DEFAULT);
    }
    return this.bankrolls.get(playerId)!;
  }

  private setBankroll(playerId: string, value: number) {
    const v = Math.max(0, Math.floor(Number(value) || 0));
    this.bankrolls.set(playerId, v);
  }

  private bankrollsSnapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [pid, amt] of this.bankrolls.entries()) out[pid] = amt;
    return out;
  }

  private broadcastSeats() {
    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "seats-update",
      seats: this.seats,
      bankrolls: this.bankrollsSnapshot(), // ✅ extra field (non-breaking)
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

  private isHost(playerId: string): boolean {
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

  addClient(playerId: string, socket: WebSocket, name?: string) {
    this.clients.set(playerId, { socket, playerId, name });

    // ✅ ensure bankroll exists for this playerId
    this.getBankroll(playerId);

    this.cleanupGhostSeats();

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "room-joined",
      onlineCount: this.clients.size,
    } as any);

    // send seats + bankrolls to the joining client
    this.sendTo(playerId, {
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "seats-update",
      seats: this.seats,
      bankrolls: this.bankrollsSnapshot(),
    } as any);

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
  }

  removeClient(playerId: string) {
    if (!this.clients.has(playerId)) return;
    this.clients.delete(playerId);

    // If disconnect while seated, return stack to bankroll, then clear seat
    let changed = false;
    this.seats = this.seats.map((s) => {
      if (s.playerId === playerId) {
        changed = true;
        const stack = Math.max(0, Math.floor(Number(s.chips ?? 0)));
        if (stack > 0) {
          const cur = this.getBankroll(playerId);
          this.setBankroll(playerId, cur + stack);
        }
        return { ...s, playerId: null, name: undefined, chips: 0 };
      }
      return s;
    });

    if (changed) this.broadcastSeats();

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
        this.handleSit(
          playerId,
          (msg as any).buyIn,
          (msg as any).seatIndex,
          (msg as any).name
        );
        return;

      case "stand":
        this.handleStand(playerId);
        return;

      case "refill-stack":
        this.handleRefillStack(playerId, (msg as any).amount);
        return;

      case "demo-topup":
        this.handleDemoTopup(playerId, (msg as any).target);
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

      default:
        // ignore unknowns to keep cross-game compatibility
        return;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // SITTING / STANDING
  // ─────────────────────────────────────────────────────────────

  private handleSit(
    playerId: string,
    buyIn?: number,
    seatIndex?: number,
    name?: string
  ) {
    const already = this.seats.find((s) => s.playerId === playerId);
    if (already) return;

    let targetSeat: SeatView | undefined;

    if (typeof seatIndex === "number") {
      targetSeat = this.seats.find(
        (s) => s.seatIndex === seatIndex && !s.playerId
      );
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

    const bankroll = this.getBankroll(playerId);
    const desired = Math.max(100, Math.floor(Number(buyIn ?? 0)));

    if (desired > bankroll) {
      this.sendTo(playerId, {
        kind: "poker",
        roomId: this.roomId,
        playerId,
        type: "error",
        message: `Not enough PGLD bankroll to buy in for ${desired}.`,
      } as any);
      return;
    }

    this.setBankroll(playerId, bankroll - desired);

    this.seats = this.seats.map((s) =>
      s.seatIndex === targetSeat!.seatIndex
        ? {
            ...s,
            playerId,
            name: name || this.clients.get(playerId)?.name,
            chips: desired,
          }
        : s
    );

    this.broadcastSeats();

    // If table idle and 2+ players with chips, arm auto-deal
    if (!this.handInProgress) {
      const eligible = this.seats.filter(
        (s) => s.playerId && (s.chips ?? 0) > 0
      );
      if (eligible.length >= 2 && this.clients.size > 0) {
        this.armAutoDeal();
      }
    }
  }

  private handleStand(playerId: string) {
    // only allow stand between hands
    const betting = this.game.getBettingState();
    if (betting && betting.street !== "done") return;

    const seat = this.seats.find((s) => s.playerId === playerId);
    if (!seat) return;

    const stack = Math.max(0, Math.floor(Number(seat.chips ?? 0)));
    if (stack > 0) {
      const cur = this.getBankroll(playerId);
      this.setBankroll(playerId, cur + stack);
    }

    this.seats = this.seats.map((s) =>
      s.playerId === playerId
        ? { ...s, playerId: null, name: undefined, chips: 0 }
        : s
    );

    this.broadcastSeats();
  }

  private handleRefillStack(playerId: string, amount?: number) {
    // only between hands
    const betting = this.game.getBettingState();
    if (betting && betting.street !== "done") return;

    const seat = this.seats.find((s) => s.playerId === playerId);
    if (!seat) return;

    const requested = Math.max(0, Math.floor(Number(amount ?? 0)));
    if (!Number.isFinite(requested) || requested <= 0) return;

    const bankroll = this.getBankroll(playerId);
    if (requested > bankroll) {
      this.sendTo(playerId, {
        kind: "poker",
        roomId: this.roomId,
        playerId,
        type: "error",
        message: `Not enough PGLD bankroll to refill ${requested}.`,
      } as any);
      return;
    }

    this.setBankroll(playerId, bankroll - requested);

    this.seats = this.seats.map((s) => {
      if (s.playerId !== playerId) return s;
      return { ...s, chips: (s.chips ?? 0) + requested };
    });

    this.broadcastSeats();

    if (!this.handInProgress) {
      const eligible = this.seats.filter(
        (s) => s.playerId && (s.chips ?? 0) > 0
      );
      if (eligible.length >= 2 && this.clients.size > 0) {
        this.armAutoDeal();
      }
    }
  }

  private handleDemoTopup(playerId: string, target?: number) {
    const tgt = Math.max(
      0,
      Math.floor(Number(target ?? PokerRoomManager.DEMO_BANKROLL_DEFAULT))
    );

    const cur = this.getBankroll(playerId);
    if (cur >= tgt) {
      this.broadcastSeats();
      return;
    }

    this.setBankroll(playerId, tgt);

    this.sendTo(playerId, {
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "chat-broadcast",
      text: `Demo bankroll topped up to ${tgt.toLocaleString()} PGLD.`,
    } as any);

    this.broadcastSeats();
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

    return true;
  }

  private handleAction(
    playerId: string,
    action: "fold" | "check" | "call" | "bet",
    amount?: number
  ) {
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

      this.broadcastSeats();

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

    if (changed) this.broadcastSeats();
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

    console.log(`[PokerRoom:${this.roomId}] All clients gone. Resetting table state.`);
  }

  // ─────────────────────────────────────────────────────────────
  // LOW-LEVEL SEND HELPERS
  // ─────────────────────────────────────────────────────────────

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
