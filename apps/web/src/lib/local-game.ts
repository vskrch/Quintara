/**
 * Local game store: pass-and-play (§21 LOCAL) and solo vs AI (§21 SOLO).
 *
 * The engine runs in the browser; all rules are engine-owned — this store
 * only dispatches commands and renders projections (§140).
 */

"use client";

import { create } from "zustand";
import {
  applyCommand,
  createGame,
  currentPlayerId,
  engineErrorMessage,
  EngineError,
  getPlayer,
  projectStateForViewer,
  resolveSequenceSelectionDefault,
  startGame,
  validateGameState,
  type GameCommand,
  type GameState,
  type ProjectedState,
  type SequenceCandidate,
} from "@quintara/game-engine";
import {
  chooseBotAction,
  createBotContext,
  decisionToCommand,
  type AiDifficulty,
  type BotContext,
} from "@quintara/game-ai";
import { haptic, reactMusic, sounds } from "./sound";

export type LocalMode = "PASS_AND_PLAY" | "SOLO";

export interface LocalSeat {
  readonly id: string;
  readonly name: string;
  readonly isAi: boolean;
}

interface Toast {
  id: number;
  message: string;
  tone: "info" | "error" | "success";
}

export type LocalResult = "WIN" | "LOSS" | "DRAW" | "COMPLETE";

export interface LocalGameRecord {
  readonly id: string;
  readonly mode: LocalMode;
  readonly difficulty: AiDifficulty;
  readonly result: LocalResult;
  readonly winnerName: string | null;
  readonly turns: number;
  readonly finishedAt: string;
  readonly durationMs: number;
}

export interface LocalStats {
  readonly gamesPlayed: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly currentStreak: number;
  readonly bestStreak: number;
  readonly history: readonly LocalGameRecord[];
}

interface LocalSave {
  readonly schema: 1;
  readonly mode: LocalMode;
  readonly seats: LocalSeat[];
  readonly difficulty: AiDifficulty;
  /** Preserved so a reloaded Daily Challenge rematch stays on the daily seed. */
  readonly seed: string | null;
  readonly state: GameState;
  readonly savedAt: string;
}

const SAVE_KEY = "quintara-local-save-v1";
const STATS_KEY = "quintara-local-stats-v1";
const MAX_HISTORY = 30;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isLocalMode(value: unknown): value is LocalMode {
  return value === "SOLO" || value === "PASS_AND_PLAY";
}

function isDifficulty(value: unknown): value is AiDifficulty {
  return (
    value === "EASY" ||
    value === "MEDIUM" ||
    value === "HARD" ||
    value === "EXPERT"
  );
}

function isSeatList(value: unknown): value is LocalSeat[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 12 &&
    value.every(
      (seat) =>
        typeof seat === "object" &&
        seat !== null &&
        typeof (seat as LocalSeat).id === "string" &&
        typeof (seat as LocalSeat).name === "string" &&
        typeof (seat as LocalSeat).isAi === "boolean",
    )
  );
}

function loadSave(): LocalSave | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalSave>;
    if (
      parsed.schema !== 1 ||
      !isLocalMode(parsed.mode) ||
      !isSeatList(parsed.seats) ||
      !isDifficulty(parsed.difficulty) ||
      (parsed.seed !== undefined &&
        parsed.seed !== null &&
        typeof parsed.seed !== "string") ||
      typeof parsed.state !== "object" ||
      parsed.state === null ||
      parsed.state.status !== "ACTIVE" ||
      !Array.isArray(parsed.state.players) ||
      typeof parsed.state.version !== "number" ||
      validateGameState(parsed.state as GameState).length !== 0
    ) {
      store.removeItem(SAVE_KEY);
      return null;
    }
    return parsed as LocalSave;
  } catch {
    return null;
  }
}

function saveGame(snapshot: LocalSave): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(SAVE_KEY, JSON.stringify(snapshot));
  } catch {
    // Quota or private mode — persistence is a convenience, never a gate.
  }
}

function clearSave(): void {
  storage()?.removeItem(SAVE_KEY);
}

