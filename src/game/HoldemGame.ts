// src/game/HoldemGame.ts

// Basic seat shape that the room + frontend use
export type SeatView = {
  seatIndex: number;
  playerId: string | null;
  name?: string;
  chips: number;
};

// Table state broadcast
export type TablePlayerState = {
  seatIndex: number;
  playerId: string;
  holeCards: string[];
};

export type TableState = {
  handId: number;
  board: string[];
  players: TablePlayerState[];
};

// Betting state broadcast
export type BettingStreet = "preflop" | "flop" | "turn" | "river" | "done";

export type BettingPlayerState = {
  seatIndex: number;
  playerId: string;
  stack: number;        // current in-hand stack
  inHand: boolean;
  hasFolded: boolean;
  hasActed: boolean;
  committed: number;    // amount committed this street
};

export type BettingState = {
  handId: number;
  street: BettingStreet;
  pot: number;
  buttonSeatIndex: number;
  currentSeatIndex: number | null;
  bigBlind: number;
  smallBlind: number;
  maxCommitted: number;
  players: BettingPlayerState[];
};

// Showdown state broadcast
export type ShowdownPlayerState = {
  seatIndex: number;
  playerId: string;
  holeCards: string[];
  bestHand: string[];
  rankName: string;
  isWinner: boolean;
};

export type ShowdownState = {
  handId: number;
  board: string[];
  players: ShowdownPlayerState[];
};

// -------------------
// Helper: Deck + cards
// -------------------

const RANKS = [
  "2","3","4","5","6","7","8","9","T","J","Q","K","A"
] as const;
const SUITS = ["s","h","d","c"] as const;

type Card = string; // e.g. "As", "Td"

function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      deck.push(`${r}${s}`);
    }
  }
  return deck;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rankValue(rank: string): number {
  const idx = RANKS.indexOf(rank as any);
  return idx >= 0 ? idx + 2 : 0; // 2..14
}

// -------------------
// HoldemGame Engine
// -------------------

export class HoldemGame {
  private handCounter = 1;

  private lastTable: TableState | null = null;
  private betting: BettingState | null = null;
  private showdown: ShowdownState | null = null;

  private deck: Card[] = [];
  private seatsSnapshot: SeatView[] = [];
  private buttonSeatIndex: number | null = null;

  // PUBLIC API used by PokerRoomManager
  // -----------------------------------

  getLastState(): TableState | null {
    return this.lastTable;
  }

  getBettingState(): BettingState | null {
    return this.betting;
  }

  /**
   * Used by the room manager to sync seat.chips with the
   * in-hand stacks the game engine is tracking.
   */
  getSeatStacksForCurrentHand(): { seatIndex: number; stack: number }[] {
    if (!this.betting) return [];
    return this.betting.players.map((p) => ({
      seatIndex: p.seatIndex,
      stack: p.stack,
    }));
  }

