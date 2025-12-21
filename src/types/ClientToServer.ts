// src/types/ClientToServer.ts
import type { MessageBase } from "./shared";

/**
 * Client → Server
 *
 * This repo intentionally uses a generic envelope shared across games (poker + blackjack).
 * We keep `type: string` + `[key: string]: any` to avoid breaking other games,
 * BUT we also provide optional typed maps for better DX in each game.
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
  // blackjack examples (keep flexible; not exhaustive)
  | "bj-place-bet"
  | "bj-action"
  | "bj-sit"
  | "bj-stand"
  | string;

/** Optional per-type payload typing (non-breaking). */
export type ClientToServerPayloadMap = {
  ping: { payload?: string };
  chat: { text: string };

  // ── Poker
  sit: { buyIn?: number; seatIndex?: number; name?: string };
  stand: Record<string, never>;
  action: { action: "fold" | "check" | "call" | "bet"; amount?: number };
  "show-cards": Record<string, never>;

  // New lifecycle
  "start-game": Record<string, never>;
  "start-hand": Record<string, never>; // legacy alias
  "refill-stack": { amount: number };
    
  "demo-topup": { target?: number };


  // ── Blackjack (examples; your bj system can keep using any fields it needs)
  "bj-place-bet": { seatIndex?: number; amount: number };
  "bj-action": { seatIndex?: number; action: string; amount?: number };
};

/**
 * The actual message type used everywhere.
 * Stays generic for maximum compatibility across games.
 */
export type ClientToServerMessage = MessageBase & {
  type: ClientToServerType;
  [key: string]: any;
};
