/**
 * Board domain: cell definitions, standard 10 × 10 board, validation.
 *
 * Rule reference: Rules Contract §9–§15 (BOARD DIMENSIONS, BOARD CELL TYPES,
 * WILD CORNER LOCATIONS/REPRESENTATION, BOARD CARD IDENTITIES,
 * BOARD CONFIGURATION), Game Design Plan §4.
 *
 * The board layout is data-driven configuration, never hard-coded in UI
 * components (Design Plan §4). The standard layout is generated once from a
 * fixed seed so every match is played on the identical physical board.
 */

import { EngineError } from "./errors.js";
import { isNormalCode, normalCardCodes, type CardCode } from "./cards.js";
import { createRngState, rngNextInt, type RngState } from "./rng.js";

export type CellId = string; // "r{row}c{col}", zero-based (§9)

export type CellType = "CARD" | "WILD_CORNER";

export interface CardCellDefinition {
  readonly id: CellId;
  readonly row: number;
  readonly column: number;
  readonly type: "CARD";
  readonly cardCode: CardCode;
}

export interface WildCornerCellDefinition {
  readonly id: CellId;
  readonly row: number;
  readonly column: number;
  readonly type: "WILD_CORNER";
}

export type BoardCellDefinition = CardCellDefinition | WildCornerCellDefinition;

export interface BoardDefinition {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly cells: readonly BoardCellDefinition[];
}

export const STANDARD_BOARD_ID = "quintara-standard-10x10-v1";
export const STANDARD_BOARD_SIZE = 10;
export const SEQUENCE_LENGTH = 5;

/** Wild corners are fixed at (0,0), (0,9), (9,0), (9,9) (§11). */
export const WILD_CORNER_COORDS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 9],
  [9, 0],
  [9, 9],
];

/** Sequence detection directions (§61): horizontal, vertical, both diagonals. */
export const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

export function cellId(row: number, column: number): CellId {
  return `r${row}c${column}`;
}

export function parseCellId(id: CellId): { row: number; column: number } {
  const match = /^r(\d+)c(\d+)$/.exec(id);
  if (!match) {
    throw new EngineError("INVALID_TARGET", `Malformed cell id ${id}`);
  }
  return { row: Number(match[1]), column: Number(match[2]) };
}

export function isWildCornerId(
  board: BoardDefinition,
  id: CellId,
): boolean {
  const cell = getCellDefinition(board, id);
  return cell.type === "WILD_CORNER";
}

export function getCellDefinition(
  board: BoardDefinition,
  id: CellId,
): BoardCellDefinition {
  const cell = findCellDefinition(board, id);
  if (!cell) {
    throw new EngineError("INVALID_TARGET", `Unknown cell id ${id}`);
  }
  return cell;
}

const cellIndexCache = new WeakMap<
  BoardDefinition,
  Map<CellId, BoardCellDefinition>
>();

/**
 * Non-throwing cell lookup backed by a per-board index. The board definition
 * is immutable, so every caller shares the same 100-entry map instead of
 * scanning the cell list on each lookup.
 */
export function findCellDefinition(
  board: BoardDefinition,
  id: CellId,
): BoardCellDefinition | undefined {
  let index = cellIndexCache.get(board);
  if (!index) {
    index = new Map(board.cells.map((cell) => [cell.id, cell]));
    cellIndexCache.set(board, index);
  }
  return index.get(id);
}

/**
 * Maps a normal card identity to its two board locations.
 * Both map positions for a given identity (§14: each identity appears twice).
 */
export function cardCellsForCode(
  board: BoardDefinition,
  code: CardCode,
): [CellId, CellId] {
  const matches: CellId[] = [];
  for (const cell of board.cells) {
    if (cell.type === "CARD" && cell.cardCode === code) {
      matches.push(cell.id);
    }
  }
  if (matches.length !== 2) {
    throw new EngineError(
      "INVALID_BOARD_DEFINITION",
      `Card identity ${code} must appear exactly twice on the board (found ${matches.length})`,
    );
  }
  return [matches[0] as CellId, matches[1] as CellId];
}

/**
 * Generates the standard Quintara board layout.
 *
 * Deterministic and fixed across games (like a physical board): the 48 normal
 * identities, each twice, are scattered across the 96 non-corner cells from a
 * fixed seed, then twin copies are pushed apart with deterministic swaps so
 * the two copies of an identity are rarely adjacent.
 */
