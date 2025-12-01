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
  stack: number;            // chips still in front of player (not in pot)
  inHand: boolean;
  hasFolded: boolean;
  hasActed: boolean;
  committed: number;        // amount committed this street toward maxCommitted
  totalContributed: number; // total chips pushed into the pot this hand (all streets)
};

export type BettingState = {
  handId: number;
  street: BettingStreet;
  pot: number;               // total pot = sum of totalContributed across players
  buttonSeatIndex: number;
  currentSeatIndex: number | null;
  bigBlind: number;
  smallBlind: number;
  maxCommitted: number;      // highest committed on this street
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

const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"] as const;
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

  getSeatStacks(): SeatView[] | null {
    if (!this.seatsSnapshot || this.seatsSnapshot.length === 0) return null;
    return this.seatsSnapshot.map((s) => ({ ...s }));
  }

  // Called by server when a new hand should start
  startHand(seats: SeatView[]): TableState | null {
    // active seats: anyone with a playerId and chips > 0
    const activeSeats = seats.filter((s) => !!s.playerId && (s.chips ?? 0) > 0);
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
      const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % occupied.length;
      this.buttonSeatIndex = occupied[nextIdx];
    }

    // Build and shuffle deck
    this.deck = shuffle(buildDeck());

    const handId = this.handCounter++;
    const board: Card[] = [];

    // Deal 2 hole cards per active player
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

    const bettingPlayers: BettingPlayerState[] = tablePlayers.map((tp) => {
      const seatSnap = this.seatsSnapshot.find(
        (s) => s.seatIndex === tp.seatIndex
      );
      const startingStack = seatSnap ? seatSnap.chips : 1000;
      return {
        seatIndex: tp.seatIndex,
        playerId: tp.playerId,
        stack: startingStack,
        inHand: true,
        hasFolded: false,
        hasActed: false,
        committed: 0,
        totalContributed: 0,
      };
    });

    // Post blinds
    const order = bettingPlayers
      .slice()
      .sort((a, b) => a.seatIndex - b.seatIndex);

    const positions = this.getActingOrder(order.map((p) => p.seatIndex));

    let smallBlindSeat: number | null = null;
    let bigBlindSeat: number | null = null;

    if (positions.length === 2) {
      // Heads-up: button = small blind; other = big blind
      smallBlindSeat = this.buttonSeatIndex;
      bigBlindSeat = positions.find((s) => s !== this.buttonSeatIndex) ?? null;
    } else {
      const idxBtn = positions.indexOf(this.buttonSeatIndex!);
      if (idxBtn !== -1) {
        smallBlindSeat = positions[(idxBtn + 1) % positions.length];
        bigBlindSeat = positions[(idxBtn + 2) % positions.length];
      }
    }

    let pot = 0;
    let maxCommitted = 0;

    function applyBlind(
      players: BettingPlayerState[],
      seatIndex: number | null,
      amount: number
    ): { potDelta: number; committed: number } {
      if (seatIndex == null) return { potDelta: 0, committed: 0 };
      const p = players.find((x) => x.seatIndex === seatIndex);
      if (!p) return { potDelta: 0, committed: 0 };
      const blind = Math.min(amount, p.stack);
      if (blind <= 0) {
        return { potDelta: 0, committed: p.committed };
      }
      p.stack -= blind;
      p.committed += blind;
      p.totalContributed += blind;
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
      if (callNeeded > 0 && p.stack > 0) {
        const callAmt = Math.min(callNeeded, p.stack);
        p.stack -= callAmt;
        p.committed += callAmt;
        p.totalContributed += callAmt;
        b.pot += callAmt;
        b.maxCommitted = Math.max(b.maxCommitted, p.committed);
      }
      p.hasActed = true;
    } else if (action === "call") {
      const callAmt = Math.min(callNeeded, p.stack);
      if (callAmt > 0) {
        p.stack -= callAmt;
        p.committed += callAmt;
        p.totalContributed += callAmt;
        b.pot += callAmt;
        b.maxCommitted = Math.max(b.maxCommitted, p.committed);
      }
      p.hasActed = true;
    } else if (action === "bet") {
      const baseBet =
        typeof amount === "number" && amount > 0
          ? Math.floor(amount)
          : b.bigBlind * 2;

      const desired = callNeeded + baseBet;
      const spend = Math.min(p.stack, desired);
      if (spend > 0) {
        p.stack -= spend;
        p.committed += spend;
        p.totalContributed += spend;
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
        (pl) => pl.playerId === bp.playerId && pl.seatIndex === bp.seatIndex
      );
      if (!tp) continue;

      const hole = tp.holeCards;
      const seven = [...hole, ...board];

      const ev = this.evaluateSevenCards(seven);
      evals.push({ bp, eval: ev });
    }

    if (evals.length === 0) return null;

    // -----------------------------
    // SIDE POT & PAYOUT CALCULATION
    // -----------------------------

    const totalPotFromContrib = b.players.reduce(
      (sum, p) => sum + (p.totalContributed || 0),
      0
    );
    if (totalPotFromContrib > 0) {
      b.pot = totalPotFromContrib;
    }

    const payouts: Record<string, number> = {};
    for (const pl of b.players) {
      payouts[pl.playerId] = 0;
    }

    const levels = Array.from(
      new Set(
        b.players
          .map((p) => p.totalContributed || 0)
          .filter((c) => c > 0)
      )
    ).sort((a, b2) => a - b2);

    if (levels.length === 0) {
      levels.push(0);
    }

    let prevLevel = 0;

    for (const level of levels) {
      const contributingPlayers = b.players.filter(
        (p) => p.totalContributed >= level
      );
      if (contributingPlayers.length === 0) {
        prevLevel = level;
        continue;
      }

      const layerAmount = level - prevLevel;
      if (layerAmount <= 0) {
        prevLevel = level;
        continue;
      }

      const potChunk = layerAmount * contributingPlayers.length;

      const eligibleEvals = evals.filter(
        ({ bp }) => bp.totalContributed >= level
      );
      if (eligibleEvals.length === 0) {
        prevLevel = level;
        continue;
      }

      let bestScore = eligibleEvals[0].eval.score;
      for (const e of eligibleEvals) {
        if (e.eval.score > bestScore) {
          bestScore = e.eval.score;
        }
      }

      const winners = eligibleEvals.filter(
        (e) => e.eval.score === bestScore
      );

      const share = Math.floor(potChunk / winners.length);
      let remainder = potChunk - share * winners.length;

      for (const { bp } of winners) {
        payouts[bp.playerId] += share;
      }

      if (remainder > 0) {
        const sortedWinners = winners
          .slice()
          .sort((a, b2) => a.bp.seatIndex - b2.bp.seatIndex);
        payouts[sortedWinners[0].bp.playerId] += remainder;
        remainder = 0;
      }

      prevLevel = level;
    }

    // Apply payouts to stacks and mirror back to seatsSnapshot
    for (const bp of b.players) {
      const win = payouts[bp.playerId] || 0;
      bp.stack += win;
    }

    for (const seat of this.seatsSnapshot) {
      if (!seat.playerId) continue;
      const bp = b.players.find(
        (pl) =>
          pl.playerId === seat.playerId && pl.seatIndex === seat.seatIndex
      );
      if (bp) {
        seat.chips = bp.stack;
      }
    }

    // Build showdownPlayers with winner flags
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
        isWinner: (payouts[bp.playerId] || 0) > 0,
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

    // If only one player remains, end hand
    const activePlayers = b.players.filter(
      (p) => p.inHand && !p.hasFolded
    );
    if (activePlayers.length <= 1) {
      b.street = "done";
      b.currentSeatIndex = null;
      this.betting = b;
      return;
    }

    const bettingDone = this.isBettingRoundComplete(b);

    if (bettingDone) {
      // Reset committed + acted flags for next street
      for (const p of b.players) {
        p.committed = 0;
        p.hasActed = false;
      }
      b.maxCommitted = 0;

      if (b.street === "preflop") {
        t.board.push(this.drawCard());
        t.board.push(this.drawCard());
        t.board.push(this.drawCard());
        b.street = "flop";
      } else if (b.street === "flop") {
        t.board.push(this.drawCard());
        b.street = "turn";
      } else if (b.street === "turn") {
        t.board.push(this.drawCard());
        b.street = "river";
      } else if (b.street === "river") {
        b.street = "done";
        b.currentSeatIndex = null;
        this.betting = b;
        this.lastTable = t;
        return;
      }

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

    const fromSeat =
      b.currentSeatIndex != null ? b.currentSeatIndex : b.buttonSeatIndex;
    const nextSeat = this.findNextSeatToAct(b.players, fromSeat, true);
    b.currentSeatIndex = nextSeat;
    this.betting = b;
  }

  private isBettingRoundComplete(b: BettingState): boolean {
    const active = b.players.filter((p) => p.inHand && !p.hasFolded);
    if (active.length <= 1) return true;

    for (const p of active) {
      if (!p.hasActed) return false;
      const owes = b.maxCommitted - p.committed;
      if (owes > 0 && p.stack > 0) {
        return false;
      }
    }
    return true;
  }

  // -------------------
  // Full 7-card evaluator
  // -------------------

  private evaluateSevenCards(cards: Card[]): {
    score: number;
    rankName: string;
    best5: Card[];
  } {
    // ranks + suits
    const ranks: number[] = cards.map((c) => rankValue(c[0]));
    const suits: string[] = cards.map((c) => c[1]);

    const rankCounts: Record<number, number> = {};
    const suitCounts: Record<string, number> = {};
    for (let i = 0; i < cards.length; i++) {
      const r = ranks[i];
      const s = suits[i];
      rankCounts[r] = (rankCounts[r] || 0) + 1;
      suitCounts[s] = (suitCounts[s] || 0) + 1;
    }

    const uniqueRanksDesc = Array.from(new Set(ranks)).sort((a, b) => b - a);

    let flushSuit: string | null = null;
    for (const s of Object.keys(suitCounts)) {
      if (suitCounts[s] >= 5) {
        flushSuit = s;
        break;
      }
    }

    // ---------- Straight Flush / Royal ----------
    if (flushSuit) {
      const flushCards = cards.filter((c) => c[1] === flushSuit);
      const flushRanks = flushCards.map((c) => rankValue(c[0]));
      const flushUniqueDesc = Array.from(new Set(flushRanks)).sort(
        (a, b) => b - a
      );
      const sfRanks = this.bestStraight(flushUniqueDesc);
      if (sfRanks.length === 5) {
        const best5 = this.pickCardsForRanks(flushCards, sfRanks);
        const high = sfRanks[0];
        let rankName = "";
        if (high === 14 && sfRanks[4] === 10) {
          rankName = "Royal flush";
        } else {
          const highName =
            high === 14
              ? "Ace-high"
              : high === 13
              ? "King-high"
              : high === 12
              ? "Queen-high"
              : high === 11
              ? "Jack-high"
              : `${high}-high`;
          rankName = `Straight flush (${highName})`;
        }
        const score = this.buildRankScore(8, sfRanks);
        return { score, rankName, best5 };
      }
    }

    // ---------- Count patterns ----------
    const ranksByCountDesc = Object.keys(rankCounts)
      .map((rStr) => {
        const r = Number(rStr);
        return { rank: r, count: rankCounts[r] };
      })
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return b.rank - a.rank;
      });

    const fourOf: number[] = [];
    const trips: number[] = [];
    const pairs: number[] = [];

    for (const rc of ranksByCountDesc) {
      if (rc.count === 4) fourOf.push(rc.rank);
      else if (rc.count === 3) trips.push(rc.rank);
      else if (rc.count === 2) pairs.push(rc.rank);
    }

    // ---------- Four of a kind ----------
    if (fourOf.length > 0) {
      const quadRank = fourOf[0];
      const kickerRank =
        uniqueRanksDesc.find((r) => r !== quadRank) ?? quadRank;
      const ranksForScore = [quadRank, quadRank, quadRank, quadRank, kickerRank];
      const best5 = this.pickCardsForRanks(cards, ranksForScore);
      const label =
        quadRank === 14
          ? "Aces"
          : quadRank === 13
          ? "Kings"
          : quadRank === 12
          ? "Queens"
          : quadRank === 11
          ? "Jacks"
          : `${quadRank}s`;
      const rankName = `Four of ${label}`;
      const score = this.buildRankScore(7, [quadRank, kickerRank]);
      return { score, rankName, best5 };
    }

    // ---------- Full house ----------
    if (trips.length > 0 && (trips.length > 1 || pairs.length > 0)) {
      const tripRank = trips[0];
      const restRanks = [...trips.slice(1), ...pairs];
      const pairRank = restRanks[0];

      const ranksForScore = [
        tripRank,
        tripRank,
        tripRank,
        pairRank,
        pairRank,
      ];
      const best5 = this.pickCardsForRanks(cards, ranksForScore);
      const tripLabel =
        tripRank === 14
          ? "Aces"
          : tripRank === 13
          ? "Kings"
          : tripRank === 12
          ? "Queens"
          : tripRank === 11
          ? "Jacks"
          : `${tripRank}s`;
      const pairLabel =
        pairRank === 14
          ? "Aces"
          : pairRank === 13
          ? "Kings"
          : pairRank === 12
          ? "Queens"
          : pairRank === 11
          ? "Jacks"
          : `${pairRank}s`;
      const rankName = `Full house, ${tripLabel} over ${pairLabel}`;
      const score = this.buildRankScore(6, [tripRank, pairRank]);
      return { score, rankName, best5 };
    }

    // ---------- Flush ----------
    if (flushSuit) {
      const flushCards = cards.filter((c) => c[1] === flushSuit);
      const flushRanks = flushCards
        .map((c) => rankValue(c[0]))
        .sort((a, b) => b - a);
      const flushUniqueDesc = Array.from(new Set(flushRanks)).sort(
        (a, b) => b - a
      );
      const top5 = flushUniqueDesc.slice(0, 5);
      const best5 = this.pickCardsForRanks(flushCards, top5);
      const high = top5[0];
      const label =
        high === 14
          ? "Ace-high"
          : high === 13
          ? "King-high"
          : high === 12
          ? "Queen-high"
          : high === 11
          ? "Jack-high"
          : `${high}-high`;
      const rankName = `Flush (${label})`;
      const score = this.buildRankScore(5, top5);
      return { score, rankName, best5 };
    }

    // ---------- Straight ----------
    const straightRanks = this.bestStraight(uniqueRanksDesc);
    if (straightRanks.length === 5) {
      const best5 = this.pickCardsForRanks(cards, straightRanks);
      const high = straightRanks[0];
      const label =
        high === 14
          ? "Ace-high"
          : high === 13
          ? "King-high"
          : high === 12
          ? "Queen-high"
          : high === 11
          ? "Jack-high"
          : `${high}-high`;
      const rankName = `Straight (${label})`;
      const score = this.buildRankScore(4, straightRanks);
      return { score, rankName, best5 };
    }

    // ---------- Trips ----------
    if (trips.length > 0) {
      const tripRank = trips[0];
      const kickers = uniqueRanksDesc.filter((r) => r !== tripRank).slice(0, 2);
      const ranksForScore = [
        tripRank,
        tripRank,
        tripRank,
        ...(kickers.length === 2 ? kickers : [kickers[0] ?? tripRank, tripRank]),
      ];
      const best5 = this.pickCardsForRanks(cards, ranksForScore);
      const label =
        tripRank === 14
          ? "Aces"
          : tripRank === 13
          ? "Kings"
          : tripRank === 12
          ? "Queens"
          : tripRank === 11
          ? "Jacks"
          : `${tripRank}s`;
      const rankName = `Three of a kind (${label})`;
      const score = this.buildRankScore(3, [
        tripRank,
        ...(kickers as number[]),
      ]);
      return { score, rankName, best5 };
    }

    // ---------- Two pair ----------
    if (pairs.length >= 2) {
      const [highPair, lowPair] = pairs.slice(0, 2);
      const kicker =
        uniqueRanksDesc.find((r) => r !== highPair && r !== lowPair) ??
        highPair;
      const ranksForScore = [
        highPair,
        highPair,
        lowPair,
        lowPair,
        kicker,
      ];
      const best5 = this.pickCardsForRanks(cards, ranksForScore);
      const highLabel =
        highPair === 14
          ? "Aces"
          : highPair === 13
          ? "Kings"
          : highPair === 12
          ? "Queens"
          : highPair === 11
          ? "Jacks"
          : `${highPair}s`;
      const lowLabel =
        lowPair === 14
          ? "Aces"
          : lowPair === 13
          ? "Kings"
          : lowPair === 12
          ? "Queens"
          : lowPair === 11
          ? "Jacks"
          : `${lowPair}s`;
      const rankName = `Two pair (${highLabel} and ${lowLabel})`;
      const score = this.buildRankScore(2, [highPair, lowPair, kicker]);
      return { score, rankName, best5 };
    }

    // ---------- One pair ----------
    if (pairs.length === 1) {
      const pairRank = pairs[0];
      const kickers = uniqueRanksDesc.filter((r) => r !== pairRank).slice(0, 3);
      const ranksForScore = [
        pairRank,
        pairRank,
        ...(kickers as number[]),
      ];
      const best5 = this.pickCardsForRanks(cards, ranksForScore);
      const label =
        pairRank === 14
          ? "Aces"
          : pairRank === 13
          ? "Kings"
          : pairRank === 12
          ? "Queens"
          : pairRank === 11
          ? "Jacks"
          : `${pairRank}s`;
      const rankName = `Pair of ${label}`;
      const score = this.buildRankScore(1, [pairRank, ...kickers]);
      return { score, rankName, best5 };
    }

    // ---------- High card ----------
    const top5 = uniqueRanksDesc.slice(0, 5);
    const best5 = this.pickCardsForRanks(cards, top5);
    const top = top5[0];
    const label =
      top === 14
        ? "Ace"
        : top === 13
        ? "King"
        : top === 12
        ? "Queen"
        : top === 11
        ? "Jack"
        : `${top}`;
    const rankName = `High card ${label}`;
    const score = this.buildRankScore(0, top5);
    return { score, rankName, best5 };
  }

  // Category: 0..8, ranksDesc: high-to-low kicker structure
  private buildRankScore(category: number, ranksDesc: number[]): number {
    // category * 1e8 + r1*1e6 + r2*1e4 + r3*1e2 + r4*1e1 + r5
    const [r1, r2, r3, r4, r5] = [
      ranksDesc[0] ?? 0,
      ranksDesc[1] ?? 0,
      ranksDesc[2] ?? 0,
      ranksDesc[3] ?? 0,
      ranksDesc[4] ?? 0,
    ];
    return (
      category * 1e8 +
      r1 * 1e6 +
      r2 * 1e4 +
      r3 * 1e2 +
      r4 * 10 +
      r5
    );
  }

  // Find best straight from a list of unique ranks (desc)
  private bestStraight(uniqueRanksDesc: number[]): number[] {
    if (uniqueRanksDesc.length < 5) return [];

    // Work on ascending for scanning
    const uniq = Array.from(new Set(uniqueRanksDesc));
    let arr = uniq.slice().sort((a, b) => a - b);

    // Wheel: if A,5,4,3,2 add A as rank 1
    if (arr.includes(14)) {
      arr.push(1);
    }
    arr = Array.from(new Set(arr)).sort((a, b) => a - b);

    let bestHigh = 0;
    let bestSeq: number[] = [];

    let run: number[] = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] === arr[i - 1] + 1) {
        run.push(arr[i]);
      } else if (arr[i] !== arr[i - 1]) {
        if (run.length >= 5) {
          const candidate = run.slice(-5);
          const high = candidate[candidate.length - 1];
          if (high > bestHigh) {
            bestHigh = high;
            bestSeq = candidate.slice();
          }
        }
        run = [arr[i]];
      }
    }
    if (run.length >= 5) {
      const candidate = run.slice(-5);
      const high = candidate[candidate.length - 1];
      if (high > bestHigh) {
        bestHigh = high;
        bestSeq = candidate.slice();
      }
    }

    if (bestSeq.length === 0) return [];

    const resultAsc = bestSeq.map((r) => (r === 1 ? 14 : r));
    return resultAsc.sort((a, b) => b - a);
  }

  // Pick actual cards matching a high->low rank pattern
  private pickCardsForRanks(cards: Card[], targetRanksDesc: number[]): Card[] {
    const result: Card[] = [];
    const remaining = cards.slice();

    for (const target of targetRanksDesc) {
      for (let i = 0; i < remaining.length; i++) {
        const c = remaining[i];
        const r = rankValue(c[0]);
        if (r === target) {
          result.push(c);
          remaining.splice(i, 1);
          break;
        }
      }
    }
    // If somehow fewer than 5, just pad with highest remaining (should be rare)
    while (result.length < 5 && remaining.length > 0) {
      result.push(remaining.shift() as Card);
    }
    return result.slice(0, 5);
  }
}
