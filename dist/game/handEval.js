"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluate7 = evaluate7;
const RANK_ORDER = "23456789TJQKA";
function rankOf(card) {
    return RANK_ORDER.indexOf(card[0]);
}
function suitOf(card) {
    return card[1];
}
function eval5(cards) {
    var _a, _b, _c, _d, _e, _f;
    if (cards.length !== 5) {
        throw new Error("eval5 expects exactly 5 cards");
    }
    const ranks = cards.map(rankOf).sort((a, b) => b - a);
    const suits = cards.map(suitOf);
    const counts = new Array(13).fill(0);
    for (const r of ranks)
        counts[r]++;
    const isFlush = suits.every((s) => s === suits[0]);
    const uniqueRanks = Array.from(new Set(ranks)).sort((a, b) => b - a);
    let isStraight = false;
    let straightHigh = -1;
    if (uniqueRanks.length >= 5) {
        for (let i = 0; i <= uniqueRanks.length - 5; i++) {
            const window = uniqueRanks.slice(i, i + 5);
            if (window[0] - window[4] === 4 &&
                new Set(window).size === 5) {
                isStraight = true;
                straightHigh = window[0];
                break;
            }
        }
    }
    if (!isStraight && uniqueRanks.includes(12)) {
        const wheel = [3, 2, 1, 0];
        if (wheel.every((r) => uniqueRanks.includes(r))) {
            isStraight = true;
            straightHigh = 3;
        }
    }
    const groups = [];
    for (let r = 12; r >= 0; r--) {
        if (counts[r] > 0) {
            groups.push({ rank: r, count: counts[r] });
        }
    }
    const fours = groups.filter((g) => g.count === 4);
    const trips = groups.filter((g) => g.count === 3);
    const pairs = groups.filter((g) => g.count === 2);
    const singles = groups.filter((g) => g.count === 1);
    const rankToCards = new Map();
    for (const c of cards) {
        const r = rankOf(c);
        const arr = (_a = rankToCards.get(r)) !== null && _a !== void 0 ? _a : [];
        arr.push(c);
        rankToCards.set(r, arr);
    }
    const pickCardsForRanks = (wantedRanks) => {
        var _a;
        const result = [];
        const localMap = new Map(rankToCards);
        for (const r of wantedRanks) {
            const arr = (_a = localMap.get(r)) !== null && _a !== void 0 ? _a : [];
            while (arr.length && result.length < 5) {
                result.push(arr.shift());
            }
            localMap.set(r, arr);
            if (result.length === 5)
                break;
        }
        if (result.length < 5) {
            for (const [, arr] of localMap) {
                while (arr.length && result.length < 5) {
                    result.push(arr.shift());
                }
                if (result.length === 5)
                    break;
            }
        }
        return result;
    };
    const base = 1000000000;
    // Straight Flush
    if (isFlush && isStraight) {
        const best5 = [...cards].sort((a, b) => rankOf(b) - rankOf(a));
        const score = 8 * base + straightHigh * 1000000;
        return {
            score,
            rankName: "Straight Flush",
            best5,
        };
    }
    // Four of a Kind
    if (fours.length > 0) {
        const fourRank = fours[0].rank;
        const kickerRank = (_c = (_b = [
            ...trips,
            ...pairs,
            ...singles,
        ]
            .filter((g) => g.rank !== fourRank)[0]) === null || _b === void 0 ? void 0 : _b.rank) !== null && _c !== void 0 ? _c : 0;
        const best5 = pickCardsForRanks([fourRank, kickerRank]);
        const score = 7 * base + fourRank * 1000000 + kickerRank * 10000;
        return {
            score,
            rankName: "Four of a Kind",
            best5,
        };
    }
    // Full House
    if (trips.length > 0 && (pairs.length > 0 || trips.length > 1)) {
        const tripRank = trips[0].rank;
        let pairRank = -1;
        if (trips.length > 1) {
            pairRank = trips[1].rank;
        }
        else {
            pairRank = pairs[0].rank;
        }
        const best5 = pickCardsForRanks([tripRank, pairRank]);
        const score = 6 * base + tripRank * 1000000 + pairRank * 10000;
        return {
            score,
            rankName: "Full House",
            best5,
        };
    }
    // Flush
    if (isFlush) {
        const best5 = [...cards].sort((a, b) => rankOf(b) - rankOf(a));
        const [r1, r2, r3, r4, r5] = best5.map(rankOf);
        const score = 5 * base +
            r1 * 1000000 +
            r2 * 10000 +
            r3 * 100 +
            r4 * 1 +
            r5 * 0.01;
        return {
            score,
            rankName: "Flush",
            best5,
        };
    }
    // Straight
    if (isStraight) {
        const best5 = [...cards].sort((a, b) => rankOf(b) - rankOf(a));
        const score = 4 * base + straightHigh * 1000000;
        return {
            score,
            rankName: "Straight",
            best5,
        };
    }
    // Trips
    if (trips.length > 0) {
        const tRank = trips[0].rank;
        const kickers = [...pairs, ...singles]
            .map((g) => g.rank)
            .sort((a, b) => b - a)
            .slice(0, 2);
        const best5 = pickCardsForRanks([tRank, ...kickers]);
        const [k1, k2] = kickers;
        const score = 3 * base + tRank * 1000000 + k1 * 10000 + k2 * 100;
        return {
            score,
            rankName: "Three of a Kind",
            best5,
        };
    }
    // Two Pair
    if (pairs.length >= 2) {
        const [p1, p2] = pairs
            .map((g) => g.rank)
            .sort((a, b) => b - a)
            .slice(0, 2);
        const kicker = (_f = (_e = (_d = singles[0]) === null || _d === void 0 ? void 0 : _d.rank) !== null && _e !== void 0 ? _e : pairs
            .map((g) => g.rank)
            .filter((r) => r !== p1 && r !== p2)[0]) !== null && _f !== void 0 ? _f : 0;
        const best5 = pickCardsForRanks([p1, p2, kicker]);
        const score = 2 * base +
            p1 * 1000000 +
            p2 * 10000 +
            kicker * 100;
        return {
            score,
            rankName: "Two Pair",
            best5,
        };
    }
    // One Pair
    if (pairs.length === 1) {
        const pRank = pairs[0].rank;
        const kickers = singles
            .map((g) => g.rank)
            .sort((a, b) => b - a)
            .slice(0, 3);
        const best5 = pickCardsForRanks([pRank, ...kickers]);
        const [k1 = 0, k2 = 0, k3 = 0] = kickers;
        const score = 1 * base +
            pRank * 1000000 +
            k1 * 10000 +
            k2 * 100 +
            k3 * 1;
        return {
            score,
            rankName: "One Pair",
            best5,
        };
    }
    // High Card
    const best5 = [...cards].sort((a, b) => rankOf(b) - rankOf(a));
    const [h1, h2, h3, h4, h5] = best5.map(rankOf);
    const score = 0 * base +
        h1 * 1000000 +
        h2 * 10000 +
        h3 * 100 +
        h4 * 1 +
        h5 * 0.01;
    return {
        score,
        rankName: "High Card",
        best5,
    };
}
function evaluate7(cards) {
    if (cards.length !== 7) {
        throw new Error("evaluate7 expects exactly 7 cards");
    }
    let best = null;
    for (let i = 0; i < 7; i++) {
        for (let j = i + 1; j < 7; j++) {
            const five = [];
            for (let k = 0; k < 7; k++) {
                if (k === i || k === j)
                    continue;
                five.push(cards[k]);
            }
            const r = eval5(five);
            if (!best || r.score > best.score) {
                best = r;
            }
        }
    }
    return best;
}