export function createStandardBoardDefinition(): BoardDefinition {
  const size = STANDARD_BOARD_SIZE;
  const cornerKeys = new Set(
    WILD_CORNER_COORDS.map(([r, c]) => cellId(r, c)),
  );

  const positions: { row: number; column: number }[] = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (!cornerKeys.has(cellId(row, column))) {
        positions.push({ row, column });
      }
    }
  }

  // 96 slots: each of the 48 identities exactly twice (§14).
  const slotCodes: CardCode[] = [];
  for (const code of normalCardCodes()) {
    slotCodes.push(code, code);
  }

  // Deterministic scatter from a fixed seed (board layout is configuration,
  // not game randomness — it must be identical for every match).
  let rng: RngState = createRngState("quintara-standard-board-layout-v1");
  const placed: CardCode[] = new Array(slotCodes.length);
  const remaining = slotCodes.slice();
  for (let i = 0; i < placed.length; i++) {
    const step = rngNextInt(rng, remaining.length);
    rng = step.state;
    placed[i] = remaining[step.value] as CardCode;
    remaining.splice(step.value, 1);
  }

  // Deterministic twin separation: swap one copy of any too-close twin pair
  // with a far slot. Improves board playability while remaining fixed.
  const slotIndexByCode = new Map<CardCode, number[]>();
  placed.forEach((code, index) => {
    const list = slotIndexByCode.get(code) ?? [];
    list.push(index);
    slotIndexByCode.set(code, list);
  });
  const manhattan = (a: number, b: number): number => {
    const pa = positions[a] as { row: number; column: number };
    const pb = positions[b] as { row: number; column: number };
    return Math.abs(pa.row - pb.row) + Math.abs(pa.column - pb.column);
  };
  for (let iteration = 0; iteration < 4000; iteration++) {
    let improved = false;
    for (const [code, indices] of slotIndexByCode) {
      const [a, b] = indices as [number, number];
      if (manhattan(a, b) >= 5) continue;
      // Swap copy at b with a far, non-twin slot.
      for (let attempt = 0; attempt < 8; attempt++) {
        const step = rngNextInt(rng, placed.length);
        rng = step.state;
        const candidate = step.value;
        const candidateCode = placed[candidate] as CardCode;
        if (candidateCode === code) continue;
        const candIndices = slotIndexByCode.get(candidateCode) as number[];
        const other = candIndices[0] === candidate ? candIndices[1] : candIndices[0];
        if (manhattan(candidate, other as number) <= 2) continue;
        // Perform swap in bookkeeping and array.
        placed[candidate] = code;
        placed[b] = candidateCode;
        indices[1] = candidate;
        candIndices[candIndices.indexOf(candidate)] = b;
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }

  // Direct coordinate → slot index mapping: findIndex would silently alias
  // every unmapped corner to slot 0's code if the guard above were removed.
  const slotByCoordinates = new Map<string, number>();
  positions.forEach((position, index) => {
    slotByCoordinates.set(`${position.row},${position.column}`, index);
  });

  const cells: BoardCellDefinition[] = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const id = cellId(row, column);
      if (cornerKeys.has(id)) {
        cells.push({ id, row, column, type: "WILD_CORNER" });
      } else {
        const slot = slotByCoordinates.get(`${row},${column}`) as number;
        cells.push({
          id,
          row,
          column,
          type: "CARD",
          cardCode: placed[slot] as CardCode,
        });
      }
    }
  }

  const board: BoardDefinition = {
    id: STANDARD_BOARD_ID,
    width: size,
    height: size,
    cells,
  };
  validateBoardDefinition(board);
  return board;
}

/**
 * Verifies every board invariant (§15). Throws with details on failure —
 * failure must prevent application startup or match creation.
 */
export function validateBoardDefinition(board: BoardDefinition): void {
  const issues = boardDefinitionIssues(board);
  if (issues.length > 0) {
    throw new EngineError(
      "INVALID_BOARD_DEFINITION",
      `Invalid board definition: ${issues.join("; ")}`,
      { issues },
    );
  }
}

