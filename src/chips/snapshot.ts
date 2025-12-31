// src/chips/snapshot.ts
import { getChipBalances } from "./balances";

export async function getPlayerChipSnapshot(playerId: string) {
  const b = await getChipBalances(playerId);
  return {
    gld: Math.floor(b.balance_gld ?? 0),
    pgld: Math.floor(b.balance_pgld ?? 0),
    reserved_gld: Math.floor(b.reserved_gld ?? 0),
    reserved_pgld: Math.floor(b.reserved_pgld ?? 0),
  };
}
