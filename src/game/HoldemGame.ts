// src/game/HoldemGame.ts
//
// ✅ Update goals:
// 1) Do NOT break cash game (keeps TableState.players[].holeCards for legacy UI)
// 2) Add support for tournament UI (private hole cards) WITHOUT changing existing broadcast types
// 3) Provide a safe per-player hole-cards getter that the manager can use to send private "hole-cards" msgs
// 4) Keep all existing betting logic intact

// Basic seat shape that the room + frontend use
export type SeatView = {
  seatIndex: number;
  playerId: string | null;
  handle?: string; // ✅ ADD
  name?: string;
  chips?: number;
};


// Table state broadcast (legacy cash UI uses this)
export type TablePlayerState = {
  seatIndex: number;
  playerId: string;
  holeCards: string[]; // ✅ keep for cash (legacy)
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
  stack: number; // chips still in front of player (not in pot)
  inHand: boolean;
  hasFolded: boolean;
  hasActed: boolean;
  committed: number; // amount committed this street toward maxCommitted
  totalContributed: number; // total chips pushed into the pot this hand (all streets)
};

export type BettingState = {
  handId: number;
  street: BettingStreet;
  pot: number; // total pot = sum of totalContributed across players
  buttonSeatIndex: number;
  currentSeatIndex: number | null;
  bigBlind: number;
  smallBlind: number;
  maxCommitted: number; // highest committed on this street
  players: BettingPlayerState[];
  smallBlindSeatIndex?: number | null;
  bigBlindSeatIndex?: number | null;
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

export type AllInRevealPlayer = {
  seatIndex: number;
  playerId: string;
  holeCards: string[];
};

export type AllInRevealPayload = {
  handId: number;
  players: AllInRevealPlayer[];
};

// -------------------
// Helper: Deck + cards
// -------------------

const RANKS = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "T",
  "J",
  "Q",
  "K",
  "A",
] as const;
const SUITS = ["s", "h", "d", "c"] as const;

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

  // --- freeze recovery / safety ---
  private lastProgressAt = Date.now();
  private pendingAllInReveal: AllInRevealPayload | null = null;

  // ✅ NEW: private hole-cards store (for tournament UI)
  // Keeps hero cards available even if you later stop broadcasting holeCards in TableState.
  private holeCardsByPlayer: Map<string, Card[]> = new Map();

  private touch(reason: string) {
    this.lastProgressAt = Date.now();
    // console.log(`[HoldemGame] ${reason}`);
  }

  /**
   * Hard aborts the current hand and clears board/holecards/betting so UI doesn't get stuck.
   * Keeps buttonSeatIndex by default so the button rotation continues naturally next hand.
   */
  abortHand(reason: string) {
    this.lastTable = null;
    this.betting = null;
    this.showdown = null;
    this.deck = [];
    this.pendingAllInReveal = null;

    // ✅ clear private hole cards
    this.holeCardsByPlayer.clear();

    // keep seatsSnapshot (manager is source of truth)
    this.touch(`abort:${reason}`);
  }

  /**
   * Full reset (host button). Also resets button rotation.
   */
  resetTable(reason: string) {
    this.abortHand(`reset:${reason}`);
    this.buttonSeatIndex = null;
    this.seatsSnapshot = [];
    this.touch(`reset:${reason}`);
  }

  /**
   * Call this whenever seats change (sit/stand/leave/disconnect).
   * If fewer than 2 active players remain while a hand is visible → abort.
   */
  onSeatsChanged(seats: SeatView[]) {
    this.seatsSnapshot = seats.map((s) => ({ ...s }));

    const activeCount = seats.filter(
      (s) => s.playerId && (s.chips ?? 0) > 0
    ).length;

    // This is the "everyone stood up but dealer hand stays" fix.
    if ((this.lastTable || this.betting) && activeCount < 2) {
      this.abortHand("NOT_ENOUGH_PLAYERS");
    }

    this.touch("seatsChanged");
  }

  /**
   * Watchdog: if a hand doesn't progress for too long, abort so room can recover.
   * Call this from the manager on an interval or before broadcasts.
   */
  maybeRecoverFromStall(stallMs = 20000) {
    if (!(this.lastTable || this.betting)) return;
    const age = Date.now() - this.lastProgressAt;
    if (age > stallMs) {
      this.abortHand(`STALL_${age}ms`);
    }
  }

  // -----------------------------------
  // PUBLIC API used by PokerRoomManager
  // -----------------------------------

  /**
   * ✅ Legacy method (cash UI / current manager might still call this).
   * Returns hole cards from lastTable (still populated).
   */
  getHoleCardsForPlayer(playerId: string): string[] | null {
    if (!this.lastTable) return null;
    const tp = this.lastTable.players.find((p) => p.playerId === playerId);
    return tp ? tp.holeCards.slice() : null;
  }

  /**
   * ✅ NEW preferred method:
   * Safe even if you later stop putting holeCards into TableState for tournaments.
   * Use this to send PRIVATE "hole-cards" messages from the room manager.
   */
  getPrivateHoleCards(playerId: string): string[] | null {
    const cards = this.holeCardsByPlayer.get(playerId);
    if (!cards || cards.length < 2) return null;
    return cards.slice(0, 2);
  }

  /**
   * If an all-in situation occurred with no actions left, this returns
   * the reveal payload ONCE, then clears it.
   */
  consumeAllInReveal(): AllInRevealPayload | null {
    const p = this.pendingAllInReveal;
    this.pendingAllInReveal = null;
    return p;
  }

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
    const activeSeats = seats.filter(
      (s) => s.playerId && (s.chips ?? 0) > 0
    );
    if (activeSeats.length < 2) return null;

    this.touch("startHand");

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

    // ✅ reset per-hand private store
    this.holeCardsByPlayer.clear();

    // Deal 2 hole cards per active player
    const tablePlayers: TablePlayerState[] = [];
    for (const seat of activeSeats) {
      const hole: Card[] = [this.drawCard(), this.drawCard()];

      // ✅ store private hole cards keyed by playerId
      this.holeCardsByPlayer.set(seat.playerId as string, hole.slice());

      // ✅ keep legacy: still include holeCards in TableState (cash game depends on it)
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
      const startingStack = seatSnap?.chips ?? 0;

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
      bigBlindSeat =
        positions.find((s) => s !== this.buttonSeatIndex) ?? null;
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
      smallBlindSeatIndex: smallBlindSeat,
      bigBlindSeatIndex: bigBlindSeat,
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

    this.touch(`action:${playerId}:${action}`);

    const callNeeded = Math.max(0, b.maxCommitted - p.committed);
    const isAllIn = p.stack <= 0;

    // If you're all-in, you have no actions. Mark acted and advance.
    if (isAllIn) {
      p.stack = Math.max(0, p.stack);
      p.hasActed = true;
      this.advanceBetting();
      return this.betting;
    }

    if (action === "fold") {
  // ✅ IMPORTANT:
  // Keep inHand=true so showdown/payout logic can still see contributors.
  // Fold is represented by hasFolded=true.
  p.hasFolded = true;
  p.hasActed = true;

  // Optional: fold clears committed for “owes” checks this street.
  // (totalContributed stays; those chips are already in the pot)
  // p.committed = p.committed;
}
 else if (action === "check") {
      // ✅ CHECK must be free; only allowed if you owe nothing.
      // If UI accidentally sends "check" when it should be "call", we ignore it.
      if (callNeeded === 0) {
        p.hasActed = true;
      } else {
        // Not allowed
        return b;
      }
    } else if (action === "call") {
      const callAmt = Math.min(callNeeded, p.stack);
      if (callAmt > 0) {
        p.stack = Math.max(0, p.stack - callAmt);
        p.committed += callAmt;
        p.totalContributed += callAmt;
        b.pot += callAmt;
        b.maxCommitted = Math.max(b.maxCommitted, p.committed);
      }
      p.hasActed = true;
    } else if (action === "bet") {
      const baseBet =
        typeof amount === "number" && Number.isFinite(amount) && amount > 0
          ? Math.floor(amount)
          : b.bigBlind * 2;

      const desired = callNeeded + baseBet;
      const spend = Math.min(p.stack, desired);

      if (spend > 0) {
        p.stack = Math.max(0, p.stack - spend);
        p.committed += spend;
        p.totalContributed += spend;
        b.pot += spend;
        b.maxCommitted = Math.max(b.maxCommitted, p.committed);
      }

      p.hasActed = true;

      // Any new bet/raise means others need to act again (unless they are all-in)
      for (let i = 0; i < b.players.length; i++) {
        if (i === pIdx) continue;
        const other = b.players[i];
        if (other.inHand && !other.hasFolded && other.stack > 0) {
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
    // ✅ Robust: "active contenders" are simply players who have NOT folded.
// inHand should remain true, but don't let a bad flag break payouts.
const active = b.players.filter((p) => !p.hasFolded && (p.totalContributed > 0 || p.stack >= 0));
if (active.length === 0) {
  // If literally everyone is folded (shouldn't happen), pick the last non-folded by seat.
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

      if (seven.length < 7) {
        evals.push({
          bp,
          eval: {
            score: 1,
            rankName: "Wins by fold",
            best5: seven,
          },
        });
        continue;
      }

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
    for (const pl of b.players) payouts[pl.playerId] = 0;

    const levels = Array.from(
      new Set(
        b.players
          .map((p) => p.totalContributed || 0)
          .filter((c) => c > 0)
      )
    ).sort((a, b2) => a - b2);

    if (levels.length === 0) levels.push(0);

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
        if (e.eval.score > bestScore) bestScore = e.eval.score;
      }

      const winners = eligibleEvals.filter((e) => e.eval.score === bestScore);

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
        (pl) => pl.playerId === seat.playerId && pl.seatIndex === seat.seatIndex
      );
      if (bp) seat.chips = bp.stack;
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
      // start at lowest eligible seat
      for (const s of seatOrder) {
        const p = players.find((pl) => pl.seatIndex === s);
        if (!p) continue;
        if (p.inHand && !p.hasFolded && p.stack > 0) return p.seatIndex; // ✅ skip all-in
      }
      return null;
    }

    for (let step = 1; step <= seatOrder.length; step++) {
      const nextIdx = (idx + step) % seatOrder.length;
      const s = seatOrder[nextIdx];
      const p = players.find((pl) => pl.seatIndex === s);
      if (!p) continue;

      // ✅ only seats with decisions left (stack > 0) can be currentSeatIndex
      if (p.inHand && !p.hasFolded && p.stack > 0) {
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

    this.touch(`advance:${b.street}`);

    // If only one player remains, end hand immediately
    const activePlayers = b.players.filter((p) => p.inHand && !p.hasFolded);
    if (activePlayers.length <= 1) {
      b.street = "done";
      b.currentSeatIndex = null;
      this.betting = b;
      return;
    }

    // If everyone remaining is all-in (stack==0), there are no actions left.
    // ✅ Run board out to the river and end hand (prevents freezes).
    const anyCanAct = activePlayers.some((p) => p.stack > 0);
    if (!anyCanAct) {
      // ✅ reveal hole cards once (integrity/clarity)
      if (!this.pendingAllInReveal) {
        const revealPlayers: AllInRevealPlayer[] = activePlayers
          .map((bp) => {
            const tp = t.players.find(
              (pl) => pl.playerId === bp.playerId && pl.seatIndex === bp.seatIndex
            );
            return tp
              ? {
                  seatIndex: bp.seatIndex,
                  playerId: bp.playerId,
                  holeCards: tp.holeCards.slice(0, 2),
                }
              : null;
          })
          .filter(Boolean) as AllInRevealPlayer[];

        this.pendingAllInReveal = {
          handId: t.handId,
          players: revealPlayers,
        };
      }

      while (t.board.length < 5) {
        t.board.push(this.drawCard());
      }
      b.street = "done";
      b.currentSeatIndex = null;
      this.betting = b;
      this.lastTable = t;
      return;
    }

    const bettingDone = this.isBettingRoundComplete(b);

    if (bettingDone) {
      // Reset committed + acted flags for next street
      for (const p of b.players) {
        p.committed = 0;
        // only players who can act should be required to act next street
        p.hasActed = p.stack <= 0; // ✅ all-in players considered "already acted"
      }
      b.maxCommitted = 0;

      if (b.street === "preflop") {
        t.board.push(this.drawCard(), this.drawCard(), this.drawCard());
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

      // Next to act postflop starts left of button
      const nextSeat = this.findNextSeatToAct(b.players, b.buttonSeatIndex, true);

      // If nobody can act on the new street, end.
      if (nextSeat == null) {
        while (t.board.length < 5) {
          t.board.push(this.drawCard());
        }
        b.street = "done";
        b.currentSeatIndex = null;
      } else {
        b.currentSeatIndex = nextSeat;
      }

      this.betting = b;
      this.lastTable = t;
      return;
    }

    const fromSeat =
      b.currentSeatIndex != null ? b.currentSeatIndex : b.buttonSeatIndex;
    const nextSeat = this.findNextSeatToAct(b.players, fromSeat, true);

    // If no eligible seat can act mid-street, run it out and end.
    if (nextSeat == null) {
      while (t.board.length < 5) {
        t.board.push(this.drawCard());
      }
      b.street = "done";
      b.currentSeatIndex = null;
      this.betting = b;
      this.lastTable = t;
      return;
    }

    b.currentSeatIndex = nextSeat;
    this.betting = b;
  }

  private isBettingRoundComplete(b: BettingState): boolean {
    const active = b.players.filter((p) => p.inHand && !p.hasFolded);
    if (active.length <= 1) return true;

    for (const p of active) {
      if (!p.hasActed) return false;
      const owes = b.maxCommitted - p.committed;
      if (owes > 0 && p.stack > 0) return false;
    }
    return true;
  }

  // -------------------
  // Hand ranking helpers
  // -------------------

  // Category: 0..8, ranksDesc: high-to-low kicker structure
  private buildRankScore(category: number, ranksDesc: number[]): number {
    const [r1, r2, r3, r4, r5] = [
      ranksDesc[0] ?? 0,
      ranksDesc[1] ?? 0,
      ranksDesc[2] ?? 0,
      ranksDesc[3] ?? 0,
      ranksDesc[4] ?? 0,
    ];
    return category * 1e8 + r1 * 1e6 + r2 * 1e4 + r3 * 1e2 + r4 * 10 + r5;
  }

  // Full 7-card evaluator – brute force all 21 combos of 5
  private evaluateSevenCards(cards: Card[]): {
    score: number;
    rankName: string;
    best5: Card[];
  } {
    // Defensive guard
    if (cards.length !== 7) {
      console.error(`evaluateSevenCards expects 7 cards, got ${cards.length}`, cards);
      return { score: 0, rankName: "No hand", best5: cards.slice(0, 5) };
    }

    let bestScore = -1;
    let bestName = "High card";
    let bestFive: Card[] = [];

    const n = cards.length;
    for (let a = 0; a < n - 4; a++) {
      for (let b = a + 1; b < n - 3; b++) {
        for (let c = b + 1; c < n - 2; c++) {
          for (let d = c + 1; d < n - 1; d++) {
            for (let e = d + 1; e < n; e++) {
              const combo = [cards[a], cards[b], cards[c], cards[d], cards[e]];
              const { category, ranksDesc, rankName } = this.evaluateFiveCards(combo);
              const score = this.buildRankScore(category, ranksDesc);

              if (score > bestScore) {
                bestScore = score;
                bestName = rankName;
                bestFive = combo;
              }
            }
          }
        }
      }
    }

    return { score: bestScore, rankName: bestName, best5: bestFive };
  }

  /**
   * Evaluate EXACTLY 5 cards.
   * Returns:
   *  - category: 0..8
   *  - ranksDesc: high->low ranks used for tie-breaking
   *  - rankName: human text
   */
  private evaluateFiveCards(cards: Card[]): {
    category: number;
    ranksDesc: number[];
    rankName: string;
  } {
    const ranks: number[] = cards.map((c) => rankValue(c[0]));
    const suits: string[] = cards.map((c) => c[1]);
    const uniqueRanksDesc = Array.from(new Set(ranks)).sort((a, b) => b - a);

    const rankCounts: Record<number, number> = {};
    const suitCounts: Record<string, number> = {};
    for (let i = 0; i < cards.length; i++) {
      const r = ranks[i];
      const s = suits[i];
      rankCounts[r] = (rankCounts[r] || 0) + 1;
      suitCounts[s] = (suitCounts[s] || 0) + 1;
    }

    const groups = Object.keys(rankCounts)
      .map((key) => ({ rank: Number(key), count: rankCounts[Number(key)] }))
      .sort((a, b) => (b.count !== a.count ? b.count - a.count : b.rank - a.rank));

    const counts = groups.map((g) => g.count);
    const topRank = groups[0]?.rank ?? 0;
    const secondRank = groups[1]?.rank ?? 0;

    const labelRankPlural = (r: number) =>
      r === 14 ? "Aces" : r === 13 ? "Kings" : r === 12 ? "Queens" : r === 11 ? "Jacks" : `${r}s`;

    const labelRankHigh = (r: number) =>
      r === 14 ? "Ace-high" : r === 13 ? "King-high" : r === 12 ? "Queen-high" : r === 11 ? "Jack-high" : `${r}-high`;

    // Straight detection (wheel A-5)
    let isStraight = false;
    let straightHigh = 0;

    const uniqAsc = Array.from(new Set(uniqueRanksDesc)).sort((a, b) => a - b);
    let arr = uniqAsc.slice();
    if (arr.includes(14)) arr.push(1);
    arr = Array.from(new Set(arr)).sort((a, b) => a - b);

    let bestSeqHigh = 0;
    let run: number[] = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] === arr[i - 1] + 1) run.push(arr[i]);
      else if (arr[i] !== arr[i - 1]) {
        if (run.length >= 5) {
          const cand = run.slice(-5);
          const hi = cand[cand.length - 1];
          if (hi > bestSeqHigh) bestSeqHigh = hi;
        }
        run = [arr[i]];
      }
    }
    if (run.length >= 5) {
      const cand = run.slice(-5);
      const hi = cand[cand.length - 1];
      if (hi > bestSeqHigh) bestSeqHigh = hi;
    }

    if (bestSeqHigh > 0) {
      isStraight = true;
      straightHigh = bestSeqHigh === 1 ? 5 : bestSeqHigh;
    }

    // Flush detection
    let flushSuit: string | null = null;
    for (const s of Object.keys(suitCounts)) {
      if (suitCounts[s] === 5) {
        flushSuit = s;
        break;
      }
    }
    const isFlush = !!flushSuit;

    // Straight flush
    if (isFlush && isStraight) {
      const sfHigh = straightHigh;
      if (sfHigh === 14) {
        return { category: 8, ranksDesc: [14, 13, 12, 11, 10], rankName: "Royal flush" };
      }
      return { category: 8, ranksDesc: [sfHigh], rankName: `Straight flush (${labelRankHigh(sfHigh)})` };
    }

    // Four of a kind
    if (counts[0] === 4) {
      const quadRank = topRank;
      const kickerRank = uniqueRanksDesc.find((r) => r !== quadRank) ?? quadRank;
      return { category: 7, ranksDesc: [quadRank, kickerRank], rankName: `Four of ${labelRankPlural(quadRank)}` };
    }

    // Full house
    if (counts[0] === 3 && (counts[1] === 3 || counts[1] === 2)) {
      const tripRank = topRank;
      const pairRank = secondRank;
      return {
        category: 6,
        ranksDesc: [tripRank, pairRank],
        rankName: `Full house, ${labelRankPlural(tripRank)} over ${labelRankPlural(pairRank)}`,
      };
    }

    // Flush
    if (isFlush) {
      const sortedFlush = ranks.slice().sort((a, b) => b - a);
      const top5 = sortedFlush.slice(0, 5);
      const high = top5[0];
      return { category: 5, ranksDesc: top5, rankName: `Flush (${labelRankHigh(high)})` };
    }

    // Straight
    if (isStraight) {
      return { category: 4, ranksDesc: [straightHigh], rankName: `Straight (${labelRankHigh(straightHigh)})` };
    }

    // Trips
    if (counts[0] === 3) {
      const tripRank = topRank;
      const kickers = uniqueRanksDesc.filter((r) => r !== tripRank).slice(0, 2);
      return { category: 3, ranksDesc: [tripRank, ...kickers], rankName: `Three of a kind (${labelRankPlural(tripRank)})` };
    }

    // Two pair
    if (counts[0] === 2 && counts[1] === 2) {
      const pair1 = topRank;
      const pair2 = secondRank;
      const hiPair = Math.max(pair1, pair2);
      const loPair = Math.min(pair1, pair2);
      const kicker = uniqueRanksDesc.find((r) => r !== hiPair && r !== loPair) ?? hiPair;
      return {
        category: 2,
        ranksDesc: [hiPair, loPair, kicker],
        rankName: `Two pair (${labelRankPlural(hiPair)} and ${labelRankPlural(loPair)})`,
      };
    }

    // One pair
    if (counts[0] === 2) {
      const pairRank = topRank;
      const kickers = uniqueRanksDesc.filter((r) => r !== pairRank).slice(0, 3);
      return { category: 1, ranksDesc: [pairRank, ...kickers], rankName: `Pair of ${labelRankPlural(pairRank)}` };
    }

    // High card
    const top5 = uniqueRanksDesc.slice(0, 5);
    const high = top5[0];
    const highLabel = high === 14 ? "Ace" : high === 13 ? "King" : high === 12 ? "Queen" : high === 11 ? "Jack" : `${high}`;
    return { category: 0, ranksDesc: top5, rankName: `High card ${highLabel}` };
  }
}
