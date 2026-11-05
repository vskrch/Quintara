/**
 * Online multiplayer (§21): quick match, private rooms with invite codes,
 * reconnect-safe gameplay driven entirely by server projections.
 */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  defaultSequenceOption,
  type CellId,
  type SequenceSelectionOption,
} from "@quintara/game-engine";
import { GameScreen } from "@/components/GameScreen";
import { ReconnectOverlay } from "@/components/Modals";
import { useOnlineGame, type OnlineGameState } from "@/lib/online-game";
import { IS_STATIC_DEMO, REPOSITORY_URL, withBasePath } from "@/lib/site";

export default function OnlinePage() {
  const online = useOnlineGame();
  const router = useRouter();
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [playerCount, setPlayerCount] = useState(2);
  const [aiSeats, setAiSeats] = useState(0);
  const [difficulty, setDifficulty] = useState("MEDIUM");
  const [roomPassword, setRoomPassword] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [turnDurationMs, setTurnDurationMs] = useState<number | null>(null);
  const [turnTimer, setTurnTimer] = useState<{
    remainingMs: number;
    totalMs: number;
  } | null>(null);
  const pendingInvite = useRef<string | null>(null);
  const actionCounter = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  useEffect(() => {
    if (IS_STATIC_DEMO) return;
    online.connect();
    // Invite deep links (§30): /play/online?room=CODE joins automatically
    // once the socket is authenticated. Keep the code in the join field so a
    // password-protected room can still be entered if auto-join is refused.
    const invitedCode = new URLSearchParams(window.location.search)
      .get("room")
      ?.trim()
      .toUpperCase();
    if (invitedCode) {
      pendingInvite.current = invitedCode;
      setJoinCode(invitedCode);
      // Clean the URL so a refresh doesn't try to join twice.
      window.history.replaceState(null, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hooks must run on every render — computed before the phase-based returns.
  const projected = online.projected;

  // Fire the pending invite join as soon as we're connected and idle.
  const joinRoom = online.joinRoom;
  const connection = online.connection;
  const phase = online.phase;
  const room = online.room;
  useEffect(() => {
    if (
      pendingInvite.current &&
      connection === "connected" &&
      phase === "HOME" &&
      !room
    ) {
      const code = pendingInvite.current;
      pendingInvite.current = null;
      joinRoom(code);
    }
  }, [connection, phase, room, joinRoom]);
  const legalTargets = useMemo(() => {
    const set = new Set<CellId>();
    if (!projected || !online.selectedCardId) return set;
    for (const action of projected.legalActions?.mainActions ?? []) {
      if (
        action.cardId === online.selectedCardId &&
        action.type !== "PLAY_REMOVE_JACK"
      ) {
        set.add(action.targetCellId);
      }
    }
    return set;
  }, [projected, online.selectedCardId]);

  const removableTargets = useMemo(() => {
    const set = new Set<CellId>();
    if (!projected) return set;
    if (online.selectedCardId) {
      for (const action of projected.legalActions?.mainActions ?? []) {
        if (
          action.cardId === online.selectedCardId &&
          action.type === "PLAY_REMOVE_JACK"
        ) {
          set.add(action.targetCellId);
        }
      }
    }
    return set;
  }, [projected, online.selectedCardId]);

  // Countdown for timed rooms. Render from the server's absolute deadline so
  // a reload/reconnect cannot visually restart the clock.
  const activeTurnDurationMs = online.room?.options.turnDurationMs ?? null;
  const turnDeadlineAt = online.turnDeadlineAt;
  const projectedVersion = projected?.version;
  const currentTurnPlayerId = projected?.currentTurnPlayerId;
  useEffect(() => {
    if (
      online.phase !== "PLAYING" ||
      !activeTurnDurationMs ||
      !projectedVersion ||
      !turnDeadlineAt
    ) {
      setTurnTimer(null);
      return;
    }
    const totalMs = activeTurnDurationMs;
    const tick = () => {
      const remainingMs = Math.max(0, turnDeadlineAt - Date.now());
      setTurnTimer({
        remainingMs: Math.min(remainingMs, totalMs),
        totalMs,
      });
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [
    online.phase,
    activeTurnDurationMs,
    projectedVersion,
    currentTurnPlayerId,
    turnDeadlineAt,
  ]);

  const isHost =
    online.identity !== null &&
    online.room?.hostPlayerId === online.identity.playerId;
  const connected = online.connection === "connected";

  // GitHub Pages build: online rooms need the authoritative WebSocket server.
  // Keep the page useful instead of showing a permanent "Connecting…" state.
  if (IS_STATIC_DEMO) {
    return (
      <main className="relative mx-auto w-full max-w-2xl px-6 pb-16 pt-[calc(var(--safe-top)+2rem)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="hero-eyebrow">
              <span className="dot" aria-hidden />
              Public demo
            </span>
            <h1 className="mt-3 text-3xl font-bold sm:text-4xl">Play Online</h1>
          </div>
          <Link href="/" className="btn btn-ghost shrink-0">
            ← Home
          </Link>
        </div>

        <section className="panel panel-raised mt-6 p-6">
          <h2 className="text-lg font-semibold">
            Multiplayer needs the game server
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-secondary">
            This site is the free, frontend-only demo. Solo, pass-and-play, the
            tutorial, and the daily challenge run entirely in your browser and
            work right now. Online rooms use an authoritative WebSocket server,
            which is not attached to this build.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-secondary">
            Want to host the full game? The repository includes a free Render
            blueprint for the server and step-by-step instructions.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href="/play/local?quick=1" className="btn btn-primary">
              ⚡ Play vs AI
            </Link>
            <Link href="/tutorial" className="btn btn-secondary">
              Learn the game
            </Link>
            <a
              className="btn btn-ghost"
              href={`${REPOSITORY_URL}#online-multiplayer`}
              target="_blank"
              rel="noreferrer"
            >
              Deploy online play ↗
            </a>
          </div>
        </section>

        <p className="mt-4 text-xs leading-relaxed text-secondary">
          Everything else — four AI levels, local multiplayer, stats, and
          offline install — is fully playable on this page.
        </p>
      </main>
    );
  }

  // Playing phase — server-driven game screen.
  if (online.phase === "PLAYING" && online.projected) {
    const state = online.projected;
    const me = online.identity?.playerId ?? null;

    return (
      <>
        {online.connection === "reconnecting" && (
          <ReconnectOverlay message="Connection lost — Reconnecting…" />
        )}
        <GameScreen
          projected={state}
          authoritativeState={null}
          viewerId={me}
          selectedCardId={online.selectedCardId}
          lastPlacedCellId={online.lastPlacedCellId}
          lastMoveSummary={online.lastMoveSummary}
          botThinking={false}
          sequenceSelection={
            state.turnPhase === "AWAITING_SEQUENCE_SELECTION"
              ? {
                  options: state.pendingSequenceOptions ?? [],
                  onSelect: (option: SequenceSelectionOption) =>
                    online.selectSequences([...option.sequences]),
                  onUseDefault: () => {
                    const options = state.pendingSequenceOptions ?? [];
                    if (options.length === 0) return;
                    // Match the server's deterministic timeout tie-break.
                    const chosen = defaultSequenceOption(options);
                    online.selectSequences([...chosen.sequences]);
                  },
                }
              : null
          }
          connectionLabel={
            online.connection === "connected"
              ? null
              : "Reconnecting to the game…"
          }
          notices={
            online.errorMessage
              ? [
                  {
                    id: "online-error",
                    message: online.errorMessage,
                    tone: "error",
                  },
                ]
              : []
          }
          onDismissNotice={online.clearError}
          turnTimer={turnTimer}
          interactionDisabled={!connected}
          onSelectCard={(cardId) => {
            if (connected) online.selectCard(cardId);
          }}
          onCellClick={(cellId: CellId) => {
            if (!connected || !online.selectedCardId) return;
            const legal = state.legalActions;
            if (!legal) return;
            const match = legal.mainActions.find(
              (a) =>
                a.targetCellId === cellId && a.cardId === online.selectedCardId,
            );
            if (
              !match ||
              (!legalTargets.has(cellId) && !removableTargets.has(cellId))
            )
              return;
            online.sendCommand({
              type: match.type,
              actionId: `web-${Date.now()}-${actionCounter.current++}`,              expectedVersion: state.version,
              cardId: match.cardId,
              targetCellId: match.targetCellId,
            });
          }}
          onExchange={(cardId) => {
            if (!connected) return;
            online.sendCommand({
              type: "EXCHANGE_DEAD_CARD",
              actionId: `web-${Date.now()}-${actionCounter.current++}`,              expectedVersion: state.version,
              cardId,
            });
          }}
          onRematch={() => {
            if (connected) online.rematch();
          }}
          hideRematch={!isHost}
          onQuit={() => {
            online.leaveRoom();
            router.push("/");
          }}
        />
      </>
    );
  }

  // Lobby / waiting room.
  return (
    <main className="relative mx-auto w-full max-w-2xl px-6 pb-16 pt-[calc(var(--safe-top)+2rem)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="hero-eyebrow">
            <span className="dot" aria-hidden />
            Online arena
          </span>
          <h1 className="mt-3 text-3xl font-bold sm:text-4xl">Play Online</h1>
        </div>
        <Link href="/" className="btn btn-ghost shrink-0">
          ← Home
        </Link>
      </div>

      {online.errorMessage && (
        <div
          className="toast mt-4 flex items-center justify-between border-[var(--color-danger)]"
          role="alert"
        >
          <span>{online.errorMessage}</span>
          <button
            type="button"
            className="btn btn-ghost px-2 py-1 text-xs"
            onClick={online.clearError}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="mt-3" role="status">
        <span
          className={`connection-pill ${
            online.connection === "connected" ? "is-online" : "is-offline"
          }`}
        >
          <span className="status-dot" aria-hidden />
          {online.connection === "connected"
            ? "Connected"
            : online.connection === "reconnecting"
              ? "Reconnecting…"
              : "Connecting…"}
        </span>
      </div>

      {!online.room && (
        <>
          <section className="panel panel-raised mt-6 p-5">
            <h2 className="flex items-center gap-2 font-semibold">
              <span className="text-accent" aria-hidden>
                ⚡
              </span>
              Quick Match
            </h2>
            <p className="mt-1 text-sm text-secondary">
              Find a compatible opponent automatically (§58).
            </p>
            <button
              type="button"
              className="btn btn-primary mt-4 w-full"
              disabled={!connected || online.matchmaking}
              onClick={online.quickMatch}
            >
              {online.matchmaking && (
                <span
                  className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                  aria-hidden
                />
              )}
              {online.matchmaking ? "Finding opponent…" : "Find Opponent"}
            </button>
            {online.matchmaking && (
              <button
                type="button"
                className="btn btn-ghost mt-2 w-full"
                onClick={online.cancelQuickMatch}
              >
                Cancel
              </button>
            )}
          </section>

          <section className="panel panel-raised mt-4 p-5">
            <h2 className="flex items-center gap-2 font-semibold">
              <span className="text-accent" aria-hidden>
                ✦
              </span>
              Private Room
            </h2>
            <p className="mt-1 text-sm text-secondary">
              Host a game and share the invite code.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <label className="text-sm">
                Players
                <select
                  className="mt-1 w-full rounded-[10px] border border-white/10 bg-surface px-3 py-2.5 text-sm"
                  value={playerCount}
                  onChange={(e) => {
                    const count = Number(e.target.value);
                    setPlayerCount(count);
                    // The server clamps AI seats to playerCount - 1; keep the
                    // form honest so the host sees what will actually start.
                    setAiSeats((current) => Math.min(current, count - 1));
                  }}
                >
                  {[2, 3, 4, 6].map((count) => (
                    <option key={count} value={count}>
                      {count} players
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                AI seats
                <select
                  className="mt-1 w-full rounded-[10px] border border-white/10 bg-surface px-3 py-2.5 text-sm"
                  value={aiSeats}
                  onChange={(e) => setAiSeats(Number(e.target.value))}
                >
                  {Array.from(
                    { length: Math.min(3, playerCount - 1) + 1 },
                    (_, count) => count,
                  ).map((count) => (
                    <option key={count} value={count}>
                      {count} bots
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {playerCount === 3 && (
              <p
                className="mt-2.5 rounded-[10px] border border-[rgba(215,173,98,0.35)] bg-accent-soft px-3 py-2 text-xs text-secondary"
                role="note"
              >
                <strong className="text-text-primary">3-player note:</strong>{" "}
                three teams share the board and games often end in a draw. 2, 4
                or 6 players give the most decisive matches.
              </p>
            )}
            <label className="mt-2.5 block text-sm">
              Bot difficulty
              <select
                className="mt-1 w-full rounded-[10px] border border-white/10 bg-surface px-3 py-2.5 text-sm"
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value)}
              >
                {["EASY", "MEDIUM", "HARD", "EXPERT"].map((level) => (
                  <option key={level} value={level}>
                    {level[0]}
                    {level.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-2.5 block text-sm">
              Turn timer
              <select
                className="mt-1 w-full rounded-[10px] border border-white/10 bg-surface px-3 py-2.5 text-sm"
                value={turnDurationMs ?? 0}
                onChange={(e) =>
                  setTurnDurationMs(Number(e.target.value) || null)
                }
              >
                <option value={0}>No timer</option>
                <option value={60000}>60 seconds</option>
                <option value={90000}>90 seconds</option>
                <option value={120000}>2 minutes</option>
              </select>
            </label>
            <label className="mt-2.5 block text-sm">
              Password <span className="text-secondary">(optional)</span>
              <input
                type="password"
                value={roomPassword}
                onChange={(e) => setRoomPassword(e.target.value)}
                placeholder="Leave empty for an open room"
                autoComplete="new-password"
                maxLength={128}
                className="mt-1 w-full rounded-[10px] border border-white/10 bg-surface px-3.5 py-2.5 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <button
              type="button"
              className="btn btn-primary mt-4 w-full"
              disabled={!connected}
              onClick={() =>
                online.createRoom({
                  playerCount,
                  aiSeats,
                  aiDifficulty: difficulty,
                  turnDurationMs,
                  ...(roomPassword.trim()
                    ? { password: roomPassword.trim() }
                    : {}),
                })
              }
            >
              Create Room
            </button>
          </section>

          <section className="panel panel-raised mt-4 p-5">
            <h2 className="flex items-center gap-2 font-semibold">
              <span className="text-accent" aria-hidden>
                ⌘
              </span>
              Join a Room
            </h2>
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                placeholder="ROOM CODE"
                maxLength={8}
                autoCapitalize="characters"
                autoComplete="off"
                className="flex-1 px-3.5 py-2.5 text-center text-lg font-semibold tracking-[0.3em]"
                aria-label="Room code"
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  online.joinRoom(
                    joinCode.trim(),
                    joinPassword.trim() || undefined,
                  )
                }
                disabled={!connected || joinCode.trim().length === 0}
              >
                Join
              </button>
            </div>
            <label className="mt-2.5 block text-sm">
              Password <span className="text-secondary">(if required)</span>
              <input
                type="password"
                value={joinPassword}
                onChange={(e) => setJoinPassword(e.target.value)}
                placeholder="Room password"
                autoComplete="current-password"
                maxLength={128}
                className="mt-1 w-full rounded-[10px] border border-white/10 bg-surface px-3.5 py-2.5 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
          </section>
        </>
      )}

      {online.room && (
        <section className="panel panel-raised mt-6 p-6">
          <h2 className="flex flex-wrap items-center justify-between gap-3 text-lg font-semibold">
            Room
            <span className="room-code rounded-xl border border-accent/25 bg-accent-soft px-3 py-1 font-mono text-xl">
              {online.room.roomCode}
            </span>
          </h2>
          {online.room.options.hasPassword && (
            <p className="mt-1 text-xs text-secondary">🔒 Password protected</p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="btn btn-secondary text-xs"
              onClick={async () => {
                const code = online.room?.roomCode ?? "";
                const invite = `${window.location.origin}${withBasePath("/play/online")}?room=${code}`;
                try {
                  if (!navigator.clipboard?.writeText) {
                    throw new Error("Clipboard unavailable");
                  }
                  await navigator.clipboard.writeText(invite);
                  setCopyFailed(false);
                  setCopied(true);
                  if (copyTimer.current) clearTimeout(copyTimer.current);
                  copyTimer.current = setTimeout(() => {
                    setCopied(false);
                    copyTimer.current = null;
                  }, 1600);
                } catch {
                  setCopied(false);
                  setCopyFailed(true);
                }
              }}
            >
              {copied ? "✓ Copied" : "Copy Invite"}
            </button>
            <button
              type="button"
              className="btn btn-ghost text-xs"
              onClick={online.leaveRoom}
            >
              Leave
            </button>
          </div>
          {copyFailed && (
            <p className="mt-2 text-xs text-[var(--color-danger)]" role="alert">
              Couldn’t copy automatically. Share code{" "}
              <strong className="font-mono">{online.room.roomCode}</strong> or
              the link in your address bar.
            </p>
          )}

          <ul className="mt-5 flex flex-col gap-2">
            {online.room.players.map((player) => (
              <li
                key={player.playerId}
                className="flex items-center justify-between rounded-[10px] border border-white/6 bg-white/5 px-3.5 py-2.5 text-sm"
              >
                <span className="flex items-center gap-2 font-medium">
                  <span
                    className="inline-block h-2 w-2 rounded-full bg-[var(--color-success)] shadow-[0_0_8px_rgba(72,187,120,0.8)]"
                    aria-hidden
                  />
                  {player.displayName}
                  {player.isAi && (
                    <span className="ml-1 rounded bg-white/10 px-1.5 py-0.5 text-[0.62rem] uppercase">
                      Bot
                    </span>
                  )}
                </span>
                <span className="text-xs text-secondary">
                  {player.isHost ? "Host" : player.connection}
                </span>
              </li>
            ))}
            {Array.from({
              length: Math.max(
                0,
                online.room.options.playerCount - online.room.players.length,
              ),
            }).map((_, index) => (
              <li
                key={`open-${index}`}
                className="waiting-slot rounded-[10px] px-3.5 py-2.5 text-sm text-secondary"
              >
                Waiting for player…
              </li>
            ))}
          </ul>

          <StartGameControl online={online} connected={connected} />
          <p className="mt-2 text-center text-xs text-secondary">
            {online.room.players.length} of {online.room.options.playerCount}{" "}
            players ready
          </p>
        </section>
      )}
    </main>
  );
}

function StartGameControl({
  online,
  connected,
}: {
  online: OnlineGameState;
  connected: boolean;
}) {
  const isHost =
    online.identity !== null &&
    online.room?.players.some(
      (player) =>
        player.isHost && player.playerId === online.identity?.playerId,
    ) === true;
  const full =
    online.room !== null &&
    online.room.players.length >= online.room.options.playerCount;

  if (!isHost) {
    return (
      <div
        className="mt-6 w-full rounded-[10px] border border-white/10 bg-white/5 py-3.5 text-center text-sm text-secondary"
        role="status"
      >
        Waiting for the host to start the game…
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        className="btn btn-primary mt-6 w-full py-3.5"
        disabled={!connected || !full}
        onClick={online.startGame}
      >
        {!connected
          ? "Reconnecting…"
          : full
            ? "Start Game"
            : "Waiting for players…"}
      </button>
      {!full && (
        <p className="mt-1.5 text-center text-xs text-secondary">
          The room must be full (or filled with bots) before starting.
        </p>
      )}
    </>
  );
}
