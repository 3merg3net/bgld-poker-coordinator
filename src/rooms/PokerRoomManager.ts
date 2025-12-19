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
// host = lowest occupied seatIndex


private getHostSeatIndex(): number | null {
  let min: number | null = null;
  for (const s of this.seats) {
    if (!s.playerId) continue;
    if (min === null || s.seatIndex < min) min = s.seatIndex;
  }
  return min;
}

  private isHost(playerId: string): boolean {
  const hostSeat = this.getHostSeatIndex();
  if (hostSeat === null) return false;
  const hero = this.seats.find((s) => s.playerId === playerId);
  return !!hero && hero.seatIndex === hostSeat;
}



  // ✅ Server-owned auto-deal timer
  private autoDealTimer: NodeJS.Timeout | null = null;

  // ✅ Track who we've revealed this hand (all-in + voluntary show)
  private revealedThisHand: Set<string> = new Set(); // key = `${handId}:${playerId}`

  // ✅ Change to 10s as requested
  private static readonly AUTO_DEAL_DELAY_MS = 10_000;

  private handleResetTable(requesterId: string) {
  // host = lowest occupied seatIndex (same as your FE host rule)
  const occupied = this.seats.filter(s => s.playerId);
  const hostSeat = occupied.map(s => s.seatIndex).sort((a,b)=>a-b)[0];
  const requesterSeat = this.seats.find(s => s.playerId === requesterId)?.seatIndex;

  if (hostSeat == null || requesterSeat !== hostSeat) {
    this.sendTo(requesterId, {
      kind: "poker",
      roomId: this.roomId,
      playerId: requesterId,
      type: "error",
      message: "Only the host can reset the table.",
    });
    return;
  }

  // keep seats as-is, just kill the current hand state
  this.game = new HoldemGame();
  this.handInProgress = false;

  // broadcast “table cleared”
  this.broadcast({
    kind: "poker",
    roomId: this.roomId,
    playerId: "server",
    type: "table-reset",
  });

  // also re-broadcast seats so everyone is synced
  this.broadcast({
    kind: "poker",
    roomId: this.roomId,
    playerId: "server",
    type: "seats-update",
    seats: this.seats,
  });
}


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

  addClient(playerId: string, socket: WebSocket, name?: string) {
    this.clients.set(playerId, { socket, playerId, name });

    this.cleanupGhostSeats();

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "room-joined",
      onlineCount: this.clients.size,
    });

    this.sendTo(playerId, {
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "seats-update",
      seats: this.seats,
    });

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
      });
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

    let changed = false;
    this.seats = this.seats.map((s) => {
      if (s.playerId === playerId) {
        changed = true;
        return { ...s, playerId: null, name: undefined, chips: 0 };
      }
      return s;
    });

    if (changed) {
      this.broadcast({
        kind: "poker",
        roomId: this.roomId,
        playerId,
        type: "seats-update",
        seats: this.seats,
      });
    }

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "room-left",
    });

    if (this.clients.size === 0) {
      this.resetTableState();
    }
  }

  handleMessage(msg: ClientToServerMessage) {
    switch (msg.type) {
      case "ping":
        this.broadcast({
          kind: "poker",
          roomId: this.roomId,
          playerId: msg.playerId,
          type: "pong",
          payload: msg.payload ?? "pong",
        });
        break;

      case "chat":
        this.broadcast({
          kind: "poker",
          roomId: this.roomId,
          playerId: msg.playerId,
          type: "chat-broadcast",
          text: msg.text,
        });
        break;

      case "sit":
        this.handleSit(msg.playerId, msg.buyIn, msg.seatIndex, msg.name);
        break;

      case "stand":
        this.handleStand(msg.playerId);
        break;

      case "start-hand":
        this.handleStartHand(msg.playerId);
        break;

      case "action":
        this.handleAction(msg.playerId, msg.action, msg.amount);
        break;

      case "show-cards":
        this.handleShowCards(msg.playerId);
        break;

        case "reset-table":
  this.handleResetTable(msg.playerId);
  break;


      default:
        break;
    }
  }

  // ───────────────── SITTING / STANDING ─────────────────

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
      });
      return;
    }

    const stack = Math.max(1, Math.floor(buyIn ?? 0));

    this.seats = this.seats.map((s) =>
      s.seatIndex === targetSeat!.seatIndex
        ? {
            ...s,
            playerId,
            name: name || this.clients.get(playerId)?.name,
            chips: stack,
          }
        : s
    );

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "seats-update",
      seats: this.seats,
    });
  }

  private handleStand(playerId: string) {
    let changed = false;

    this.seats = this.seats.map((s) => {
      if (s.playerId === playerId) {
        changed = true;
        return { ...s, playerId: null, name: undefined, chips: 0 };
      }
      return s;
    });

    if (changed) {
      this.broadcast({
        kind: "poker",
        roomId: this.roomId,
        playerId,
        type: "seats-update",
        seats: this.seats,
      });
    }
  }

  // ───────────────── HAND LIFECYCLE ─────────────────

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

    // Try to start. If it fails (ex: players at 0 chips), re-arm and keep polling.
    const started = this.tryStartHand(true);

    if (!started && this.clients.size > 0) {
      // Re-arm in a shorter interval so table recovers quickly once someone refills
      this.clearAutoDealTimer();
      this.autoDealTimer = setTimeout(() => {
        if (this.clients.size === 0) return;
        this.tryStartHand(true);
      }, 5_000) as any;
    }
  }, PokerRoomManager.AUTO_DEAL_DELAY_MS) as any;
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
        });
      }
      return false;
    }

    this.cleanupGhostSeats();

    const seatedPlayers = this.seats.filter((s) => s.playerId && (s.chips ?? 0) > 0);
