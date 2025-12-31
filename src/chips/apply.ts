// src/chips/apply.ts
import { supabaseAdmin } from "./supabaseAdmin";
import { ensureChipBalanceRow } from "./balances";

export type ChipKind = "gld" | "pgld";

// match your enum (you called it public.chip_tx_type)
export type ChipTxType =
  | "DEPOSIT"
  | "WITHDRAW"
  | "BET"
  | "WIN"
  | "RAKE"
  | "JACKPOT"
  | "BONUS"
  | "ADJUST"
  | "TRANSFER"
  // you also used these in poker manager:
  | "poker_buyin"
  | "poker_refill"
  | "poker_cashout"
  | "demo_topup";

export type ApplyArgs = {
  playerId: string;
  kind: ChipKind;
  txType: ChipTxType;
  deltaBalance: number;   // +/- integer
  deltaReserved?: number; // +/- integer
  ref?: string | null;
  meta?: Record<string, any> | null;

  /**
   * Optional. If you later add a unique constraint in ledger for idempotency,
   * pass something stable like `${txType}:${ref}:${handId}:${playerId}`
   */
  idempotencyKey?: string | null;
};

function asInt(n: any) {
  const v = Math.trunc(Number(n ?? 0));
  if (!Number.isFinite(v)) return 0;
  return v;
}

/**
 * Preferred path: call your Supabase RPC(s).
 * Fallback: manual update + ledger insert (works while you’re fixing SQL).
 */
export async function applyChipDelta(args: ApplyArgs): Promise<{ ok: true }> {
  const playerId = args.playerId;
  const kind = args.kind;
  const txType = args.txType;
  const deltaBalance = asInt(args.deltaBalance);
  const deltaReserved = asInt(args.deltaReserved);
  const ref = args.ref ?? null;
  const meta = args.meta ?? null;

  if (!playerId || playerId.length < 3) throw new Error("Missing playerId");

  // ---------- RPC FIRST ----------
  // If your DB has these RPCs already, this is the cleanest:
  // - apply_chip_delta      (pgld)
  // - apply_chip_delta_gld  (gld)
  //
  // If you later unify to apply_chip_delta_any, update here.
  try {
    if (kind === "pgld") {
      const { error } = await supabaseAdmin.rpc("apply_chip_delta", {
        in_player_id: playerId,
        in_tx_type: txType,
        in_delta_balance_pgld: deltaBalance,
        in_delta_reserved_pgld: deltaReserved,
        in_ref: ref,
        in_meta: meta,
        // If your function supports it later:
        // in_idempotency_key: args.idempotencyKey ?? null,
      });
      if (!error) return { ok: true };
      // If function missing, fall through to fallback.
      if (!String(error.message || "").toLowerCase().includes("function")) {
        throw new Error(error.message);
      }
    } else {
      const { error } = await supabaseAdmin.rpc("apply_chip_delta_gld", {
        in_player_id: playerId,
        in_tx_type: txType,
        in_delta_balance_gld: deltaBalance,
        in_delta_reserved_gld: deltaReserved,
        in_ref: ref,
        in_meta: meta,
        // in_idempotency_key: args.idempotencyKey ?? null,
      });
      if (!error) return { ok: true };
      if (!String(error.message || "").toLowerCase().includes("function")) {
        throw new Error(error.message);
      }
    }
  } catch (e) {
    // fall back below if RPC not ready
    // but keep real errors (like insufficient) as errors
    const msg = (e as any)?.message ?? "";
    if (
      msg.includes("INSUFFICIENT") ||
      msg.toLowerCase().includes("insufficient")
    ) {
      throw e;
    }
  }

  // ---------- FALLBACK PATH ----------
  // This is safe enough for dev/testing and while you fix RPC/idempotency.
  // NOTE: For production with concurrency, use RPC only.
  const cur = await ensureChipBalanceRow(playerId);

  if (kind === "pgld") {
    const before = Math.floor(Number(cur.balance_pgld ?? 0));
    const beforeR = Math.floor(Number(cur.reserved_pgld ?? 0));
    const after = before + deltaBalance;
    const afterR = beforeR + deltaReserved;

    if (after < 0) throw new Error("INSUFFICIENT_PGLD");
    if (afterR < 0) throw new Error("NEGATIVE_RESERVED_PGLD");

    // update balances
    const { error: upErr } = await supabaseAdmin
      .from("chip_balances")
      .update({
        balance_pgld: after,
        reserved_pgld: afterR,
        updated_at: new Date().toISOString(),
      })
      .eq("player_id", playerId);

    if (upErr) throw new Error(upErr.message);

    // write ledger row
    const { error: ledErr } = await supabaseAdmin.from("chip_ledger").insert({
      player_id: playerId,
      tx_type: txType,
      delta_balance_pgld: deltaBalance,
      delta_reserved_pgld: deltaReserved,
      balance_before_pgld: before,
      balance_after_pgld: after,
      reserved_before_pgld: beforeR,
      reserved_after_pgld: afterR,

      // fill gld fields to satisfy NOT NULL defaults if needed
      delta_balance_gld: 0,
      delta_reserved_gld: 0,
      balance_before_gld: Math.floor(Number(cur.balance_gld ?? 0)),
      balance_after_gld: Math.floor(Number(cur.balance_gld ?? 0)),
      reserved_before_gld: Math.floor(Number(cur.reserved_gld ?? 0)),
      reserved_after_gld: Math.floor(Number(cur.reserved_gld ?? 0)),

      ref,
      meta: meta ? { ...meta, idempotencyKey: args.idempotencyKey ?? null } : { idempotencyKey: args.idempotencyKey ?? null },
    });

    if (ledErr) throw new Error(ledErr.message);

    return { ok: true };
  }

  // kind === "gld"
  const before = Math.floor(Number(cur.balance_gld ?? 0));
  const beforeR = Math.floor(Number(cur.reserved_gld ?? 0));
  const after = before + deltaBalance;
  const afterR = beforeR + deltaReserved;

  if (after < 0) throw new Error("INSUFFICIENT_GLD");
  if (afterR < 0) throw new Error("NEGATIVE_RESERVED_GLD");

  const { error: upErr } = await supabaseAdmin
    .from("chip_balances")
    .update({
      balance_gld: after,
      reserved_gld: afterR,
      updated_at: new Date().toISOString(),
    })
    .eq("player_id", playerId);

  if (upErr) throw new Error(upErr.message);

  const { error: ledErr } = await supabaseAdmin.from("chip_ledger").insert({
    player_id: playerId,
    tx_type: txType,
    delta_balance_gld: deltaBalance,
    delta_reserved_gld: deltaReserved,
    balance_before_gld: before,
    balance_after_gld: after,
    reserved_before_gld: beforeR,
    reserved_after_gld: afterR,

    // fill pgld fields
    delta_balance_pgld: 0,
    delta_reserved_pgld: 0,
    balance_before_pgld: Math.floor(Number(cur.balance_pgld ?? 0)),
    balance_after_pgld: Math.floor(Number(cur.balance_pgld ?? 0)),
    reserved_before_pgld: Math.floor(Number(cur.reserved_pgld ?? 0)),
    reserved_after_pgld: Math.floor(Number(cur.reserved_pgld ?? 0)),

    ref,
    meta: meta ? { ...meta, idempotencyKey: args.idempotencyKey ?? null } : { idempotencyKey: args.idempotencyKey ?? null },
  });

  if (ledErr) throw new Error(ledErr.message);

  return { ok: true };
}
