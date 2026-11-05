/**
 * Card domain: identities, physical card instances, Jack classification, deck.
 *
 * Rule reference: Rules Contract §14–§18 (BOARD CARD IDENTITIES, DECK,
 * NORMAL CARD COUNT, JACK TYPES), Game Design Plan §5.
 */

import { EngineError } from "./errors.js";

export type CardId = string;
/** Card identity code, e.g. "8H", "10S", "QC", "JC". */
export type CardCode = string;

export type Suit = "CLUBS" | "DIAMONDS" | "HEARTS" | "SPADES";
export type Rank =
  | "A"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "Q"
  | "K";

export const SUITS: readonly Suit[] = [
  "CLUBS",
  "DIAMONDS",
  "HEARTS",
  "SPADES",
];

/** Board ranks: 12 ranks, no Jacks (§14). */
export const BOARD_RANKS: readonly Rank[] = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "Q",
  "K",
];

export const JACK_RANK = "J";

export interface Card {
  readonly id: CardId;
  readonly deckCopy: 1 | 2;
  readonly rank: Rank;
  readonly suit: Suit;
  readonly code: CardCode;
}

export type JackKind = "TWO_EYED" | "ONE_EYED";

/** Two-Eyed Jacks (wild placement): J♣, J♦ (§18). */
export const TWO_EYED_JACK_CODES: readonly CardCode[] = ["JC", "JD"];
/** One-Eyed Jacks (remove opponent marker): J♥, J♠ (§18). */
export const ONE_EYED_JACK_CODES: readonly CardCode[] = ["JH", "JS"];

const SUIT_INITIAL: Record<Suit, string> = {
  CLUBS: "C",
  DIAMONDS: "D",
  HEARTS: "H",
  SPADES: "S",
};

export function cardCode(rank: Rank, suit: Suit): CardCode {
  return `${rank}${SUIT_INITIAL[suit]}`;
}

export function isJackCode(code: CardCode): boolean {
  return code.startsWith(JACK_RANK);
}

export function jackKind(code: CardCode): JackKind | null {
  if (TWO_EYED_JACK_CODES.includes(code)) return "TWO_EYED";
  if (ONE_EYED_JACK_CODES.includes(code)) return "ONE_EYED";
  return null;
}

export function isTwoEyedJackCode(code: CardCode): boolean {
  return jackKind(code) === "TWO_EYED";
}

export function isOneEyedJackCode(code: CardCode): boolean {
  return jackKind(code) === "ONE_EYED";
}

/** A normal (non-Jack) card identity — 48 of these (§14). */
export function isNormalCode(code: CardCode): boolean {
  return !isJackCode(code);
}

/** All 48 normal board identities, in deterministic order. */
export function normalCardCodes(): CardCode[] {
  const codes: CardCode[] = [];
  for (const suit of SUITS) {
    for (const rank of BOARD_RANKS) {
      codes.push(cardCode(rank, suit));
    }
  }
  return codes;
}

/**
 * Builds the standard Quintara deck: two 52-card decks, no Jokers (§16).
 * Every physical card instance has a unique id: "D1-8H" / "D2-8H".
 */
export function createStandardDeck(): Card[] {
  const cards: Card[] = [];
  for (const deckCopy of [1, 2] as const) {
    for (const suit of SUITS) {
      for (const rank of BOARD_RANKS) {
        const code = cardCode(rank, suit);
        cards.push({
          id: `D${deckCopy}-${code}`,
          deckCopy,
          rank,
          suit,
          code,
        });
      }
      // One Jack per suit per deck copy.
      const jackCode = cardCode(JACK_RANK as Rank, suit);
      cards.push({
        id: `D${deckCopy}-${jackCode}`,
        deckCopy,
        rank: JACK_RANK as Rank,
        suit,
        code: jackCode,
      });
    }
  }
  return cards;
}

const RANK_LABEL: Record<string, string> = {
  A: "Ace",
  J: "Jack",
  Q: "Queen",
  K: "King",
  "10": "Ten",
};

const SUIT_LABEL: Record<Suit, string> = {
  CLUBS: "Clubs",
  DIAMONDS: "Diamonds",
  HEARTS: "Hearts",
  SPADES: "Spades",
};

/**
 * Accessible card description, e.g. "Eight of Hearts" (Design Plan §64).
 */
export function cardLabel(code: CardCode): string {
  const rank = code.slice(0, -1);
  const suitInitial = code.slice(-1);
  const suit = (Object.keys(SUIT_INITIAL) as Suit[]).find(
    (s) => SUIT_INITIAL[s] === suitInitial,
  );
  const RANK_DIGIT_LABEL: Record<string, string> = {
    "2": "Two",
    "3": "Three",
    "4": "Four",
    "5": "Five",
    "6": "Six",
    "7": "Seven",
    "8": "Eight",
    "9": "Nine",
  };
  const rankLabel = RANK_LABEL[rank] ?? RANK_DIGIT_LABEL[rank] ?? rank;
  const kind = jackKind(code);
  const jackSuffix =
    kind === "TWO_EYED" ? ", Two-Eyed Jack" : kind === "ONE_EYED" ? ", One-Eyed Jack" : "";
  return `${rankLabel} of ${suit ? SUIT_LABEL[suit] : "Unknown"}${jackSuffix}`;
}

export function getCard(cards: Record<CardId, Card>, cardId: CardId): Card {
  const card = cards[cardId];
  if (!card) {
    throw new EngineError("INVALID_CARD", `Unknown card id ${cardId}`);
  }
  return card;
}