export function loadLocalStats(): LocalStats {
  const empty: LocalStats = {
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    currentStreak: 0,
    bestStreak: 0,
    history: [],
  };
  const store = storage();
  if (!store) return empty;
  try {
    const raw = store.getItem(STATS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<LocalStats>;
    if (
      typeof parsed.gamesPlayed !== "number" ||
      typeof parsed.wins !== "number" ||
      typeof parsed.losses !== "number" ||
      typeof parsed.draws !== "number" ||
      typeof parsed.currentStreak !== "number" ||
      typeof parsed.bestStreak !== "number" ||
      !Array.isArray(parsed.history)
    ) {
      return empty;
    }
    return {
      gamesPlayed: parsed.gamesPlayed,
      wins: parsed.wins,
      losses: parsed.losses,
      draws: parsed.draws,
      currentStreak: parsed.currentStreak,
      bestStreak: parsed.bestStreak,
      history: parsed.history.slice(0, MAX_HISTORY),
    };
  } catch {
    return empty;
  }
}

function recordResult(record: LocalGameRecord): void {
  const store = storage();
  if (!store) return;
  const stats = loadLocalStats();
  const history = [record, ...stats.history].slice(0, MAX_HISTORY);
  const nextStreak =
    record.mode === "SOLO"
      ? record.result === "WIN"
        ? stats.currentStreak + 1
        : 0
      : stats.currentStreak;
  const next: LocalStats = {
    gamesPlayed: stats.gamesPlayed + 1,
    wins: stats.wins + (record.mode === "SOLO" && record.result === "WIN" ? 1 : 0),
    losses:
      stats.losses + (record.mode === "SOLO" && record.result === "LOSS" ? 1 : 0),
    draws:
      stats.draws + (record.mode === "SOLO" && record.result === "DRAW" ? 1 : 0),
    currentStreak: nextStreak,
    bestStreak: Math.max(stats.bestStreak, nextStreak),
    history,
  };
  try {
    store.setItem(STATS_KEY, JSON.stringify(next));
  } catch {
    // Ignore quota failures.
  }
}

/** Stable seed shared by everyone playing the Daily Challenge on a given day. */
export function dailySeed(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `quintara-daily-${year}-${month}-${day}`;
}

export function dailyLabel(date = new Date()): string {
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface LocalGameState {
  mode: LocalMode | null;
  seats: LocalSeat[];
  difficulty: AiDifficulty;
  /** Fixed seed for challenge games; null for ordinary matches. */
  seed: string | null;
  state: GameState | null;
  projected: ProjectedState | null;
  selectedCardId: string | null;
  toasts: Toast[];
  botThinking: boolean;
  lastMoveSummary: string | null;
  /** Most recent marker placement, for the drop animation (§45). */
  lastPlacedCellId: string | null;

  start: (config: {
    mode: LocalMode;
    seats: LocalSeat[];
    difficulty: AiDifficulty;
    seed?: string;
  }) => void;
  /** Restores an interrupted local match, if one is saved. */
  hydrate: () => LocalMode | null;
  rematch: () => void;
  quit: () => void;

  selectCard: (cardId: string | null) => void;
  playAt: (cellId: string) => void;
  exchangeDeadCard: (cardId: string) => void;
  selectSequences: (sequences: SequenceCandidate[]) => void;
  useDefaultSequenceSelection: () => void;
  dismissToast: (id: number) => void;
}

let toastCounter = 0;
let botTimer: ReturnType<typeof setTimeout> | null = null;

function notice(
  message: string,
  tone: Toast["tone"] = "info",
): { id: number; message: string; tone: Toast["tone"] } {
  return { id: ++toastCounter, message, tone };
}

export const useLocalGame = create<LocalGameState>((set, get) => {
  /** Re-derives the projection for the correct viewer after every change. */
  function refresh(next: GameState): void {
    const { mode, seats } = get();
    const activeId = currentPlayerId(next);
    let viewerId: string | null = null;

    if (mode === "SOLO") {
      viewerId = seats.find((s) => !s.isAi)?.id ?? null;
    } else {
      viewerId = activeId;
    }

    const projected = projectStateForViewer(next, viewerId);

    // Drop a card selection that is no longer playable for the viewer:
    // selections must never leak across turns or into finished games.
    const selected = get().selectedCardId;
    const selectionStillPlayable =
      next.status === "ACTIVE" &&
      selected !== null &&
      (projected.legalActions?.mainActions ?? []).some(
        (action) => action.cardId === selected,
      );

    set({
      state: next,
      projected,
      ...(selected !== null && !selectionStillPlayable
        ? { selectedCardId: null }
        : {}),
    });

    if (next.status === "ACTIVE") {
      const { mode, seats, difficulty } = get();
      if (mode) {
        saveGame({
          schema: 1,
          mode,
          seats,
          difficulty,
          seed: get().seed,
          state: next,
          savedAt: new Date().toISOString(),
        });
      }
    } else {
      clearSave();
    }

    maybeScheduleBot(next);
  }

  function maybeScheduleBot(state: GameState): void {
    const { seats, mode } = get();
    if (mode !== "SOLO" || state.status !== "ACTIVE") return;
    const activeId = currentPlayerId(state);
    const seat = seats.find((s) => s.id === activeId);
    if (!seat?.isAi) return;
    if (state.turnPhase === "AWAITING_SEQUENCE_SELECTION") {
      // Same player resolves their own selection — act immediately.
    }

    set({ botThinking: true });
    if (botTimer) clearTimeout(botTimer);
    botTimer = setTimeout(() => {
      const current = get().state;
      if (!current || current.status !== "ACTIVE") {
        set({ botThinking: false });
        return;
      }
      const active = currentPlayerId(current);
      if (!active) {
        set({ botThinking: false });
        return;
      }
      const activeSeat = get().seats.find((s) => s.id === active);
      if (!activeSeat?.isAi) {
        set({ botThinking: false });
        return;
      }
      const context =
        botContexts[activeSeat.id] ??
        (botContexts[activeSeat.id] = createBotContext(get().difficulty));
      try {
        const decision = chooseBotAction(current, active, context);
        const command = decisionToCommand(
          decision,
          active,
          `bot-${Date.now()}`,
          current.version,
        );
        dispatch(command);
      } catch {
        set({ botThinking: false });
      }
    }, 550);
  }

  const botContexts: Record<string, BotContext> = {};

  function dispatch(command: GameCommand): void {
    const current = get().state;
    if (!current) return;
    try {
      const result = applyCommand(current, command);
      set({
        botThinking: false,
        ...("targetCellId" in command &&
        command.type !== "PLAY_REMOVE_JACK"
          ? { lastPlacedCellId: command.targetCellId }
          : {}),
      });
      const previousActive = currentPlayerId(current);
      refresh(result.state);
      afterEvents(result.state, command, previousActive);
    } catch (error) {
      set({ botThinking: false });
      if (error instanceof EngineError) {
        set({
          toasts: [
            ...get().toasts.slice(-3),
            notice(engineErrorMessage(error.code), "error"),
          ],
        });
        sounds.error();
        haptic("warning");
      }
    }
  }

  function afterEvents(
    state: GameState,
    command: GameCommand,
    previousActive: string | null,
  ): void {
    const summaries: string[] = [];
    if (command.type === "PLAY_NORMAL_CARD") {
      const card = state.cards[command.cardId];
      const cell = command.targetCellId.replace("r", "R").replace("c", "C");
      summaries.push(`${card?.code ?? "Card"} → ${cell}`);
      sounds.place();
      reactMusic("place");
      haptic("light");
    } else if (command.type === "PLAY_WILD_JACK") {
      const cell = command.targetCellId.replace("r", "R").replace("c", "C");
      summaries.push(`Two-Eyed Jack → ${cell}`);
      sounds.jack();
      haptic("light");
    } else if (command.type === "PLAY_REMOVE_JACK") {
      const cell = command.targetCellId.replace("r", "R").replace("c", "C");
      summaries.push(`One-Eyed Jack removed a marker at ${cell}`);
      sounds.remove();
      haptic("light");
    } else if (command.type === "EXCHANGE_DEAD_CARD") {
      summaries.push("Dead card exchanged");
      sounds.exchange();
    } else if (command.type === "SELECT_SEQUENCE_SET") {
      summaries.push("Line completed!");
    }

    if (summaries.length > 0) {
      set({
        lastMoveSummary: summaries.join(" · "),
      });
    }

    if (state.status === "FINISHED") {
      const mode = get().mode;
      if (mode) {
        const winner = state.winnerTeamId
          ? (state.teams.find((team) => team.id === state.winnerTeamId) ?? null)
          : null;
        let result: LocalResult;
        if (state.resultType === "STALEMATE") {
          result = "DRAW";
        } else if (mode === "PASS_AND_PLAY") {
          result = "COMPLETE";
        } else {
          const human = get().seats.find((seat) => !seat.isAi);
          const humanTeam = human
            ? state.players.find((player) => player.id === human.id)?.teamId
            : null;
          result =
            humanTeam && state.winnerTeamId === humanTeam ? "WIN" : "LOSS";
        }
        const finishedAt = state.finishedAt ?? new Date().toISOString();
        recordResult({
          id: state.id,
          mode,
          difficulty: get().difficulty,
          result,
          winnerName: winner?.name ?? null,
          turns: state.turnNumber,
          finishedAt,
          durationMs: Math.max(
            0,
            new Date(finishedAt).getTime() - new Date(state.createdAt).getTime(),
          ),
        });
      }
      if (state.winnerTeamId) {
        sounds.victory();
        haptic("victory");
      }
      return;
    }

    const nextActive = currentPlayerId(state);
    const mode = get().mode;
    // Same-player sub-steps (dead-card exchange, ambiguous line selection)
    // must not interrupt the acting player mid-turn. A seat change gets a
    // light cue, but the next hand is shown immediately for pass-and-play.
    if (
      mode === "PASS_AND_PLAY" &&
      nextActive !== null &&
      nextActive !== previousActive
    ) {
      sounds.turn();
      reactMusic("turn");
      haptic("light");
    }
  }

  return {
    mode: null,
    seats: [],
    difficulty: "MEDIUM",
    seed: null,
    state: null,
    projected: null,
    selectedCardId: null,
    toasts: [],
    botThinking: false,
    lastMoveSummary: null,
    lastPlacedCellId: null,

    start: ({ mode, seats, difficulty, seed }) => {
      if (botTimer) clearTimeout(botTimer);
      for (const key of Object.keys(botContexts)) delete botContexts[key];

      const created = createGame({
        gameId: `local-${Date.now()}`,
        players: seats.map((seat) => ({ id: seat.id, name: seat.name })),
        seed:
          seed ??
          (typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `seed-${Date.now()}`),
      });
      const started = startGame(created).state;

      set({
        mode,
        seats,
        difficulty,
        seed: seed ?? null,
        state: started,
        selectedCardId: null,
        toasts: [notice("Game started — good luck!", "success")],
        lastMoveSummary: null,
        lastPlacedCellId: null,
      });
      refresh(started);
      sounds.deal();
      haptic("medium");
    },

    hydrate: () => {
      if (get().state) return null;
      const saved = loadSave();
      if (!saved) return null;
      set({
        mode: saved.mode,
        seats: saved.seats,
        difficulty: saved.difficulty,
        seed: saved.seed ?? null,
        state: saved.state,
        selectedCardId: null,
        toasts: [notice("Saved game restored.", "info")],
        lastMoveSummary: null,
        lastPlacedCellId: null,
        botThinking: false,
      });
      refresh(saved.state);
      return saved.mode;
    },

    rematch: () => {
      const { mode, seats, difficulty, seed } = get();
      if (!mode) return;
      get().start({ mode, seats, difficulty, seed: seed ?? undefined });
    },

    quit: () => {
      if (botTimer) clearTimeout(botTimer);
      clearSave();
      set({
        mode: null,
        seed: null,
        state: null,
        projected: null,
        seats: [],
        selectedCardId: null,
        botThinking: false,
        lastPlacedCellId: null,
        toasts: [],
      });
    },

    selectCard: (cardId) => {
      set({ selectedCardId: get().selectedCardId === cardId ? null : cardId });
      sounds.select();
      reactMusic("select");
      haptic("selection");
    },

    playAt: (cellId) => {
      const { state, selectedCardId, projected, seats, mode } = get();
      if (!state || !selectedCardId || !projected) return;
      const legal = projected.legalActions;
      if (!legal) return;

      const match = [
        ...legal.mainActions,
      ].find(
        (a) => a.cardId === selectedCardId && a.targetCellId === cellId,
      );
      if (!match) {
        sounds.error();
        return;
      }

      const viewerId =
        mode === "SOLO"
          ? (seats.find((s) => !s.isAi)?.id ?? null)
          : currentPlayerId(state);
      if (!viewerId) return;

      const command: GameCommand = {
        type: match.type,
        playerId: viewerId,
        actionId: `local-${Date.now()}`,
        expectedVersion: state.version,
        cardId: match.cardId,
        targetCellId: match.targetCellId,
      };
      set({ selectedCardId: null });
      dispatch(command);
    },

    exchangeDeadCard: (cardId) => {
      const { state, projected, seats, mode } = get();
      if (!state || !projected?.legalActions) return;
      const viewerId =
        mode === "SOLO"
          ? (seats.find((s) => !s.isAi)?.id ?? null)
          : currentPlayerId(state);
      if (!viewerId) return;
      const exchange = projected.legalActions.deadExchanges.find(
        (e) => e.cardId === cardId,
      );
      if (!exchange) {
        set({
          toasts: [...get().toasts.slice(-3), notice("That card is not dead.", "error")],
        });
        return;
      }
      dispatch({
        type: "EXCHANGE_DEAD_CARD",
        playerId: viewerId,
        actionId: `local-${Date.now()}`,
        expectedVersion: state.version,
        cardId,
      });
    },

    selectSequences: (sequences) => {
      const { state, seats, mode } = get();
      if (!state) return;
      const viewerId =
        mode === "SOLO"
          ? (seats.find((s) => !s.isAi)?.id ?? null)
          : currentPlayerId(state);
      if (!viewerId) return;
      sounds.sequence();
      reactMusic("sequence");
      haptic("success");
      dispatch({
        type: "SELECT_SEQUENCE_SET",
        playerId: viewerId,
        actionId: `local-${Date.now()}`,
        expectedVersion: state.version,
        sequenceCellSets: sequences.map((s) => [...s.cells]),
      });
    },

    useDefaultSequenceSelection: () => {
      const { state } = get();
      if (!state) return;
      const sequences = resolveSequenceSelectionDefault(state);
      get().selectSequences([...sequences]);
    },

    dismissToast: (id) => {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
  };
});

/** Player display name lookup for turn banners. */
export function seatName(state: GameState, playerId: string): string {
  try {
    return getPlayer(state, playerId).name;
  } catch {
    return playerId;
  }
}
