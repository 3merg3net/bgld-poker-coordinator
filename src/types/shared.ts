// src/types/shared.ts

// Base shape for all messages
export type MessageBase = {
  kind: "poker" | "blackjack";  // ⬅️ add "blackjack" here
  roomId: string;
  playerId: string;
};
