// src/types/ServerToClient.ts
import type { MessageBase } from "./shared";
import type { Card } from "../game/cards";

/**
 * Server → Client
 *
 * Generic envelope shared across games.
 */

export type ServerToClientType =
  // shared / generic
  | "pong"
  | "error"
  | "chat-broadcast"
  | "room-joined"
  | "room-left"

  // ✅ lobby
  | "rooms-list"

  // poker
  | "seats-update"
  | "table-state"
  | "betting-state"
  | "showdown"
  | "player-show-cards"
  | "game-status"

    // ✅ tournaments
  | "tournament-created"
  | "tournament-join-result"

  // blackjack (legacy labels allowed)
  | "blackjack-state"
  | "blackjack-seats"

  // ✅ blackjack lobby ops
  | "bj-room-created"
  | "bj-delete-room-result"

  | string;

/** Optional per-type payload typing (non-breaking). */
export type ServerToClientPayloadMap = {
  pong: { payload?: string };
  error: { message: string };
  "chat-broadcast": { text: string };

  // Lobby
  "rooms-list": {
    rooms: any[];
    game?: string;
    displayName?: string;
  };

  // Poker
  "seats-update": {
    seats: Array<{
      seatIndex: number;
      playerId: string | null;
      name?: string;
      chips?: number;
    }>;
    bankrolls?: Record<string, number>;
  };
   "game-status": { started: boolean; handInProgress: boolean };

    // ✅ tournaments
  "tournament-created": {
    ok: boolean;
    tournamentId?: string;
    tableRoomId?: string;
    error?: string;
  };

  "tournament-join-result": {
    ok: boolean;
    tournamentId: string;
    tableRoomId?: string;
    error?: string;
  };

  // Blackjack lobby create/delete helpers
  "bj-room-created": { roomId: string };
  "bj-delete-room-result": { ok: boolean; roomId: string; error?: string };
};

export type PokerPlayerShowCards = MessageBase & {
  kind: "poker";
  type: "player-show-cards";
  roomId: string;
  playerId: string;
  cards: string[];
  reason?: "all-in" | "voluntary";
};

export type ServerToClientMessage = MessageBase & {
  type: ServerToClientType;
  [key: string]: any;
};

/**
 * Blackjack view types
 */

export type BlackjackPhase =
  | "waiting-bets"
  | "dealing"
  | "player-action"
  | "dealer-turn"
  | "round-complete";

export type BlackjackCard = Card;

export type BlackjackHandResult =
  | "pending"
  | "win"
  | "lose"
  | "push"
  | "blackjack";

export type BlackjackHandState = {
  handIndex: number;
  cards: BlackjackCard[];
  bet: number;
  isBusted: boolean;
  isStanding: boolean;
  isBlackjack: boolean;
  result: BlackjackHandResult;
  payout: number;
};

export type BlackjackSeatState = {
  seatIndex: number;
  playerId: string | null;
  name?: string;
  bankroll: number;
  hands: BlackjackHandState[];
};

export type BlackjackDealerState = {
  cards: string[];
  hideHoleCard: boolean;
};

export type BlackjackTableState = {
  roundId: number;
  phase: BlackjackPhase;
  minBet: number;
  maxBet: number;
  activeSeatIndex: number | null;
  activeHandIndex: number | null;
  dealer: BlackjackDealerState;
  seats: BlackjackSeatState[];
  betDeadlineMs?: number | null;
};
