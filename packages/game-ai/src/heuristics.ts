/**
 * Heuristic evaluation for Medium+ bots (Design Plan §22 suggested weights,
 * tuned within the engine's rules).
 */

import {
  detectCandidateSequences,
  findMaximumCompatibleSets,
  getPlayer,
  isProtectedCell,
  type BoardDefinition,
  type CellId,
  type GameState,
  type MainAction,
  type PlayerId,
  type SequenceCandidate,
} from "@quintara/game-engine";

/** Design Plan §22 suggested evaluation weights. */
export const HEURISTIC_WEIGHTS = {
  immediateVictory: 100_000,
  preventOpponentVictory: 90_000,
  completeOwnFour: 20_000,
  blockOpponentFour: 18_000,
  createDoubleThreat: 12_000,
  buildOpenFour: 7_000,
  blockStrongIntersection: 6_000,
  createOpenThree: 2_500,
  highConnectivityCell: 1_000,
  wasteTwoEyedJack: -1_500,
  wasteOneEyedJack: -1_800,
} as const;

export interface EvaluationInput {
  readonly state: GameState;
  readonly playerId: PlayerId;
}

export function teamOf(state: GameState, playerId: PlayerId): string {
  return getPlayer(state, playerId).teamId;
}

const neighbourCountCache = new WeakMap<BoardDefinition, Map<string, number>>();

/** Per-board neighbour counts, computed once and shared by every bot turn. */
function neighbourCounts(board: BoardDefinition): Map<string, number> {
  let counts = neighbourCountCache.get(board);
  if (!counts) {
    counts = new Map();
    for (const cell of board.cells) {
      let count = 0;
      for (const other of board.cells) {
        if (other.id === cell.id) continue;
        if (
          Math.abs(other.row - cell.row) <= 1 &&
          Math.abs(other.column - cell.column) <= 1
        ) {
          count += 1;
        }
      }
      counts.set(cell.id, count);
    }
    neighbourCountCache.set(board, counts);
  }
  return counts;
}

/** Number of directions in which a cell extends the team's lines. */
export function connectivity(state: GameState, cellId: string): number {
  return neighbourCounts(state.boardDefinition).get(cellId) ?? 0;
}

/**
 * Heuristic lookups repeat across the candidate actions of one decision
 * (score, then threat avoidance). States are immutable and short-lived, so
 * a WeakMap keyed by the state is a safe, self-cleaning memo.
 */
const threatCache = new WeakMap<GameState, Map<string, number>>();
const candidateCache = new WeakMap<GameState, Map<string, SequenceCandidate[]>>();

function cacheKey(teamId: string, cellId: string): string {
  return `${teamId}\u0000${cellId}`;
}

function candidatesAt(
  state: GameState,
  teamId: string,
  cellId: CellId,
): SequenceCandidate[] {
  let cache = candidateCache.get(state);
  if (!cache) {
    cache = new Map();
    candidateCache.set(state, cache);
  }
  const key = cacheKey(teamId, cellId);
  let candidates = cache.get(key);
  if (!candidates) {
    candidates = detectCandidateSequences(state, teamId, cellId);
    cache.set(key, candidates);
  }
  return candidates;
}

/**
 * Counts immediate winning completions for a team if it could place at a
 * cell — i.e. how many candidate sequences a placement would add.
 */
export function threatLevel(
  state: GameState,
  teamId: string,
  cellId: string,
): number {
  let cache = threatCache.get(state);
  if (!cache) {
    cache = new Map();
    threatCache.set(state, cache);
  }
  const key = cacheKey(teamId, cellId);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const candidates = candidatesAt(state, teamId, cellId);
  const existing = state.completedSequences[teamId] ?? [];
  const sets = findMaximumCompatibleSets(candidates, existing);
  const value = sets[0]?.length ?? 0;
  cache.set(key, value);
  return value;
}

/** Whether a cell is part of any completed (protected) sequence. */
export function isStrongIntersection(
  state: GameState,
  cellId: string,
): boolean {
  return isProtectedCell(state, cellId);
}

/**
 * Scores a main action for the acting player's team. Purely positional —
 * uses only public board information and the bot's own identity (§91).
 */
export function scoreMainAction(
  input: EvaluationInput,
  action: MainAction,
): number {
  const { state, playerId } = input;
  const myTeam = teamOf(state, playerId);
  const weights = HEURISTIC_WEIGHTS;
  let score = 0;

  if (action.type === "PLAY_REMOVE_JACK") {
    const occupancy = state.board.cells[action.targetCellId];
    const removedTeam = occupancy?.occupantTeamId;
    // Removing a marker that completes an opponent threat is valuable.
    if (removedTeam && removedTeam !== myTeam) {
      const opponentThreat = threatLevel(
        state,
        removedTeam,
        action.targetCellId,
      );
      score += weights.blockOpponentFour * (1 + opponentThreat);
      score += connectivity(state, action.targetCellId);
    } else {
      score += weights.wasteOneEyedJack;
    }
    return score;
  }

  // Placement actions: evaluate resulting threats for both sides.
  const target = action.targetCellId;
  const myThreat = threatLevel(state, myTeam, target);
  if (myThreat > 0) {
    score +=
      myThreat >= (state.requiredSequences - countTeamSequences(state, myTeam))
        ? weights.immediateVictory
        : weights.completeOwnFour * myThreat;
  }

  // Double threat: two separate windows created by one placement.
  const candidates = candidatesAt(state, myTeam, target);
  if (candidates.length >= 2) {
    score += weights.createDoubleThreat;
    score += weights.buildOpenFour;
  } else if (candidates.length === 1) {
    score += weights.createOpenThree;
  }

  // Blocking: would this cell win for an opponent right now?
  for (const team of state.teams) {
    if (team.id === myTeam) continue;
    const opponentThreat = threatLevel(state, team.id, target);
    if (opponentThreat > 0) {
      const opponentNeeds =
        state.requiredSequences - countTeamSequences(state, team.id);
      score +=
        opponentThreat >= opponentNeeds
          ? weights.preventOpponentVictory
          : weights.blockOpponentFour * opponentThreat;
    }
  }

  // Positional value.
  score += weights.highConnectivityCell * (connectivity(state, target) / 8);

  if (action.type === "PLAY_WILD_JACK" && myThreat === 0) {
    // Conserving Two-Eyed Jacks for real threats (§22).
    score += weights.wasteTwoEyedJack;
  }

  return score;
}

function countTeamSequences(state: GameState, teamId: string): number {
  return state.completedSequences[teamId]?.length ?? 0;
}
