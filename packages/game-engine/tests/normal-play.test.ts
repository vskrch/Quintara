/**
 * Required normal-card tests (§115, §31–§34) + event ordering (§153).
 */
import { describe, expect, it } from "vitest";
import {
  applyCommand,
  getLegalActions,
  isDeadCard,
  scenario,
  validateGameState,
  EngineError,
  type MainAction,
} from "../src/index.js";
import { codeCells, codeCoords, handCardId } from "./helpers.js";

function mainActionsFor(
  state: ReturnType<typeof scenario.prototype.build>,
  playerId: string,
  code: string,
): MainAction[] {
  const cardId = handCardId(state, playerId, code);
  return getLegalActions(state, playerId).mainActions.filter(
    (a) => a.cardId === cardId,
  );
}

describe("normal card legal targets (§32, §115)", () => {
  it("offers both mapped cells when both are open", () => {
    const state = scenario()
      .withCurrentPlayer("A")
      .withHand("A", ["8H"])
      .build();
    const targets = mainActionsFor(state, "p-A", "8H");
    expect(targets.length).toBe(2);
    expect(targets.map((t) => t.targetCellId).sort()).toEqual(
      codeCells(state, "8H").sort(),
    );
  });

  it("offers only the open copy when one is occupied", () => {
    const base = scenario();
    const pre = base.build();
    const [first] = codeCoords(pre, "8H");
    const state = scenario()
      .withCurrentPlayer("A")
      .withHand("A", ["8H"])
      .withMarker("B", first!.row, first!.column)
      .build();
    const targets = mainActionsFor(state, "p-A", "8H");
    expect(targets.length).toBe(1);
    expect(targets[0]?.targetCellId).toBe(codeCells(state, "8H").find((id) => id !== codeCells(state, "8H")[0]) ?? "");
  });

  it("offers no target when both copies are occupied (dead card)", () => {
    const pre = scenario().build();
    const coords = codeCoords(pre, "8H");
    const state = scenario()
      .withCurrentPlayer("A")
      .withHand("A", ["8H"])
      .withMarker("A", coords[0]!.row, coords[0]!.column)
      .withMarker("B", coords[1]!.row, coords[1]!.column)
      .build();
    expect(mainActionsFor(state, "p-A", "8H").length).toBe(0);
    const card = state.cards[handCardId(state, "p-A", "8H")];
    expect(isDeadCard(state, card!)).toBe(true);
  });
});

