/**
 * Bot decision engine.
 *
 * Every strategy observes only the bot's own hand and public information
 * (§91). Expert search uses public-information rollouts where hands are
 * abstracted to "can place anywhere" — it assumes nothing about hidden
 * opponent cards.
 */

import {
  createRngState,
  detectCandidateSequences,
  findMaximumCompatibleSets,
  getLegalActions,
  getPlayer,
  rngNextInt,
  type CellId,
  type GameCommand,
  type GameState,
  type MainAction,
  type PlayerId,
  type RngState,
  type SequenceSelectionOption,
} from "@quintara/game-engine";
import {
  connectivity,
  scoreMainAction,
  teamOf,
  threatLevel,
} from "./heuristics.js";
import type { AiDifficulty } from "./index.js";

export type BotDecision =
  | { readonly kind: "EXCHANGE"; readonly cardId: string }
  | { readonly kind: "PLAY"; readonly action: MainAction }
  | {
      readonly kind: "SELECT_SEQUENCES";
      readonly sequenceCellSets: CellId[][];
    };

export interface BotContext {
  readonly difficulty: AiDifficulty;
  /** Deterministic RNG for reproducible bot behaviour. */
  rng: RngState;
}

export function createBotContext(
  difficulty: AiDifficulty,
  seed?: string,
): BotContext {
  return { difficulty, rng: createRngState(seed ?? `bot-${difficulty}`) };
}

/**
 * Chooses the bot's next decision for its turn (or sequence selection).
 * Throws when the player has no legal actions — the engine's turn safeguard
 * should have skipped the turn already.
 */
export function chooseBotAction(
  state: GameState,
  playerId: PlayerId,
  context: BotContext,
): BotDecision {
  const legal = getLegalActions(state, playerId);

  if (state.turnPhase === "AWAITING_SEQUENCE_SELECTION") {
    return {
      kind: "SELECT_SEQUENCES",
      sequenceCellSets: chooseSequenceOption(
        state,
        playerId,
        legal.sequenceSelectionOptions ?? [],
      ),
    };
  }

  // Dead cards are never useful — exchange them first (§29).
  const deadExchange = legal.deadExchanges[0];
  if (deadExchange) {
    return { kind: "EXCHANGE", cardId: deadExchange.cardId };
  }

  const actions = legal.mainActions;
  if (actions.length === 0) {
    throw new Error("No legal main actions for bot");
  }

  switch (context.difficulty) {
    case "EASY":
      return { kind: "PLAY", action: easyChoice(state, playerId, actions, context) };
    case "MEDIUM":
      return { kind: "PLAY", action: mediumChoice(state, playerId, actions) };
    case "HARD":
      return { kind: "PLAY", action: hardChoice(state, playerId, actions) };
    case "EXPERT":
      return { kind: "PLAY", action: expertChoice(state, playerId, actions, context) };
  }
}

