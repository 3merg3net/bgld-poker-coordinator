// src/types/ServerToClient.ts
import type { MessageBase } from "./shared";
import type { Card } from "../game/cards";

/**
 * Server → Client
 *
 * Like ClientToServer, this stays as a generic envelope shared across games.
 * We add optional type maps for better DX without breaking anything.
 */

export type ServerToClientType =
  // shared / generic
  | "pong"
  | "error"
  | "chat-broadcast"
  | "room-joined"
  | "room-left"
  // poker
  | "seats-update"
  | "table-state"
  | "betting-state"
  | "showdown"
  | "player-show-cards"
  | "game-status"
  // blackjack examples (not exhaustive)
  | "blackjack-state"
  | "blackjack-seats"
  | string;

/** Optional per-type payload typing (non-breaking). */
export type ServerToClientPayloadMap = {
  pong: { payload?: string };
  error: { message: string };
  "chat-broadcast": { text: string };

  // Poker (high-level; game files can define richer types if needed)
  "game-status": { started: boolean; handInProgress: boolean };
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
 * (only used for typing / FE — coordinator just sends plain objects)
 */

export type BlackjackPhase =
  | "waiting-bets"
  | "dealing"
  | "player-action"
  | "dealer-turn"
  | "round-complete";

export type BlackjackCard = Card;
// same "As", "Td" style as cards.ts

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
  // net change to bankroll after settlement (can be negative)
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
  // we allow a face-down marker like "XX" so keep this as string[]
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

  // optional betting deadline for countdown UI
  betDeadlineMs?: number | null;
};
