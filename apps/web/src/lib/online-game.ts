/**
 * Online multiplayer client (§28–§30).
 *
 * Sends intents (commands with actionId + expectedVersion) and renders
 * server-provided viewer projections. Never derives game state locally: the
 * server is authoritative (§30). Reconnect restores state via RESYNC.
 */

"use client";

import { create } from "zustand";
import type {
  ClientGameCommand,
  ClientMessage,
  RoomState,
  ServerMessage,
} from "@quintara/shared-types";
import type { ProjectedState, SequenceCandidate } from "@quintara/game-engine";
import {
  engineErrorMessage,
  isEngineErrorCode,
  type EngineErrorCode,
} from "@quintara/game-engine";
import { haptic, sounds } from "./sound";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";

type Phase = "HOME" | "LOBBY" | "PLAYING";

export interface OnlineGameState {
  connection: ConnectionStatus;
  phase: Phase;
  identity: { playerId: string; displayName: string; token: string } | null;
  room: RoomState | null;
  projected: ProjectedState | null;
  version: number;
  /** Server-authoritative current-turn deadline (epoch ms), if timed. */
  turnDeadlineAt: number | null;
  selectedCardId: string | null;
  lastMoveSummary: string | null;
  /** Most recent marker placement (§45 drop animation), from projected events. */
  lastPlacedCellId: string | null;
  errorMessage: string | null;
  matchmaking: boolean;

  connect: () => void;
  disconnect: () => void;
  createRoom: (options: {
    playerCount: number;
    aiSeats: number;
    aiDifficulty: string;
    password?: string;
    turnDurationMs?: number | null;
  }) => void;
  joinRoom: (roomCode: string, password?: string) => void;
  quickMatch: () => void;
  cancelQuickMatch: () => void;
  startGame: () => void;
  leaveRoom: () => void;
  rematch: () => void;
  selectCard: (cardId: string | null) => void;
  sendCommand: (command: ClientGameCommand) => void;
  selectSequences: (sequences: SequenceCandidate[]) => void;
  clearError: () => void;
}

let socket: WebSocket | null = null;
let requestCounter = 0;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pendingToken: string | null = null;

