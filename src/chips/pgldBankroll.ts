// src/chips/pgldBankroll.ts
import { applyChipDelta } from "./apply";
import { getPgldBalance } from "./balances";

export async function getPgld(playerId: string): Promise<number> {
  return getPgldBalance(playerId);
}

export async function debitPgld(args: {
  playerId: string;
  amount: number;
  txType: string; // keep loose to match your poker tx types
  ref?: string | null;
  meta?: Record<string, any> | null;
}) {
  const amt = Math.max(0, Math.trunc(Number(args.amount ?? 0)));
  if (!amt) return;

  // debit = negative delta
  await applyChipDelta({
    playerId: args.playerId,
    kind: "pgld",
    txType: args.txType as any,
    deltaBalance: -amt,
    deltaReserved: 0,
    ref: args.ref ?? null,
    meta: args.meta ?? null,
    // idempotencyKey: `${args.txType}:${args.ref}:${args.playerId}:${amt}`, // optional later
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
    txType: args.txType as any,
    deltaBalance: amt,
    deltaReserved: 0,
    ref: args.ref ?? null,
    meta: args.meta ?? null,
  });
}
