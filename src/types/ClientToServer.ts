// src/types/ClientToServer.ts
import type { MessageBase } from "./shared";

export type ClientToServerMessage = MessageBase & {
  // e.g. "join-room", "seat-change", "bj-place-bet", "bj-action"…
  type: string;
  // extra payload fields
  [key: string]: any;
  
};
