// src/types/ClientToServer.ts
import type { MessageBase } from "./shared";

export type ClientToServerMessage =
  // Join a room
  | (MessageBase & {
      type: "join-room";
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
    });
