// src/types/ClientToServer.ts
import type { MessageBase } from "./shared";

/**
 * Client → Server
 *
 * Generic envelope shared across games (poker + blackjack).
 * Keep `type: string` + `[key: string]: any` for compatibility,
 * but provide optional payload maps for DX.
 */

export type ClientToServerType =
  // shared / generic
  | "ping"
  | "chat"
  | "join-room"
  | "leave-room"

  // poker
  | "sit"
  | "stand"
  | "action"
  | "show-cards"
  | "start-hand" // legacy alias for "start-game"
  | "start-game"
  | "refill-stack"
  | "demo-topup"
  | "close-room"
  

    // ✅ tournaments (coordinator-level)
  | "tournament-create"
  | "tournament-join"
  | "tournament-start"
  | "tournament-list"


  // blackjack
  | "bj-seat"
  | "bj-place-bet"
  | "bj-action"

  // ✅ blackjack lobby lifecycle
  | "bj-create-room"
  | "bj-delete-room"

  // allow extensions
  | string;

export type BlackjackAction =
  | "hit"
  | "stand"
  | "double"
  | "split"
  | "next-round"
  | "reload-demo";

/** Optional per-type payload typing (non-breaking). */
export type ClientToServerPayloadMap = {
  ping: { payload?: string };
  chat: { text: string };

  // ── Poker
  sit: { buyIn?: number; seatIndex?: number; name?: string; handle?: string };
  stand: Record<string, never>;
  action: { action: "fold" | "check" | "call" | "bet"; amount?: number };
  "show-cards": Record<string, never>;
  "start-game": Record<string, never>;
  "start-hand": Record<string, never>;
  "refill-stack": { amount: number };
  "demo-topup": { target?: number };

  // ✅ poker host close (used inside room)
  "close-room": { roomId: string; playerId: string };

   // ✅ Tournaments
  "tournament-create": {
    playerId: string;
    tournamentName?: string;
    buyIn: number;          // chips buy-in (e.g. 10_000)
    startingStack: number;  // stack each entrant gets at table
    seatsPerTable?: number; // default 9
    isPrivate?: boolean;
  };

  "tournament-join": {
    playerId: string;
    tournamentId: string;
    name?: string;          // display name
  };

    "tournament-start": {
    playerId: string;
    tournamentId: string;
  };

  "tournament-list": {
    // optional filters later (private/public, etc.)
  };


  // ── Blackjack
  "bj-seat": { action: "sit" | "leave"; seatIndex: number; name?: string };
  "bj-place-bet": { seatIndex?: number; amount: number };
  "bj-action": { seatIndex?: number; action: BlackjackAction; amount?: number };
  

  // ✅ Blackjack lobby create/delete (server-managed roomId + host)
  "bj-create-room": {
    playerId: string;
    tableName: string;
    minBet: number;
    maxBet: number;
    seats?: number; // optional, default 7
    isPrivate?: boolean;
  };

  "bj-delete-room": {
    playerId: string;
    roomId: string;
    // optional: allow adminKey override from lobby
    adminKey?: string;
  };
};

/**
 * The actual message type used everywhere.
 */
export type ClientToServerMessage = MessageBase & {
  type: ClientToServerType;
  [key: string]: any;
};