export function boardDefinitionIssues(board: BoardDefinition): string[] {
  const issues: string[] = [];
  const { width, height, cells } = board;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    issues.push("dimensions must be positive integers");
    return issues;
  }
  // §106: board dimensions are a dangerous modification, not a custom option.
  if (width !== STANDARD_BOARD_SIZE || height !== STANDARD_BOARD_SIZE) {
    issues.push(
      `board must be ${STANDARD_BOARD_SIZE}×${STANDARD_BOARD_SIZE}`,
    );
  }
  if (!Array.isArray(cells)) {
    issues.push("cells must be an array");
    return issues;
  }

  const expected = width * height;
  if (cells.length !== expected) {
    issues.push(`expected ${expected} cells, found ${cells.length}`);
  }

  const seenIds = new Set<string>();
  const seenCoords = new Set<string>();
  let wildCorners = 0;
  let cardCells = 0;
  const identityCounts = new Map<CardCode, number>();

  const expectedCorners = new Set(
    WILD_CORNER_COORDS.map(([r, c]) => cellId(r, c)),
  );

  for (const cell of cells) {
    if (!cell || typeof cell !== "object") {
      issues.push("invalid cell entry");
      continue;
    }
    if (typeof cell.id !== "string") {
      issues.push("cell id must be a string");
      continue;
    }
    if (seenIds.has(cell.id)) issues.push(`duplicate cell id ${cell.id}`);
    seenIds.add(cell.id);

    const coordKey = `${cell.row},${cell.column}`;
    if (seenCoords.has(coordKey)) {
      issues.push(`duplicate coordinates ${coordKey}`);
    }
    seenCoords.add(coordKey);

    if (
      cell.row < 0 ||
      cell.row >= height ||
      cell.column < 0 ||
      cell.column >= width
    ) {
      issues.push(`cell ${cell.id} coordinates out of range`);
    }

    try {
      const parsed = parseCellId(cell.id);
      if (parsed.row !== cell.row || parsed.column !== cell.column) {
        issues.push(`cell id ${cell.id} does not match its coordinates`);
      }
      // Sequence detection and marker lookups build canonical ids. A
      // non-canonical alias such as "r01c1" would validate but silently break
      // every line that crosses that cell.
      if (cell.id !== cellId(cell.row, cell.column)) {
        issues.push(`cell id ${cell.id} is not canonical`);
      }
    } catch {
      issues.push(`malformed cell id ${cell.id}`);
    }

    if (cell.type === "WILD_CORNER") {
      wildCorners++;
      if (!expectedCorners.has(cell.id)) {
        issues.push(`unexpected wild corner at ${cell.id}`);
      }
    } else if (cell.type === "CARD") {
      cardCells++;
      if (expectedCorners.has(cell.id)) {
        issues.push(`corner ${cell.id} must be a wild corner`);
      }
      if (typeof cell.cardCode !== "string") {
        issues.push(`cell ${cell.id} must have a card identity`);
        continue;
      }
      if (!isNormalCode(cell.cardCode)) {
        issues.push(`Jack identity ${cell.cardCode} must not appear on the board`);
      }
      identityCounts.set(
        cell.cardCode,
        (identityCounts.get(cell.cardCode) ?? 0) + 1,
      );
    } else {
      const unknownCell = cell as { id: string };
      issues.push(`unknown cell type on ${unknownCell.id}`);
    }
  }

  if (wildCorners !== 4) issues.push(`expected 4 wild corners, found ${wildCorners}`);
  if (cardCells !== expected - 4) {
    issues.push(`expected ${expected - 4} card cells, found ${cardCells}`);
  }

  const uniqueIdentities = identityCounts.size;
  const expectedIdentities = ((expected - 4) / 2) | 0;
  if (uniqueIdentities !== expectedIdentities) {
    issues.push(
      `expected ${expectedIdentities} unique card identities, found ${uniqueIdentities}`,
    );
  }
  const standardIdentities = new Set(normalCardCodes());
  for (const code of identityCounts.keys()) {
    if (!standardIdentities.has(code)) {
      issues.push(`unknown card identity ${code}`);
    }
  }
  for (const code of standardIdentities) {
    if (!identityCounts.has(code)) {
      issues.push(`missing card identity ${code}`);
    }
  }
  for (const [code, count] of identityCounts) {
    if (count !== 2) {
      issues.push(`identity ${code} appears ${count} times (expected exactly 2)`);
    }
  }

  return issues;
}
