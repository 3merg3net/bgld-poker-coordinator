// src/types/ServerToClient.ts
import type { MessageBase } from "./shared";

export type ServerToClientMessage =
  // server confirms room join + online count
  | (MessageBase & {
      type: "room-joined";
      onlineCount: number;
    })
  // someone left the room
  | (MessageBase & {
      type: "room-left";
    })
  // reply to ping
  | (MessageBase & {
      type: "pong";
      payload?: string;
    })
  // chat broadcast to everyone in room
  | (MessageBase & {
      type: "chat-broadcast";
      text: string;
    })
  // generic error
  | (MessageBase & {
      type: "error";
      message: string;
    });