  // Called by server when a new hand should start
  startHand(seats: SeatView[]): TableState | null {
    // Eligible = any seat with a playerId
    const activeSeats = seats.filter((s) => !!s.playerId);

    if (activeSeats.length < 1) {
      return null;
    }

    // Snapshot seats for this hand
    this.seatsSnapshot = seats.map((s) => ({ ...s }));

    // Set / rotate button seat
    if (this.buttonSeatIndex == null) {
      // First hand: choose lowest seat index with player
      this.buttonSeatIndex = activeSeats
        .map((s) => s.seatIndex)
        .sort((a, b) => a - b)[0];
    } else {
      // Move button to next occupied seat
      const occupied = activeSeats
        .map((s) => s.seatIndex)
        .sort((a, b) => a - b);
      const currentIdx = occupied.indexOf(this.buttonSeatIndex);
      const nextIdx =
        currentIdx === -1 ? 0 : (currentIdx + 1) % occupied.length;
      this.buttonSeatIndex = occupied[nextIdx];
    }

    // Build and shuffle deck
    this.deck = shuffle(buildDeck());

    const handId = this.handCounter++;
    const board: Card[] = [];

    // Deal 2 hole cards per active player (simple order)
    const tablePlayers: TablePlayerState[] = [];
    for (const seat of activeSeats) {
      const hole: Card[] = [this.drawCard(), this.drawCard()];
      tablePlayers.push({
        seatIndex: seat.seatIndex,
        playerId: seat.playerId as string,
        holeCards: hole,
      });
    }

    this.lastTable = {
      handId,
      board,
      players: tablePlayers,
    };

    // Initialize betting state
    const bigBlind = 50;
    const smallBlind = 25;

    // Build betting players from seats snapshot
    const bettingPlayers: BettingPlayerState[] = tablePlayers.map((tp) => {
      const seatSnap = this.seatsSnapshot.find(
        (s) => s.seatIndex === tp.seatIndex
      );
      return {
        seatIndex: tp.seatIndex,
        playerId: tp.playerId,
        stack: seatSnap ? seatSnap.chips : 1000,
        inHand: true,
        hasFolded: false,
        hasActed: false,
        committed: 0,
      };
    });

    // Post blinds (simple: find order by seat index around button)
    const order = bettingPlayers
      .slice()
      .sort((a, b) => a.seatIndex - b.seatIndex);

    const positions = this.getActingOrder(order.map((p) => p.seatIndex));

    // small blind = first after button, big blind = second after button
    let smallBlindSeat: number | null = null;
    let bigBlindSeat: number | null = null;

    if (positions.length === 2) {
      // Heads-up: button = small blind; other = big blind
      smallBlindSeat = this.buttonSeatIndex;
      bigBlindSeat =
        positions.find((s) => s !== this.buttonSeatIndex) ?? null;
    } else {
      // 3+ players
      const idxBtn = positions.indexOf(this.buttonSeatIndex!);
      if (idxBtn !== -1) {
        smallBlindSeat = positions[(idxBtn + 1) % positions.length];
        bigBlindSeat = positions[(idxBtn + 2) % positions.length];
      }
    }

    let pot = 0;
    let maxCommitted = 0;

    // Apply blinds
    function applyBlind(
      players: BettingPlayerState[],
      seatIndex: number | null,
      amount: number
    ): { potDelta: number; committed: number } {
      if (seatIndex == null) return { potDelta: 0, committed: 0 };
      const p = players.find((x) => x.seatIndex === seatIndex);
      if (!p) return { potDelta: 0, committed: 0 };
      const blind = Math.min(amount, p.stack);
      p.stack -= blind;
      p.committed += blind;
      p.hasActed = false; // blinds can still act on preflop
      return { potDelta: blind, committed: p.committed };
    }

    if (smallBlindSeat != null) {
      const res = applyBlind(bettingPlayers, smallBlindSeat, smallBlind);
      pot += res.potDelta;
      maxCommitted = Math.max(maxCommitted, res.committed ?? 0);
    }
    if (bigBlindSeat != null) {
      const res = applyBlind(bettingPlayers, bigBlindSeat, bigBlind);
      pot += res.potDelta;
      maxCommitted = Math.max(maxCommitted, res.committed ?? 0);
    }

    // First to act preflop = first seat after big blind
    let currentSeatIndex: number | null = null;
    if (bigBlindSeat != null) {
      currentSeatIndex = this.findNextSeatToAct(
        bettingPlayers,
        bigBlindSeat,
        true
      );
    }

    this.betting = {
      handId,
      street: "preflop",
      pot,
      buttonSeatIndex: this.buttonSeatIndex!,
      currentSeatIndex,
      bigBlind,
      smallBlind,
      maxCommitted,
      players: bettingPlayers,
    };

    this.showdown = null;

    return this.lastTable;
  }

  // Called for each player action
  applyAction(
    playerId: string,
    action: "fold" | "check" | "call" | "bet",
    amount?: number
  ): BettingState | null {
    const b = this.betting;
    if (!b || b.street === "done") return this.betting;

    const pIdx = b.players.findIndex((p) => p.playerId === playerId);
    if (pIdx === -1) return b;

    const p = b.players[pIdx];
    if (!p.inHand || p.hasFolded) return b;

    const callNeeded = Math.max(0, b.maxCommitted - p.committed);

    if (action === "fold") {
      p.hasFolded = true;
      p.inHand = false;
      p.hasActed = true;
    } else if (action === "check") {
      // If there is money to call, treat as call instead
      if (callNeeded > 0 && p.stack > 0) {
        const callAmt = Math.min(callNeeded, p.stack);
        p.stack -= callAmt;
        p.committed += callAmt;
        b.pot += callAmt;
        b.maxCommitted = Math.max(b.maxCommitted, p.committed);
      }
      p.hasActed = true;
    } else if (action === "call") {
      const callAmt = Math.min(callNeeded, p.stack);
      p.stack -= callAmt;
      p.committed += callAmt;
      b.pot += callAmt;
      b.maxCommitted = Math.max(b.maxCommitted, p.committed);
      p.hasActed = true;
    } else if (action === "bet") {
      const betAmt =
        typeof amount === "number" && amount > 0
          ? Math.floor(amount)
          : b.bigBlind * 2;

      const spend = Math.min(p.stack, betAmt + callNeeded);
      if (spend > 0) {
        p.stack -= spend;
        p.committed += spend;
        b.pot += spend;
        b.maxCommitted = Math.max(b.maxCommitted, p.committed);
      }
      p.hasActed = true;

      // Any new bet/raise means others need to act again
      for (let i = 0; i < b.players.length; i++) {
        if (i === pIdx) continue;
        const other = b.players[i];
        if (other.inHand && !other.hasFolded) {
          other.hasActed = false;
        }
      }
    }

    // After applying the action, advance to next player / street / showdown
    this.advanceBetting();

    return this.betting;
  }

