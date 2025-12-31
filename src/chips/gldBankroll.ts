// src/chips/gldBankroll.ts
import { applyChipDelta } from "./apply";
import { getGldBalance } from "./balances";

export async function getGld(playerId: string): Promise<number> {
  return getGldBalance(playerId);
}

export async function debitGld(args: {
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
    kind: "gld",
    txType: args.txType as any,
    deltaBalance: -amt,
    deltaReserved: 0,
    ref: args.ref ?? null,
    meta: args.meta ?? null,
  });
}

export async function creditGld(args: {
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
    kind: "gld",
    txType: args.txType as any,
    deltaBalance: amt,
    deltaReserved: 0,
    ref: args.ref ?? null,
    meta: args.meta ?? null,
  });
}
