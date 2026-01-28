// src/chips/apply.ts
import { supabaseAdmin } from "./supabaseAdmin";
import { ensureChipBalanceRow } from "./balances";

export type ChipKind = "gld" | "pgld";

// match your enum (public.chip_tx_type)
export type ChipTxType =
  | "DEPOSIT"
  | "WITHDRAW"
  | "BET"
  | "WIN"
  | "RAKE"
  | "JACKPOT"
  | "BONUS"
  | "ADJUST"
  | "TRANSFER";

export type ApplyArgs = {
  playerId: string;
  kind: ChipKind;

  // allow callers to pass either enum values or legacy strings
  txType: string;

  deltaBalance: number; // +/- integer
  deltaReserved?: number; // +/- integer
  ref?: string | null;
  meta?: Record<string, any> | null;
  idempotencyKey?: string | null;
};

function asInt(n: any) {
  const v = Math.trunc(Number(n ?? 0));
  if (!Number.isFinite(v)) return 0;
  return v;
}

function normalizeTxType(txType: string): ChipTxType {
  const t = String(txType || "").trim();

  // If already an allowed enum, keep it
  const allowed: ChipTxType[] = [
    "DEPOSIT",
    "WITHDRAW",
    "BET",
    "WIN",
    "RAKE",
    "JACKPOT",
    "BONUS",
    "ADJUST",
    "TRANSFER",
  ];
  if ((allowed as string[]).includes(t)) return t as ChipTxType;

  // Map poker / app-specific values → enum
  const low = t.toLowerCase();

  if (low.includes("buyin")) return "WITHDRAW";
  if (low.includes("refill")) return "WITHDRAW";
  if (low.includes("cashout")) return "DEPOSIT";
  if (low.includes("demo")) return "BONUS";

  // safe default
  return "ADJUST";
}

/**
 * Preferred path: call your Supabase RPC(s).
 * Fallback: manual update + ledger insert.
 */
export async function applyChipDelta(args: ApplyArgs): Promise<{ ok: true }> {
  const playerId = args.playerId;
  const kind = args.kind;

  // ✅ normalize here (single source of truth)
  const txType = normalizeTxType(args.txType);

  const deltaBalance = asInt(args.deltaBalance);
  const deltaReserved = asInt(args.deltaReserved);
  const ref = args.ref ?? null;
  const meta = args.meta ?? null;

  if (!playerId || playerId.length < 3) throw new Error("Missing playerId");

  // ---------- RPC FIRST ----------
  try {
    if (kind === "pgld") {
      const { error } = await supabaseAdmin.rpc("apply_chip_delta", {
        in_player_id: playerId,
        in_tx_type: txType, // ✅ enum-safe
        in_delta_balance_pgld: deltaBalance,
        in_delta_reserved_pgld: deltaReserved,
        in_ref: ref,
        in_meta: meta,
      });
      if (!error) return { ok: true };
      if (!String(error.message || "").toLowerCase().includes("function")) {
        throw new Error(error.message);
      }
    } else {
      const { error } = await supabaseAdmin.rpc("apply_chip_delta_gld", {
        in_player_id: playerId,
        in_tx_type: txType, // ✅ enum-safe
        in_delta_balance_gld: deltaBalance,
        in_delta_reserved_gld: deltaReserved,
        in_ref: ref,
        in_meta: meta,
      });
      if (!error) return { ok: true };
      if (!String(error.message || "").toLowerCase().includes("function")) {
        throw new Error(error.message);
      }
    }
  } catch (e) {
    // keep real "insufficient" errors as errors
    const msg = (e as any)?.message ?? "";
    if (msg.includes("INSUFFICIENT") || msg.toLowerCase().includes("insufficient")) {
      throw e;
    }
    // otherwise fall through to fallback path
  }

  // ---------- FALLBACK PATH ----------
  const cur = await ensureChipBalanceRow(playerId);

  if (kind === "pgld") {
    const before = Math.floor(Number(cur.balance_pgld ?? 0));
    const beforeR = Math.floor(Number(cur.reserved_pgld ?? 0));
    const after = before + deltaBalance;
    const afterR = beforeR + deltaReserved;

    if (after < 0) throw new Error("INSUFFICIENT_PGLD");
    if (afterR < 0) throw new Error("NEGATIVE_RESERVED_PGLD");

    const { error: upErr } = await supabaseAdmin
      .from("chip_balances")
      .update({
        balance_pgld: after,
        reserved_pgld: afterR,
        updated_at: new Date().toISOString(),
      })
      .eq("player_id", playerId);

    if (upErr) throw new Error(upErr.message);

    const { error: ledErr } = await supabaseAdmin.from("chip_ledger").insert({
      player_id: playerId,
      tx_type: txType, // ✅ enum-safe
      delta_balance_pgld: deltaBalance,
      delta_reserved_pgld: deltaReserved,
      balance_before_pgld: before,
      balance_after_pgld: after,
      reserved_before_pgld: beforeR,
      reserved_after_pgld: afterR,

      // fill gld fields
      delta_balance_gld: 0,
      delta_reserved_gld: 0,
      balance_before_gld: Math.floor(Number(cur.balance_gld ?? 0)),
      balance_after_gld: Math.floor(Number(cur.balance_gld ?? 0)),
      reserved_before_gld: Math.floor(Number(cur.reserved_gld ?? 0)),
      reserved_after_gld: Math.floor(Number(cur.reserved_gld ?? 0)),

      ref,
      meta: meta
        ? { ...meta, idempotencyKey: args.idempotencyKey ?? null }
        : { idempotencyKey: args.idempotencyKey ?? null },
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
    tx_type: txType, // ✅ enum-safe
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
    meta: meta
      ? { ...meta, idempotencyKey: args.idempotencyKey ?? null }
      : { idempotencyKey: args.idempotencyKey ?? null },
  });

  if (ledErr) throw new Error(ledErr.message);
  return { ok: true };
}
