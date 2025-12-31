// src/chips/balances.ts
import { supabaseAdmin } from "./supabaseAdmin";

export type ChipBalances = {
  player_id: string;
  balance_gld: number;
  reserved_gld: number;
  balance_pgld: number;
  reserved_pgld: number;
};

/**
 * IMPORTANT:
 * Your error "duplicate key value violates unique constraint chip_balances_pkey"
 * comes from doing a plain INSERT when the row already exists.
 *
 * Fix: UPSERT on player_id (or whatever your PK is).
 */
export async function ensureChipBalanceRow(playerId: string): Promise<ChipBalances> {
  if (!playerId || playerId.length < 3) throw new Error("Missing playerId");

  // 1) Try read
  const { data, error } = await supabaseAdmin
    .from("chip_balances")
    .select("player_id, balance_gld, reserved_gld, balance_pgld, reserved_pgld")
    .eq("player_id", playerId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (data) {
    return {
      player_id: data.player_id,
      balance_gld: Number(data.balance_gld ?? 0),
      reserved_gld: Number(data.reserved_gld ?? 0),
      balance_pgld: Number(data.balance_pgld ?? 0),
      reserved_pgld: Number(data.reserved_pgld ?? 0),
    };
  }

  // 2) Create row safely (UPSERT instead of INSERT)
  const row = {
    player_id: playerId,
    balance_gld: 0,
    reserved_gld: 0,
    balance_pgld: 0,
    reserved_pgld: 0,
  };

  // If your PK is player_id, this works as-is.
  // If you have a composite key, adjust onConflict accordingly.
  const { error: upErr } = await supabaseAdmin
    .from("chip_balances")
    .upsert(row, { onConflict: "player_id" });

  if (upErr) throw new Error(upErr.message);

  // 3) Re-read (ensures we return the canonical row)
  const { data: data2, error: err2 } = await supabaseAdmin
    .from("chip_balances")
    .select("player_id, balance_gld, reserved_gld, balance_pgld, reserved_pgld")
    .eq("player_id", playerId)
    .maybeSingle();

  if (err2) throw new Error(err2.message);

  return {
    player_id: data2?.player_id ?? playerId,
    balance_gld: Number(data2?.balance_gld ?? 0),
    reserved_gld: Number(data2?.reserved_gld ?? 0),
    balance_pgld: Number(data2?.balance_pgld ?? 0),
    reserved_pgld: Number(data2?.reserved_pgld ?? 0),
  };
}

export async function getChipBalances(playerId: string): Promise<ChipBalances> {
  return ensureChipBalanceRow(playerId);
}

export async function getPgldBalance(playerId: string): Promise<number> {
  const b = await ensureChipBalanceRow(playerId);
  return Math.max(0, Math.floor(b.balance_pgld ?? 0));
}

export async function getGldBalance(playerId: string): Promise<number> {
  const b = await ensureChipBalanceRow(playerId);
  return Math.max(0, Math.floor(b.balance_gld ?? 0));
}
