// src/chips/pgldBankroll.ts
import { applyChipDelta } from "./apply";
import { getPgldBalance } from "./balances";

// Your poker code uses tx types like "poker_buyin".
// The API/RPC only accepts these:
type ChipTxType =
  | "DEPOSIT"
  | "WITHDRAW"
  | "BET"
  | "WIN"
  | "RAKE"
  | "JACKPOT"
  | "BONUS"
  | "ADJUST"
  | "TRANSFER";

function mapTxType(txType: string): ChipTxType {
  const t = String(txType || "").toLowerCase();

  // poker → chip ledger mapping
  if (t.includes("buyin")) return "WITHDRAW";
  if (t.includes("refill")) return "WITHDRAW";
  if (t.includes("cashout")) return "DEPOSIT";
  if (t.includes("demo")) return "BONUS";

  // safe default (keeps system working, easy to filter later)
  return "ADJUST";
}

export async function getPgld(playerId: string): Promise<number> {
  return getPgldBalance(playerId);
}

export async function debitPgld(args: {
  playerId: string;
  amount: number;
  txType: string;
  ref?: string | null;
  meta?: Record<string, any> | null;
}) {
  const amt = Math.max(0, Math.trunc(Number(args.amount ?? 0)));
  if (!amt) return;

  await applyChipDelta({
    playerId: args.playerId,
    kind: "pgld",
    txType: mapTxType(args.txType),
    deltaBalance: -amt,
    deltaReserved: 0,
    ref: args.ref ?? null,
    meta: args.meta ?? null,
  });
}

export async function creditPgld(args: {
  playerId: string;
  amount: number;
  txType: string;
  ref?: string | null;
  meta?: Record<string, any> | null;
}) {
  const amt = Math.max(0, Math.trunc(Number(args.amount ?? 0)));
  if (!amt) return;

  await applyChipDelta({
    playerId: args.playerId,
    kind: "pgld",
    txType: mapTxType(args.txType),
    deltaBalance: amt,
    deltaReserved: 0,
    ref: args.ref ?? null,
    meta: args.meta ?? null,
  });
}