function wsUrl(): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured) return configured;
  if (typeof window === "undefined") return "ws://localhost:4000/ws";
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/ws`;
}

function request(): string {
  return `req-${++requestCounter}-${Date.now()}`;
}

export const useOnlineGame = create<OnlineGameState>((set, get) => {
  function send(message: ClientMessage): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  /**
   * User intents must not disappear silently while the socket is down. The
   * UI gates most controls, but keyboard/automation can still reach them.
   */
  function sendIntent(message: ClientMessage): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      set({ errorMessage: "Not connected yet — reconnecting…" });
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  function handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "WELCOME":
        set({
          identity: {
            playerId: message.identity.playerId,
            displayName: message.identity.displayName,
            token: message.identity.token,
          },
          connection: "connected",
          errorMessage: null,
        });
        pendingToken = message.identity.token;
        try {
          window.localStorage.setItem("quintara-auth", message.identity.token);
        } catch {
          // Storage unavailable — token stays in memory.
        }
        break;

      case "ROOM_STATE":
        set({
          room: message.room,
          phase: message.room.status === "LOBBY" ? "LOBBY" : "PLAYING",
        });
        break;

      case "GAME_STATE": {
        // Drop a selection the new authoritative state no longer supports.
        const selected = get().selectedCardId;
        const stillPlayable =
          selected !== null &&
          (message.state.legalActions?.mainActions ?? []).some(
            (action) => action.cardId === selected,
          );
        set({
          projected: message.state,
          version: message.state.version,
          turnDeadlineAt: message.turnDeadlineAt ?? null,
          phase: "PLAYING",
          lastPlacedCellId: null,
          errorMessage: null,
          ...(selected !== null && !stillPlayable
            ? { selectedCardId: null }
            : {}),
        });
        break;
      }

      case "GAME_EVENTS": {
        const summaries: string[] = [];
        for (const event of message.events) {
          switch (event.type) {
            case "MARKER_PLACED":
              summaries.push("Marker placed");
              sounds.place();
              haptic("light");
              set({ lastPlacedCellId: event.cellId });
              break;
            case "MARKER_REMOVED":
              summaries.push("Marker removed");
              sounds.remove();
              haptic("light");
              break;
            case "SEQUENCE_COMPLETED":
              summaries.push("Line completed!");
              sounds.sequence();
              haptic("success");
              break;
            case "DEAD_CARD_EXCHANGED":
              summaries.push("Dead card exchanged");
              sounds.exchange();
              break;
            case "TURN_SKIPPED_NO_LEGAL_ACTION":
              summaries.push("Turn skipped — no legal moves");
              break;
            case "GAME_WON":
              summaries.push("Game over!");
              sounds.victory();
              haptic("victory");
              break;
          }
        }
        if (summaries.length > 0) {
          set({ lastMoveSummary: summaries.join(" · ") });
        }
        break;
      }

      case "ACTION_RESULT":
        if (!message.ok) {
          const code =
            message.errorCode && isEngineErrorCode(message.errorCode)
              ? (message.errorCode as EngineErrorCode)
              : undefined;
          set({
            errorMessage: message.errorMessage
              ? message.errorMessage
              : code
                ? engineErrorMessage(code)
                : "That move was rejected.",
          });
        } else {
          set({ errorMessage: null });
        }
        break;

      case "MATCHMAKING_STATUS":
        set({ matchmaking: message.queued });
        break;

      case "ERROR":
        if (message.code === "UNAUTHENTICATED") {
          pendingToken = null;
          try {
            window.localStorage.removeItem("quintara-auth");
          } catch {
            // Storage unavailable — in-memory token is cleared above.
          }
          set({
            identity: null,
            room: null,
            projected: null,
            turnDeadlineAt: null,
            phase: "HOME",
            matchmaking: false,
            errorMessage:
              "Your session expired. Reconnecting as a new guest…",
          });
        } else {
          set({ errorMessage: message.message });
        }
        break;

      case "PONG":
        break;
    }
  }

  function connect(): void {
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    set({
      connection: get().connection === "idle" ? "connecting" : "reconnecting",
    });

    socket = new WebSocket(wsUrl());

    socket.onopen = () => {
      reconnectAttempts = 0;
      const token =
        pendingToken ??
        (typeof window !== "undefined"
          ? window.localStorage.getItem("quintara-auth")
          : null);
      send({ type: "AUTH", token: token ?? undefined });
      // Recover in-flight games after a reconnect (§30).
      if (get().room) {
        send({ type: "RESYNC", requestId: request() });
      }
    };

    socket.onmessage = (event) => {
      try {
        handleMessage(JSON.parse(event.data as string) as ServerMessage);
      } catch {
        // Ignore malformed frames.
      }
    };

    socket.onclose = () => {
      socket = null;
      if (get().connection === "idle") return;
      // §30: "Connection lost / Reconnecting…" — never eject immediately.
      // The server removes disconnected players from matchmaking, so clear
      // the local queue flag until the reconnect handshake completes.
      set({ connection: "reconnecting", matchmaking: false });
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const delay = Math.min(8000, 500 * 2 ** reconnectAttempts);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(() => connect(), delay);
    };

    socket.onerror = () => {
      // onclose follows and drives reconnection.
    };
  }

  return {
    connection: "idle",
    phase: "HOME",
    identity: null,
    room: null,
    projected: null,
    version: 0,
    turnDeadlineAt: null,
    selectedCardId: null,
    lastMoveSummary: null,
    lastPlacedCellId: null,
    errorMessage: null,
    matchmaking: false,

    connect,
    disconnect: () => {
      set({
        connection: "idle",
        phase: "HOME",
        room: null,
        projected: null,
        turnDeadlineAt: null,
        matchmaking: false,
        selectedCardId: null,
      });
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      socket = null;
    },

    createRoom: ({
      playerCount,
      aiSeats,
      aiDifficulty,
      password,
      turnDurationMs,
    }) => {
      sendIntent({
        type: "CREATE_ROOM",
        requestId: request(),
        mode: aiSeats > 0 ? "SOLO" : "PRIVATE",
        options: {
          playerCount,
          aiSeats,
          aiDifficulty: aiDifficulty as never,
          isPublic: false,
          ...(password ? { password } : {}),
          ...(turnDurationMs ? { turnDurationMs } : {}),
        },
      });
    },

    joinRoom: (roomCode, password) => {
      sendIntent({
        type: "JOIN_ROOM",
        requestId: request(),
        roomCode,
        password,
      });
    },

    quickMatch: () => {
      if (sendIntent({ type: "JOIN_QUICK_MATCH", requestId: request() })) {
        set({ matchmaking: true });
      }
    },

    cancelQuickMatch: () => {
      // Only meaningful while actually queued; leaving an already-matched
      // room is leaveRoom's job, not a matchmaking cancellation.
      if (!get().matchmaking) return;
      // Best-effort: the local queue is cleared even while offline.
      send({ type: "LEAVE_ROOM", requestId: request() });
      set({ matchmaking: false });
    },

    startGame: () => {
      sendIntent({ type: "START_GAME", requestId: request() });
    },

    leaveRoom: () => {
      send({ type: "LEAVE_ROOM", requestId: request() });
      set({
        phase: "HOME",
        room: null,
        projected: null,
        turnDeadlineAt: null,
        matchmaking: false,
        selectedCardId: null,
      });
    },

    rematch: () => {
      sendIntent({ type: "REMATCH", requestId: request() });
    },

    selectCard: (cardId) => {
      set({ selectedCardId: get().selectedCardId === cardId ? null : cardId });
    },

    sendCommand: (command) => {
      if (
        sendIntent({
          type: "GAME_COMMAND",
          requestId: request(),
          roomActionId: command.actionId,
          command,
        })
      ) {
        set({ selectedCardId: null });
      }
    },

    selectSequences: (sequences) => {
      const { projected, sendCommand } = get();
      if (!projected) return;
      sendCommand({
        type: "SELECT_SEQUENCE_SET",
        actionId: `web-${Date.now()}`,
        expectedVersion: projected.version,
        sequenceCellSets: sequences.map((s) => [...s.cells]),
      });
    },

    clearError: () => set({ errorMessage: null }),
  };
});

export function rememberToken(token: string): void {
  pendingToken = token;
}
