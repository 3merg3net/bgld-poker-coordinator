"use strict";
// src/rooms/BlackjackRoomManager.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BlackjackRoomManager = void 0;
const ws_1 = __importDefault(require("ws"));
const cards_1 = require("../game/cards");
const MAX_SEATS = 7;
const START_BANKROLL = 10000;
const MIN_BET = 50;
const MAX_BET = 5000;
// ---------- helpers ----------
function handValue(cards) {
    let total = 0;
    let aces = 0;
    for (const c of cards) {
        const rank = c[0]; // "A", "K", "Q", "J", "T", "9"...
        if (rank === "A") {
            aces += 1;
            total += 11;
        }
        else if ("KQJT".includes(rank)) {
            total += 10;
        }
        else {
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
function isBlackjack(cards) {
    if (cards.length !== 2)
        return false;
    return handValue(cards).total === 21;
}
// ---------- BlackjackRoomManager ----------
class BlackjackRoomManager {
    constructor(roomId) {
        this.clients = new Map();
        this.seats = [];
        this.dealerCards = [];
        this.shoe = [];
        this.phase = "waiting-bets";
        this.roundId = 1;
        this.activeSeatIndex = null;
        this.activeHandIndex = null;
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
    resetShoe() {
        // 6-deck shoe
        let full = [];
        for (let i = 0; i < 6; i++) {
            full = full.concat((0, cards_1.makeDeck)());
        }
        this.shoe = (0, cards_1.shuffle)(full);
    }
    drawCard() {
        if (this.shoe.length < 30) {
            this.resetShoe();
        }
        const card = this.shoe.pop();
        if (!card) {
            this.resetShoe();
            return this.shoe.pop();
        }
        return card;
    }
    // ---- public API called from server.ts ----
    addClient(playerId, socket, name) {
        this.clients.set(playerId, { socket, name });
        console.log(`[BlackjackRoomManager] Player ${playerId} connected to room ${this.roomId}`);
        // send initial snapshot
        this.broadcastState();
    }
    removeClient(playerId) {
        this.clients.delete(playerId);
        // free their seat(s)
        const seat = this.seats.find((s) => s.playerId === playerId);
        if (seat) {
            seat.playerId = null;
            seat.hands = [];
        }
        console.log(`[BlackjackRoomManager] Player ${playerId} disconnected from room ${this.roomId}`);
        this.broadcastState();
    }
    handleMessage(msg) {
        if (msg.kind !== "blackjack")
            return;
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
    handleSeatMessage(msg) {
        const { playerId } = msg;
        const action = msg.action;
        const seatIndex = typeof msg.seatIndex === "number" ? msg.seatIndex : -1;
        const name = typeof msg.name === "string" ? msg.name : undefined;
        if (!action || seatIndex < 0 || seatIndex >= MAX_SEATS)
            return;
        const seat = this.seats[seatIndex];
        if (action === "sit") {
            if (seat.playerId && seat.playerId !== playerId) {
                this.sendError(playerId, "Seat already taken");
                return;
            }
            seat.playerId = playerId;
            if (name)
                seat.name = name;
            if (!seat.bankroll)
                seat.bankroll = START_BANKROLL;
            console.log(`[BlackjackRoomManager] Player ${playerId} sat in seat ${seatIndex}`);
        }
        else if (action === "leave") {
            if (seat.playerId === playerId) {
                seat.playerId = null;
                seat.hands = [];
                console.log(`[BlackjackRoomManager] Player ${playerId} left seat ${seatIndex}`);
            }
        }
        this.broadcastState();
    }
    // ---- betting + round lifecycle ----
    handlePlaceBet(msg) {
        var _a;
        if (this.phase !== "waiting-bets" && this.phase !== "round-complete") {
            this.sendError(msg.playerId, "Cannot bet right now");
            return;
        }
        const seatIndex = typeof msg.seatIndex === "number" ? msg.seatIndex : -1;
        const amount = Number((_a = msg.amount) !== null && _a !== void 0 ? _a : 0);
        if (seatIndex < 0 || seatIndex >= MAX_SEATS)
            return;
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
        // consume bankroll and create fresh single hand with bet
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
        this.phase = "waiting-bets";
        // auto-start round once at least one player has a bet
        this.maybeStartRound();
        this.broadcastState();
    }
    maybeStartRound() {
        if (this.phase !== "waiting-bets")
            return;
        const anyBet = this.seats.some((s) => s.hands.some((h) => h.bet > 0 && h.cards.length === 0));
        if (!anyBet)
            return;
        this.startRound();
    }
    startRound() {
        this.roundId += 1;
        this.phase = "dealing";
        this.dealerCards = [];
        // initial dealer cards: one up, one down
        this.dealerCards.push(this.drawCard()); // up
        this.dealerCards.push(this.drawCard()); // hole
        // deal two cards to each hand with a bet
        for (const seat of this.seats) {
            for (const hand of seat.hands) {
                if (hand.bet > 0) {
                    hand.cards = [this.drawCard(), this.drawCard()];
                    hand.isBusted = false;
                    hand.isStanding = false;
                    hand.isBlackjack = isBlackjack(hand.cards);
                    hand.result = "pending";
                    hand.payout = 0;
                }
            }
        }
        // find first active hand
        this.phase = "player-action";
        this.setNextActiveHand();
        this.broadcastState();
    }
    setNextActiveHand() {
        for (let si = 0; si < this.seats.length; si++) {
            const seat = this.seats[si];
            for (let hi = 0; hi < seat.hands.length; hi++) {
                const hand = seat.hands[hi];
                if (hand.bet > 0 &&
                    !hand.isBusted &&
                    !hand.isStanding &&
                    hand.result === "pending") {
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
    // ---- player actions ----
    handleAction(msg) {
        const action = msg.action;
        if (!action)
            return;
        if (action === "next-round") {
            if (this.phase !== "round-complete")
                return;
            this.prepareNextRound();
            return;
        }
        if (this.phase !== "player-action") {
            this.sendError(msg.playerId, "Not your turn");
            return;
        }
        const seatIndex = typeof msg.seatIndex === "number" ? msg.seatIndex : -1;
        if (seatIndex < 0 || seatIndex >= MAX_SEATS)
            return;
        const seat = this.seats[seatIndex];
        if (seat.playerId !== msg.playerId) {
            this.sendError(msg.playerId, "Not your seat");
            return;
        }
        if (this.activeSeatIndex !== seatIndex ||
            this.activeHandIndex === null ||
            this.activeHandIndex < 0) {
            this.sendError(msg.playerId, "Not your turn");
            return;
        }
        const hand = seat.hands[this.activeHandIndex];
        if (!hand)
            return;
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
    handleHit(hand) {
        hand.cards.push(this.drawCard());
        const { total } = handValue(hand.cards);
        if (total > 21) {
            hand.isBusted = true;
            hand.result = "lose";
        }
        this.setNextActiveHand();
    }
    handleStand(hand) {
        hand.isStanding = true;
        this.setNextActiveHand();
    }
    handleDouble(seat, hand) {
        if (hand.cards.length !== 2)
            return;
        if (seat.bankroll < hand.bet)
            return;
        seat.bankroll -= hand.bet;
        hand.bet *= 2;
        // one card only then stand
        hand.cards.push(this.drawCard());
        const { total } = handValue(hand.cards);
        if (total > 21) {
            hand.isBusted = true;
            hand.result = "lose";
        }
        else {
            hand.isStanding = true;
        }
        this.setNextActiveHand();
    }
    handleSplit(seat, hand) {
        if (hand.cards.length !== 2)
            return;
        if (seat.hands.length >= 2)
            return; // allow single split only
        const [c1, c2] = hand.cards;
        const rank1 = c1[0];
        const rank2 = c2[0];
        if (rank1 !== rank2)
            return;
        if (seat.bankroll < hand.bet)
            return;
        seat.bankroll -= hand.bet;
        // create second hand
        const newHand = {
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
    startDealerTurn() {
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
    }
    settleHands() {
        const dealerVal = handValue(this.dealerCards);
        const dealerTotal = dealerVal.total;
        const dealerBust = dealerTotal > 21;
        const dealerBJ = isBlackjack(this.dealerCards);
        for (const seat of this.seats) {
            for (const hand of seat.hands) {
                if (hand.bet <= 0)
                    continue;
                const hv = handValue(hand.cards);
                const total = hv.total;
                const bust = total > 21;
                const bj = isBlackjack(hand.cards);
                let payout = 0;
                let result = "pending";
                if (bust) {
                    result = "lose";
                    payout = -hand.bet;
                }
                else if (bj && !dealerBJ) {
                    result = "blackjack";
                    payout = Math.floor(hand.bet * 3 / 2); // net 1.5x
                }
                else if (dealerBust) {
                    result = "win";
                    payout = hand.bet;
                }
                else if (dealerBJ && !bj) {
                    result = "lose";
                    payout = -hand.bet;
                }
                else if (total > dealerTotal) {
                    result = "win";
                    payout = hand.bet;
                }
                else if (total < dealerTotal) {
                    result = "lose";
                    payout = -hand.bet;
                }
                else {
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
    prepareNextRound() {
        this.phase = "waiting-bets";
        this.dealerCards = [];
        this.activeSeatIndex = null;
        this.activeHandIndex = null;
        for (const seat of this.seats) {
            seat.hands = [];
        }
        this.broadcastState();
    }
    // ---- broadcast / views ----
    buildView() {
        const seats = this.seats.map((s) => ({
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
        };
    }
    broadcastState() {
        const table = this.buildView();
        const payload = {
            kind: "blackjack",
            roomId: this.roomId,
            playerId: "server",
            type: "blackjack-state",
            table,
        };
        const encoded = JSON.stringify(payload);
        for (const { socket } of this.clients.values()) {
            if (socket.readyState === ws_1.default.OPEN) {
                socket.send(encoded);
            }
        }
    }
    sendError(playerId, message) {
        const client = this.clients.get(playerId);
        if (!client)
            return;
        const payload = {
            kind: "blackjack",
            roomId: this.roomId,
            playerId,
            type: "error",
            message,
        };
        if (client.socket.readyState === ws_1.default.OPEN) {
            client.socket.send(JSON.stringify(payload));
        }
    }
}
exports.BlackjackRoomManager = BlackjackRoomManager;
