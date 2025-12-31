// src/rooms/BlackjackRoomManager.ts
import WebSocket from "ws";
import type { ClientToServerMessage } from "../types/ClientToServer";
import type {
  ServerToClientMessage,
  BlackjackTableState,
  BlackjackSeatState,
  BlackjackHandState,
  BlackjackHandResult,
  BlackjackPhase,
} from "../types/ServerToClient";
import type { Card } from "../game/cards";
import { makeDeck, shuffle } from "../game/cards";

const MAX_SEATS = 7;
const START_BANKROLL = 10_000;

// Defaults if roomId does not encode a tier
const DEFAULT_MIN_BET = 50;
const DEFAULT_MAX_BET = 5_000;

function parseTierFromRoomId(roomId: string): { minBet: number; maxBet: number } {
  const id = String(roomId || "").toLowerCase();
  const m = id.match(/^bj-(\d+)-(\d+)-[a-z0-9]+$/i);
  if (!m) return { minBet: DEFAULT_MIN_BET, maxBet: DEFAULT_MAX_BET };

  const minBet = Number(m[1]);
  const maxBet = Number(m[2]);

  if (!Number.isFinite(minBet) || !Number.isFinite(maxBet)) {
    return { minBet: DEFAULT_MIN_BET, maxBet: DEFAULT_MAX_BET };
  }

  if (minBet < 1) return { minBet: DEFAULT_MIN_BET, maxBet: DEFAULT_MAX_BET };
  if (maxBet < minBet) return { minBet: DEFAULT_MIN_BET, maxBet: DEFAULT_MAX_BET };
  if (maxBet > 1_000_000) return { minBet: DEFAULT_MIN_BET, maxBet: DEFAULT_MAX_BET };

  return { minBet, maxBet };
}

function handValue(cards: Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;

  for (const c of cards) {
    const rank = c[0];
    if (rank === "A") {
      aces += 1;
      total += 11;
    } else if ("KQJT".includes(rank)) {
      total += 10;
    } else {
      total += Number(rank);
    }
  }

  let soft = false;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  if (aces > 0 && total <= 21) soft = true;

  return { total, soft };
}

function isBlackjack(cards: Card[]): boolean {
  if (cards.length !== 2) return false;
  return handValue(cards).total === 21;
}

function normalizeResult(r: any): BlackjackHandResult {
  const s = String(r ?? "").toLowerCase();
  if (!s || s.includes("pending")) return "pending";
  if (s.includes("push") || s.includes("tie")) return "push";
  if (s.includes("blackjack") || s === "bj") return "blackjack";
  if (s === "win" || s.includes("won")) return "win";
  if (s === "lose" || s.includes("lost")) return "lose";
  return "pending";
}

type InternalHand = BlackjackHandState;
type InternalSeat = BlackjackSeatState;

type ClientInfo = {
  socket: WebSocket;
  name?: string;
};

export class BlackjackRoomManager {
  readonly roomId: string;
  readonly minBet: number;
  readonly maxBet: number;

  private clients = new Map<string, ClientInfo>();
  private seats: InternalSeat[] = [];
  private dealerCards: Card[] = [];
  private shoe: Card[] = [];
  private phase: BlackjackPhase = "waiting-bets";
  private roundId = 1;
  private activeSeatIndex: number | null = null;
  private activeHandIndex: number | null = null;

  private betDeadline: number | null = null;
  private betTimer: NodeJS.Timeout | null = null;
  private roundCompleteTimeout: NodeJS.Timeout | null = null;

  // ✅ server-side action timer (prevents client-timeout bugs)
  private actionDeadline: number | null = null;
  private actionTimer: NodeJS.Timeout | null = null;
  private actionKey: string | null = null;
  private static readonly ACTION_WINDOW_MS = 20_000;

  // Dealer suspense
  private dealerHoleRevealed = false;
  private dealerStepTimeout: NodeJS.Timeout | null = null;

  private static readonly DEALER_REVEAL_DELAY_MS = 700;
  private static readonly DEALER_HIT_DELAY_MS = 850;

  private static readonly BET_WINDOW_MS = 10_000;

