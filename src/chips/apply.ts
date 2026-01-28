// src/chips/apply.ts
import { supabaseAdmin } from "./supabaseAdmin";
import { ensureChipBalanceRow } from "./balances";

export type ChipKind = "gld" | "pgld";

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
  // local app types (we'll map these below)
  | "poker_buyin"
  | "poker_refill"
  | "poker_cashout"
  | "demo_topup";

export type ApplyArgs = {
  playerId: string;
  kind: ChipKind;
  txType: ChipTxType;
  deltaBalance: number;
  deltaReserved?: number;
  ref?: string | null;
  meta?: Record<string, any> | null;
  idempotencyKey?: string | null;
};

function asInt(n: any) {
  const v = Math.trunc(Number(n ?? 0));
  if (!Number.isFinite(v)) return 0;
  return v;
}



/**
 * IMPORTANT:
 * Your DB enum chip_tx_type likely does NOT include poker_buyin/refill/etc.
 * So we map app tx types -> enum tx types here.
 */
function mapTxTypeToEnum(txType: ChipTxType): Exclude<
  ChipTxType,
  "poker_buyin" | "poker_refill" | "poker_cashout" | "demo_topup"
> {
  switch (txType) {
    case "poker_buyin":
    case "poker_refill":
      return "BET";
    case "poker_cashout":
      return "WITHDRAW";
    case "demo_topup":
      return "BONUS";
    default:
      return txType;
  }
}

export async function applyChipDelta(args: ApplyArgs): Promise<{ ok: true }> {
  const playerId = args.playerId;
  const kind = args.kind;

  const deltaBalance = asInt(args.deltaBalance);
  const deltaReserved = asInt(args.deltaReserved);

  const ref = args.ref ?? null;
  const meta = args.meta ?? null;

  if (!playerId || playerId.length < 3) throw new Error("Missing playerId");

  // Ensure balance row exists (helps RPCs that assume it)
  await ensureChipBalanceRow(playerId);

  // Map local tx types to DB enum
  const txTypeEnum = mapTxTypeToEnum(args.txType);

  // Use the unified RPC you already have
  const in_delta_balance_gld = kind === "gld" ? deltaBalance : 0;
  const in_delta_reserved_gld = kind === "gld" ? deltaReserved : 0;
  const in_delta_balance_pgld = kind === "pgld" ? deltaBalance : 0;
  const in_delta_reserved_pgld = kind === "pgld" ? deltaReserved : 0;

  const { error } = await supabaseAdmin.rpc("apply_chip_delta_any", {
    in_player_id: playerId,
    in_tx_type: txTypeEnum,
    in_delta_balance_gld,
    in_delta_reserved_gld,
    in_delta_balance_pgld,
    in_delta_reserved_pgld,
    in_ref: ref,
    in_meta: meta,
    in_idempotency_key: args.idempotencyKey ?? null,
  });

  if (error) {
    const msg = String(error.message ?? "");
    if (msg.toLowerCase().includes("insufficient")) {
      // normalize to what your PokerRoomManager expects
      if (kind === "pgld") throw new Error("INSUFFICIENT_PGLD");
      throw new Error("INSUFFICIENT_GLD");
    }
    throw new Error(msg || "apply_chip_delta_any failed");
  }

  return { ok: true };
}
