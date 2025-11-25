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

  private handleSit(
    playerId: string,
    buyIn?: number,
    seatIndex?: number,
    name?: string
  ) {
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

    // SANITIZE BUY-IN
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

  private handleStartHand(requesterId: string) {
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

    // If hand ended, compute and broadcast showdown
    if (betting.street === "done") {
      const showdown = this.game.computeShowdown();
      if (showdown) {
        this.broadcast({
          kind: "poker",
          roomId: this.roomId,
          playerId: "server",
          type: "showdown",
          handId: showdown.handId,
          board: showdown.board,
          // showdown.players already has correct card types
          players: showdown.players as any,
        });
      }
    }
  }

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
