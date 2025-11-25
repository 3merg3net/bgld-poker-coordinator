// src/types/ClientToServer.ts
import type { MessageBase } from "./shared";

export type ClientToServerMessage =
  // Join a room
  | (MessageBase & {
      type: "join-room";
      name?: string;
    })
  // Leave a room
  | (MessageBase & {
      type: "leave-room";
    })
  // Ping test
  | (MessageBase & {
      type: "ping";
      payload?: string;
    })
  // Simple chat message
  | (MessageBase & {
      type: "chat";
      text: string;
    })
  // Request to sit at the table (seatIndex optional = auto)
  | (MessageBase & {
      type: "sit";
      seatIndex?: number;
      name?: string;
      buyIn?: number; // ← added here
    })
  // Stand up from table
  | (MessageBase & {
      type: "stand";
    })
  // Start a new hand
  | (MessageBase & {
      type: "start-hand";
    })
  // Player betting action
  | (MessageBase & {
      type: "action";
      action: "fold" | "check" | "call" | "bet";
      amount?: number;
    });
