/**
 * Quintara game engine — public API (§144).
 *
 * The engine is deterministic and pure: no React, no DOM, no CSS, no
 * database, no WebSocket (§142). Same initial state + same RNG stream + same
 * ordered actions = same final state (§1).
 *
 * Low-level mutation helpers stay internal (§145). The scenario builder is
 * test/debug tooling only (§146–§147).
 */

// Setup & lifecycle
export {
  createGame,
  startGame,
  getRulesConfig,
  standardHandSize,
  standardRequiredSequences,
  standardTeamConfigurations,
  isStandardPlayerCount,
  buildTurnOrder,
  STANDARD_HAND_SIZE,
  STANDARD_PLAYER_COUNTS,
  STANDARD_DECK_SIZE,
  MAX_REQUIRED_SEQUENCES,
  MIN_TURN_DURATION_MS,
  MAX_TURN_DURATION_MS,
  CUSTOM_RULES_VERSION,
  type CreateGameOptions,
  type CreateGamePlayerInput,
} from "./setup.js";

// Commands
export {
  applyCommand,
  resolveSequenceSelectionDefault,
  type CommandOptions,
  type GameCommand,
  type CommandBase,
  type ExchangeDeadCardCommand,
  type PlayNormalCardCommand,
  type PlayWildJackCommand,
  type PlayRemoveJackCommand,
  type SelectSequenceSetCommand,
  type EngineResult,
} from "./commands.js";

// Legal actions
export {
  getLegalActions,
  getMainActions,
  getDeadExchangeActions,
  getNormalCardLegalTargets,
} from "./legal-actions.js";
export type {
  LegalActions,
  MainAction,
  ExchangeDeadCardAction,
  PlayNormalCardAction,
  PlayWildJackAction,
  PlayRemoveJackAction,
} from "./actions.js";

// Projection
export {
  projectStateForViewer,
  projectEventsForViewer,
  type ProjectedState,
  type ProjectedEvent,
  type ViewerPlayerInfo,
  type ViewerTeamInfo,
  type ViewerCardInfo,
} from "./projection.js";

// Rules helpers (single source of truth for consumers)
export { isDeadCard, deadCardsInHand, canExchangeDeadCard } from "./dead-cards.js";
export {
  isTwoEyedJack,
  isOneEyedJack,
  jackKind,
  describeJack,
  getWildJackLegalTargets,
  getRemovalJackLegalTargets,
} from "./jacks.js";
export {
  detectCandidateSequences,
  qualifiesForTeam,
  canonicalCellKey,
} from "./sequences.js";
export {
  sequencesCompatible,
  findMaximumCompatibleSets,
  filterClaimableCandidates,
  toSelectionOptions,
  defaultSequenceOption,
} from "./overlap.js";
export { checkVictory, wallClock, type Clock } from "./victory.js";
export { drawCards, discardCard, countAllCards } from "./draw.js";
export {
  completeTurnAndAdvance,
  enforceNoLegalActionSafeguard,
  startTurnsWithSafeguard,
  withBoardChange,
} from "./turns.js";

// Board & cards
export {
  createStandardBoardDefinition,
  validateBoardDefinition,
  boardDefinitionIssues,
  cardCellsForCode,
  cellId,
  parseCellId,
  getCellDefinition,
  STANDARD_BOARD_ID,
  STANDARD_BOARD_SIZE,
  SEQUENCE_LENGTH,
  WILD_CORNER_COORDS,
  DIRECTIONS,
  type BoardDefinition,
  type BoardCellDefinition,
  type CardCellDefinition,
  type WildCornerCellDefinition,
  type CellId,
  type CellType,
} from "./board.js";
export {
  createStandardDeck,
  normalCardCodes,
  cardCode,
  cardLabel,
  isJackCode,
  isNormalCode,
  isTwoEyedJackCode,
  isOneEyedJackCode,
  SUITS,
  BOARD_RANKS,
  TWO_EYED_JACK_CODES,
  ONE_EYED_JACK_CODES,
  type Card,
  type CardCode,
  type CardId,
  type Rank,
  type Suit,
  type JackKind,
} from "./cards.js";

// RNG (authoritative seed generation for online matches)
export {
  createRngState,
  rngNext,
  rngNextInt,
  shuffled,
  generateSecureSeed,
  RNG_ALGORITHM_VERSION,
  type RngState,
} from "./rng.js";

// State & events
export {
  RULES_VERSION,
  getPlayer,
  getTeam,
  getTeamOfPlayer,
  currentPlayerId,
  currentPlayerTeamId,
  isProtectedCell,
  countCompletedSequences,
  type GameState,
  type GameRulesConfig,
  type GameStatus,
  type GameResultType,
  type TurnPhase,
  type PlayerState,
  type TeamState,
  type BoardState,
  type CellOccupancy,
  type CompletedSequence,
  type SequenceCandidate,
  type SequenceSelectionOption,
  type SequenceDirection,
  type SequenceId,
  type PlayerId,
  type TeamId,
  type ActionId,
  type GameId,
} from "./state.js";
export type { DomainEvent, DrawReason, SequenceCompletedPayload } from "./events.js";

// Errors
export {
  EngineError,
  engineErrorMessage,
  isEngineErrorCode,
  type EngineErrorCode,
} from "./errors.js";

// Validation & invariants
export { validateGameState } from "./invariants.js";

// Test/debug tooling (§146: never expose through production endpoints)
export { scenario, ScenarioBuilder, type ScenarioOptions } from "./scenario.js";

// ---------------------------------------------------------------------------
// Replay (§102)
// ---------------------------------------------------------------------------

import {
  applyCommand,
  type CommandOptions,
  type GameCommand,
  type EngineResult,
} from "./commands.js";
import type { DomainEvent } from "./events.js";
import type { GameState } from "./state.js";

export interface ReplayOptions extends CommandOptions {
  /**
   * Terminal timestamp recorded in the original event stream. Supplying it
   * makes `finishedAt` byte-exact; omitting it uses the deterministic game
   * creation timestamp rather than the wall clock.
   */
  readonly finishedAt?: string;
}

/**
 * Deterministically replays a recorded command stream from an initial state
 * (§102 REPLAY: initial state + complete command/event stream + RNG
 * information reproduces the game exactly).
 *
 * Replay never reads the wall clock: pass `finishedAt` from the recorded
 * GAME_WON/GAME_STALEMATED event to reproduce terminal metadata exactly.
 */
export function replayCommands(
  initialState: GameState,
  commands: readonly GameCommand[],
  options?: ReplayOptions,
): EngineResult {
  const replayOptions: CommandOptions = {
    ...options,
    now: options?.now ?? (() => options?.finishedAt ?? initialState.createdAt),
  };
  let state = initialState;
  const events: DomainEvent[] = [];
  for (const command of commands) {
    const result = applyCommand(state, command, replayOptions);
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}
