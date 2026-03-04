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
 * Ensures:
 * 1) players row exists (required by FK chip_balances_player_id_fkey)
 * 2) chip_balances row exists (UPSERT-safe)
 */
export async function ensureChipBalanceRow(playerId: string): Promise<ChipBalances> {
  if (!playerId || playerId.length < 3) throw new Error("Missing playerId");

  // 0) ✅ Ensure the player exists (FK requirement)
  // Only upsert the PK to avoid clobbering any real profile fields.
  const { error: playerUpErr } = await supabaseAdmin
    .from("players")
    .upsert({ id: playerId }, { onConflict: "id" });

  if (playerUpErr) throw new Error(playerUpErr.message);

  // 1) Try read balances
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

  // 2) Create balance row safely (UPSERT)
  const row = {
    player_id: playerId,
    balance_gld: 0,
    reserved_gld: 0,
    balance_pgld: 0,
    reserved_pgld: 0,
  };

  const { error: upErr } = await supabaseAdmin
    .from("chip_balances")
    .upsert(row, { onConflict: "player_id" });

  if (upErr) throw new Error(upErr.message);

  // 3) Re-read (return canonical row)
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