  // Called by server when street is done and we need final result
  computeShowdown(): ShowdownState | null {
    const b = this.betting;
    const t = this.lastTable;
    if (!b || !t || b.street !== "done") return null;

    if (this.showdown) return this.showdown;

    const board = t.board;
    const active = b.players.filter((p) => p.inHand && !p.hasFolded);

    if (active.length === 0) {
      // Edge case: everyone folded, should have been handled earlier
      return null;
    }

    type EvalResult = {
      score: number;
      rankName: string;
      best5: Card[];
    };

    const evals: { bp: BettingPlayerState; eval: EvalResult }[] = [];

    for (const bp of active) {
      const tp = t.players.find(
        (pl) =>
          pl.playerId === bp.playerId && pl.seatIndex === bp.seatIndex
      );
      if (!tp) continue;

      const hole = tp.holeCards;
      const seven = [...hole, ...board];

      const ev = this.evaluateSevenCards(seven);
      evals.push({ bp: bp, eval: ev });
    }

    if (evals.length === 0) return null;

    // Find best score
    let bestScore = evals[0].eval.score;
    for (const e of evals) {
      if (e.eval.score > bestScore) {
        bestScore = e.eval.score;
      }
    }

    const winners = evals.filter((e) => e.eval.score === bestScore);

    // ── VERY SIMPLE POT AWARD (NO TRUE SIDE-POT LOGIC YET) ──
    if (winners.length > 0 && b.pot > 0) {
      const share = Math.floor(b.pot / winners.length);
      const remainder = b.pot - share * winners.length;

      winners.forEach((w, idx) => {
        // bp references objects inside b.players
        w.bp.stack += share + (idx === 0 ? remainder : 0);
      });

      // Pot fully distributed
      b.pot = 0;
      this.betting = b;
    }

    // Build showdown payload for clients
    const showdownPlayers: ShowdownPlayerState[] = [];

    for (const { bp, eval: ev } of evals) {
      const tp = t.players.find(
        (pl) => pl.playerId === bp.playerId && pl.seatIndex === bp.seatIndex
      );
      if (!tp) continue;
      showdownPlayers.push({
        seatIndex: bp.seatIndex,
        playerId: bp.playerId,
        holeCards: tp.holeCards.slice(),
        bestHand: ev.best5,
        rankName: ev.rankName,
        isWinner: winners.some((w) => w.bp.playerId === bp.playerId),
      });
    }

    this.showdown = {
      handId: t.handId,
      board: t.board.slice(),
      players: showdownPlayers,
    };

    return this.showdown;
  }

  // -------------------
  // Internal helpers
  // -------------------

  private drawCard(): Card {
    if (this.deck.length === 0) {
      this.deck = shuffle(buildDeck());
    }
    return this.deck.pop() as Card;
  }

  // Given seatIndex order for circle, find next to act
  private findNextSeatToAct(
    players: BettingPlayerState[],
    fromSeatIndex: number,
    wrap: boolean
  ): number | null {
    const seatOrder = players
      .map((p) => p.seatIndex)
      .sort((a, b) => a - b);

    const idx = seatOrder.indexOf(fromSeatIndex);
    if (idx === -1) {
      return seatOrder.length > 0 ? seatOrder[0] : null;
    }

    for (let step = 1; step <= seatOrder.length; step++) {
      const nextIdx = (idx + step) % seatOrder.length;
      const s = seatOrder[nextIdx];
      const p = players.find((pl) => pl.seatIndex === s);
      if (!p) continue;
      if (p.inHand && !p.hasFolded && p.stack >= 0) {
        return p.seatIndex;
      }
      if (!wrap && nextIdx < idx) break;
    }

    return null;
  }

  private getActingOrder(seatIndices: number[]): number[] {
    return seatIndices.slice().sort((a, b) => a - b);
  }