describe("PLAY_NORMAL_CARD validation (§34, §115)", () => {
  function readyState() {
    return scenario()
      .withCurrentPlayer("A")
      .withHand("A", ["8H", "AC"])
      .withHand("B", ["2C"])
      .build();
  }

  it("rejects a mismatched target cell (TARGET_CARD_MISMATCH)", () => {
    const state = readyState();
    const wrongCell = codeCells(state, "AC")[0]!;
    expect(() =>
      applyCommand(state, {
        type: "PLAY_NORMAL_CARD",
        playerId: "p-A",
        actionId: "a1",
        cardId: handCardId(state, "p-A", "8H"),
        targetCellId: wrongCell,
      }),
    ).toThrow(
      expect.objectContaining({ code: "TARGET_CARD_MISMATCH" }) as Error,
    );
  });

  it("rejects an occupied target (TARGET_OCCUPIED)", () => {
    const pre = scenario().build();
    const [cell] = codeCoords(pre, "8H");
    const state = scenario()
      .withCurrentPlayer("A")
      .withHand("A", ["8H"])
      .withMarker("B", cell!.row, cell!.column)
      .build();
    const target = codeCells(state, "8H").find((id) => {
      const coords = codeCoords(state, "8H")[0];
      return coords && id.startsWith(`r${coords.row}c${coords.column}`);
    });
    // Use the occupied cell explicitly.
    const occupied = `r${cell!.row}c${cell!.column}`;
    expect(() =>
      applyCommand(state, {
        type: "PLAY_NORMAL_CARD",
        playerId: "p-A",
        actionId: "a1",
        cardId: handCardId(state, "p-A", "8H"),
        targetCellId: occupied,
      }),
    ).toThrow(expect.objectContaining({ code: "TARGET_OCCUPIED" }) as Error);
    expect(target).toBe(occupied);
  });

  it("rejects a card the player does not own (CARD_NOT_OWNED)", () => {
    const state = readyState();
    expect(() =>
      applyCommand(state, {
        type: "PLAY_NORMAL_CARD",
        playerId: "p-A",
        actionId: "a1",
        cardId: handCardId(state, "p-B", "2C"),
        targetCellId: codeCells(state, "2C")[0]!,
      }),
    ).toThrow(expect.objectContaining({ code: "CARD_NOT_OWNED" }) as Error);
  });

  it("rejects play out of turn (NOT_YOUR_TURN)", () => {
    const state = readyState();
    expect(() =>
      applyCommand(state, {
        type: "PLAY_NORMAL_CARD",
        playerId: "p-B",
        actionId: "a1",
        cardId: handCardId(state, "p-B", "2C"),
        targetCellId: codeCells(state, "2C")[0]!,
      }),
    ).toThrow(expect.objectContaining({ code: "NOT_YOUR_TURN" }) as Error);
  });

  it("rejects playing a Jack through the normal action (INVALID_JACK_TYPE)", () => {
    const state = scenario()
      .withCurrentPlayer("A")
      .withHand("A", ["JC"])
      .build();
    expect(() =>
      applyCommand(state, {
        type: "PLAY_NORMAL_CARD",
        playerId: "p-A",
        actionId: "a1",
        cardId: handCardId(state, "p-A", "JC"),
        targetCellId: codeCells(state, "8H")[0]!,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_JACK_TYPE" }) as Error);
  });

  it("rejects targeting a wild corner (INVALID_TARGET)", () => {
    const state = readyState();
    expect(() =>
      applyCommand(state, {
        type: "PLAY_NORMAL_CARD",
        playerId: "p-A",
        actionId: "a1",
        cardId: handCardId(state, "p-A", "8H"),
        targetCellId: "r0c0",
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_TARGET" }) as Error);
  });
});

describe("PLAY_NORMAL_CARD resolution (§34, §153)", () => {
  it("discards, places, draws and advances with deterministic events", () => {
    const state = scenario()
      .withCurrentPlayer("A")
      .withHand("A", ["8H"])
      .withHand("B", ["2C"])
      .build();
    const target = codeCells(state, "8H")[0]!;
    const result = applyCommand(state, {
      type: "PLAY_NORMAL_CARD",
      playerId: "p-A",
      actionId: "a1",
      cardId: handCardId(state, "p-A", "8H"),
      targetCellId: target,
    });

    // Marker placed for A's team.
    expect(result.state.board.cells[target]?.occupantTeamId).toBe("team-1");
    // Card discarded, replacement drawn.
    expect(result.state.discardPiles["p-A"]).toHaveLength(1);
    expect(result.state.hands["p-A"]).toHaveLength(1);
    // Turn advanced to B.
    expect(result.state.turnOrder[result.state.currentTurnIndex]).toBe("p-B");

    // Event order (§153): CARD_PLAYED, MARKER_PLACED, CARD_DRAWN,
    // TURN_COMPLETED, TURN_STARTED.
    expect(result.events.map((e) => e.type)).toEqual([
      "CARD_PLAYED",
      "MARKER_PLACED",
      "CARD_DRAWN",
      "TURN_COMPLETED",
      "TURN_STARTED",
    ]);
    expect(validateGameState(result.state)).toEqual([]);
  });

  it("increments version exactly once per command (§80)", () => {
    const state = scenario()
      .withCurrentPlayer("A")
      .withHand("A", ["8H"])
      .build();
    const result = applyCommand(state, {
      type: "PLAY_NORMAL_CARD",
      playerId: "p-A",
      actionId: "a1",
      cardId: handCardId(state, "p-A", "8H"),
      targetCellId: codeCells(state, "8H")[0]!,
    });
    expect(result.state.version).toBe(state.version + 1);
  });

  it("rejects stale expectedVersion (STALE_GAME_STATE, §80)", () => {
    const state = scenario()
      .withCurrentPlayer("A")
      .withHand("A", ["8H"])
      .build();
    expect(() =>
      applyCommand(state, {
        type: "PLAY_NORMAL_CARD",
        playerId: "p-A",
        actionId: "a1",
        expectedVersion: state.version + 5,
        cardId: handCardId(state, "p-A", "8H"),
        targetCellId: codeCells(state, "8H")[0]!,
      }),
    ).toThrow(expect.objectContaining({ code: "STALE_GAME_STATE" }) as Error);
  });

  it("accepts a matching expectedVersion", () => {
    const state = scenario()
      .withCurrentPlayer("A")
      .withHand("A", ["8H"])
      .build();
    const result = applyCommand(state, {
      type: "PLAY_NORMAL_CARD",
      playerId: "p-A",
      actionId: "a1",
      expectedVersion: state.version,
      cardId: handCardId(state, "p-A", "8H"),
      targetCellId: codeCells(state, "8H")[0]!,
    });
    expect(result.state.version).toBe(state.version + 1);
  });

  it("leaves state untouched after a rejected command (§137)", () => {
    const state = scenario()
      .withCurrentPlayer("A")
      .withHand("A", ["8H"])
      .build();
    const before = JSON.stringify(state);
    try {
      applyCommand(state, {
        type: "PLAY_NORMAL_CARD",
        playerId: "p-B",
        actionId: "a1",
        cardId: handCardId(state, "p-A", "8H"),
        targetCellId: codeCells(state, "8H")[0]!,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
    }
    expect(JSON.stringify(state)).toBe(before);
  });
});
