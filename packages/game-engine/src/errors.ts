/**
 * Domain error model for the Quintara engine.
 *
 * Rule reference: Rules Contract §84 (ENGINE ERROR MODEL).
 * Safe user-facing translations are exposed separately via {@link engineErrorMessage}.
 */

export type EngineErrorCode =
  | "GAME_NOT_ACTIVE"
  | "GAME_ALREADY_STARTED"
  | "GAME_ALREADY_FINISHED"
  | "NOT_YOUR_TURN"
  | "INVALID_PHASE"
  | "CARD_NOT_OWNED"
  | "CARD_NOT_DEAD"
  | "DEAD_CARD_ALREADY_EXCHANGED"
  | "CARD_HAS_NO_LEGAL_TARGET"
  | "TARGET_OCCUPIED"
  | "TARGET_CARD_MISMATCH"
  | "INVALID_JACK_TYPE"
  | "INVALID_JACK_TARGET"
  | "PROTECTED_MARKER"
  | "CANNOT_TARGET_TEAMMATE"
  | "INVALID_SEQUENCE_SELECTION"
  | "STALE_GAME_STATE"
  | "DUPLICATE_ACTION"
  | "INVALID_CARD"
  | "INVALID_TARGET"
  | "INVALID_COMMAND"
  | "INVALID_GAME_CONFIG"
  | "INVALID_BOARD_DEFINITION"
  | "CARD_CONSERVATION_VIOLATED";

export class EngineError extends Error {
  public readonly code: EngineErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  constructor(
    code: EngineErrorCode,
    message?: string,
    details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "EngineError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Human-readable, non-technical translations for user-facing surfaces.
 *
 * Rule reference: Game Design Plan §94 (ERROR HANDLING):
 * never show raw codes like ERR_ILLEGAL_TARGET_4021 to users.
 */
const USER_MESSAGES: Record<EngineErrorCode, string> = {
  GAME_NOT_ACTIVE: "This game is not currently accepting moves.",
  GAME_ALREADY_STARTED: "This game has already started.",
  GAME_ALREADY_FINISHED: "This game is over.",
  NOT_YOUR_TURN: "It is not your turn yet.",
  INVALID_PHASE: "That action is not possible right now.",
  CARD_NOT_OWNED: "You can only play cards from your own hand.",
  CARD_NOT_DEAD: "That card still has an open space on the board.",
  DEAD_CARD_ALREADY_EXCHANGED:
    "You have already exchanged a dead card this turn.",
  CARD_HAS_NO_LEGAL_TARGET: "That card has nowhere legal to be played.",
  TARGET_OCCUPIED: "That space is already occupied.",
  TARGET_CARD_MISMATCH: "That card does not match that board space.",
  INVALID_JACK_TYPE: "That card cannot be used that way.",
  INVALID_JACK_TARGET: "That is not a legal target for this Jack.",
  PROTECTED_MARKER:
    "That marker belongs to a completed line and cannot be removed.",
  CANNOT_TARGET_TEAMMATE: "You cannot target a teammate's marker.",
  INVALID_SEQUENCE_SELECTION: "That line selection is not a valid option.",
  STALE_GAME_STATE:
    "The game has advanced past your copy — refreshing to the latest state.",
  DUPLICATE_ACTION: "That move was already played.",
  INVALID_CARD: "That card is not available.",
  INVALID_TARGET: "That board space is not valid.",
  INVALID_COMMAND: "That action could not be understood.",
  INVALID_GAME_CONFIG: "That game configuration is not supported.",
  INVALID_BOARD_DEFINITION: "The board configuration is invalid.",
  CARD_CONSERVATION_VIOLATED:
    "The deck is out of cards — that should not be possible. Please restart the match.",
};

export function engineErrorMessage(code: EngineErrorCode): string {
  return USER_MESSAGES[code];
}

export function isEngineErrorCode(code: string): code is EngineErrorCode {
  return Object.prototype.hasOwnProperty.call(USER_MESSAGES, code);
}
