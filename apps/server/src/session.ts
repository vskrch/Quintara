/**
 * Room & game session management.
 *
 * The server is authoritative (§28, §139): clients send intents; every
 * command is validated by the engine, applied atomically (§138), made
 * idempotent via persisted action ids (§79), versioned (§80) and broadcast as
 * per-viewer projections only (§88).
 */

import {
  applyCommand,
  createGame,
  currentPlayerId,
  detectCandidateSequences,
  engineErrorMessage,
  EngineError,
  findMaximumCompatibleSets,
  generateSecureSeed,
  getPlayer,
  getLegalActions,
  MAX_REQUIRED_SEQUENCES,
  MAX_TURN_DURATION_MS,
  MIN_TURN_DURATION_MS,
  projectEventsForViewer,
  projectStateForViewer,
  resolveSequenceSelectionDefault,
  startGame,
  type CellId,
  type DomainEvent,
  type GameCommand,
  type GameState,
  type MainAction,
  type TeamId,
} from "@quintara/game-engine";
import {
  createHash,
  randomInt,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  chooseBotAction,
  createBotContext,
  decisionToCommand,
  type AiDifficulty,
  type BotContext,
} from "@quintara/game-ai";
import type {
  ClientGameCommand,
  ConnectionStatus,
  GameMode,
  RoomOptions,
  RoomOptionsInput,
  RoomPlayerInfo,
  RoomState,
  ServerMessage,
  GameSummary,
} from "@quintara/shared-types";
import {
  InMemoryGameStore,
  type GameStore,
  type StoredGame,
} from "./store.js";

interface RoomPlayer {
  playerId: string;
  displayName: string;
  isAi: boolean;
  isHost: boolean;
  connection: ConnectionStatus;
}

/** Server-only room settings. The password hash never leaves this object. */
interface RoomSettings extends Omit<RoomOptions, "hasPassword"> {
  passwordHash: string | null;
}

interface Room {
  id: string;
  code: string;
  mode: GameMode;
  options: RoomSettings;
  hostPlayerId: string;
  players: RoomPlayer[];
  spectators: Set<string>;
  status: "LOBBY" | "ACTIVE" | "FINISHED";
  game: StoredGame | null;
  botContexts: Map<string, BotContext>;
  turnTimer: ReturnType<typeof setTimeout> | null;
  botTimer: ReturnType<typeof setTimeout> | null;
  /** Absolute deadline for the current turn, or null when untimed. */
  turnDeadlineAt: number | null;
  createdAt: number;
  /** Last meaningful state change; drives idle-room TTLs. */
  lastActivityAt: number;
}

export interface SessionSink {
  /** Deliver a message to one connected player (or spectator). */
  send(playerId: string, message: ServerMessage): void;
  /** Deliver to every member of a room (players + spectators). */
  broadcastRoom(roomId: string, message: ServerMessage): void;
}

const DEFAULT_OPTIONS: RoomSettings = {
  playerCount: 2,
  teamSizes: [],
  requiredSequences: null,
  turnDurationMs: null,
  isPublic: false,
  passwordHash: null,
  aiSeats: 0,
  aiDifficulty: "MEDIUM",
};

const RECONNECT_GRACE_MS = 1000 * 60 * 3;
const PENDING_ROOM_GRACE_MS = 1000 * 30;
const LOBBY_TTL_MS = 1000 * 60 * 30;
const FINISHED_TTL_MS = 1000 * 60 * 60 * 2;
const QUICK_QUEUE_TTL_MS = 1000 * 60 * 2;
/** Public quick matches need a deadline; otherwise one AFK player stalls it. */
const QUICK_MATCH_TURN_MS = 1000 * 120;
/** A disconnected player's turn is auto-resolved after this short delay. */
const DISCONNECTED_TURN_MS = 1000 * 10;
const MAX_ROOM_PLAYERS = 12;
const MAX_AI_SEATS = 11;
const MAX_ROOMS = 1000;
const MAX_ROOMS_PER_MINUTE = 10;
const MAX_PASSWORD_LENGTH = 64;
const ROOM_CODE_LENGTH = 8;
const GAME_MODES: readonly GameMode[] = [
  "SOLO",
  "LOCAL",
  "PRIVATE",
  "QUICK_MATCH",
  "RANKED",
];
const AI_DIFFICULTIES = ["EASY", "MEDIUM", "HARD", "EXPERT"] as const;

/** Thrown when a caller exceeds a server resource limit. */
export class RoomLimitError extends Error {
  constructor(
    readonly code: "RATE_LIMITED" | "SERVER_BUSY",
    message: string,
  ) {
    super(message);
    this.name = "RoomLimitError";
  }
}

