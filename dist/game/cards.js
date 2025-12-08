"use strict";
// src/game/cards.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeDeck = makeDeck;
exports.shuffle = shuffle;
function makeDeck() {
    const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
    const suits = ["c", "d", "h", "s"];
    const deck = [];
    for (const r of ranks) {
        for (const s of suits) {
            deck.push(`${r}${s}`);
        }
    }
    return deck;
}
function shuffle(arr) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}
