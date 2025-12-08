"use strict";
// src/game/HoldemGame.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.HoldemGame = void 0;
// -------------------
// Helper: Deck + cards
// -------------------
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["s", "h", "d", "c"];
function buildDeck() {
    const deck = [];
    for (const r of RANKS) {
        for (const s of SUITS) {
            deck.push(`${r}${s}`);
        }
    }
    return deck;
}
function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
function rankValue(rank) {
    const idx = RANKS.indexOf(rank);
    return idx >= 0 ? idx + 2 : 0; // 2..14
}
// -------------------
// HoldemGame Engine
// -------------------
class HoldemGame {
    constructor() {
        this.handCounter = 1;
        this.lastTable = null;
        this.betting = null;
        this.showdown = null;
        this.deck = [];
        this.seatsSnapshot = [];
        this.buttonSeatIndex = null;
    }
    // PUBLIC API used by PokerRoomManager
    // -----------------------------------
    getHoleCardsForPlayer(playerId) {
        return null;
    }
    getLastState() {
        return this.lastTable;
    }
    getBettingState() {
        return this.betting;
    }
    getSeatStacks() {
        if (!this.seatsSnapshot || this.seatsSnapshot.length === 0)
            return null;
        return this.seatsSnapshot.map((s) => ({ ...s }));
    }
    // Called by server when a new hand should start
    startHand(seats) {
        var _a, _b, _c;
        // active seats: anyone with a playerId and chips > 0
        const activeSeats = seats.filter((s) => { var _a; return !!s.playerId && ((_a = s.chips) !== null && _a !== void 0 ? _a : 0) > 0; });
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
        }
        else {
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
        const board = [];
        // Deal 2 hole cards per active player
        const tablePlayers = [];
        for (const seat of activeSeats) {
            const hole = [this.drawCard(), this.drawCard()];
            tablePlayers.push({
                seatIndex: seat.seatIndex,
                playerId: seat.playerId,
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
        const bettingPlayers = tablePlayers.map((tp) => {
            const seatSnap = this.seatsSnapshot.find((s) => s.seatIndex === tp.seatIndex);
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
        let smallBlindSeat = null;
        let bigBlindSeat = null;
        if (positions.length === 2) {
            // Heads-up: button = small blind; other = big blind
            smallBlindSeat = this.buttonSeatIndex;
            bigBlindSeat = (_a = positions.find((s) => s !== this.buttonSeatIndex)) !== null && _a !== void 0 ? _a : null;
        }
        else {
            const idxBtn = positions.indexOf(this.buttonSeatIndex);
            if (idxBtn !== -1) {
                smallBlindSeat = positions[(idxBtn + 1) % positions.length];
                bigBlindSeat = positions[(idxBtn + 2) % positions.length];
            }
        }
        let pot = 0;
        let maxCommitted = 0;
        function applyBlind(players, seatIndex, amount) {
            if (seatIndex == null)
                return { potDelta: 0, committed: 0 };
            const p = players.find((x) => x.seatIndex === seatIndex);
            if (!p)
                return { potDelta: 0, committed: 0 };
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
            maxCommitted = Math.max(maxCommitted, (_b = res.committed) !== null && _b !== void 0 ? _b : 0);
        }
        if (bigBlindSeat != null) {
            const res = applyBlind(bettingPlayers, bigBlindSeat, bigBlind);
            pot += res.potDelta;
            maxCommitted = Math.max(maxCommitted, (_c = res.committed) !== null && _c !== void 0 ? _c : 0);
        }
        // First to act preflop = first seat after big blind
        let currentSeatIndex = null;
        if (bigBlindSeat != null) {
            currentSeatIndex = this.findNextSeatToAct(bettingPlayers, bigBlindSeat, true);
        }
        this.betting = {
            handId,
            street: "preflop",
            pot,
            buttonSeatIndex: this.buttonSeatIndex,
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
    applyAction(playerId, action, amount) {
        const b = this.betting;
        if (!b || b.street === "done")
            return this.betting;
        const pIdx = b.players.findIndex((p) => p.playerId === playerId);
        if (pIdx === -1)
            return b;
        const p = b.players[pIdx];
        if (!p.inHand || p.hasFolded)
            return b;
        const callNeeded = Math.max(0, b.maxCommitted - p.committed);
        if (action === "fold") {
            p.hasFolded = true;
            p.inHand = false;
            p.hasActed = true;
        }
        else if (action === "check") {
            if (callNeeded > 0 && p.stack > 0) {
                const callAmt = Math.min(callNeeded, p.stack);
                p.stack -= callAmt;
                p.committed += callAmt;
                p.totalContributed += callAmt;
                b.pot += callAmt;
                b.maxCommitted = Math.max(b.maxCommitted, p.committed);
            }
            p.hasActed = true;
        }
        else if (action === "call") {
            const callAmt = Math.min(callNeeded, p.stack);
            if (callAmt > 0) {
                p.stack -= callAmt;
                p.committed += callAmt;
                p.totalContributed += callAmt;
                b.pot += callAmt;
                b.maxCommitted = Math.max(b.maxCommitted, p.committed);
            }
            p.hasActed = true;
        }
        else if (action === "bet") {
            const baseBet = typeof amount === "number" && amount > 0
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
                if (i === pIdx)
                    continue;
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
    computeShowdown() {
        const b = this.betting;
        const t = this.lastTable;
        if (!b || !t || b.street !== "done")
            return null;
        if (this.showdown)
            return this.showdown;
        const board = t.board;
        const active = b.players.filter((p) => p.inHand && !p.hasFolded);
        if (active.length === 0) {
            return null;
        }
        const evals = [];
        for (const bp of active) {
            const tp = t.players.find((pl) => pl.playerId === bp.playerId && pl.seatIndex === bp.seatIndex);
            if (!tp)
                continue;
            const hole = tp.holeCards;
            const seven = [...hole, ...board];
            // Early-fold / incomplete-board case:
            // e.g. everyone folds preflop or on the flop/turn, so board.length < 5
            // In that case we *do not* call evaluateSevenCards (which expects 7 cards).
            if (seven.length < 7) {
                evals.push({
                    bp,
                    eval: {
                        score: 1, // any positive score, only player left anyway
                        rankName: "Wins by fold", // label for the client
                        best5: seven, // might be < 5, frontend can still show something
                    },
                });
                continue;
            }
            // Normal full-board showdown (7 cards: 2 hole + 5 board)
            const ev = this.evaluateSevenCards(seven);
            evals.push({ bp, eval: ev });
        }
        if (evals.length === 0)
            return null;
        // -----------------------------
        // SIDE POT & PAYOUT CALCULATION
        // -----------------------------
        const totalPotFromContrib = b.players.reduce((sum, p) => sum + (p.totalContributed || 0), 0);
        if (totalPotFromContrib > 0) {
            b.pot = totalPotFromContrib;
        }
        const payouts = {};
        for (const pl of b.players) {
            payouts[pl.playerId] = 0;
        }
        const levels = Array.from(new Set(b.players
            .map((p) => p.totalContributed || 0)
            .filter((c) => c > 0))).sort((a, b2) => a - b2);
        if (levels.length === 0) {
            levels.push(0);
        }
        let prevLevel = 0;
        for (const level of levels) {
            const contributingPlayers = b.players.filter((p) => p.totalContributed >= level);
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
            const eligibleEvals = evals.filter(({ bp }) => bp.totalContributed >= level);
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
            if (!seat.playerId)
                continue;
            const bp = b.players.find((pl) => pl.playerId === seat.playerId && pl.seatIndex === seat.seatIndex);
            if (bp) {
                seat.chips = bp.stack;
            }
        }
        // Build showdownPlayers with winner flags
        const showdownPlayers = [];
        for (const { bp, eval: ev } of evals) {
            const tp = t.players.find((pl) => pl.playerId === bp.playerId && pl.seatIndex === bp.seatIndex);
            if (!tp)
                continue;
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
    drawCard() {
        if (this.deck.length === 0) {
            this.deck = shuffle(buildDeck());
        }
        return this.deck.pop();
    }
    findNextSeatToAct(players, fromSeatIndex, wrap) {
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
            if (!p)
                continue;
            if (p.inHand && !p.hasFolded && p.stack >= 0) {
                return p.seatIndex;
            }
            if (!wrap && nextIdx < idx)
                break;
        }
        return null;
    }
    getActingOrder(seatIndices) {
        return seatIndices.slice().sort((a, b) => a - b);
    }
    advanceBetting() {
        const b = this.betting;
        const t = this.lastTable;
        if (!b || !t)
            return;
        // If only one player remains, end hand
        const activePlayers = b.players.filter((p) => p.inHand && !p.hasFolded);
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
            }
            else if (b.street === "flop") {
                t.board.push(this.drawCard());
                b.street = "turn";
            }
            else if (b.street === "turn") {
                t.board.push(this.drawCard());
                b.street = "river";
            }
            else if (b.street === "river") {
                b.street = "done";
                b.currentSeatIndex = null;
                this.betting = b;
                this.lastTable = t;
                return;
            }
            const nextSeat = this.findNextSeatToAct(b.players, b.buttonSeatIndex, true);
            b.currentSeatIndex = nextSeat;
            this.betting = b;
            this.lastTable = t;
            return;
        }
        const fromSeat = b.currentSeatIndex != null ? b.currentSeatIndex : b.buttonSeatIndex;
        const nextSeat = this.findNextSeatToAct(b.players, fromSeat, true);
        b.currentSeatIndex = nextSeat;
        this.betting = b;
    }
    isBettingRoundComplete(b) {
        const active = b.players.filter((p) => p.inHand && !p.hasFolded);
        if (active.length <= 1)
            return true;
        for (const p of active) {
            if (!p.hasActed)
                return false;
            const owes = b.maxCommitted - p.committed;
            if (owes > 0 && p.stack > 0) {
                return false;
            }
        }
        return true;
    }
    // -------------------
    // Hand ranking helpers
    // -------------------
    // Category: 0..8, ranksDesc: high-to-low kicker structure
    buildRankScore(category, ranksDesc) {
        var _a, _b, _c, _d, _e;
        const [r1, r2, r3, r4, r5] = [
            (_a = ranksDesc[0]) !== null && _a !== void 0 ? _a : 0,
            (_b = ranksDesc[1]) !== null && _b !== void 0 ? _b : 0,
            (_c = ranksDesc[2]) !== null && _c !== void 0 ? _c : 0,
            (_d = ranksDesc[3]) !== null && _d !== void 0 ? _d : 0,
            (_e = ranksDesc[4]) !== null && _e !== void 0 ? _e : 0,
        ];
        return (category * 1e8 +
            r1 * 1e6 +
            r2 * 1e4 +
            r3 * 1e2 +
            r4 * 10 +
            r5);
    }
    // Full 7-card evaluator – brute force all 21 combos of 5
    evaluateSevenCards(cards) {
        if (cards.length !== 7) {
            throw new Error(`evaluateSevenCards expects 7 cards, got ${cards.length}`);
        }
        let bestScore = -1;
        let bestName = "High card";
        let bestFive = [];
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
        return {
            score: bestScore,
            rankName: bestName,
            best5: bestFive,
        };
    }
    /**
     * Evaluate EXACTLY 5 cards.
     * Returns:
     *  - category: 0..8   (0=High card, 1=Pair, 2=Two pair, 3=Trips,
     *                      4=Straight, 5=Flush, 6=Full house,
     *                      7=Four of a kind, 8=Straight flush)
     *  - ranksDesc: high->low ranks used for tie-breaking
     *  - rankName: human text ("Full house, Kings over Tens")
     */
    evaluateFiveCards(cards) {
        var _a, _b, _c, _d, _e, _f;
        const ranks = cards.map((c) => rankValue(c[0]));
        const suits = cards.map((c) => c[1]);
        const uniqueRanksDesc = Array.from(new Set(ranks)).sort((a, b) => b - a);
        const rankCounts = {};
        const suitCounts = {};
        for (let i = 0; i < cards.length; i++) {
            const r = ranks[i];
            const s = suits[i];
            rankCounts[r] = (rankCounts[r] || 0) + 1;
            suitCounts[s] = (suitCounts[s] || 0) + 1;
        }
        const groups = Object.keys(rankCounts)
            .map((key) => {
            const r = Number(key);
            return { rank: r, count: rankCounts[r] };
        })
            .sort((a, b) => {
            if (b.count !== a.count)
                return b.count - a.count;
            return b.rank - a.rank;
        });
        const counts = groups.map((g) => g.count);
        const topRank = (_b = (_a = groups[0]) === null || _a === void 0 ? void 0 : _a.rank) !== null && _b !== void 0 ? _b : 0;
        const secondRank = (_d = (_c = groups[1]) === null || _c === void 0 ? void 0 : _c.rank) !== null && _d !== void 0 ? _d : 0;
        const labelRankPlural = (r) => r === 14
            ? "Aces"
            : r === 13
                ? "Kings"
                : r === 12
                    ? "Queens"
                    : r === 11
                        ? "Jacks"
                        : `${r}s`;
        const labelRankHigh = (r) => r === 14
            ? "Ace-high"
            : r === 13
                ? "King-high"
                : r === 12
                    ? "Queen-high"
                    : r === 11
                        ? "Jack-high"
                        : `${r}-high`;
        // ----- Straight detection (handle wheel A-5) -----
        let isStraight = false;
        let straightHigh = 0;
        const uniqAsc = Array.from(new Set(uniqueRanksDesc)).sort((a, b) => a - b);
        let arr = uniqAsc.slice();
        if (arr.includes(14)) {
            arr.push(1);
        }
        arr = Array.from(new Set(arr)).sort((a, b) => a - b);
        let bestSeqHigh = 0;
        let run = [arr[0]];
        for (let i = 1; i < arr.length; i++) {
            if (arr[i] === arr[i - 1] + 1) {
                run.push(arr[i]);
            }
            else if (arr[i] !== arr[i - 1]) {
                if (run.length >= 5) {
                    const cand = run.slice(-5);
                    const hi = cand[cand.length - 1];
                    if (hi > bestSeqHigh) {
                        bestSeqHigh = hi;
                    }
                }
                run = [arr[i]];
            }
        }
        if (run.length >= 5) {
            const cand = run.slice(-5);
            const hi = cand[cand.length - 1];
            if (hi > bestSeqHigh) {
                bestSeqHigh = hi;
            }
        }
        if (bestSeqHigh > 0) {
            isStraight = true;
            straightHigh = bestSeqHigh === 1 ? 5 : bestSeqHigh;
        }
        // ----- Flush detection -----
        let flushSuit = null;
        for (const s of Object.keys(suitCounts)) {
            if (suitCounts[s] === 5) {
                flushSuit = s;
                break;
            }
        }
        const isFlush = !!flushSuit;
        // ----- Straight flush / Royal -----
        if (isFlush && isStraight) {
            const sfHigh = straightHigh;
            if (sfHigh === 14) {
                return {
                    category: 8,
                    ranksDesc: [14, 13, 12, 11, 10],
                    rankName: "Royal flush",
                };
            }
            return {
                category: 8,
                ranksDesc: [sfHigh],
                rankName: `Straight flush (${labelRankHigh(sfHigh)})`,
            };
        }
        // ----- Four of a kind -----
        if (counts[0] === 4) {
            const quadRank = topRank;
            const kickerRank = (_e = uniqueRanksDesc.find((r) => r !== quadRank)) !== null && _e !== void 0 ? _e : quadRank;
            return {
                category: 7,
                ranksDesc: [quadRank, kickerRank],
                rankName: `Four of ${labelRankPlural(quadRank)}`,
            };
        }
        // ----- Full house -----
        if (counts[0] === 3 && (counts[1] === 3 || counts[1] === 2)) {
            const tripRank = topRank;
            const pairRank = secondRank;
            return {
                category: 6,
                ranksDesc: [tripRank, pairRank],
                rankName: `Full house, ${labelRankPlural(tripRank)} over ${labelRankPlural(pairRank)}`,
            };
        }
        // ----- Flush -----
        if (isFlush) {
            const sortedFlush = ranks.slice().sort((a, b) => b - a);
            const top5 = sortedFlush.slice(0, 5);
            const high = top5[0];
            return {
                category: 5,
                ranksDesc: top5,
                rankName: `Flush (${labelRankHigh(high)})`,
            };
        }
        // ----- Straight -----
        if (isStraight) {
            return {
                category: 4,
                ranksDesc: [straightHigh],
                rankName: `Straight (${labelRankHigh(straightHigh)})`,
            };
        }
        // ----- Three of a kind -----
        if (counts[0] === 3) {
            const tripRank = topRank;
            const kickers = uniqueRanksDesc
                .filter((r) => r !== tripRank)
                .slice(0, 2);
            return {
                category: 3,
                ranksDesc: [tripRank, ...kickers],
                rankName: `Three of a kind (${labelRankPlural(tripRank)})`,
            };
        }
        // ----- Two pair -----
        if (counts[0] === 2 && counts[1] === 2) {
            const pair1 = topRank;
            const pair2 = secondRank;
            const hiPair = Math.max(pair1, pair2);
            const loPair = Math.min(pair1, pair2);
            const kicker = (_f = uniqueRanksDesc.find((r) => r !== hiPair && r !== loPair)) !== null && _f !== void 0 ? _f : hiPair;
            return {
                category: 2,
                ranksDesc: [hiPair, loPair, kicker],
                rankName: `Two pair (${labelRankPlural(hiPair)} and ${labelRankPlural(loPair)})`,
            };
        }
        // ----- One pair -----
        if (counts[0] === 2) {
            const pairRank = topRank;
            const kickers = uniqueRanksDesc
                .filter((r) => r !== pairRank)
                .slice(0, 3);
            return {
                category: 1,
                ranksDesc: [pairRank, ...kickers],
                rankName: `Pair of ${labelRankPlural(pairRank)}`,
            };
        }
        // ----- High card -----
        const top5 = uniqueRanksDesc.slice(0, 5);
        const high = top5[0];
        const highLabel = high === 14
            ? "Ace"
            : high === 13
                ? "King"
                : high === 12
                    ? "Queen"
                    : high === 11
                        ? "Jack"
                        : `${high}`;
        return {
            category: 0,
            ranksDesc: top5,
            rankName: `High card ${highLabel}`,
        };
    }
}
exports.HoldemGame = HoldemGame;