function hashPassword(password: string): string {
  const salt = randomUUID().replaceAll("-", "");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(stored: string | null, candidate: unknown): boolean {
  if (!stored) return false;
  // Creation trims and caps the password; verification must apply the exact
  // same normalisation or long/whitespace-padded passwords become unjoinable.
  const normalised = normalisePassword(candidate);
  if (!normalised) return false;
  const [salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(normalised, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function normaliseMode(mode: unknown): GameMode {
  return typeof mode === "string" && GAME_MODES.includes(mode as GameMode)
    ? (mode as GameMode)
    : "PRIVATE";
}

function normalisePassword(password: unknown): string | null {
  if (typeof password !== "string") return null;
  const trimmed = password.trim();
  return trimmed.length > 0 ? trimmed.slice(0, MAX_PASSWORD_LENGTH) : null;
}

function stableCommandPayload(command: GameCommand | ClientGameCommand): string {
  // Stable key ordering makes a retry with re-ordered JSON keys count as the
  // same action instead of a false ACTION_ID_REUSED.
  const record = command as unknown as Record<string, unknown>;
  const ordered = Object.keys(record)
    .sort()
    .map((key) => [key, record[key]]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

function disconnectKey(roomId: string, playerId: string): string {
  // A player can have a timer for more than one abandoned room while moving
  // between lobbies; a player-only key silently cancelled the older timer.
  return `${roomId}:${playerId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/**
 * Rebuilds a command from an explicit allowlist. This both prevents unknown
 * client fields from reaching the event/replay store and turns malformed
 * shapes into a clean BAD_COMMAND instead of an exception.
 */
export function buildAuthoritativeCommand(
  command: unknown,
  playerId: string,
): GameCommand | null {
  if (!isRecord(command)) return null;
  const { type, actionId } = command;
  if (!isBoundedString(actionId) || typeof type !== "string") return null;

  const rawVersion = command.expectedVersion;
  if (
    rawVersion !== undefined &&
    (typeof rawVersion !== "number" ||
      !Number.isInteger(rawVersion) ||
      rawVersion < 0)
  ) {
    return null;
  }
  const base: {
    playerId: string;
    actionId: string;
    expectedVersion?: number;
  } = {
    playerId,
    actionId,
    ...(rawVersion === undefined ? {} : { expectedVersion: rawVersion }),
  };

  switch (type) {
    case "EXCHANGE_DEAD_CARD":
      return isBoundedString(command.cardId)
        ? ({ ...base, type, cardId: command.cardId } as GameCommand)
        : null;
    case "PLAY_NORMAL_CARD":
    case "PLAY_WILD_JACK":
    case "PLAY_REMOVE_JACK":
      return isBoundedString(command.cardId) &&
        isBoundedString(command.targetCellId, 16)
        ? ({
            ...base,
            type,
            cardId: command.cardId,
            targetCellId: command.targetCellId,
          } as GameCommand)
        : null;
    case "SELECT_SEQUENCE_SET": {
      const sets = command.sequenceCellSets;
      if (
        !Array.isArray(sets) ||
        sets.length === 0 ||
        sets.length > 12 ||
        !sets.every(
          (set) =>
            Array.isArray(set) &&
            set.length > 0 &&
            set.length <= 10 &&
            set.every((cell) => isBoundedString(cell, 16)),
        )
      ) {
        return null;
      }
      return {
        ...base,
        type,
        sequenceCellSets: sets.map((set) => [...(set as string[])]),
      } as GameCommand;
    }
    default:
      return null;
  }
}

export class SessionManager {
  private readonly rooms = new Map<string, Room>();
  private readonly roomsByCode = new Map<string, Room>();
  private readonly roomByPlayer = new Map<string, string>();
  private readonly quickQueue: {
    playerId: string;
    displayName: string;
    queuedAt: number;
  }[] = [];
  private readonly disconnectTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly roomCreationLog = new Map<string, number[]>();
  private janitor: ReturnType<typeof setInterval> | null = null;
  private sink: SessionSink = { send: () => {}, broadcastRoom: () => {} };

  constructor(private readonly store: GameStore = new InMemoryGameStore()) {}

  attachSink(sink: SessionSink): void {
    this.sink = sink;
  }

  /** Stops the janitor and every pending timer (graceful shutdown/tests). */
  dispose(): void {
    if (this.janitor) {
      clearInterval(this.janitor);
      this.janitor = null;
    }
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.disconnectTimers.clear();
    for (const room of this.rooms.values()) {
      if (room.botTimer) clearTimeout(room.botTimer);
      if (room.turnTimer) clearTimeout(room.turnTimer);
    }
    this.quickQueue.length = 0;
  }

  private ensureJanitor(): void {
    if (this.janitor) return;
    this.janitor = setInterval(() => this.sweepStale(), 60_000);
    this.janitor.unref?.();
  }

  private sweepStale(): void {
    const now = Date.now();
    for (let i = this.quickQueue.length - 1; i >= 0; i--) {
      const entry = this.quickQueue[i];
      if (entry && now - entry.queuedAt >= QUICK_QUEUE_TTL_MS) {
        this.quickQueue.splice(i, 1);
      }
    }
    // Guest identities are cheap and unbounded; prune old creation windows.
    for (const [playerId, timestamps] of this.roomCreationLog) {
      const recent = timestamps.filter((timestamp) => now - timestamp < 60_000);
      if (recent.length === 0) this.roomCreationLog.delete(playerId);
      else if (recent.length !== timestamps.length) {
        this.roomCreationLog.set(playerId, recent);
      }
    }
    for (const room of [...this.rooms.values()]) {
      const idleFor = now - room.lastActivityAt;
      if (
        (room.status === "LOBBY" && idleFor > LOBBY_TTL_MS) ||
        (room.status === "FINISHED" && idleFor > FINISHED_TTL_MS)
      ) {
        this.disposeRoom(room);
        continue;
      }
      // A REST-created room whose owner never opened a socket should not
      // linger for the full lobby TTL.
      if (
        room.status === "LOBBY" &&
        room.game === null &&
        idleFor > PENDING_ROOM_GRACE_MS &&
        !room.players.some(
          (p) =>
            !p.isAi &&
            (p.connection === "CONNECTED" ||
              this.disconnectTimers.has(disconnectKey(room.id, p.playerId))),
        ) &&
        room.spectators.size === 0
      ) {
        this.disposeRoom(room);
        continue;
      }
      // Safety net for lost/legacy timers: an active room with no connected
      // humans and no spectator is dead weight. Its disconnect timers should
      // normally dispose it first.
      if (
        room.status === "ACTIVE" &&
        idleFor > RECONNECT_GRACE_MS + 10_000 &&
        !room.players.some(
          (p) => !p.isAi && p.connection === "CONNECTED",
        ) &&
        room.spectators.size === 0
      ) {
        this.disposeRoom(room);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------

  createRoom(
    hostPlayerId: string,
    displayName: string,
    mode: GameMode,
    partial: RoomOptionsInput,
    hostConnected = true,
  ): RoomState {
    if (this.rooms.size >= MAX_ROOMS) {
      throw new RoomLimitError(
        "SERVER_BUSY",
        "The server is at capacity. Try again shortly.",
      );
    }
    this.recordRoomCreation(hostPlayerId);
    this.ensureJanitor();

    // Treat the payload as untrusted even though the type says otherwise:
    // REST/WS callers can send any JSON shape.
    const input =
      partial && typeof partial === "object"
        ? (partial as RoomOptionsInput)
        : {};

    // Normalise client-supplied options: a missing/invalid playerCount would
    // otherwise make createGame throw mid-startGame with a confusing error.
    const requestedCount = Number(input.playerCount);
    const playerCount =
      Number.isInteger(requestedCount) &&
      requestedCount >= 2 &&
      requestedCount <= MAX_ROOM_PLAYERS
        ? requestedCount
        : DEFAULT_OPTIONS.playerCount;

    // AI seats can never crowd out the host: at least one seat stays human.
    const requestedAiSeats = Number(input.aiSeats ?? DEFAULT_OPTIONS.aiSeats);
    const aiSeats =
      Number.isInteger(requestedAiSeats) && requestedAiSeats > 0
        ? Math.min(
            playerCount - 1,
            MAX_AI_SEATS,
            requestedAiSeats,
          )
        : 0;

    // A team configuration that does not match the seat count would make
    // createGame reject the game later; fall back to the default layout.
    const requestedTeamSizes = input.teamSizes;
    const teamSizes =
      Array.isArray(requestedTeamSizes) &&
      requestedTeamSizes.length > 0 &&
      requestedTeamSizes.length <= 3 &&
      requestedTeamSizes.every(
        (size) => Number.isInteger(size) && size > 0,
      ) &&
      requestedTeamSizes.reduce((a, b) => a + b, 0) === playerCount
        ? [...requestedTeamSizes]
        : [];

    const requestedSequences = Number(input.requiredSequences);
    const requiredSequences =
      Number.isInteger(requestedSequences) &&
      requestedSequences >= 1 &&
      requestedSequences <= MAX_REQUIRED_SEQUENCES
        ? requestedSequences
        : null;

    const requestedDuration = Number(input.turnDurationMs);
    const turnDurationMs =
      Number.isInteger(requestedDuration) &&
      requestedDuration >= MIN_TURN_DURATION_MS &&
      requestedDuration <= MAX_TURN_DURATION_MS
        ? requestedDuration
        : null;

    const aiDifficulty =
      typeof input.aiDifficulty === "string" &&
      AI_DIFFICULTIES.includes(input.aiDifficulty as never)
        ? (input.aiDifficulty as RoomSettings["aiDifficulty"])
        : DEFAULT_OPTIONS.aiDifficulty;

    const password = normalisePassword(input.password);
    const options: RoomSettings = {
      playerCount,
      teamSizes,
      requiredSequences,
      turnDurationMs,
      isPublic: input.isPublic === true,
      passwordHash: password ? hashPassword(password) : null,
      aiSeats,
      aiDifficulty,
    };

    const room: Room = {
      id: `room-${randomUUID()}`,
      code: this.unusedRoomCode(),
      mode: normaliseMode(mode),
      options,
      hostPlayerId,
      players: [
        {
          playerId: hostPlayerId,
          displayName,
          isAi: false,
          isHost: true,
          connection: hostConnected ? "CONNECTED" : "RECONNECTING",
        },
      ],
      spectators: new Set(),
      status: "LOBBY",
      game: null,
      botContexts: new Map(),
      turnTimer: null,
      botTimer: null,
      turnDeadlineAt: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    for (let i = 0; i < options.aiSeats; i++) {
      room.players.push({
        playerId: `ai-${room.code}-${i + 1}`,
        displayName: `Bot ${i + 1}`,
        isAi: true,
        isHost: false,
        connection: "CONNECTED",
      });
    }

    // A player belongs to at most one room: creating a room abandons any
    // previous membership, or the old room keeps a ghost seat forever.
    this.leaveRoom(hostPlayerId);
    this.rooms.set(room.id, room);
    this.roomsByCode.set(room.code, room);
    this.roomByPlayer.set(hostPlayerId, room.id);
    if (!hostConnected) {
      // REST-created host: hold the seat only long enough for the client to
      // authenticate over the socket.
      this.scheduleDisconnect(room, hostPlayerId, PENDING_ROOM_GRACE_MS);
    }
    return this.roomState(room);
  }

  private recordRoomCreation(playerId: string): void {
    const now = Date.now();
    const recent = (this.roomCreationLog.get(playerId) ?? []).filter(
      (timestamp) => now - timestamp < 60_000,
    );
    if (recent.length >= MAX_ROOMS_PER_MINUTE) {
      throw new RoomLimitError(
        "RATE_LIMITED",
        "Too many rooms created. Wait a minute and try again.",
      );
    }
    recent.push(now);
    this.roomCreationLog.set(playerId, recent);
  }

  joinRoom(
    playerId: string,
    displayName: string,
    roomCode: string,
    password?: string,
    connected = true,
  ): { room?: RoomState; error?: string } {
    const code =
      typeof roomCode === "string" ? roomCode.trim().toUpperCase() : "";
    if (!code || code.length > ROOM_CODE_LENGTH) {
      return { error: "Room not found. Check the code and try again." };
    }
    const room = this.roomsByCode.get(code);
    if (!room) {
      return { error: "Room not found. Check the code and try again." };
    }

    // A known member may reconnect with their signed identity without
    // re-entering the password.
    const existing = room.players.find((p) => p.playerId === playerId);
    if (existing) {
      if (this.roomByPlayer.get(playerId) !== room.id) {
        this.leaveRoom(playerId);
      }
      existing.connection = connected ? "CONNECTED" : "RECONNECTING";
      this.roomByPlayer.set(playerId, room.id);
      if (connected) {
        this.clearDisconnectTimer(room.id, playerId);
      } else {
        this.scheduleDisconnect(room, playerId, PENDING_ROOM_GRACE_MS);
      }
      room.lastActivityAt = Date.now();
      this.broadcastRoomState(room);
      return { room: this.roomState(room) };
    }

    // Uniform failure: never reveal whether a code exists to an unauthorised
    // joiner (room enumeration).
    if (
      room.options.passwordHash !== null &&
      !verifyPassword(room.options.passwordHash, password)
    ) {
      return { error: "Room not found or password incorrect." };
    }
    if (room.status !== "LOBBY") {
      return { error: "This game has already started." };
    }
    if (room.players.length >= room.options.playerCount) {
      return { error: "This room is full." };
    }

    // Single-room membership: joining abandons any previous room.
    if (this.roomByPlayer.get(playerId) !== room.id) {
      this.leaveRoom(playerId);
    }

    room.players.push({
      playerId,
      displayName,
      isAi: false,
      isHost: false,
      connection: connected ? "CONNECTED" : "RECONNECTING",
    });
    this.roomByPlayer.set(playerId, room.id);
    room.lastActivityAt = Date.now();
    if (!connected) {
      // A REST join reserves a seat but must not block the lobby forever if
      // the client never opens a socket.
      this.scheduleDisconnect(room, playerId, PENDING_ROOM_GRACE_MS);
    }
    this.broadcastRoomState(room);
    return { room: this.roomState(room) };
  }

  spectateRoom(
    playerId: string,
    roomCode: string,
    password?: string,
  ): { error?: string } {
    const code =
      typeof roomCode === "string" ? roomCode.trim().toUpperCase() : "";
    const room = code ? this.roomsByCode.get(code) : undefined;
    if (!room) return { error: "Room not found." };
    if (
      room.options.passwordHash !== null &&
      !verifyPassword(room.options.passwordHash, password)
    ) {
      return { error: "Room not found or password incorrect." };
    }
    if (room.players.some((player) => player.playerId === playerId)) {
      return { error: "You are already a player in this room." };
    }
    if (this.roomByPlayer.get(playerId) !== room.id) {
      this.leaveRoom(playerId);
    }
    room.spectators.add(playerId);
    this.roomByPlayer.set(playerId, room.id);
    room.lastActivityAt = Date.now();
    this.sink.send(playerId, { type: "ROOM_STATE", room: this.roomState(room) });
    if (room.game) {
      this.sink.send(playerId, {
        type: "GAME_STATE",
        state: projectStateForViewer(room.game.currentState, null),
        turnDeadlineAt: room.turnDeadlineAt,
      });
    }
    return {};
  }

  leaveRoom(playerId: string): void {
    // Leaving also cancels a pending quick-match request (§58).
    this.cancelQuickMatch(playerId);
    const roomId = this.roomByPlayer.get(playerId);
    if (!roomId) return;
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.spectators.delete(playerId);
    this.clearDisconnectTimer(room.id, playerId);
    const player = room.players.find((p) => p.playerId === playerId);
    if (player && !player.isAi) {
      if (room.status === "ACTIVE") {
        // §30/§96: disconnection does not immediately eject the player.
        player.connection = "RECONNECTING";
        this.scheduleDisconnect(room, playerId);
      } else {
        // LOBBY and FINISHED release the seat immediately. A FINISHED room
        // keeps its roster for the rematch — a departed player must not
        // ghost a seat, or the rematch starts shorthanded or not at all.
        this.removeHumanPlayer(room, playerId);
      }
    }
    if (room.hostPlayerId === playerId) this.promoteHost(room, playerId);
    this.roomByPlayer.delete(playerId);
    room.lastActivityAt = Date.now();
    this.broadcastRoomState(room);
    this.sweepIfEmpty(room);
  }

  private clearDisconnectTimer(roomId: string, playerId: string): void {
    const key = disconnectKey(roomId, playerId);
    const existing = this.disconnectTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.disconnectTimers.delete(key);
    }
  }

  private scheduleDisconnect(
    room: Room,
    playerId: string,
    graceMs = RECONNECT_GRACE_MS,
  ): void {
    this.clearDisconnectTimer(room.id, playerId);
    const key = disconnectKey(room.id, playerId);
    this.disconnectTimers.set(
      key,
      setTimeout(() => {
        this.disconnectTimers.delete(key);
        const current = room.players.find((p) => p.playerId === playerId);
        if (!current || current.connection !== "RECONNECTING") return;
        if (room.status === "LOBBY") {
          this.removeHumanPlayer(room, playerId);
        } else {
          current.connection = "DISCONNECTED";
        }
        room.lastActivityAt = Date.now();
        if (room.hostPlayerId === playerId) this.promoteHost(room, playerId);
        this.broadcastRoomState(room);
        // A disconnected player whose turn comes up must not stall a
        // timerless room. Resolve the turn after a short visible delay, but
        // never restart the clock because an idle bystander dropped.
        if (
          room.status === "ACTIVE" &&
          room.game !== null &&
          currentPlayerId(room.game.currentState) === playerId
        ) {
          this.afterAction(room);
        }
        this.sweepIfEmpty(room);
      }, graceMs),
    );
  }

  private removeHumanPlayer(room: Room, playerId: string): void {
    room.players = room.players.filter(
      (p) => p.playerId !== playerId || p.isAi,
    );
    if (this.roomByPlayer.get(playerId) === room.id) {
      this.roomByPlayer.delete(playerId);
    }
    this.clearDisconnectTimer(room.id, playerId);
  }

  private promoteHost(room: Room, departingId?: string): void {
    const candidates = room.players.filter(
      (p) => !p.isAi && p.playerId !== departingId,
    );
    const nextHost =
      candidates.find((p) => p.connection === "CONNECTED") ?? candidates[0];
    if (!nextHost) return;
    room.hostPlayerId = nextHost.playerId;
    for (const player of room.players) {
      player.isHost = player.playerId === nextHost.playerId;
    }
  }

  setConnection(playerId: string, connected: boolean): void {
    // A socket that dies while queued must not stay in matchmaking forever.
    if (!connected) this.cancelQuickMatch(playerId);

    const roomId = this.roomByPlayer.get(playerId);
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room) return;
    const player = room.players.find((p) => p.playerId === playerId);
    if (!player) return;

    if (connected) {
      this.clearDisconnectTimer(room.id, playerId);
      player.connection = "CONNECTED";
      room.lastActivityAt = Date.now();
      // Reconnecting as the active seat must resume the existing deadline,
      // not restart it. Otherwise refreshing the page grants a fresh turn
      // clock every time. Non-active seats never touch the clock.
      const game = room.game;
      if (game && currentPlayerId(game.currentState) === playerId) {
        if (room.turnDeadlineAt !== null) {
          const remaining = room.turnDeadlineAt - Date.now();
          if (room.turnTimer) {
            clearTimeout(room.turnTimer);
            room.turnTimer = null;
          }
          if (remaining <= 0) {
            this.runTimeoutAction(room);
          } else {
            room.turnTimer = setTimeout(
              () => this.runTimeoutAction(room),
              remaining,
            );
          }
        } else if (room.turnTimer) {
          // Untimed room: cancel the short auto-resolution clock armed while
          // this seat was offline.
          clearTimeout(room.turnTimer);
          room.turnTimer = null;
        }
      }
    } else {
      player.connection = "RECONNECTING";
      room.lastActivityAt = Date.now();
      this.scheduleDisconnect(room, playerId);
    }
    this.broadcastRoomState(room);
  }

  /**
   * Disposes a room once no human can ever use it again (all humans
   * disconnected and no spectators watching). Without this, abandoned rooms
   * and their timers accumulate forever.
   */
  /** Invite codes key roomsByCode, so never reuse a code that is live. */
  private unusedRoomCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = drawRoomCode();
      if (!this.roomsByCode.has(code)) return code;
    }
    throw new RoomLimitError(
      "SERVER_BUSY",
      "Could not allocate a room code. Try again shortly.",
    );
  }

  private sweepIfEmpty(room: Room): void {
    // RECONNECTING humans are still potentially active; their grace timer
    // calls sweepIfEmpty again once it expires.
    const anyHuman = room.players.some(
      (p) =>
        !p.isAi &&
        (p.connection === "CONNECTED" || p.connection === "RECONNECTING"),
    );
    if (anyHuman || room.spectators.size > 0) return;
    this.disposeRoom(room);
  }

  private disposeRoom(room: Room): void {
    if (room.botTimer) clearTimeout(room.botTimer);
    if (room.turnTimer) clearTimeout(room.turnTimer);
    // Cancel any pending reconnect-grace timers for this room.
    for (const key of [...this.disconnectTimers.keys()]) {
      if (key.startsWith(`${room.id}:`)) {
        const timer = this.disconnectTimers.get(key);
        if (timer) clearTimeout(timer);
        this.disconnectTimers.delete(key);
      }
    }
    for (const player of room.players) {
      if (this.roomByPlayer.get(player.playerId) === room.id) {
        this.roomByPlayer.delete(player.playerId);
      }
    }
    for (const spectator of room.spectators) {
      if (this.roomByPlayer.get(spectator) === room.id) {
        this.roomByPlayer.delete(spectator);
      }
    }
    this.rooms.delete(room.id);
    this.roomsByCode.delete(room.code);
    // Preserve finished replays for history; only discard an unfinished
    // game's working state. The bounded store evicts old games eventually.
    if (room.status !== "FINISHED" && room.game) {
      void this.store.deleteGame(room.game.gameId).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Matchmaking (§58)
  // -------------------------------------------------------------------------

  joinQuickMatch(playerId: string, displayName: string): void {
    this.ensureJanitor();
    // Joining matchmaking must never silently abandon an existing room.
    // Players who want to leave a lobby/game must do so explicitly first.
    if (this.getRoomForPlayer(playerId)) {
      this.sink.send(playerId, {
        type: "ERROR",
        code: "ALREADY_IN_ROOM",
        message: "Leave your current room before searching for a match.",
      });
      this.sink.send(playerId, {
        type: "MATCHMAKING_STATUS",
        queued: false,
        estimatedWaitMs: null,
      });
      return;
    }
    if (!this.quickQueue.some((entry) => entry.playerId === playerId)) {
      this.quickQueue.push({ playerId, displayName, queuedAt: Date.now() });
    }
    this.sink.send(playerId, {
      type: "MATCHMAKING_STATUS",
      queued: true,
      estimatedWaitMs: 8000,
    });
    this.tryMatch();
  }

  cancelQuickMatch(playerId: string): void {
    const index = this.quickQueue.findIndex((e) => e.playerId === playerId);
    if (index >= 0) this.quickQueue.splice(index, 1);
    this.sink.send(playerId, {
      type: "MATCHMAKING_STATUS",
      queued: false,
      estimatedWaitMs: null,
    });
  }

  private tryMatch(): void {
    if (this.quickQueue.length < 2) return;
    const [a, b] = this.quickQueue.splice(0, 2) as [
      { playerId: string; displayName: string; queuedAt: number },
      { playerId: string; displayName: string; queuedAt: number },
    ];
    // A player may have joined/created a room after queuing. Never create a
    // second membership implicitly.
    if (this.getRoomForPlayer(a.playerId) || this.getRoomForPlayer(b.playerId)) {
      for (const entry of [a, b]) {
        this.sink.send(entry.playerId, {
          type: "MATCHMAKING_STATUS",
          queued: false,
          estimatedWaitMs: null,
        });
      }
      return;
    }
    const room = this.rooms.get(
      // createRoom registers everything we need.
      this.createRoom(a.playerId, a.displayName, "QUICK_MATCH", {
        playerCount: 2,
        isPublic: true,
        turnDurationMs: QUICK_MATCH_TURN_MS,
      }).roomId,
    );
    if (!room) return;
    this.joinRoom(b.playerId, b.displayName, room.code);
    for (const entry of [a, b]) {
      this.sink.send(entry.playerId, {
        type: "MATCHMAKING_STATUS",
        queued: false,
        estimatedWaitMs: null,
      });
    }
    this.startGame(room.id, room.hostPlayerId);
  }

  // -------------------------------------------------------------------------
  // Game lifecycle
  // -------------------------------------------------------------------------

  startGame(roomId: string, requesterId: string): { error?: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { error: "Room not found." };
    if (room.hostPlayerId !== requesterId) {
      return { error: "Only the host can start the game." };
    }
    if (room.status !== "LOBBY") return { error: "Game already started." };

    // The dealing configuration is derived from the seat count, so the room
    // must be exactly full (humans + AI seats) before the host may start.
    const teamSizesProvided = room.options.teamSizes.length > 0;
    const target = teamSizesProvided
      ? room.options.teamSizes.reduce((a, b) => a + b, 0)
      : room.options.playerCount;
    if (room.players.length < target) {
      return {
        error: `Waiting for players — ${target - room.players.length} more seat(s) needed.`,
      };
    }
    if (room.players.length > target) {
      return { error: "Too many players for this configuration." };
    }
    if (!room.players.some((p) => !p.isAi)) {
      return { error: "At least one human player is required." };
    }
    const absent = room.players.filter(
      (p) => !p.isAi && p.connection !== "CONNECTED",
    );
    if (absent.length > 0) {
      return {
        error: `Waiting for ${absent.length} player(s) to connect.`,
      };
    }

    // Room options arrive from clients; a configuration the engine rejects
    // must surface as a room error, not an unhandled throw.
    let started: GameState;
    try {
      const created = createGame({
        // A rematch must be a new replay, not overwrite the previous one.
        gameId: `${room.id}:${randomUUID()}`,
        players: room.players.map((p) => ({
          id: p.playerId,
          name: p.displayName,
        })),
        teamSizes: room.options.teamSizes.length
          ? room.options.teamSizes
          : undefined,
        requiredSequences: room.options.requiredSequences ?? undefined,
        turnDurationMs: room.options.turnDurationMs,
        seed: generateSecureSeed(),
      });
      started = startGame(created).state;
    } catch (error) {
      return {
        error:
          error instanceof EngineError
            ? error.message || engineErrorMessage(error.code)
            : "Could not start this game configuration.",
      };
    }

    const game: StoredGame = {
      gameId: started.id,
      roomId: room.id,
      initialState: started,
      currentState: started,
      commands: [],
      events: [],
      processedActions: new Map(),
      summary: null,
    };
    this.persistGame(game);

    room.game = game;
    room.status = "ACTIVE";
    room.lastActivityAt = Date.now();
    room.botContexts.clear();

    // Arm the first turn before broadcasting so the message carries the
    // deadline that matches the state.
    this.afterAction(room);
    this.broadcastGameState(room);
    this.broadcastRoomState(room);
    return {};
  }

  /**
   * Submits a player command (§28). Idempotent per actionId (§79);
   * stale expectedVersion is rejected with STALE_GAME_STATE (§80).
   */
  submitCommand(
    roomId: string,
    playerId: string,
    command: ClientGameCommand,
    requestId: string,
  ): {
    ok: boolean;
    version?: number;
    duplicate?: boolean;
    errorCode?: string;
    errorMessage?: string;
  } {
    const room = this.rooms.get(roomId);
    const game = room?.game;
    if (!room || !game) {
      return { ok: false, errorCode: "GAME_NOT_ACTIVE", errorMessage: "No active game." };
    }

    const authoritative = buildAuthoritativeCommand(command, playerId);
    if (!authoritative) {
      return {
        ok: false,
        errorCode: "BAD_COMMAND",
        errorMessage: "That command is malformed.",
      };
    }

    // Idempotency (§79): a retried action returns the original outcome.
    // Keyed by (playerId, actionId): clients routinely reuse short actionIds
    // ("a1") across seats and turns, and a bare actionId would replay one
    // player's move as another's.
    const actionKey = `${playerId}:${authoritative.actionId}`;
    const fingerprint = stableCommandPayload(authoritative);
    const processed = game.processedActions.get(actionKey);
    if (processed) {
      if (processed.fingerprint !== fingerprint) {
        return {
          ok: false,
          errorCode: "ACTION_ID_REUSED",
          errorMessage:
            "That action id was already used for a different move. Retry with a new id.",
        };
      }
      return { ok: true, version: processed.versionAfter, duplicate: true };
    }

    try {
      const result = applyCommand(game.currentState, authoritative);

      game.currentState = result.state;
      game.commands.push(authoritative);
      game.events.push(...(result.events as DomainEvent[]));
      room.lastActivityAt = Date.now();
      game.processedActions.set(actionKey, {
        actionId: actionKey,
        playerId,
        requestId,
        versionAfter: result.state.version,
        fingerprint,
        storedAt: Date.now(),
      });
      this.persistGame(game);

      if (result.state.status === "FINISHED") {
        room.status = "FINISHED";
        this.finalizeGame(room);
      } else {
        // Arm the next turn before broadcasting so the message carries the
        // new deadline rather than the previous turn's expired one.
        this.afterAction(room);
      }

      // Broadcast per-viewer projections (§88) — never raw state (§23).
      this.broadcastGameState(room, result.events as DomainEvent[]);

      return { ok: true, version: result.state.version };
    } catch (error) {
      if (error instanceof EngineError) {
        return {
          ok: false,
          errorCode: error.code,
          errorMessage: engineErrorMessage(error.code),
        };
      }
      return {
        ok: false,
        errorCode: "INTERNAL",
        errorMessage: "Something went wrong applying that move.",
      };
    }
  }

  /** Reconnect support (§30, §92–§93): full authoritative projection. */
  resync(roomId: string, playerId: string): void {
    const room = this.rooms.get(roomId);
    const game = room?.game;
    if (!room || !game) return;
    const viewerId = room.players.some((p) => p.playerId === playerId)
      ? playerId
      : null;
    this.sink.send(playerId, {
      type: "GAME_STATE",
      state: projectStateForViewer(game.currentState, viewerId),
      turnDeadlineAt: room.turnDeadlineAt,
    });
    this.sink.send(playerId, { type: "ROOM_STATE", room: this.roomState(room) });
  }

  rematch(
    roomId: string,
    playerId: string,
  ): { ok?: boolean; error?: string } {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== "FINISHED") {
      return { error: "No finished game to rematch." };
    }
    if (room.hostPlayerId !== playerId) {
      return { error: "Only the host can start the rematch." };
    }
    room.status = "LOBBY";
    room.game = null;
    room.lastActivityAt = Date.now();
    this.broadcastRoomState(room);
    const started = this.startGame(roomId, room.hostPlayerId);
    return started.error ? { error: started.error } : { ok: true };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Runs after every action: bots, turn timers (§94). */
  private afterAction(room: Room): void {
    const game = room.game;
    if (!game || game.currentState.status !== "ACTIVE") {
      room.turnDeadlineAt = null;
      return;
    }

    if (room.botTimer) clearTimeout(room.botTimer);
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.turnTimer = null;
    room.turnDeadlineAt = null;

    const activeId = currentPlayerId(game.currentState);
    if (!activeId) return;
    const activePlayer = room.players.find((p) => p.playerId === activeId);

    if (activePlayer?.isAi) {
      room.botTimer = setTimeout(() => this.runBot(room), 650);
      return;
    }

    if (activePlayer && activePlayer.connection !== "CONNECTED") {
      // The active seat is offline. Give a reconnecting player the normal
      // grace window, but never leave the table waiting forever — even when
      // the room was created with "no timer".
      const delay =
        activePlayer.connection === "DISCONNECTED"
          ? DISCONNECTED_TURN_MS
          : RECONNECT_GRACE_MS;
      room.turnDeadlineAt = Date.now() + delay;
      room.turnTimer = setTimeout(
        () => this.runTimeoutAction(room),
        delay,
      );
      return;
    }

    const duration = room.options.turnDurationMs;
    if (duration) {
      room.turnDeadlineAt = Date.now() + duration;
      room.turnTimer = setTimeout(
        () => this.runTimeoutAction(room),
        duration,
      );
    }
  }

  /**
   * Bot seat action (§22, §91). Bots receive only their own seat's legal
   * information; decisions run through the shared AI package.
   */
  private runBot(room: Room): void {
    const game = room.game;
    if (!game || game.currentState.status !== "ACTIVE") return;
    const activeId = currentPlayerId(game.currentState);
    if (!activeId) return;
    const player = room.players.find((p) => p.playerId === activeId);
    if (!player?.isAi) return;

    let context = room.botContexts.get(activeId);
    if (!context) {
      context = createBotContext(room.options.aiDifficulty as AiDifficulty);
      room.botContexts.set(activeId, context);
    }

    try {
      const state = game.currentState;
      let decision;
      if (state.turnPhase === "AWAITING_SEQUENCE_SELECTION") {
        decision = {
          kind: "SELECT_SEQUENCES" as const,
          sequenceCellSets: resolveSequenceSelectionDefault(state).map((s) => [
            ...s.cells,
          ]),
        };
      } else {
        decision = chooseBotAction(state, activeId, context);
      }
      const command = decisionToCommand(
        decision,
        activeId,
        `bot-${randomUUID()}`,
        game.currentState.version,
      );
      const { playerId: _ignored, ...rest } = command;
      const result = this.submitCommand(
        room.id,
        activeId,
        rest,
        `bot-${Date.now()}`,
      );
      if (!result.ok) {
        // A rejected bot move must not strand the table — fall back to the
        // deterministic timeout policy for this turn.
        this.runTimeoutAction(room);
      }
    } catch {
      // Bot decision failed — the deterministic timeout policy still
      // advances the turn (the engine skip safeguard only runs while a
      // command is applied).
      this.runTimeoutAction(room);
    }
  }

  /**
   * Timeout auto-action (§94–§95): versioned policy —
   * 1. winning legal action, 2. block immediate opponent victory,
   * 3. first deterministic legal action. Never inspects hidden hands.
   */
  private runTimeoutAction(room: Room): void {
    const game = room.game;
    if (!game || game.currentState.status !== "ACTIVE") return;
    const activeId = currentPlayerId(game.currentState);
    if (!activeId) return;

    const state = game.currentState;
    try {
      let command: ClientGameCommand;
      if (state.turnPhase === "AWAITING_SEQUENCE_SELECTION") {
        command = {
          type: "SELECT_SEQUENCE_SET",
          actionId: `timeout-${Date.now()}`,
          sequenceCellSets: resolveSequenceSelectionDefault(state).map((s) => [
            ...s.cells,
          ]),
        };
      } else {
        const legal = getLegalActions(state, activeId);
        const main = legal.mainActions;
        if (main.length === 0) {
          // §75/§94: no main action, but an unused dead-card exchange may
          // still be legal. Take it deterministically — abandoning the turn
          // here would leave it stuck forever, because the engine's skip
          // safeguard only runs while applying a command.
          const exchange = legal.deadExchanges[0];
          if (!exchange) return; // engine safeguard already resolved this
          command = {
            type: "EXCHANGE_DEAD_CARD",
            actionId: `timeout-${Date.now()}`,
            cardId: exchange.cardId,
          };
        } else {
          const chosen = pickTimeoutAction(state, activeId, main);
          command = {
            type: chosen.type,
            actionId: `timeout-${Date.now()}`,
            cardId: chosen.cardId,
            targetCellId: chosen.targetCellId,
          } as ClientGameCommand;
        }
      }
      this.submitCommand(room.id, activeId, command, `timeout-${Date.now()}`);
    } catch {
      // Engine safeguard resolves genuinely stuck turns.
    }
  }

  private persistGame(game: StoredGame): void {
    // Fire-and-forget is acceptable for the in-memory default, but a durable
    // adapter must not produce an unhandled rejection.
    void this.store.saveGame(game).catch(() => {});
  }

  private finalizeGame(room: Room): void {
    const game = room.game;
    if (!game) return;
    const state = game.currentState;
    const winnerTeamId = state.winnerTeamId;
    const summary: GameSummary = {
      gameId: game.gameId,
      finishedAt: state.finishedAt ?? new Date().toISOString(),
      durationMs:
        new Date(state.finishedAt ?? Date.now()).getTime() -
        new Date(state.createdAt).getTime(),
      totalTurns: state.turnNumber,
      winnerTeamId,
      resultType: state.resultType ?? "WIN",
      isPublic: room.options.isPublic,
      players: state.players.map((player) => {
        const teamId = getPlayer(state, player.id).teamId;
        return {
          playerId: player.id,
          displayName: player.name,
          teamId,
          sequences: state.completedSequences[teamId]?.length ?? 0,
        };
      }),
    };
    game.summary = summary;
    room.lastActivityAt = Date.now();
    this.persistGame(game);
    void this.store.saveSummary(summary).catch(() => {});
    if (room.botTimer) clearTimeout(room.botTimer);
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.botTimer = null;
    room.turnTimer = null;
    room.turnDeadlineAt = null;
  }

  private broadcastRoomState(room: Room): void {
    const message: ServerMessage = {
      type: "ROOM_STATE",
      room: this.roomState(room),
    };
    // sink.broadcastRoom already delivers to players *and* spectators.
    this.sink.broadcastRoom(room.id, message);
  }

  private broadcastGameState(room: Room, events?: readonly DomainEvent[]): void {
    const game = room.game;
    if (!game) return;

    for (const player of room.players) {
      if (player.isAi) continue;
      this.sink.send(player.playerId, {
        type: "GAME_STATE",
        state: projectStateForViewer(game.currentState, player.playerId),
        turnDeadlineAt: room.turnDeadlineAt,
      });
      if (events && events.length > 0) {
        this.sink.send(player.playerId, {
          type: "GAME_EVENTS",
          events: projectEventsForViewer(events, player.playerId),
          version: game.currentState.version,
        });
      }
    }
    for (const spectator of room.spectators) {
      this.sink.send(spectator, {
        type: "GAME_STATE",
        state: projectStateForViewer(game.currentState, null),
        turnDeadlineAt: room.turnDeadlineAt,
      });
      if (events && events.length > 0) {
        this.sink.send(spectator, {
          type: "GAME_EVENTS",
          events: projectEventsForViewer(events, null),
          version: game.currentState.version,
        });
      }
    }
  }

  roomState(room: Room): RoomState {
    const { passwordHash, ...publicOptions } = room.options;
    return {
      roomId: room.id,
      roomCode: room.code,
      mode: room.mode,
      options: {
        ...publicOptions,
        hasPassword: passwordHash !== null,
      },
      status: room.status,
      hostPlayerId: room.hostPlayerId,
      players: room.players.map(
        (player): RoomPlayerInfo => ({
          playerId: player.playerId,
          displayName: player.displayName,
          seat: null,
          teamId: null,
          connection: player.connection,
          isAi: player.isAi,
          isHost: player.isHost,
        }),
      ),
    };
  }

  getRoomForPlayer(playerId: string): Room | undefined {
    const roomId = this.roomByPlayer.get(playerId);
    return roomId ? this.rooms.get(roomId) : undefined;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** Authoritative game state accessor (server-side only; tests/telemetry). */
  getGameState(roomId: string): GameState | null {
    return this.rooms.get(roomId)?.game?.currentState ?? null;
  }

  async listHistory(limit = 20): Promise<GameSummary[]> {
    // Private-room results remain replayable by their unguessable game id for
    // participants, but their player names must not appear in a public feed.
    return this.store.listSummaries(limit, { publicOnly: true });
  }

  async getReplay(gameId: string) {
    return this.store.getGame(gameId);
  }
}

/**
 * §94–§95 timeout auto-action policy (v1): 1. an immediately-winning
 * placement, 2. a placement blocking an immediate opponent victory,
 * 3. the first deterministic legal action. Uses public board state only —
 * never hidden hands.
 */
export function pickTimeoutAction(
  state: GameState,
  playerId: string,
  main: readonly MainAction[],
): MainAction {
  const myTeam = getPlayer(state, playerId).teamId;
  const needs =
    state.requiredSequences -
    (state.completedSequences[myTeam]?.length ?? 0);

  const threatFor = (teamId: TeamId, cellId: string): number =>
    findMaximumCompatibleSets(
      detectCandidateSequences(state, teamId, cellId as CellId),
      state.completedSequences[teamId] ?? [],
    )[0]?.length ?? 0;

  const placements = main.filter((a) => a.type !== "PLAY_REMOVE_JACK");
  const winning = placements.find(
    (a) => needs <= 0 || threatFor(myTeam, a.targetCellId) >= needs,
  );
  if (winning) return winning as MainAction;

  for (const team of state.teams) {
    if (team.id === myTeam) continue;
    const oppNeeds =
      state.requiredSequences -
      (state.completedSequences[team.id]?.length ?? 0);
    if (oppNeeds <= 0) continue;
    const blocker = placements.find(
      (a) => threatFor(team.id, a.targetCellId) >= oppNeeds,
    );
    if (blocker) return blocker as MainAction;
  }
  return main[0] as MainAction;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function drawRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}
