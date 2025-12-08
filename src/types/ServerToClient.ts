// src/types/ServerToClient.ts
import type { MessageBase } from "./shared";
import type { Card } from "../game/cards";


export type ServerToClientMessage = MessageBase & {
  // e.g. "table-state", "chat", "blackjack-state"…
  type: string;
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

  // 👇 NEW: optional betting deadline for countdown UI
  betDeadlineMs?: number | null;
};

