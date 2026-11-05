/**
 * Sequence detection and registration (§51–§53, §60–§62, §70, §72).
 *
 * Detection runs only after marker placement, and only evaluates lines
 * through the newly placed marker (§60–§61).
 */

import {
  DIRECTIONS,
  SEQUENCE_LENGTH,
  findCellDefinition,
  parseCellId,
  type CellId,
} from "./board.js";
import type { DomainEvent } from "./events.js";
import {
  type ActionId,
  type CompletedSequence,
  type GameState,
  type SequenceCandidate,
  type SequenceDirection,
  type SequenceId,
  type TeamId,
} from "./state.js";

/** §51: wild corners qualify for every team; markers qualify for their team. */
export function qualifiesForTeam(
  state: GameState,
  id: CellId,
  teamId: TeamId,
): boolean {
  const cell = findCellDefinition(state.boardDefinition, id);
  if (!cell) return false;
  if (cell.type === "WILD_CORNER") return true;
  const occupancy = state.board.cells[id];
  return occupancy?.occupantTeamId === teamId;
}

export function directionFor(
  dr: number,
  dc: number,
): SequenceDirection {
  if (dr === 0) return "HORIZONTAL";
  if (dc === 0) return "VERTICAL";
  return dr === dc ? "DIAGONAL_DOWN" : "DIAGONAL_UP";
}

/** Canonical key: cells sorted lexicographically (§68). */
export function canonicalCellKey(cells: readonly CellId[]): string {
  return [...cells].sort().join(",");
}

export function candidateKey(candidate: SequenceCandidate): string {
  return `${candidate.direction}|${canonicalCellKey(candidate.cells)}`;
}

/** Canonical serialisation of a candidate set (§68). */
export function optionKey(sequences: readonly SequenceCandidate[]): string {
  return sequences
    .map((s) => candidateKey(s))
    .sort()
    .join("||");
}

/**
 * §61–§62 CANDIDATE GENERATION: collect the contiguous compatible run
 * through the newly placed marker along each direction, then enumerate
 * every 5-cell window that contains the new marker.
 */
export function detectCandidateSequences(
  state: GameState,
  teamId: TeamId,
  placedCellId: CellId,
): SequenceCandidate[] {
  const { row, column } = parseCellId(placedCellId);
  const width = state.boardDefinition.width;
  const height = state.boardDefinition.height;
  const candidates: SequenceCandidate[] = [];

  for (const [dr, dc] of DIRECTIONS) {
    // Walk backwards from the placed cell.
    const run: CellId[] = [placedCellId];
    let r = row - dr;
    let c = column - dc;
    while (r >= 0 && r < height && c >= 0 && c < width) {
      const id = `r${r}c${c}`;
      if (!qualifiesForTeam(state, id, teamId)) break;
      run.unshift(id);
      r -= dr;
      c -= dc;
    }
    // Walk forwards.
    r = row + dr;
    c = column + dc;
    while (r >= 0 && r < height && c >= 0 && c < width) {
      const id = `r${r}c${c}`;
      if (!qualifiesForTeam(state, id, teamId)) break;
      run.push(id);
      r += dr;
      c += dc;
    }

    if (run.length < SEQUENCE_LENGTH) continue;

    for (let start = 0; start <= run.length - SEQUENCE_LENGTH; start++) {
      const window = run.slice(start, start + SEQUENCE_LENGTH);
      if (!window.includes(placedCellId)) continue;
      candidates.push({
        teamId,
        cells: window as [CellId, CellId, CellId, CellId, CellId],
        direction: directionFor(dr, dc),
      });
    }
  }

  // Reject duplicate candidates (same five coordinates, §54/§62).
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = canonicalCellKey(candidate.cells);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Registers new completed sequences for a team (§52–§53, §70).
 * Appends immutable entries and updates the sequence membership index.
 */
export function registerSequences(
  state: GameState,
  candidates: readonly SequenceCandidate[],
  createdByActionId: ActionId,
): { state: GameState; events: DomainEvent[] } {
  if (candidates.length === 0) {
    return { state, events: [] };
  }

  const events: DomainEvent[] = [];
  const newSequences: CompletedSequence[] = [];
  const membership: Record<CellId, SequenceId[]> = {};
  for (const [key, value] of Object.entries(state.sequenceMembership)) {
    membership[key] = [...value];
  }

  let counter = state.sequenceCounter;
  for (const candidate of candidates) {
    counter += 1;
    const sequenceId: SequenceId = `S${counter}`;
    newSequences.push({
      id: sequenceId,
      teamId: candidate.teamId,
      cells: candidate.cells,
      direction: candidate.direction,
      createdTurn: state.turnNumber,
      createdByActionId,
    });
    // §70: membership index for every non-corner cell in the sequence.
    for (const cellId of candidate.cells) {
      const cell = findCellDefinition(state.boardDefinition, cellId);
      if (cell && cell.type === "CARD") {
        const list = membership[cellId] ?? [];
        list.push(sequenceId);
        membership[cellId] = list;
      }
    }
    events.push({
      type: "SEQUENCE_COMPLETED",
      sequenceId,
      teamId: candidate.teamId,
      cells: candidate.cells,
      direction: candidate.direction,
    });
  }

  const teamId = candidates[0]?.teamId;
  if (!teamId) return { state, events: [] };

  const next: GameState = {
    ...state,
    completedSequences: {
      ...state.completedSequences,
      [teamId]: [...(state.completedSequences[teamId] ?? []), ...newSequences],
    },
    sequenceMembership: membership,
    sequenceCounter: counter,
  };
  return { state: next, events };
}

/** Number of board cells shared by two sequences (§56 overlap rule). */
export function intersectionSize(
  a: readonly CellId[],
  b: readonly CellId[],
): number {
  const setB = new Set(b);
  let count = 0;
  for (const cell of a) {
    if (setB.has(cell)) count++;
  }
  return count;
}
