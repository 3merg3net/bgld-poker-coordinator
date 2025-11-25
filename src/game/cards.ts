// src/game/cards.ts

export type Suit = "c" | "d" | "h" | "s"; // clubs, diamonds, hearts, spades
export type Rank =
  | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "T"
  | "J" | "Q" | "K" | "A";

export type Card = `${Rank}${Suit}`;

export function makeDeck(): Card[] {
  const ranks: Rank[] = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
  const suits: Suit[] = ["c","d","h","s"];
  const deck: Card[] = [];
  for (const r of ranks) {
    for (const s of suits) {
      deck.push(`${r}${s}` as Card);
    }
  }
  return deck;
}

export function shuffle<T>(arr: T[]): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
