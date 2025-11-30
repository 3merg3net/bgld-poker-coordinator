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

  // Track if a hand is currently running (for sit/stand + start-hand safety)
  private handInProgress = false;

  // Fake rake tracker (just console logging; not applied to stacks)
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
    // If a hand is running, don't let new players pop in mid-hand
    if (this.handInProgress) {
      this.sendTo(playerId, {
        kind: "poker",
        roomId: this.roomId,
        playerId,
        type: "error",
        message:
          "A hand is currently in progress. Please wait for this hand to finish before sitting.",
      });
      return;
    }

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
    // Prevent spamming new hands while one is running
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

    // Ensure seats reflect in-hand stacks (usually identical at start)
    this.syncSeatStacksFromGame();
  }

  private handleAction(
    playerId: string,
    action: "fold" | "check" | "call" | "bet",
    amount?: number
  ) {
    const betting = this.game.applyAction(playerId, action, amount);
    if (!betting) return;

    // After server updates, keep the seat.chips in sync with betting stacks
    this.syncSeatStacksFromGame();

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

    // If hand ended, compute and broadcast showdown
    if (betting.street === "done") {
      // 👉 Fake rake: 5% of final pot (for logging only; pot already
      // distributed by HoldemGame.computeShowdown)
      const fakeRake = Math.floor((betting.pot * 5) / 100);
      this.totalFakeRake += fakeRake;

      console.log(
        `[PokerRoom:${this.roomId}] Hand #${betting.handId} complete. ` +
          `Pot=${betting.pot}, Fake rake (5%)=${fakeRake}, Total fake rake=${this.totalFakeRake}`
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

      // After showdown, seat stacks are final for this hand
      this.syncSeatStacksFromGame();

      // Hand is over; allow new players to sit and new hand to start
      this.handInProgress = false;
    }
  }

  // ───────────────── STACK SYNC HELPER ─────────────────

  /**
   * Pulls current in-hand stacks from HoldemGame and
   * mirrors them onto this.seats[].chips so the UI
   * shows accurate chip stacks at each avatar.
   */
  private syncSeatStacksFromGame() {
    const seatStacks = this.game.getSeatStacksForCurrentHand();
    if (!seatStacks.length) return;

    let changed = false;

    this.seats = this.seats.map((s) => {
      if (!s.playerId) return s;
      const match = seatStacks.find(
        (ss) => ss.seatIndex === s.seatIndex
      );
      if (!match) return s;
      if (s.chips !== match.stack) {
        changed = true;
        return { ...s, chips: match.stack };
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
