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

  // Track if a hand is currently running
  private handInProgress = false;

  // Track lifetime fake rake (just for logging / dev)
  private totalFakeRake = 0;

  constructor(roomId: string) {
    this.roomId = roomId;

    // 9-max layout – front-end dynamically places seated players in a ring
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
    this.clients.set(playerId, {
      socket,
      playerId,
      name,
    });

    // Clear out any seats that belong to players who are no longer connected
    this.cleanupGhostSeats();

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "room-joined",
      onlineCount: this.clients.size,
    });

    // Send seats + current state
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
      });
    }
  }

  removeClient(playerId: string) {
    if (!this.clients.has(playerId)) return;
    this.clients.delete(playerId);

    // Stand them up if seated
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

    // If no clients remain, hard reset table so no ghost seats/hands remain
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

      // client asks server to reveal *their* hole cards to everyone
      case "show-cards":
        this.handleShowCards(msg.playerId);
        break;

      default:
        // join/leave handled at connection level
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
    // ✅ GG-style: allow sitting mid-hand.
    // New players won't appear in the current betting state,
    // so they simply wait and are dealt in on the *next* hand.

    // If already seated, ignore
    const already = this.seats.find((s) => s.playerId === playerId);
    if (already) return;

    // Pick seat: specific or first open
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

    // SANITIZE BUY-IN (fake chips)
    const stack = Math.max(1, Math.floor(buyIn ?? 0));

    // Assign seat
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

    // Optional: system chat "X sits and will be dealt next hand."
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

  private handleStartHand(requesterId: string) {
    // Re-sync handInProgress with actual betting state
    const currentBetting = this.game.getBettingState();
    if (!currentBetting || currentBetting.street === "done") {
      this.handInProgress = false;
    }

    // Prevent spamming new hands while one is really running
    if (this.handInProgress) {
      this.sendTo(requesterId, {
        kind: "poker",
        roomId: this.roomId,
        playerId: requesterId,
        type: "error",
        message: "A hand is already in progress.",
      });
      return;
    }

    // Clear any ghost seats before we look at active players
    this.cleanupGhostSeats();

    // Require at least 2 active players with chips
    const activeSeats = this.seats.filter(
      (s) => s.playerId && (s.chips ?? 0) > 0
    );
    if (activeSeats.length < 2) {
      this.sendTo(requesterId, {
        kind: "poker",
        roomId: this.roomId,
        playerId: requesterId,
        type: "error",
        message:
          "At least 2 seated players with chips are required to start a hand.",
      });
      return;
    }

    const table = this.game.startHand(this.seats);

    if (!table) {
      this.sendTo(requesterId, {
        kind: "poker",
        roomId: this.roomId,
        playerId: requesterId,
        type: "error",
        message: "No seated players to start a hand",
      });
      return;
    }

    // Mark a hand as running
    this.handInProgress = true;

    // Broadcast table + betting
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
      });
    }
  }

  private handleAction(
    playerId: string,
    action: "fold" | "check" | "call" | "bet",
    amount?: number
  ) {
    const betting = this.game.applyAction(playerId, action, amount);
    if (!betting) return;

    // Always broadcast updated betting state
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
    });

    // Also broadcast updated table state (board might have changed)
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

      // If hand ended, compute and broadcast showdown + track fake rake
  if (betting.street === "done") {
    // Fake rake: 5% of final pot
    const fakeRake = Math.floor((betting.pot * 5) / 100);
    this.totalFakeRake += fakeRake;

    console.log(
      `[PokerRoom:${this.roomId}] Hand #${betting.handId} complete. Pot=${betting.pot}, ` +
        `Fake rake (5%)=${fakeRake}, Total fake rake=${this.totalFakeRake}`
    );

    const showdown = this.game.computeShowdown();
    if (showdown) {
      // Broadcast showdown as-is
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

    // 🔥 NEW: sync seat chip stacks from final game state
    const finalTable = this.game.getLastState();
    if (finalTable && Array.isArray(finalTable.players)) {
      // Build a seatIndex -> stack map from the game
      const stacksBySeat: Record<number, number> = {};
      for (const p of finalTable.players as any[]) {
        const seatIdx = p.seatIndex;
        const stack = typeof p.stack === "number" ? p.stack : 0;
        if (typeof seatIdx === "number") {
          stacksBySeat[seatIdx] = stack;
        }
      }

      // Update this.seats with those stacks so next hand uses correct chip counts
      this.seats = this.seats.map((s) => {
        if (!s.playerId) return s;
        const newStack = stacksBySeat[s.seatIndex];
        if (typeof newStack === "number") {
          return { ...s, chips: newStack };
        }
        return s;
      });

      // Let clients know seat chip counts updated
      this.broadcast({
        kind: "poker",
        roomId: this.roomId,
        playerId: "server",
        type: "seats-update",
        seats: this.seats,
      });
    }

    // Hand is over; allow new players to sit and new hand to start
    this.handInProgress = false;
  }

  }

  /**
   * Player requests to show *their* hole cards to the table.
   * We only allow this after river (street === "done").
   */
  private handleShowCards(playerId: string) {
    const betting = this.game.getBettingState();
    if (!betting || betting.street !== "done") {
      // Don’t reveal mid-hand
      return;
    }

    // Optional helper on HoldemGame:
    // getHoleCardsForPlayer(playerId: string): string[] | null
    const anyGame: any = this.game as any;
    if (typeof anyGame.getHoleCardsForPlayer !== "function") {
      return;
    }

    const hole = anyGame.getHoleCardsForPlayer(playerId) as
      | string[]
      | null
      | undefined;
    if (!hole || hole.length !== 2) return;

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "player-show-cards",
      cards: hole, // e.g. ["Ah", "Kd"]
    } as ServerToClientMessage);
  }

  // ───────────────── GHOST / RESET HELPERS ─────────────────

  /** Remove seats that reference players who no longer have a live WebSocket */
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

  /** When the last client leaves, fully reset seats + game state. */
  private resetTableState() {
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