  private advanceBetting() {
    const b = this.betting;
    const t = this.lastTable;
    if (!b || !t) return;

    // If only one player remains, end hand immediately
    const activePlayers = b.players.filter(
      (p) => p.inHand && !p.hasFolded
    );
    if (activePlayers.length <= 1) {
      b.street = "done";
      b.currentSeatIndex = null;
      this.betting = b;
      return;
    }

    // Check if betting round is complete
    const bettingDone = this.isBettingRoundComplete(b);

    if (bettingDone) {
      // Move committed bets into pot and reset for next street
      for (const p of b.players) {
        b.pot += p.committed;
        p.committed = 0;
        p.hasActed = false;
      }
      b.maxCommitted = 0;

      if (b.street === "preflop") {
        // Deal flop (3 cards)
        t.board.push(this.drawCard());
        t.board.push(this.drawCard());
        t.board.push(this.drawCard());
        b.street = "flop";
      } else if (b.street === "flop") {
        // Deal turn
        t.board.push(this.drawCard());
        b.street = "turn";
      } else if (b.street === "turn") {
        // Deal river
        t.board.push(this.drawCard());
        b.street = "river";
      } else if (b.street === "river") {
        // Done, go to showdown
        b.street = "done";
        b.currentSeatIndex = null;
        this.betting = b;
        this.lastTable = t;
        return;
      }

      // Choose first active player as new currentSeatIndex
      const nextSeat = this.findNextSeatToAct(
        b.players,
        b.buttonSeatIndex,
        true
      );
      b.currentSeatIndex = nextSeat;
      this.betting = b;
      this.lastTable = t;
      return;
    }

    // Otherwise, move action to next seat
    const fromSeat =
      b.currentSeatIndex != null ? b.currentSeatIndex : b.buttonSeatIndex;
    const nextSeat = this.findNextSeatToAct(b.players, fromSeat, true);
    b.currentSeatIndex = nextSeat;
    this.betting = b;
  }

  private isBettingRoundComplete(b: BettingState): boolean {
    const active = b.players.filter((p) => p.inHand && !p.hasFolded);

    if (active.length <= 1) return true;

    // All active players have:
    //  - hasActed = true
    //  - committed == maxCommitted OR stack == 0 (all-in)
    for (const p of active) {
      if (!p.hasActed) return false;
      const owes = b.maxCommitted - p.committed;
      if (owes > 0 && p.stack > 0) {
        return false;
      }
    }
    return true;
  }

  // Very simple 7-card evaluation: high card / pair only
  private evaluateSevenCards(cards: Card[]): {
    score: number;
    rankName: string;
    best5: Card[];
  } {
    // cards: 7
    // Count ranks
    const byRank: Record<string, Card[]> = {};
    for (const c of cards) {
      const r = c[0];
      if (!byRank[r]) byRank[r] = [];
      byRank[r].push(c);
    }

    let bestType = 0; // 0 = high card, 1 = pair
    let bestRankVal = 0;
    let pairRank: string | null = null;

    for (const r of Object.keys(byRank)) {
      const cnt = byRank[r].length;
      const rv = rankValue(r);
      if (cnt >= 2) {
        // pair
        if (bestType < 1 || (bestType === 1 && rv > bestRankVal)) {
          bestType = 1;
          bestRankVal = rv;
          pairRank = r;
        }
      } else {
        // treat as high card candidate only if no pair found yet
        if (bestType === 0 && rv > bestRankVal) {
          bestRankVal = rv;
        }
      }
    }

    // Build best5
    let best5: Card[] = [];
    let rankName = "";

    if (bestType === 1 && pairRank) {
      // Pair
      const pairCards = byRank[pairRank].slice(0, 2);
      const others = cards
        .filter((c) => c[0] !== pairRank)
        .sort((a, b) => rankValue(b[0]) - rankValue(a[0]))
        .slice(0, 3);
      best5 = [...pairCards, ...others];

      const label =
        pairRank === "T"
          ? "Tens"
          : pairRank === "J"
          ? "Jacks"
          : pairRank === "Q"
          ? "Queens"
          : pairRank === "K"
          ? "Kings"
          : pairRank === "A"
          ? "Aces"
          : `${pairRank}${pairRank}`;
      rankName = `Pair of ${label}`;
    } else {
      // High card
      const sorted = cards
        .slice()
        .sort((a, b) => rankValue(b[0]) - rankValue(a[0]));
      best5 = sorted.slice(0, 5);
      const top = best5[0][0];
      const label =
        top === "T"
          ? "Ten"
          : top === "J"
          ? "Jack"
          : top === "Q"
          ? "Queen"
          : top === "K"
          ? "King"
          : top === "A"
          ? "Ace"
          : top;
      rankName = `High card ${label}`;
    }

    const score = bestType * 100 + bestRankVal;
    return { score, rankName, best5 };
  }
}
