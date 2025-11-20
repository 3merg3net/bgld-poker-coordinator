// src/rooms/PokerRoomManager.ts
import type WebSocket from "ws";
import type { ClientToServerMessage } from "../types/ClientToServer";
import type { ServerToClientMessage } from "../types/ServerToClient";

type ClientEntry = {
  socket: WebSocket;
  playerId: string;
};

export class PokerRoomManager {
  private roomId: string;
  private clients: Map<string, ClientEntry> = new Map();

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  addClient(playerId: string, socket: WebSocket) {
    this.clients.set(playerId, { socket, playerId });

    this.broadcast({
      kind: "poker",
      roomId: this.roomId,
      playerId,
      type: "room-joined",
      onlineCount: this.clients.size,
    });
  }

  removeClient(playerId: string) {
    if (!this.clients.has(playerId)) return;
    this.clients.delete(playerId);

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

      case "join-room":
      case "leave-room":
      default:
        // join/leave are handled in the server connection logic
        break;
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
}
