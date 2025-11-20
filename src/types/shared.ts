// src/types/shared.ts

// Base shape for all poker messages
export type MessageBase = {
  kind: "poker";
  roomId: string;
  playerId: string;
};