if (seatedPlayers.length < 2) {
      if (!auto && requesterId) {
        this.sendTo(requesterId, {
          kind: "poker",
          roomId: this.roomId,
          playerId: requesterId,
          type: "error",
          message: "At least 2 seated players are required to start a hand.",
        });
      }
      return false;
    }

    // ✅ Starting a new hand cancels any pending auto-deal
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
        });
      }
      return false;
    }

    this.handInProgress = true;

    // ✅ New hand: reset reveal tracking
    this.revealedThisHand.clear();

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId: "server",
      type: "table-state",
      handId: table.handId,
      board: table.board,
      players: table.players,
    });

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

  private handleStartHand(requesterId: string) {
    this.tryStartHand(false, requesterId);
  }

  private maybeRevealAllInHands() {
    const betting = this.game.getBettingState();
    if (!betting || betting.street === "done") return;

    for (const p of betting.players as any[]) {
      if (!p?.playerId) continue;
      if (!p.inHand || p.hasFolded) continue;

      // ✅ "All-in" condition
      if (typeof p.stack === "number" && p.stack === 0) {
        const key = `${betting.handId}:${p.playerId}`;
        if (this.revealedThisHand.has(key)) continue;

        const anyGame: any = this.game as any;
        if (typeof anyGame.getHoleCardsForPlayer !== "function") continue;

        const hole = anyGame.getHoleCardsForPlayer(p.playerId) as string[] | null;
        if (!hole || hole.length !== 2) continue;

        this.revealedThisHand.add(key);

        this.broadcast({
          kind: "poker",
          roomId: this.roomId,
          playerId: p.playerId,
          type: "player-show-cards",
          cards: hole,
          reason: "all-in",
        } as any);
      }
    }
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
      });
    }

    // ✅ reveal any newly all-in hands immediately
    this.maybeRevealAllInHands();

    if (betting.street === "done") {
      const fakeRake = Math.floor((betting.pot * 5) / 100);
      this.totalFakeRake += fakeRake;

      console.log(
        `[PokerRoom:${this.roomId}] Hand #${betting.handId} complete. Pot=${betting.pot}, ` +
          `Fake rake (5%)=${fakeRake}, Total fake rake=${this.totalFakeRake}`
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
        });
      }

      // Sync seat chip stacks from final game state
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

      this.broadcast({
        kind: "poker",
        roomId: this.roomId,
        playerId: "server",
        type: "seats-update",
        seats: this.seats,
      });

      this.handInProgress = false;

      // ✅ Always arm next hand after a finish (server-owned)
      this.cleanupGhostSeats();

// ✅ only arm if 2+ players are BOTH seated AND have chips
const eligible = this.seats.filter((s) => s.playerId && (s.chips ?? 0) > 0);

if (eligible.length >= 2 && this.clients.size > 0) {
  console.log(
    `[PokerRoom:${this.roomId}] Auto-deal armed: next hand in ${PokerRoomManager.AUTO_DEAL_DELAY_MS}ms`
  );
  this.armAutoDeal();
} else {
  console.log(
    `[PokerRoom:${this.roomId}] Auto-deal paused; need 2 seated players with chips (>0) and at least 1 connected.`
  );

  // Optional: tell table why it stopped (feels less “broken”)
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

    
// ✅ Hand is over
this.handInProgress = false;

// ✅ Always arm auto-deal after a completed hand (server-owned)
this.armAutoDeal();

    const anyGame: any = this.game as any;
    if (typeof anyGame.getHoleCardsForPlayer !== "function") return;

    const hole = anyGame.getHoleCardsForPlayer(playerId) as string[] | null;
    if (!hole || hole.length !== 2) return;

    // ✅ prevent spamming same reveal
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

  // ───────────────── GHOST / RESET HELPERS ─────────────────

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
      this.broadcast({
        kind: "poker",
        roomId: this.roomId,
        playerId: "server",
        type: "seats-update",
        seats: this.seats,
      });
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

  // ───────────────── LOW-LEVEL SEND HELPERS ─────────────────

  private broadcast(message: ServerToClientMessage) {
    const raw = JSON.stringify(message);
    for (const { socket } of this.clients.values()) {
      if (socket.readyState === socket.OPEN) {
        socket.send(raw);
      }
    }
  }

  private sendTo(playerId: string, message: ServerToClientMessage) {
    const entry = this.clients.get(playerId);
    if (!entry) return;
    if (entry.socket.readyState !== entry.socket.OPEN) return;
    entry.socket.send(JSON.stringify(message));
  }
}
