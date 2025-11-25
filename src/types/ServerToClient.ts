// src/types/ServerToClient.ts
import type { MessageBase } from "./shared";

export type ServerToClientMessage =
  | (MessageBase & {
      type: "room-joined";
      onlineCount: number;
    })
  | (MessageBase & {
      type: "room-left";
    })
  | (MessageBase & {
      type: "pong";
      payload?: string;
    })
  | (MessageBase & {
      type: "chat-broadcast";
      text: string;
    })
  | (MessageBase & {
      type: "seats-update";
      seats: {
        seatIndex: number;
        playerId: string | null;
        name?: string;
        chips?: number;
      }[];
    })
  | (MessageBase & {
      type: "table-state";
      handId: number;
      board: string[]; // ← relaxed from Card[]
      players: {
        seatIndex: number;
        playerId: string;
        holeCards: string[]; // ← relaxed from Card[]
      }[];
    })
  | (MessageBase & {
      type: "betting-state";
      handId: number;
      street: "preflop" | "flop" | "turn" | "river" | "done";
      pot: number;
      buttonSeatIndex: number;
      currentSeatIndex: number | null;
      bigBlind: number;
      smallBlind: number;
      maxCommitted: number;
      players: {
        seatIndex: number;
        playerId: string;
        stack: number;
        inHand: boolean;
        hasFolded: boolean;
        hasActed: boolean;
        committed: number;
      }[];
    })
  | (MessageBase & {
      type: "showdown";
      handId: number;
      board: string[]; // ← relaxed from Card[]
      players: {
        seatIndex: number;
        playerId: string;
        holeCards: string[]; // ← relaxed from Card[]
        bestHand: string[];  // ← relaxed from Card[]
        rankName: string;
        isWinner: boolean;
      }[];
    })
  | (MessageBase & {
      type: "error";
      message: string;
    });