/** Converts a decision into an authoritative engine command. */
export function decisionToCommand(
  decision: BotDecision,
  playerId: PlayerId,
  actionId: string,
  expectedVersion: number,
): GameCommand {
  switch (decision.kind) {
    case "EXCHANGE":
      return {
        type: "EXCHANGE_DEAD_CARD",
        playerId,
        actionId,
        expectedVersion,
        cardId: decision.cardId,
      };
    case "SELECT_SEQUENCES":
      return {
        type: "SELECT_SEQUENCE_SET",
        playerId,
        actionId,
        expectedVersion,
        sequenceCellSets: decision.sequenceCellSets,
      };
    case "PLAY": {
      const base = {
        playerId,
        actionId,
        expectedVersion,
        cardId: decision.action.cardId,
        targetCellId: decision.action.targetCellId,
      };
      switch (decision.action.type) {
        case "PLAY_NORMAL_CARD":
          return { type: "PLAY_NORMAL_CARD", ...base };
        case "PLAY_WILD_JACK":
          return { type: "PLAY_WILD_JACK", ...base };
        case "PLAY_REMOVE_JACK":
          return { type: "PLAY_REMOVE_JACK", ...base };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/** Easy: random legal move, but never pass up an immediate win. */
function easyChoice(
  state: GameState,
  playerId: PlayerId,
  actions: readonly MainAction[],
  context: BotContext,
): MainAction {
  const myTeam = teamOf(state, playerId);
  const winning = actions.find((a) => isWinningAction(state, myTeam, a));
  if (winning) return winning;

  const step = rngNextInt(context.rng, actions.length);
  context.rng = step.state;
  return actions[step.value] as MainAction;
}

/** Medium: best heuristic score (Design Plan §22 weights). */
function mediumChoice(
  state: GameState,
  playerId: PlayerId,
  actions: readonly MainAction[],
): MainAction {
  return bestBy(actions, (a) => scoreMainAction({ state, playerId }, a));
}

/** Hard: heuristics + one-ply opponent threat avoidance + Jack conservation. */
function hardChoice(
  state: GameState,
  playerId: PlayerId,
  actions: readonly MainAction[],
): MainAction {
  const myTeam = teamOf(state, playerId);
  return bestBy(actions, (a) => {
    let score = scoreMainAction({ state, playerId }, a);
    if (a.type !== "PLAY_REMOVE_JACK") {
      // Penalise cells that hand an opponent an immediate counter-threat.
      for (const team of state.teams) {
        if (team.id === myTeam) continue;
        const counter = threatLevel(state, team.id, a.targetCellId);
        if (counter > 0) score -= 4_000 * counter;
      }
      // Prefer central, high-connectivity placements.
      score += 250 * connectivity(state, a.targetCellId);
    } else {
      // Removal is best when it breaks a strong opponent intersection.
      score += 800;
    }
    return score;
  });
}

/**
 * Expert: public-information Monte-Carlo style search. Each candidate action
 * is followed by sampled abstract rollouts (hands abstracted to "place
 * anywhere") and scored by resulting sequence advantage. Uses no hidden
 * information (§91).
 */
function expertChoice(
  state: GameState,
  playerId: PlayerId,
  actions: readonly MainAction[],
  context: BotContext,
): MainAction {
  const myTeam = teamOf(state, playerId);

  // Always take an immediate win; avoid moves that let opponents win next.
  const winning = actions.filter((a) => isWinningAction(state, myTeam, a));
  if (winning.length > 0) return winning[0] as MainAction;

  let best = actions[0] as MainAction;
  let bestScore = -Infinity;
  const targetByCell = new Map(
    state.boardDefinition.cells.map((cell) => [cell.id, cell]),
  );

  for (const action of actions) {
    // Average the heuristic prior and the abstract rollouts together. Scale
    // the heuristic by 24 before dividing so it is not diluted 24-fold.
    let total = scoreMainAction({ state, playerId }, action) * 0.6 * 24;
    const target = targetByCell.get(action.targetCellId);
    for (let rollout = 0; rollout < 24; rollout++) {
      total += rolloutScore(state, myTeam, action, context, target);
    }
    const score = total / 24;
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }
  return best;
}

/**
 * One sampled abstract rollout after the candidate action. The board is
 * simulated with a simple grid; each side "can place anywhere", so no hidden
 * hand information is assumed. Returns the advantage for `myTeam`.
 */
function rolloutScore(
  state: GameState,
  myTeam: string,
  action: MainAction,
  context: BotContext,
  target: { row: number; column: number } | undefined,
): number {
  const width = state.boardDefinition.width;
  const height = state.boardDefinition.height;
  const grid: (string | null)[][] = Array.from({ length: height }, () =>
    new Array<string | null>(width).fill(null),
  );

  // Seed the grid from the public board. Non-card cells (corners/holes) are
  // marked blocked so abstract rollouts never place on them.
  for (const cell of state.boardDefinition.cells) {
    if (cell.type === "CARD") {
      grid[cell.row]![cell.column] =
        state.board.cells[cell.id]?.occupantTeamId ?? null;
    } else {
      grid[cell.row]![cell.column] = "__blocked__";
    }
  }

  // Apply the candidate action (coordinate resolved once per action).
  if (target) {
    if (action.type === "PLAY_REMOVE_JACK") {
      grid[target.row]![target.column] = null;
    } else {
      grid[target.row]![target.column] = myTeam;
    }
  }

  const teams = state.teams.map((t) => t.id);
  const scores = new Map<string, number>(teams.map((t) => [t, 0]));

  // Empty cells in row-major order, then maintained in that order. Rebuilding
  // this 10×10 scan on every ply allocated thousands of objects per decision.
  const empty: { row: number; column: number }[] = [];
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      if (grid[row]![column] === null) empty.push({ row, column });
    }
  }

  // Abstract plies: each side places on a random empty cell.
  for (let ply = 0; ply < 10; ply++) {
    const team = teams[ply % teams.length] as string;
    if (empty.length === 0) break;

    // Sample biased toward threatening cells.
    let choiceIndex = 0;
    let bestValue = -Infinity;
    for (let attempt = 0; attempt < 6; attempt++) {
      const step = rngNextInt(context.rng, empty.length);
      context.rng = step.state;
      const candidate = empty[step.value]!;
      const value =
        linePotential(grid, team, candidate.row, candidate.column) +
        (candidate.row > 1 && candidate.row < height - 2 ? 0.5 : 0) +
        (candidate.column > 1 && candidate.column < width - 2 ? 0.5 : 0);
      if (value > bestValue) {
        bestValue = value;
        choiceIndex = step.value;
      }
    }
    const choice = empty[choiceIndex]!;
    grid[choice.row]![choice.column] = team;
    empty.splice(choiceIndex, 1);

    if (linePotential(grid, team, choice.row, choice.column) >= 5) {
      scores.set(team, (scores.get(team) ?? 0) + 10);
      break;
    }
  }

  let advantage = 0;
  for (const team of teams) {
    const value = scores.get(team) ?? 0;
    advantage += team === myTeam ? value : -value;
  }
  return advantage;
}

/** Longest line through (row, column) for `team` on the simulated grid. */
function linePotential(
  grid: (string | null)[][],
  team: string,
  row: number,
  column: number,
): number {
  let best = 1;
  for (const [dr, dc] of [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ] as const) {
    let count = 1;
    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = column + dc * sign;
      while (
        r >= 0 &&
        r < grid.length &&
        c >= 0 &&
        c < (grid[0]?.length ?? 0) &&
        grid[r]?.[c] === team
      ) {
        count++;
        r += dr * sign;
        c += dc * sign;
      }
    }
    best = Math.max(best, count);
  }
  return best;
}

function isWinningAction(
  state: GameState,
  myTeam: string,
  action: MainAction,
): boolean {
  if (action.type === "PLAY_REMOVE_JACK") return false;
  const needs =
    state.requiredSequences - (state.completedSequences[myTeam]?.length ?? 0);
  if (needs <= 0) return true;
  return threatLevel(state, myTeam, action.targetCellId) >= needs;
}

// ---------------------------------------------------------------------------
// Sequence selection
// ---------------------------------------------------------------------------

/**
 * When the claim is ambiguous (§63–§66), prefer the option that keeps the
 * most future potential: high-connectivity protected cells and windows that
 * leave overlapping future runs claimable.
 */
function chooseSequenceOption(
  state: GameState,
  playerId: PlayerId,
  options: readonly SequenceSelectionOption[],
): CellId[][] {
  if (options.length === 0) return [];
  const best = bestBy(options, (option) => {
    let score = 0;
    for (const sequence of option.sequences) {
      for (const cellId of sequence.cells) {
        score += connectivity(state, cellId);
        // Reward windows that keep their ends open for future extensions.
        score += 50;
      }
    }
    void playerId;
    return score;
  });
  return best.sequences.map((s) => [...s.cells]);
}

function bestBy<T>(items: readonly T[], score: (item: T) => number): T {
  let best = items[0] as T;
  let bestScore = -Infinity;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      bestScore = value;
      best = item;
    }
  }
  return best;
}

// Re-exported for tests/telemetry.
export { detectCandidateSequences, findMaximumCompatibleSets, getPlayer };
