/**
 * GameBoard — the visually dominant 10 × 10 surface (§35).
 *
 * Legal-move guidance (§49): legal targets glow, illegal cells dim, and
 * invalid cells never show misleading hover states (§50). Completed
 * sequences stay subtly visible via a gold trace (§47).
 */

"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  cardLabel,
  type CellId,
  type ProjectedState,
} from "@quintara/game-engine";
import { TeamMarker } from "./TeamMarker";
import { teamVisual } from "@/lib/team-visuals";

export interface GameBoardProps {
  projected: ProjectedState;
  selectedCardId: string | null;
  legalTargets: ReadonlySet<CellId>;
  removableTargets: ReadonlySet<CellId>;
  showLegalMoves: boolean;
  animationSpeed: number;
  lastPlacedCellId?: CellId | null;
  /** Online reconnect: keep the board readable but inert. */
  disabled?: boolean;
  onCellClick: (cellId: CellId) => void;
}

export function GameBoard({
  projected,
  selectedCardId,
  legalTargets,
  removableTargets,
  showLegalMoves,
  animationSpeed,
  lastPlacedCellId = null,
  disabled = false,
  onCellClick,
}: GameBoardProps) {
  const reduced = useReducedMotion();
  const selecting = selectedCardId !== null;
  const cellRefs = useRef(new Map<CellId, HTMLButtonElement>());
  const [focusedCellId, setFocusedCellId] = useState<CellId>("r0c0");

  // Roving tabindex: when a card is selected, Tab lands on the first legal
  // target instead of forcing keyboard users through up to 100 cells.
  useEffect(() => {
    if (!selecting || legalTargets.size === 0) return;
    const first = projected.boardDefinition.cells.find((cell) =>
      legalTargets.has(cell.id),
    );
    if (first) setFocusedCellId(first.id);
  }, [selecting, legalTargets, projected.boardDefinition.cells]);

  useEffect(() => {
    // Keep the roving tab stop on a cell that still exists.
    if (!projected.boardDefinition.cells.some((cell) => cell.id === focusedCellId)) {
      setFocusedCellId("r0c0");
    }
  }, [focusedCellId, projected.boardDefinition.cells]);

  function moveFocus(row: number, column: number): void {
    const next = `r${row}c${column}`;
    const target = cellRefs.current.get(next);
    if (!target) return;
    setFocusedCellId(next);
    target.focus();
  }

  const lastRow = projected.boardDefinition.height - 1;
  const lastColumn = projected.boardDefinition.width - 1;

  function onCellKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    row: number,
    column: number,
  ): void {
    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        moveFocus(Math.max(0, row - 1), column);
        break;
      case "ArrowDown":
        event.preventDefault();
        moveFocus(Math.min(lastRow, row + 1), column);
        break;
      case "ArrowLeft":
        event.preventDefault();
        moveFocus(row, Math.max(0, column - 1));
        break;
      case "ArrowRight":
        event.preventDefault();
        moveFocus(row, Math.min(lastColumn, column + 1));
        break;
      case "Home":
        event.preventDefault();
        moveFocus(row, 0);
        break;
      case "End":
        event.preventDefault();
        moveFocus(row, lastColumn);
        break;
      default:
        break;
    }
  }

  const protectedCells = useMemo(() => {
    const set = new Set<CellId>();
    for (const [cellId, sequenceIds] of Object.entries(
      projected.sequenceMembership,
    )) {
      if ((sequenceIds as string[]).length > 0) set.add(cellId as CellId);
    }
    return set;
  }, [projected.sequenceMembership]);

  const rows = Array.from(
    { length: projected.boardDefinition.height },
    (_, row) =>
      projected.boardDefinition.cells.filter((cell) => cell.row === row),
  );

  return (
    <div className="board-stage">
      <div className="board-surface w-full">
        <p id="board-instructions" className="sr-only">
          Quintara board. Use the arrow keys to move between cells, Home and End
          to jump across a row, and Enter or Space to play on a highlighted
          target. Only highlighted cells accept a move.
        </p>
        <div className="relative">
          <div
            className="board-grid"
            role="grid"
            aria-label="Quintara game board"
            aria-describedby="board-instructions"
            aria-rowcount={projected.boardDefinition.height}
            aria-colcount={projected.boardDefinition.width}
            aria-busy={disabled || undefined}
          >
            {rows.map((rowCells) => (
              <div key={rowCells[0]?.row ?? 0} role="row" className="board-row">
                {rowCells.map((cell) => {
                  const occupancy = projected.boardCells[cell.id];
                  const occupantTeamId = occupancy?.occupantTeamId ?? null;
                  const isWild = cell.type === "WILD_CORNER";
                  const isLegal = legalTargets.has(cell.id);
                  const isRemovable = removableTargets.has(cell.id);
                  const isProtected = protectedCells.has(cell.id);

                  const dimmed =
                    selecting && showLegalMoves && !isLegal && !isRemovable;
                  const classes = [
                    "board-cell",
                    isWild ? "is-wild" : "",
                    showLegalMoves && isLegal ? "is-legal" : "",
                    showLegalMoves && isRemovable ? "is-targetable" : "",
                    dimmed ? "is-dimmed" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");

                  const actionHint = isLegal
                    ? " Legal move."
                    : isRemovable
                      ? " You can remove this marker."
                      : "";
                  const label =
                    cell.type === "WILD_CORNER"
                      ? `Row ${cell.row + 1} column ${cell.column + 1}. Wild corner.${actionHint}`
                      : `Row ${cell.row + 1} column ${cell.column + 1}. ${cardLabel(cell.cardCode)}.${occupantTeamId ? ` Occupied by ${teamName(projected, occupantTeamId)}.` : " Open."}${isProtected ? " Protected sequence marker." : ""}${actionHint}`;

                  return (
                    <button
                      key={cell.id}
                      ref={(node) => {
                        if (node) cellRefs.current.set(cell.id, node);
                        else cellRefs.current.delete(cell.id);
                      }}
                      type="button"
                      role="gridcell"
                      data-cell-id={cell.id}
                      aria-rowindex={cell.row + 1}
                      aria-colindex={cell.column + 1}
                      aria-label={label}
                      aria-disabled={disabled || (!isLegal && !isRemovable)}
                      tabIndex={focusedCellId === cell.id ? 0 : -1}
                      className={classes}
                      onFocus={() => setFocusedCellId(cell.id)}
                      onKeyDown={(event) =>
                        onCellKeyDown(event, cell.row, cell.column)
                      }
                      onClick={() => {
                        // Callers decide whether a non-target cell is a no-op or
                        // explanatory feedback (the tutorial uses the latter).
                        if (!disabled) onCellClick(cell.id);
                      }}
                      style={{
                        cursor:
                          disabled || (!isLegal && !isRemovable)
                            ? "default"
                            : "pointer",
                        opacity: dimmed ? 0.38 : 1,
                      }}
                    >
                      {showLegalMoves && (isLegal || isRemovable) && (
                        <span className="cell-pulse" aria-hidden />
                      )}

                      {cell.type === "CARD" ? (
                        <CardFace
                          rank={cell.cardCode.slice(0, -1)}
                          suit={cell.cardCode.slice(-1)}
                        />
                      ) : (
                        <WildCornerGlyph />
                      )}

                      {occupantTeamId && (
                        <TeamMarker
                          teamId={occupantTeamId}
                          teamName={teamName(projected, occupantTeamId)}
                          isNew={lastPlacedCellId === cell.id && !reduced}
                          animationSpeed={animationSpeed}
                          compact
                        />
                      )}

                      {isProtected && occupantTeamId && (
                        <span
                          className="sequence-trace"
                          style={{
                            boxShadow: `inset 0 0 0 2px ${teamVisual(occupantTeamId).ringColor}cc`,
                          }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <SequenceTraceOverlay
            projected={projected}
            speed={animationSpeed}
          />
        </div>
      </div>
    </div>
  );
}

function teamName(projected: ProjectedState, teamId: string): string {
  return projected.teams.find((t) => t.id === teamId)?.name ?? teamId;
}

/** Miniature vector card face inside a board cell (§39). */
function CardFace({ rank, suit }: { rank: string; suit: string }) {
  const glyph =
    suit === "C" ? "♣" : suit === "D" ? "♦" : suit === "H" ? "♥" : "♠";
  const red = suit === "H" || suit === "D";
  return (
    <span
      className="flex h-full w-full flex-col items-center justify-center leading-none"
      style={{ color: red ? "#b3261e" : "#232a35" }}
      aria-hidden
    >
      <span className="text-[clamp(0.55rem,1.6vw,0.95rem)] font-bold">
        {rank}
      </span>
      <span className="text-[clamp(0.55rem,1.5vw,0.9rem)]">{glyph}</span>
    </span>
  );
}

function WildCornerGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="62%"
      height="62%"
      aria-hidden
      opacity="0.85"
    >
      <path
        d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"
        fill="rgba(120, 84, 20, 0.75)"
      />
    </svg>
  );
}

/** Animated overlay drawn over completed sequences (§47). */
export function SequenceTraceOverlay({
  projected,
  speed,
}: {
  projected: ProjectedState;
  speed: number;
}) {
  const reduced = useReducedMotion();
  const sequences = Object.values(projected.completedSequences).flat();
  if (sequences.length === 0) return null;

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 10 10"
      aria-hidden
    >
      {sequences.map((sequence) => {
        const first = sequence.cells[0];
        const last = sequence.cells[4];
        const a = parse(first);
        const b = parse(last);
        return (
          <motion.line
            key={sequence.id}
            x1={a.x + 0.5}
            y1={a.y + 0.5}
            x2={b.x + 0.5}
            y2={b.y + 0.5}
            stroke="rgba(215, 173, 98, 0.55)"
            strokeWidth="0.12"
            strokeLinecap="round"
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.6 / (speed || 1) }}
          />
        );
      })}
    </svg>
  );
}

function parse(cellId: string): { x: number; y: number } {
  const match = /^r(\d+)c(\d+)$/.exec(cellId);
  return {
    x: match ? Number(match[2]) : 0,
    y: match ? Number(match[1]) : 0,
  };
}
