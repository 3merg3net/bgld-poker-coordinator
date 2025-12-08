// src/rooms/BlackjackRoomManager.ts

import WebSocket from "ws";
import type { ClientToServerMessage } from "../types/ClientToServer";
import type {
  ServerToClientMessage,
  BlackjackTableState,
  BlackjackSeatState,
  BlackjackHandState,
  BlackjackPhase,
} from "../types/ServerToClient";
import type { Card } from "../game/cards";
import { makeDeck, shuffle } from "../game/cards";

const MAX_SEATS = 7;
const START_BANKROLL = 10_000;
const MIN_BET = 50;
const MAX_BET = 5_000;

// ---------- helpers ----------

function handValue(cards: Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;

  for (const c of cards) {
    const rank = c[0]; // "A", "K", "Q", "J", "T", "9"...
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
  if (aces > 0 && total <= 21) {
    soft = true;
  }

  return { total, soft };
}

function isBlackjack(cards: Card[]): boolean {
  if (cards.length !== 2) return false;
  return handValue(cards).total === 21;
}

// ---------- types inside room ----------

type InternalHand = BlackjackHandState;

type InternalSeat = BlackjackSeatState;

type ClientInfo = {
  socket: WebSocket;
  name?: string;
};

// ---------- BlackjackRoomManager ----------

export class BlackjackRoomManager {
  readonly roomId: string;

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
  private static readonly BET_WINDOW_MS = 15000; // 15s window

  constructor(roomId: string) {
    this.roomId = roomId;
    for (let i = 0; i < MAX_SEATS; i++) {
      this.seats.push({
        seatIndex: i,
        playerId: null,
        bankroll: START_BANKROLL,
        hands: [],
      });
    }
    this.resetShoe();
    console.log(`[BlackjackRoomManager] Created room ${roomId}`);
  }

  // ---- shoe / dealing ----

  private resetShoe() {
    // 6-deck shoe
    let full: Card[] = [];
    for (let i = 0; i < 6; i++) {
      full = full.concat(makeDeck());
    }
    this.shoe = shuffle(full);
  }

  private drawCard(): Card {
    if (this.shoe.length < 30) {
      this.resetShoe();
    }
    const card = this.shoe.pop();
    if (!card) {
      this.resetShoe();
      return this.shoe.pop()!;
    }
    return card;
  }

  

  // ---- public API called from server.ts ----

  addClient(playerId: string, socket: WebSocket, name?: string) {
    this.clients.set(playerId, { socket, name });
    console.log(
      `[BlackjackRoomManager] Player ${playerId} connected to room ${this.roomId}`
    );
    // send initial snapshot
    this.broadcastState();
  }

  removeClient(playerId: string) {
    this.clients.delete(playerId);

    // free their seat(s)
    const seat = this.seats.find((s) => s.playerId === playerId);
    if (seat) {
      seat.playerId = null;
      seat.hands = [];
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
        // ignore unknown
        break;
    }
  }

  // ---- seat management ----

 // ---- seat management ----
private handleSeatMessage(msg: ClientToServerMessage) {
  const { playerId } = msg;
  const action = msg.action as "sit" | "leave" | undefined;
  const seatIndex = typeof msg.seatIndex === "number" ? msg.seatIndex : -1;
  const name = typeof msg.name === "string" ? msg.name : undefined;

  if (!action || seatIndex < 0 || seatIndex >= MAX_SEATS) return;

  const seat = this.seats[seatIndex];

  if (action === "sit") {
    // Block ONLY if another player already owns this seat
    if (seat.playerId && seat.playerId !== playerId) {
      this.sendError(playerId, "Seat already taken");
      return;
    }

    // Allow the same player to occupy multiple seats
    seat.playerId = playerId;
    if (name) seat.name = name;
    if (!seat.bankroll && seat.bankroll !== 0) {
      seat.bankroll = START_BANKROLL;
    }

    console.log(
      `[BlackjackRoomManager] Player ${playerId} sat in seat ${seatIndex}`
    );
  } else if (action === "leave") {
    if (seat.playerId === playerId) {
      seat.playerId = null;
      seat.hands = [];
      console.log(
        `[BlackjackRoomManager] Player ${playerId} left seat ${seatIndex}`
      );
    }
  }

  this.broadcastState();
}

  /**
   * If there are no active hands in progress, normalize the table
   * back into "waiting-bets" and clear dealer cards.
   * This prevents getting stuck in player-action with no players.
   */
  private ensureBettingPhase() {
    // Any hand that is mid-round?
    const anyActiveHand = this.seats.some((seat) =>
      seat.hands.some((h) =>
        h.bet > 0 &&
        h.cards.length > 0 &&
        h.result === "pending" &&
        !h.isBusted &&
        !h.isStanding
      )
    );

    if (!anyActiveHand) {
      // Table is effectively idle → reset into betting state
      this.phase = "waiting-bets";
      this.dealerCards = [];
      this.activeSeatIndex = null;
      this.activeHandIndex = null;
    }
  }



  // ---- betting + round lifecycle ----

      private handlePlaceBet(msg: ClientToServerMessage) {
    if (this.phase !== "waiting-bets" && this.phase !== "round-complete") {
      this.sendError(msg.playerId, "Cannot bet right now");
      return;
    }

    const seatIndex = typeof msg.seatIndex === "number" ? msg.seatIndex : -1;
    const amount = Number(msg.amount ?? 0);

    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return;
    if (!Number.isFinite(amount) || amount < MIN_BET || amount > MAX_BET) {
      this.sendError(msg.playerId, "Invalid bet amount");
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

    // 🔥 NEW LOGIC:
    // If this seat already has a pre-deal hand with a bet, ADD to that bet.
    // Otherwise, create a fresh hand.
    const existingHand = seat.hands.find(
      (h) => h.bet > 0 && h.cards.length === 0
    );

    if (existingHand) {
      // stack onto existing bet
      seat.bankroll -= amount;
      existingHand.bet += amount;
    } else {
      // fresh single hand with this bet
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

    // phase stays waiting-bets; dealing kicks in once at least one bet exists
    this.phase = "waiting-bets";
    this.maybeStartRound();
    this.broadcastState();
  }


private openBetWindow() {
  // clear any previous timer just in case
  if (this.betTimer) {
    clearTimeout(this.betTimer);
    this.betTimer = null;
  }

  this.phase = "waiting-bets";
  this.betDeadline = Date.now() + BlackjackRoomManager.BET_WINDOW_MS;

  // broadcast so clients can show countdown
  this.broadcastState();

  this.betTimer = setTimeout(() => {
    this.betTimer = null;
    const deadline = this.betDeadline;
    this.betDeadline = null;

    // Check if any seat actually has a bet
    const anyBet = this.seats.some((s) =>
      s.hands.some((h) => h.bet > 0)
    );

    if (!anyBet) {
      // No bets placed -> stay in waiting-bets, dealer has no cards
      this.phase = "waiting-bets";
      this.dealerCards = [];
      this.broadcastState();
      return;
    }

    // At least one bet -> deal round to ALL seats with bets
    this.startRound();
  }, BlackjackRoomManager.BET_WINDOW_MS);
}



  private maybeStartRound() {
    if (this.phase !== "waiting-bets") return;

    const anyBet = this.seats.some((s) =>
      s.hands.some((h) => h.bet > 0 && h.cards.length === 0)
    );
    if (!anyBet) return;

    this.startRound();
  }

    private startRound() {
    console.log("[BJ server] startRound called, round", this.roundId + 1);

    this.roundId += 1;
    this.phase = "dealing";
    this.dealerCards = [];

    // initial dealer cards: one up, one down
    this.dealerCards.push(this.drawCard()); // up
    this.dealerCards.push(this.drawCard()); // hole

    // deal two cards to each hand with a bet
    let handsDealt = 0;
    for (const seat of this.seats) {
      for (const hand of seat.hands) {
        if (hand.bet > 0) {
          hand.cards = [this.drawCard(), this.drawCard()];
          hand.isBusted = false;
          hand.isStanding = false;
          hand.isBlackjack = isBlackjack(hand.cards);
          hand.result = "pending";
          hand.payout = 0;
          handsDealt++;
        }
      }
    }

    console.log("[BJ server] startRound dealt hands:", handsDealt);

    // find first active hand
    this.phase = "player-action";
    this.setNextActiveHand();
    this.broadcastState();
  }


  private setNextActiveHand() {
    for (let si = 0; si < this.seats.length; si++) {
      const seat = this.seats[si];
      for (let hi = 0; hi < seat.hands.length; hi++) {
        const hand = seat.hands[hi];
        if (
          hand.bet > 0 &&
          !hand.isBusted &&
          !hand.isStanding &&
          hand.result === "pending"
        ) {
          this.activeSeatIndex = si;
          this.activeHandIndex = hi;
          return;
        }
      }
    }

    // no more player hands -> dealer turn
    this.activeSeatIndex = null;
    this.activeHandIndex = null;
    this.startDealerTurn();
  }

    private roundCompleteTimeout: NodeJS.Timeout | null = null;


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

    // If this is our demo-only reload action, handle it early and bail.
// (no need to look up a specific hand)
if (action === "reload-demo") {
  const TARGET_BANKROLL = 5000;

  if (seat.bankroll < TARGET_BANKROLL) {
    seat.bankroll = TARGET_BANKROLL;
  }

  this.broadcastState();
  return;
}

// For all *normal* actions we still require an active hand
const hand = seat.hands[this.activeHandIndex];
if (!hand) return;

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

    // one card only then stand
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
    if (seat.hands.length >= 2) return; // allow single split only

    const [c1, c2] = hand.cards;
    const rank1 = c1[0];
    const rank2 = c2[0];
    if (rank1 !== rank2) return;
    if (seat.bankroll < hand.bet) return;

    seat.bankroll -= hand.bet;

    // create second hand
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

    // mutate original
    hand.cards = [c1, this.drawCard()];
    hand.isBusted = false;
    hand.isStanding = false;
    hand.isBlackjack = false;
    hand.result = "pending";
    hand.payout = 0;

    seat.hands = [hand, newHand];

    // keep active hand on the first one after split
    this.activeHandIndex = 0;
  }

  // ---- dealer + settlement ----

  private startDealerTurn() {
    this.phase = "dealer-turn";

    // reveal hole card and play out dealer hand
    let { total, soft } = handValue(this.dealerCards);
    while (total < 17 || (total === 17 && soft === true)) {
      this.dealerCards.push(this.drawCard());
      const res = handValue(this.dealerCards);
      total = res.total;
      soft = res.soft;
    }

    this.settleHands();
    this.phase = "round-complete";
    this.broadcastState();
    this.scheduleAutoNextRound();
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
          payout = Math.floor(hand.bet * 3 / 2); // net 1.5x
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

        seat.bankroll += hand.bet + payout; // return stake + net win (or just stake if push)
      }
    }
  }

    private clearRoundCompleteTimeout() {
    if (this.roundCompleteTimeout) {
      clearTimeout(this.roundCompleteTimeout);
      this.roundCompleteTimeout = null;
    }
  }

  private scheduleAutoNextRound() {
    // Clear any existing timer first
    this.clearRoundCompleteTimeout();

    this.roundCompleteTimeout = setTimeout(() => {
      console.log(
        `[BlackjackRoomManager] Auto-prepare next round in room ${this.roomId}`
      );
      this.prepareNextRound();
    }, 15000); // 15 seconds – tweak to taste
  }


    private prepareNextRound() {
  this.phase = "waiting-bets";
  this.dealerCards = [];
  this.activeSeatIndex = null;
  this.activeHandIndex = null;

  // 👇 reset betting window
  if (this.betTimer) {
    clearTimeout(this.betTimer);
    this.betTimer = null;
  }
  this.betDeadline = null;

  for (const seat of this.seats) {
    seat.hands = [];
  }

  this.broadcastState();
}



  

  // ---- broadcast / views ----

  private buildView(): BlackjackTableState {
    const seats: BlackjackSeatState[] = this.seats.map((s) => ({
      seatIndex: s.seatIndex,
      playerId: s.playerId,
      name: s.name,
      bankroll: s.bankroll,
      hands: s.hands.map((h, idx) => ({
        ...h,
        handIndex: idx,
      })),
    }));

    const hideHoleCard = this.phase === "player-action" || this.phase === "dealing";

    const dealerViewCards = hideHoleCard
      ? this.dealerCards.map((c, i) => (i === 1 ? "XX" : c))
      : this.dealerCards;

    return {
  roundId: this.roundId,
  phase: this.phase,
  minBet: MIN_BET,
  maxBet: MAX_BET,
  activeSeatIndex: this.activeSeatIndex,
  activeHandIndex: this.activeHandIndex,
  dealer: {
    cards: dealerViewCards,
    hideHoleCard,
  },
  seats,
  betDeadlineMs: this.betDeadline, // 👈 expose deadline to clients
};

  }

      private broadcastState() {
    const table = this.buildView();

    const payload: ServerToClientMessage = {
      kind: "blackjack",
      roomId: this.roomId,
      playerId: "server",
      type: "table-state", // 👈 simpler & matches the hook
      table,
    };

    const encoded = JSON.stringify(payload);

    console.log(
      "[BlackjackRoomManager] broadcastState ->",
      this.roomId,
      "round",
      this.roundId,
      "phase",
      this.phase,
      "seats",
      table.seats.map((s) => ({
        seatIndex: s.seatIndex,
        playerId: s.playerId,
        bankroll: s.bankroll,
      }))
    );

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