  constructor(roomId: string) {
    this.roomId = roomId;

    const tier = parseTierFromRoomId(roomId);
    this.minBet = tier.minBet;
    this.maxBet = tier.maxBet;

    for (let i = 0; i < MAX_SEATS; i++) {
      this.seats.push({
        seatIndex: i,
        playerId: null,
        bankroll: START_BANKROLL,
        hands: [],
      });
    }

    this.resetShoe();
    console.log(
      `[BlackjackRoomManager] Created room ${roomId} (min=${this.minBet}, max=${this.maxBet})`
    );
  }

  // ✅ lobby snapshot
  getSnapshot() {
    return {
      roomId: this.roomId,
      onlineCount: this.clients.size,
      seatedCount: this.seats.filter((s) => !!s.playerId).length,
      minBet: this.minBet,
      maxBet: this.maxBet,
    };
  }

  public getCounts() {
    return {
      onlineCount: this.clients.size,
      seatedCount: this.seats.filter((s) => !!s.playerId).length,
    };
  }

  // ✅ admin delete / prune support
  shutdown(reason = "Room closed") {
    const payload = JSON.stringify({
      kind: "blackjack",
      roomId: this.roomId,
      playerId: "server",
      type: "error",
      message: reason,
    } satisfies ServerToClientMessage as any);

    for (const { socket } of this.clients.values()) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payload);
          socket.close();
        }
      } catch {}
    }

    this.clients.clear();
    this.clearDealerStepTimeout();
    this.clearRoundCompleteTimeout();
    this.clearBetTimer();
    this.clearActionTimer();
    this.betDeadline = null;
  }

  // ---- shoe / dealing ----

  private resetShoe() {
    let full: Card[] = [];
    for (let i = 0; i < 6; i++) full = full.concat(makeDeck());
    this.shoe = shuffle(full);
  }

  private drawCard(): Card {
    if (this.shoe.length < 30) this.resetShoe();
    const card = this.shoe.pop();
    if (!card) {
      this.resetShoe();
      return this.shoe.pop()!;
    }
    return card;
  }

  // ---- timers (safe clears) ----

  private clearBetTimer() {
    if (this.betTimer) {
      clearTimeout(this.betTimer);
      this.betTimer = null;
    }
  }

  private clearDealerStepTimeout() {
    if (this.dealerStepTimeout) {
      clearTimeout(this.dealerStepTimeout);
      this.dealerStepTimeout = null;
    }
  }

  private clearRoundCompleteTimeout() {
    if (this.roundCompleteTimeout) {
      clearTimeout(this.roundCompleteTimeout);
      this.roundCompleteTimeout = null;
    }
  }

  private clearActionTimer() {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    this.actionDeadline = null;
    this.actionKey = null;
  }

  /**
   * ✅ Arm a turn timer ONLY for the active hand.
   * On timeout, we auto-stand ONLY that hand, then advance.
   */
  private armActionTimer() {
    if (this.phase !== "player-action") {
      this.clearActionTimer();
      return;
    }
    if (this.activeSeatIndex === null || this.activeHandIndex === null) {
      this.clearActionTimer();
      return;
    }

    this.clearActionTimer();

    const key = `${this.roundId}:${this.activeSeatIndex}:${this.activeHandIndex}`;
    this.actionKey = key;
    this.actionDeadline = Date.now() + BlackjackRoomManager.ACTION_WINDOW_MS;

    this.actionTimer = setTimeout(() => {
      // stale timer guard
      if (this.phase !== "player-action") return;
      if (this.actionKey !== key) return;
      if (this.activeSeatIndex === null || this.activeHandIndex === null) return;

      const seat = this.seats[this.activeSeatIndex];
      const hand = seat?.hands?.[this.activeHandIndex];

      // if seat/hand is missing or already resolved, just advance
      if (!seat || !hand) {
        this.setNextActiveHand();
        this.broadcastState();
        return;
      }

      // ✅ Auto-stand ONLY this hand (never everyone)
      if (
        hand.bet > 0 &&
        normalizeResult(hand.result) === "pending" &&
        !hand.isBusted &&
        !hand.isStanding
      ) {
        hand.isStanding = true;
      }

      this.setNextActiveHand();
      this.broadcastState();
    }, BlackjackRoomManager.ACTION_WINDOW_MS);
  }

  // ✅ Safety: after weird events (disconnect/leave), ensure active pointers are valid
  private advanceGameIfNeeded() {
    if (this.phase !== "player-action") return;

    if (this.activeSeatIndex === null || this.activeHandIndex === null) {
      this.setNextActiveHand();
      return;
    }

    const seat = this.seats[this.activeSeatIndex];
    const hand = seat?.hands?.[this.activeHandIndex];

    const invalid =
      !seat ||
      !hand ||
      hand.bet <= 0 ||
      normalizeResult(hand.result) !== "pending" ||
      hand.isBusted ||
      hand.isStanding;

    if (invalid) {
      this.setNextActiveHand();
    }
  }

  // ---- public API called from server.ts ----

  addClient(playerId: string, socket: WebSocket, name?: string) {
    // If same player reconnects, replace socket
    this.clients.set(playerId, { socket, name });
    console.log(
      `[BlackjackRoomManager] Player ${playerId} connected to room ${this.roomId}`
    );
    this.broadcastState();
  }

  removeClient(playerId: string) {
    this.clients.delete(playerId);

    const seatIndex = this.seats.findIndex((s) => s.playerId === playerId);
    const seat = seatIndex >= 0 ? this.seats[seatIndex] : null;

    if (seat) {
      // ✅ Mid-round disconnect: DO NOT clear hands; auto-stand pending hands and keep flow.
      if (this.phase !== "waiting-bets") {
        seat.playerId = null;

        for (const h of seat.hands) {
          if (
            h.bet > 0 &&
            normalizeResult(h.result) === "pending" &&
            !h.isBusted &&
            !h.isStanding
          ) {
            h.isStanding = true;
          }
        }

        // If it was their turn, advance immediately
        if (this.phase === "player-action" && this.activeSeatIndex === seatIndex) {
          this.clearActionTimer();
          this.setNextActiveHand();
        }
      } else {
        // waiting-bets: safe to clear
        seat.playerId = null;
        seat.hands = [];
      }
    }

    console.log(
      `[BlackjackRoomManager] Player ${playerId} disconnected from room ${this.roomId}`
    );
    this.broadcastState();
  }

  handleMessage(msg: ClientToServerMessage) {
    if (msg.kind !== "blackjack") return;

    switch (msg.type) {
      case "bj-seat":
        this.handleSeatMessage(msg);
        break;
      case "bj-place-bet":
        this.handlePlaceBet(msg);
        break;
      case "bj-action":
        this.handleAction(msg);
        break;
      default:
        break;
    }
  }

  // ---- seat management ----

  private handleSeatMessage(msg: ClientToServerMessage) {
    const { playerId } = msg;
    const action = msg.action as "sit" | "leave" | undefined;
    const seatIndex = typeof msg.seatIndex === "number" ? msg.seatIndex : -1;
    const name = typeof msg.name === "string" ? msg.name : undefined;

    if (!action || seatIndex < 0 || seatIndex >= MAX_SEATS) return;

    const seat = this.seats[seatIndex];

    if (action === "sit") {
      if (seat.playerId && seat.playerId !== playerId) {
        this.sendError(playerId, "Seat already taken");
        return;
      }

      // Don’t allow taking a different seat while already seated elsewhere
      const otherSeat = this.seats.find((s) => s.playerId === playerId);
      if (otherSeat && otherSeat.seatIndex !== seatIndex) {
        this.sendError(playerId, "You are already seated");
        return;
      }

      seat.playerId = playerId;
      if (name) seat.name = name;
      if (seat.bankroll === undefined || seat.bankroll === null) {
        seat.bankroll = START_BANKROLL;
      }
    } else if (action === "leave") {
      if (seat.playerId === playerId) {
        // ✅ leaving mid-round: auto-stand pending hands so game flow never freezes
        for (const h of seat.hands) {
          if (
            h.bet > 0 &&
            normalizeResult(h.result) === "pending" &&
            !h.isBusted &&
            !h.isStanding
          ) {
            h.isStanding = true;
          }
        }

        seat.playerId = null;

        // If it was their active turn, advance safely
        if (this.phase === "player-action") {
          this.advanceGameIfNeeded();
        }
      }
    }

    this.broadcastState();
  }

  // ---- betting + round lifecycle ----

  private openBetWindow() {
    this.clearBetTimer();

    this.phase = "waiting-bets";
    this.betDeadline = Date.now() + BlackjackRoomManager.BET_WINDOW_MS;

    this.betTimer = setTimeout(() => {
      this.betTimer = null;
      this.betDeadline = null;

      const anyBet = this.seats.some((s) => s.hands.some((h) => h.bet > 0));

      if (!anyBet) {
        this.phase = "waiting-bets";
        this.dealerCards = [];
        this.activeSeatIndex = null;
        this.activeHandIndex = null;
        this.clearActionTimer();
        this.broadcastState();
        return;
      }

      this.startRound();
    }, BlackjackRoomManager.BET_WINDOW_MS);
  }

  private handlePlaceBet(msg: ClientToServerMessage) {
    if (this.phase === "round-complete") {
      // allow “bet next hand” to immediately reopen betting
      this.clearRoundCompleteTimeout();
      this.phase = "waiting-bets";
      this.dealerCards = [];
      this.activeSeatIndex = null;
      this.activeHandIndex = null;
      this.clearDealerStepTimeout();
      this.clearActionTimer();
      for (const seat of this.seats) seat.hands = [];
    } else if (this.phase !== "waiting-bets") {
      this.sendError(msg.playerId, "Cannot bet right now");
      return;
    }

    const seatIndex = typeof msg.seatIndex === "number" ? msg.seatIndex : -1;
    const amount = Number(msg.amount ?? 0);
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return;

    if (!Number.isFinite(amount) || amount < this.minBet || amount > this.maxBet) {
      this.sendError(
        msg.playerId,
        `Invalid bet amount (min ${this.minBet}, max ${this.maxBet})`
      );
      return;
    }

    const seat = this.seats[seatIndex];
    if (seat.playerId !== msg.playerId) {
      this.sendError(msg.playerId, "You are not sitting at this seat");
      return;
    }

    if (seat.bankroll < amount) {
      this.sendError(msg.playerId, "Not enough bankroll");
      return;
    }

    // Only allow a pre-deal bet “stub” in waiting-bets
    const existingHand = seat.hands.find((h) => h.bet > 0 && h.cards.length === 0);
    if (existingHand) {
      seat.bankroll -= amount;
      existingHand.bet += amount;
    } else {
      seat.bankroll -= amount;
      seat.hands = [
        {
          handIndex: 0,
          cards: [],
          bet: amount,
          isBusted: false,
          isStanding: false,
          isBlackjack: false,
          result: "pending",
          payout: 0,
        },
      ];
    }

    if (!this.betDeadline) {
      this.openBetWindow();
    }

    this.broadcastState();
  }

  private startRound() {
    this.roundId += 1;

    this.phase = "dealing";
    this.clearDealerStepTimeout();
    this.clearRoundCompleteTimeout();
    this.clearActionTimer();
    this.dealerHoleRevealed = false;

    this.dealerCards = [];
    this.dealerCards.push(this.drawCard()); // up
    this.dealerCards.push(this.drawCard()); // hole

    for (const seat of this.seats) {
      for (const hand of seat.hands) {
        if (hand.bet > 0) {
          hand.cards = [this.drawCard(), this.drawCard()];
          hand.isBusted = false;
          hand.isBlackjack = isBlackjack(hand.cards);
          hand.payout = 0;

          if (hand.isBlackjack) {
            hand.result = "blackjack";
            hand.isStanding = true;
          } else {
            hand.result = "pending";
            hand.isStanding = false;
          }
        }
      }
    }

    this.betDeadline = null;

    this.phase = "player-action";

    // start from the first eligible hand
    this.activeSeatIndex = null;
    this.activeHandIndex = null;
    this.setNextActiveHand();

    this.broadcastState();
  }

  /**
   * ✅ Select next hand that still needs action.
   * Arms timer for that hand only.
   */
  private setNextActiveHand() {
    // clear existing timer whenever we are re-evaluating turns
    this.clearActionTimer();

    for (let si = 0; si < this.seats.length; si++) {
      const seat = this.seats[si];
      for (let hi = 0; hi < seat.hands.length; hi++) {
        const hand = seat.hands[hi];
        if (
          hand.bet > 0 &&
          normalizeResult(hand.result) === "pending" &&
          !hand.isBusted &&
          !hand.isStanding
        ) {
          this.activeSeatIndex = si;
          this.activeHandIndex = hi;

          // ✅ start a fresh timer ONLY for the active seat/hand
          this.armActionTimer();
          return;
        }
      }
    }

    // no more player actions
    this.activeSeatIndex = null;
    this.activeHandIndex = null;
    this.clearActionTimer();
    this.startDealerTurn();
  }

  // ---- player actions ----

  private handleAction(msg: ClientToServerMessage) {
    const action = msg.action as
      | "hit"
      | "stand"
      | "double"
      | "split"
      | "next-round"
      | "reload-demo"
      | undefined;

    if (!action) return;

    if (action === "next-round") {
      if (this.phase !== "round-complete") return;
      this.clearRoundCompleteTimeout();
      this.prepareNextRound();
      this.clearDealerStepTimeout();
      this.clearActionTimer();
      return;
    }

    if (this.phase !== "player-action") {
      this.sendError(msg.playerId, "Not your turn");
      return;
    }

    const seatIndex = typeof msg.seatIndex === "number" ? msg.seatIndex : -1;
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return;

    const seat = this.seats[seatIndex];
    if (seat.playerId !== msg.playerId) {
      this.sendError(msg.playerId, "Not your seat");
      return;
    }

    if (
      this.activeSeatIndex !== seatIndex ||
      this.activeHandIndex === null ||
      this.activeHandIndex < 0
    ) {
      this.sendError(msg.playerId, "Not your turn");
      return;
    }

    if (action === "reload-demo") {
      const TARGET_BANKROLL = 5000;
      if (seat.bankroll < TARGET_BANKROLL) seat.bankroll = TARGET_BANKROLL;
      this.broadcastState();
      return;
    }

    const hand = seat.hands[this.activeHandIndex];
    if (!hand) return;

    // ✅ consume turn timer on any valid action attempt
    this.clearActionTimer();

    switch (action) {
      case "hit":
        this.handleHit(hand);
        break;
      case "stand":
        this.handleStand(hand);
        break;
      case "double":
        this.handleDouble(seat, hand);
        break;
      case "split":
        this.handleSplit(seat, hand);
        break;
      default:
        break;
    }

    this.broadcastState();
  }

  private handleHit(hand: InternalHand) {
    hand.cards.push(this.drawCard());
    const { total } = handValue(hand.cards);
    if (total > 21) {
      hand.isBusted = true;
      hand.result = "lose";
    }
    this.setNextActiveHand();
  }

  private handleStand(hand: InternalHand) {
    hand.isStanding = true;
    this.setNextActiveHand();
  }

  private handleDouble(seat: InternalSeat, hand: InternalHand) {
    if (hand.cards.length !== 2) return;
    if (seat.bankroll < hand.bet) return;

    seat.bankroll -= hand.bet;
    hand.bet *= 2;

    hand.cards.push(this.drawCard());
    const { total } = handValue(hand.cards);
    if (total > 21) {
      hand.isBusted = true;
      hand.result = "lose";
    } else {
      hand.isStanding = true;
    }
    this.setNextActiveHand();
  }

  private handleSplit(seat: InternalSeat, hand: InternalHand) {
    if (hand.cards.length !== 2) return;
    if (seat.hands.length >= 2) return;

    const [c1, c2] = hand.cards;
    if (c1[0] !== c2[0]) return;
    if (seat.bankroll < hand.bet) return;

    seat.bankroll -= hand.bet;

    const newHand: InternalHand = {
      handIndex: 1,
      cards: [c2, this.drawCard()],
      bet: hand.bet,
      isBusted: false,
      isStanding: false,
      isBlackjack: false,
      result: "pending",
      payout: 0,
    };

    hand.cards = [c1, this.drawCard()];
    hand.isBusted = false;
    hand.isStanding = false;
    hand.isBlackjack = false;
    hand.result = "pending";
    hand.payout = 0;

    seat.hands = [hand, newHand];

    // After split, player should act on hand 0 first
    this.activeHandIndex = 0;
    this.activeSeatIndex = seat.seatIndex;

    // ✅ re-arm timer for this new “same-seat” turn
    this.armActionTimer();
  }

  // ---- dealer + settlement ----

  private startDealerTurn() {
    this.phase = "dealer-turn";
    this.clearActionTimer(); // ✅ stop player timer
    this.clearDealerStepTimeout();
    this.dealerHoleRevealed = false;

    this.broadcastState();

    this.dealerStepTimeout = setTimeout(() => {
      this.dealerHoleRevealed = true;
      this.broadcastState();
      this.stepDealerDraw();
    }, BlackjackRoomManager.DEALER_REVEAL_DELAY_MS);
  }

  private stepDealerDraw() {
    if (this.phase !== "dealer-turn") return;

    if (!this.dealerHoleRevealed) {
      this.dealerHoleRevealed = true;
      this.broadcastState();
    }

    const { total, soft } = handValue(this.dealerCards);

    const shouldHit = total < 17 || (total === 17 && soft === true); // H17
    if (!shouldHit) {
      this.settleHands();
      this.phase = "round-complete";
      this.broadcastState();
      this.scheduleAutoNextRound();
      return;
    }

    this.dealerCards.push(this.drawCard());
    this.broadcastState();

    this.dealerStepTimeout = setTimeout(() => {
      this.stepDealerDraw();
    }, BlackjackRoomManager.DEALER_HIT_DELAY_MS);
  }

  private settleHands() {
    const dealerVal = handValue(this.dealerCards);
    const dealerTotal = dealerVal.total;
    const dealerBust = dealerTotal > 21;
    const dealerBJ = isBlackjack(this.dealerCards);

    for (const seat of this.seats) {
      for (const hand of seat.hands) {
        if (hand.bet <= 0) continue;

        const hv = handValue(hand.cards);
        const total = hv.total;
        const bust = total > 21;
        const bj = isBlackjack(hand.cards);

        let payout = 0;
        let result: BlackjackHandState["result"] = "pending";

        if (bust) {
          result = "lose";
          payout = -hand.bet;
        } else if (bj && !dealerBJ) {
          result = "blackjack";
          payout = Math.floor((hand.bet * 3) / 2);
        } else if (dealerBust) {
          result = "win";
          payout = hand.bet;
        } else if (dealerBJ && !bj) {
          result = "lose";
          payout = -hand.bet;
        } else if (total > dealerTotal) {
          result = "win";
          payout = hand.bet;
        } else if (total < dealerTotal) {
          result = "lose";
          payout = -hand.bet;
        } else {
          result = "push";
          payout = 0;
        }

        hand.result = result;
        hand.payout = payout;
        hand.isBlackjack = bj;
        hand.isBusted = bust;

        // bankroll settles back locally (your real GLD settlement is handled by client)
        seat.bankroll += hand.bet + payout;
      }
    }
  }

  private scheduleAutoNextRound() {
    this.clearRoundCompleteTimeout();
    this.roundCompleteTimeout = setTimeout(() => {
      this.prepareNextRound();
    }, 4500);
  }

  private prepareNextRound() {
    this.phase = "waiting-bets";
    this.dealerCards = [];
    this.activeSeatIndex = null;
    this.activeHandIndex = null;

    this.clearDealerStepTimeout();
    this.clearActionTimer();
    this.dealerHoleRevealed = false;

    this.clearBetTimer();
    this.betDeadline = null;

    for (const seat of this.seats) seat.hands = [];

    this.broadcastState();
  }

  // ---- broadcast / views ----

  private buildView(): BlackjackTableState {
    const seats: BlackjackSeatState[] = this.seats.map((s) => ({
      seatIndex: s.seatIndex,
      playerId: s.playerId,
      name: s.name,
      bankroll: s.bankroll,
      hands: s.hands.map((h, idx) => ({ ...h, handIndex: idx })),
    }));

    const hideHoleCard =
      this.phase === "player-action" ||
      this.phase === "dealing" ||
      (this.phase === "dealer-turn" && !this.dealerHoleRevealed);

    const dealerViewCards = hideHoleCard
      ? this.dealerCards.map((c, i) => (i === 1 ? "XX" : c))
      : this.dealerCards;

    return {
      roundId: this.roundId,
      phase: this.phase,
      minBet: this.minBet,
      maxBet: this.maxBet,
      activeSeatIndex: this.activeSeatIndex,
      activeHandIndex: this.activeHandIndex,
      dealer: {
        cards: dealerViewCards,
        hideHoleCard,
      },
      seats,
      betDeadlineMs: this.betDeadline,
    };
  }

  private broadcastState() {
    const table = this.buildView();

    const payload: ServerToClientMessage = {
      kind: "blackjack",
      roomId: this.roomId,
      playerId: "server",
      type: "table-state",
      table,
    };

    const encoded = JSON.stringify(payload);

    for (const { socket } of this.clients.values()) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encoded);
      }
    }
  }

  private sendError(playerId: string, message: string) {
    const client = this.clients.get(playerId);
    if (!client) return;

    const payload: ServerToClientMessage = {
      kind: "blackjack",
      roomId: this.roomId,
      playerId,
      type: "error",
      message,
    };

    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(JSON.stringify(payload));
    }
  }
}
