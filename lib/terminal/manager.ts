import { randomUUID } from "node:crypto";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { navigationEmitter } from "@/lib/navigation-events";
import { serverLogger as logger } from "@/lib/logger";
import { getPreset } from "./presets";
import { launchLineForPreset } from "./launch-command";
import { ensureCodexHome } from "@/lib/codex-config/canonical";
import { stripHostSessionEnv } from "@/lib/agents/child-env";
import { LIBI_SERVER_PORT_ENV } from "@/lib/libi-home";
import { MAX_TERMINAL_SESSIONS, SETUP_TERMINAL_IDLE_MS, isSetupSurface } from "./types";
import type {
  AttachedSocket,
  PtyFactory,
  PtyLike,
  SetupSurface,
  TerminalClientMessage,
  TerminalPurpose,
  TerminalServerMessage,
  TerminalSessionMeta,
} from "./types";

export { MAX_TERMINAL_SESSIONS } from "./types";

/** Lines of scrollback mirrored server-side for reattach snapshots. */
const SCROLLBACK_LINES = 5000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Pause the PTY when an attached socket buffers more than this. */
const FLOW_HIGH_WATER_BYTES = 1_000_000;
const FLOW_LOW_WATER_BYTES = 256_000;
const FLOW_POLL_MS = 100;

/**
 * DoS bounds on inbound WS control frames. A terminal peer sends only tiny
 * JSON frames (keystrokes, pastes, resize) — none of these limits constrain
 * a legitimate client:
 * - `MAX_CLIENT_FRAME_CHARS`: reject an oversized raw frame before parsing it.
 * - `MAX_INPUT_CHARS`: truncate the decoded input payload forwarded to the PTY.
 * - `MAX_TERMINAL_DIMENSION`: clamp resize cols/rows (a giant grid would
 *   allocate huge xterm buffers server-side).
 */
const MAX_CLIENT_FRAME_CHARS = 64 * 1024;
const MAX_INPUT_CHARS = 64 * 1024;
const MAX_TERMINAL_DIMENSION = 1000;

/**
 * When a held `initialInput` may be typed — see `flushPendingInput`.
 * - `LINE_EDITOR_READY_SEQUENCE` (bracketed-paste enable): zsh >= 5.1 and
 *   bash/readline >= 5.1 emit it as their line editor starts reading a line.
 *   Seeing it types the command at once.
 * - Shells that never emit it (macOS's /bin/bash 3.2, dash, a readline with
 *   bracketed paste turned off): ready once output has been quiet for
 *   `PENDING_INPUT_QUIET_MS`, and never earlier than
 *   `PENDING_INPUT_MIN_DELAY_MS` after spawn.
 * - `PENDING_INPUT_MAX_WAIT_MS` after spawn it is typed regardless.
 */
export const LINE_EDITOR_READY_SEQUENCE = "\x1b[?2004h";
export const PENDING_INPUT_QUIET_MS = 750;
export const PENDING_INPUT_MIN_DELAY_MS = 1500;
export const PENDING_INPUT_MAX_WAIT_MS = 15_000;
/**
 * Terminal-reply formats that reach the shell even while a setup command
 * waits — see `acceptPendingClientInput`. Each is xterm answering a query
 * from the user's rc, never something a person types:
 * - Cursor position report:       ESC [ <digits> ; <digits> R
 * - Device attributes replies:    ESC [ ? <digits/;> c   and   ESC [ > <digits/;> c
 * - Device status / mode reports: ESC [ <digits> n   and   ESC [ ? <digits/;> $ y
 * - OSC replies (e.g. color queries): ESC ] … BEL   or   ESC ] … ESC \
 * - DCS replies (e.g. XTVERSION / DECRQSS answers): ESC P … ESC \
 * A chunk made of several such replies concatenated back to back still
 * matches in full. No unit's body may contain the byte that ends it (or an
 * ESC), so a chunk splits into units exactly one way: a lazy "anything" body
 * could also swallow the next reply, and a long near-miss chunk (thousands of
 * replies and one stray byte, within the 64 K input cap) then made the
 * matcher try every split — exponential, stalling the event loop.
 * Anything else — arrow keys, Escape alone, Alt-combos, F-keys, focus events,
 * plain keystrokes, or a chunk mixing a reply with any of those — does not
 * match and is dropped.
 */
const TERMINAL_REPLY_CHUNK = new RegExp(
  "^(?:" +
    "\\x1b\\[\\d+;\\d+R" + // CPR: ESC [ row ; col R
    "|\\x1b\\[\\?[\\d;]*c" + // DA1 reply: ESC [ ? params c
    "|\\x1b\\[>[\\d;]*c" + // DA2 reply: ESC [ > params c
    "|\\x1b\\[\\d+n" + // DSR: ESC [ digits n
    "|\\x1b\\[\\?[\\d;]*\\$y" + // DECRPM: ESC [ ? digits/; $ y
    "|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)" + // OSC reply: ESC ] <no BEL/ESC> BEL | ESC \
    "|\\x1bP[^\\x1b]*\\x1b\\\\" + // DCS reply: ESC P <no ESC> ESC \
    ")+$",
);

/** True when `data` is one or more recognised terminal replies with nothing else mixed in. */
function isTerminalReplyChunk(data: string): boolean {
  return TERMINAL_REPLY_CHUNK.test(data);
}

type PendingInputReadyReason = "bracketed_paste" | "quiet" | "cap";

export class TerminalCapacityError extends Error {
  constructor(max: number) {
    super(
      `Terminal session limit reached (${max}). Close a terminal before opening a new one.`,
    );
    this.name = "TerminalCapacityError";
  }
}

/** An `initialInput` still waiting to be typed — see `flushPendingInput`. */
interface PendingInput {
  text: string;
  /** Plain-keystroke input frames dropped while `text` waited; logged once, as a count. */
  droppedKeystrokes: number;
  /** A viewer has sized the grid at least once. */
  clientSized: boolean;
  /** The line editor is reading — or a fallback stopped waiting for it. */
  shellReady: boolean;
  sawOutput: boolean;
  /** No output for `PENDING_INPUT_QUIET_MS` since the last chunk. */
  quiet: boolean;
  minDelayElapsed: boolean;
  /** The last output bytes, so a ready sequence split across chunks still matches. */
  scanTail: string;
  quietTimer: ReturnType<typeof setTimeout> | null;
  minDelayTimer: ReturnType<typeof setTimeout> | null;
  capTimer: ReturnType<typeof setTimeout> | null;
}

/** Background bookkeeping timers must never hold the process open. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

interface TerminalEntry {
  meta: TerminalSessionMeta;
  /** Monotonic creation counter — sort tiebreaker for same-ms createdAt. */
  seq: number;
  pty: PtyLike;
  headless: HeadlessTerminal;
  serialize: SerializeAddon;
  sockets: Set<AttachedSocket>;
  flowTimer: ReturnType<typeof setInterval> | null;
  /**
   * Text to type into the shell once a viewer has sized it AND the shell's
   * line editor is ready. Cleared on flush or teardown — see `flushPendingInput`.
   */
  pending?: PendingInput;
  /** When the last viewer left (or the session was created); null while one is attached. */
  detachedSince: number | null;
}

export interface TerminalManagerOpts {
  /** Working directory for new PTYs, resolved at spawn time. */
  cwd: () => string;
  maxSessions?: number;
  /** Called with the owning surface once a setup terminal is running. */
  onSetupTerminalOpen?: (surface: SetupSurface) => void;
  /** Called with the owning surface whenever a setup terminal goes away. */
  onSetupTerminalExit?: (surface: SetupSurface) => void;
  /** Clock for the idle reaper; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Owns all live terminal sessions in the Next.js server process.
 *
 * Sessions are purely in-memory: a PTY's child process dies with this
 * process, so nothing is persisted and nothing survives a restart (see
 * the design spec — VS Code-style "revive" was deliberately skipped).
 * Detach/reattach within a server lifetime is supported via a headless
 * xterm mirror whose serialized buffer is replayed on attach.
 */
export class TerminalManager {
  private sessions = new Map<string, TerminalEntry>();
  private readonly maxSessions: number;
  private nextSeq = 0;
  private readonly now: () => number;

  constructor(
    private ptyFactory: PtyFactory,
    private opts: TerminalManagerOpts,
  ) {
    this.maxSessions = opts.maxSessions ?? MAX_TERMINAL_SESSIONS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * `initialInput` is typed into the new shell WITHOUT a trailing newline, so
   * it sits at the prompt for the user to read and press Enter on. Used by the
   * Agents page's setup terminals, whose commands `lib/agents/setup/commands.ts`
   * builds.
   *
   * It is delivered HERE, server-side, and not pasted from the browser — that
   * matters. A client-side paste has to survive the view mounting, a WebSocket
   * connecting, and the server's attach `snapshot`, which the client replays
   * with a `term.reset()` that wipes anything echoed before it. Two client-side
   * attempts were tried and both lost that race.
   *
   * The text is HELD here rather than typed immediately — see
   * `flushPendingInput` for when it goes in: after the client's first resize
   * AND once the shell's line editor is ready.
   *
   * `purpose: "setup"` is a terminal the Agents page opens to show the user one
   * command. It needs a `surface`, replaces that surface's previous setup
   * terminal, spawns a known shell rather than `$SHELL` and always with the
   * plain `shell` preset whatever `cliId` asks for, is left out of the
   * default (chat) `list()`, and is reaped once nobody has watched it for
   * `SETUP_TERMINAL_IDLE_MS`. It still counts toward the session cap.
   */
  create({
    cliId,
    initialInput,
    purpose = "chat",
    surface,
  }: {
    cliId: string;
    initialInput?: string;
    purpose?: TerminalPurpose;
    surface?: SetupSurface;
  }): TerminalSessionMeta {
    const now = this.now();
    if (purpose === "setup") {
      if (!isSetupSurface(surface)) {
        throw new Error("a setup terminal needs a surface");
      }
      // Replace the surface's previous setup terminal BEFORE the capacity
      // check, so showing the next command is never refused for capacity.
      for (const [existingId, existing] of this.sessions) {
        if (existing.meta.purpose === "setup" && existing.meta.surface === surface) {
          this.close(existingId);
        }
      }
    }

    if (this.sessions.size >= this.maxSessions) {
      throw new TerminalCapacityError(this.maxSessions);
    }

    // A preset types its launch line (`claude\r`, which runs) ahead of the command a setup terminal
    // was opened to show, so a setup terminal is the plain shell whatever preset was asked for.
    const effectiveCliId = purpose === "setup" ? "shell" : cliId;
    const preset = getPreset(effectiveCliId);
    const id = `term-${randomUUID()}`;
    const cwd = this.opts.cwd();

    // Point any codex launched in this terminal at the codex home libi uses for
    // THIS instance: the user's real `~/.codex` (installed app, dev checkout and
    // worktree alike), or a scoped `<LIBI_HOME>/.codex` under test mode. The
    // in-app Codex chat reads the same home, so a `codex mcp add` submitted here
    // is what that chat — and the user's own Codex — sees. Harmless for
    // non-codex presets (claude ignores it).
    //
    // `ensureCodexHome` creates it if absent: codex exits 1 rather than
    // starting when CODEX_HOME names a missing directory, and the preset is
    // NOT a safe gate for that — a setup terminal spawns with the `shell`
    // preset and types a `codex` command into it.
    //
    // Minus LIBI_SERVER_PORT, which Category B sets in this server's own
    // environment for the server and the processes that act for it. What the
    // user starts in a terminal is theirs: a hand-run `serve-mcp-http`, or a
    // stdio MCP pointed at another home, has to find its server through that
    // home's port file, as it would in any other shell. Setup terminals too.
    const env: NodeJS.ProcessEnv = stripHostSessionEnv({ ...process.env, CODEX_HOME: ensureCodexHome() });
    delete env[LIBI_SERVER_PORT_ENV];
    const pty = this.ptyFactory({
      cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      env,
      purpose,
    });

    const headless = new HeadlessTerminal({
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    const serialize = new SerializeAddon();
    headless.loadAddon(serialize);

    const entry: TerminalEntry = {
      seq: this.nextSeq++,
      meta: {
        id,
        title: this.dedupeTitle(
          purpose === "setup" ? "Setup" : (preset?.label ?? "Terminal"),
        ),
        cliId: preset?.id ?? "shell",
        createdAt: now,
        status: "running",
        purpose,
        ...(purpose === "setup" ? { surface } : {}),
      },
      pty,
      headless,
      serialize,
      sockets: new Set(),
      flowTimer: null,
      detachedSince: now,
    };
    this.sessions.set(id, entry);
    // Once it is in the map, `destroy` reports its exit, so every open reported here is matched by one exit — and a
    // terminal whose setup below fails is closed at once, rather than counted open until the reaper finds it.
    if (purpose === "setup" && surface) this.opts.onSetupTerminalOpen?.(surface);

    try {
      // Held, not written yet — see flushPendingInput for when it goes in. No
      // `\r` when it does: the user reviews the command and presses Enter
      // themselves, because we are about to run a binary out of libi's own
      // node_modules. Armed before output is observed, so the readiness clock
      // starts at spawn.
      if (initialInput) {
        this.holdPendingInput(entry, initialInput);
      }

      pty.onData((data) => {
        entry.headless.write(data);
        this.broadcastOutput(entry, data);
        // After the viewer has the output, so the prompt shows before the command.
        this.observePendingOutput(entry, data);
      });
      pty.onExit(({ exitCode }) => {
        this.destroy(id, exitCode);
      });

      // The line to type (e.g. `claude`, `codex`) — `null` for the plain shell.
      const launchLine = launchLineForPreset(effectiveCliId);
      if (launchLine) {
        // Typed into the shell (kernel pty input buffer holds it until the
        // shell reads), not exec'd — the user keeps a live shell when the
        // CLI exits and the command stays editable in history.
        pty.write(`${launchLine.text}\r`);
      }
    } catch (err) {
      logger.warn({ tag: "terminal", op: "create_failed", id, purpose, err }, "terminal failed while starting; removing it");
      try {
        pty.kill();
      } catch {
        // The PTY that failed may be gone already; removing the entry below is what matters.
      }
      this.destroy(id, -1);
      throw err;
    }

    logger.info(
      {
        tag: "terminal",
        op: "spawn",
        id,
        cliId: entry.meta.cliId,
        purpose,
        surface: entry.meta.surface,
        cwd,
        pid: pty.pid,
      },
      "terminal session spawned",
    );
    this.emitListChanged();
    return { ...entry.meta };
  }

  /** Live sessions of one purpose, newest first. Chat surfaces never see setup terminals. */
  list(purpose: TerminalPurpose = "chat"): TerminalSessionMeta[] {
    return [...this.sessions.values()]
      .filter((e) => e.meta.purpose === purpose)
      .sort((a, b) => b.meta.createdAt - a.meta.createdAt || b.seq - a.seq)
      .map((e) => ({ ...e.meta }));
  }

  rename(id: string, title: string): boolean {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    const trimmed = title.trim();
    if (!trimmed) return false;
    entry.meta.title = trimmed;
    this.emitListChanged();
    return true;
  }

  /** Kill the PTY and remove the session. */
  close(id: string): boolean {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    logger.info({ tag: "terminal", op: "close", id }, "terminal session closed by user");
    // kill() triggers onExit → destroy(); destroy() is idempotent so a
    // PTY implementation that never fires onExit still gets cleaned up.
    entry.pty.kill();
    this.destroy(id, 0);
    return true;
  }

  /**
   * Attach a viewer socket: replay the serialized buffer (pixel-faithful
   * snapshot — colors, cursor, alt-screen) then stream live output.
   * Async because xterm parses writes asynchronously — we flush the
   * headless terminal before serializing so the snapshot is current.
   */
  async attach(id: string, socket: AttachedSocket): Promise<boolean> {
    const entry = this.sessions.get(id);
    if (!entry) {
      socket.close(4404, "terminal session not found");
      return false;
    }

    // The close handler goes on BEFORE the flush is awaited. A viewer that
    // disconnects during that await fires its one `close` then, and a handler
    // added afterwards would never run: the dead socket would stay in
    // `sockets`, `detachedSince` would stay null, and the idle reaper would
    // never collect a setup terminal nobody can see any more.
    let closed = false;
    socket.on("close", () => {
      closed = true;
      // Closed before it was ever counted as a viewer: the terminal's
      // detachment (and its idle clock) is exactly what it was.
      if (!entry.sockets.delete(socket)) return;
      if (entry.sockets.size === 0) entry.detachedSince = this.now();
    });

    await new Promise<void>((resolve) => entry.headless.write("", resolve));
    if (closed) return false;
    this.sendControl(socket, {
      type: "snapshot",
      data: entry.serialize.serialize({ scrollback: SCROLLBACK_LINES }),
      cols: entry.headless.cols,
      rows: entry.headless.rows,
    });

    entry.sockets.add(socket);
    entry.detachedSince = null;
    socket.on("message", (raw) => {
      this.handleClientMessage(entry, raw);
    });

    logger.info(
      { tag: "terminal", op: "attach", id, viewers: entry.sockets.size },
      "terminal viewer attached",
    );
    return true;
  }

  /**
   * Close every setup terminal that has had no viewer for longer than
   * `SETUP_TERMINAL_IDLE_MS` — the page that opened it is gone (a crashed tab,
   * a lost DELETE). Chat terminals are never reaped: those belong to the user.
   * Returns how many were closed.
   */
  sweepIdleSetupTerminals(now: number = this.now()): number {
    let closed = 0;
    for (const [id, entry] of [...this.sessions]) {
      if (
        entry.meta.purpose !== "setup" ||
        entry.sockets.size > 0 ||
        entry.detachedSince === null
      ) {
        continue;
      }
      const idleMs = now - entry.detachedSince;
      if (idleMs <= SETUP_TERMINAL_IDLE_MS) continue;
      logger.info(
        { tag: "terminal", op: "setup_reaped", id, surface: entry.meta.surface, idleMs },
        "reaped a setup terminal nobody was attached to",
      );
      if (this.close(id)) closed++;
    }
    return closed;
  }

  // ── internals ────────────────────────────────────────────────────────

  private handleClientMessage(entry: TerminalEntry, raw: unknown): void {
    const text = String(raw);
    // Bound the raw frame before parsing — a peer must not be able to make us
    // buffer/parse an arbitrarily large control frame. Real frames are tiny.
    if (text.length > MAX_CLIENT_FRAME_CHARS) {
      logger.warn(
        { tag: "terminal", op: "frame_too_large", id: entry.meta.id, chars: text.length },
        "dropped oversized terminal client frame",
      );
      return;
    }
    let msg: TerminalClientMessage;
    try {
      msg = JSON.parse(text) as TerminalClientMessage;
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      // Truncate the decoded payload as a second bound on what reaches the PTY.
      const data =
        msg.data.length > MAX_INPUT_CHARS ? msg.data.slice(0, MAX_INPUT_CHARS) : msg.data;
      if (entry.pending) {
        this.acceptPendingClientInput(entry, entry.pending, data);
      } else {
        entry.pty.write(data);
      }
    } else if (
      msg.type === "resize" &&
      Number.isInteger(msg.cols) &&
      Number.isInteger(msg.rows) &&
      msg.cols > 1 &&
      msg.rows > 1
    ) {
      // Clamp to a sane maximum grid so a hostile resize can't force a huge
      // server-side xterm allocation.
      const cols = Math.min(msg.cols, MAX_TERMINAL_DIMENSION);
      const rows = Math.min(msg.rows, MAX_TERMINAL_DIMENSION);
      entry.pty.resize(cols, rows);
      entry.headless.resize(cols, rows);
      if (entry.pending) {
        entry.pending.clientSized = true;
        this.flushPendingInput(entry);
      }
    }
  }

  /**
   * Type the held `initialInput` — exactly once, and only when BOTH hold:
   *
   * 1. A viewer has sized the grid (its first `resize`). Writing at spawn works
   *    functionally but looks broken: the shell echoes the raw bytes before its
   *    prompt exists, redraws when zle initialises, and redraws AGAIN when the
   *    client's first resize arrives, so the user saw the command three times
   *    at three widths. After that resize the viewer is attached, streaming,
   *    and the grid is at its real width.
   * 2. The shell's line editor is reading. The first resize says nothing about
   *    the shell — it follows the snapshot replay, while a login shell's rc
   *    (oh-my-zsh, nvm, conda) may still be running. Until the line editor
   *    starts, the tty is in canonical mode, and macOS keeps only the first
   *    1024 bytes of a typed line: a ~2 KB setup command was cut short, the
   *    shell sat at a continuation prompt, and the secret the user typed next
   *    landed on screen and in history. Readiness is
   *    `LINE_EDITOR_READY_SEQUENCE` in the output; for a shell that never emits
   *    it, a quiet period after output (not before the minimum delay); and, in
   *    any case, the cap. See `observePendingOutput`. The quiet fallback is a
   *    heuristic: an rc that prints, then works silently for longer than the
   *    quiet period, is taken as ready too early — the sequence is what makes
   *    zsh and modern bash exact.
   *
   * Client input that arrives before the command is written is split in two
   * (`acceptPendingClientInput`):
   * - A chunk made up ENTIRELY of recognised terminal-reply sequences (cursor
   *   position report, device-attributes/status reports, OSC/DCS replies —
   *   see `TERMINAL_REPLY_CHUNK`) is xterm answering a query from the user's
   *   rc, and is written to the PTY at once. The rc is blocked on it; holding
   *   it behind a command that waits for that rc would stall startup for up
   *   to the cap.
   * - Anything else is DROPPED, never replayed: a plain keystroke, an arrow,
   *   Escape alone, an Alt-combo, an F-key, a focus event, or a chunk that
   *   mixes a reply with any of those. Written before the command it would
   *   corrupt it, and an early Enter would end the line editor's turn — the
   *   truncation this waits to avoid. Written after it, an Enter pressed
   *   before the command even appeared would run an installer or config
   *   write the user never read. Matching an arrow key as a reply would let
   *   an early Up-arrow recall a zsh history line, landing the command after
   *   it — visible corruption of a different kind. The number of dropped
   *   chunks is logged once (`pending_input_keystrokes_dropped`), never the
   *   characters.
   * Once the command is written, all input flows straight to the PTY.
   *
   * A session that exits or is closed first drops the command (`destroy`).
   */
  private flushPendingInput(entry: TerminalEntry): void {
    const pending = entry.pending;
    if (!pending || !pending.shellReady || !pending.clientSized) return;
    entry.pending = undefined;
    this.clearPendingTimers(pending);
    entry.pty.write(pending.text);
    this.logDroppedKeystrokes(entry, pending);
  }

  /** Hold `text` and start the fallback clocks — see `flushPendingInput`. */
  private holdPendingInput(entry: TerminalEntry, text: string): void {
    const pending: PendingInput = {
      text,
      droppedKeystrokes: 0,
      clientSized: false,
      shellReady: false,
      sawOutput: false,
      quiet: false,
      minDelayElapsed: false,
      scanTail: "",
      quietTimer: null,
      minDelayTimer: null,
      capTimer: null,
    };
    entry.pending = pending;
    pending.minDelayTimer = unrefTimer(
      setTimeout(() => {
        pending.minDelayTimer = null;
        pending.minDelayElapsed = true;
        this.maybeQuietFallback(entry, pending);
      }, PENDING_INPUT_MIN_DELAY_MS),
    );
    pending.capTimer = unrefTimer(
      setTimeout(() => {
        pending.capTimer = null;
        this.markShellReady(entry, pending, "cap");
      }, PENDING_INPUT_MAX_WAIT_MS),
    );
  }

  /** Watch output for the line editor starting; otherwise restart the quiet clock. */
  private observePendingOutput(entry: TerminalEntry, data: string): void {
    const pending = entry.pending;
    if (!pending || pending.shellReady || data.length === 0) return;
    const keep = LINE_EDITOR_READY_SEQUENCE.length - 1;
    const boundary = pending.scanTail + data.slice(0, keep);
    if (data.includes(LINE_EDITOR_READY_SEQUENCE) || boundary.includes(LINE_EDITOR_READY_SEQUENCE)) {
      this.markShellReady(entry, pending, "bracketed_paste");
      return;
    }
    pending.scanTail = (data.length >= keep ? data : pending.scanTail + data).slice(-keep);
    pending.sawOutput = true;
    pending.quiet = false;
    if (pending.quietTimer) clearTimeout(pending.quietTimer);
    pending.quietTimer = unrefTimer(
      setTimeout(() => {
        pending.quietTimer = null;
        pending.quiet = true;
        this.maybeQuietFallback(entry, pending);
      }, PENDING_INPUT_QUIET_MS),
    );
  }

  private maybeQuietFallback(entry: TerminalEntry, pending: PendingInput): void {
    if (pending.sawOutput && pending.quiet && pending.minDelayElapsed) {
      this.markShellReady(entry, pending, "quiet");
    }
  }

  private markShellReady(
    entry: TerminalEntry,
    pending: PendingInput,
    reason: PendingInputReadyReason,
  ): void {
    // A stale timer for a pending input already typed or torn down does nothing.
    if (entry.pending !== pending || pending.shellReady) return;
    pending.shellReady = true;
    this.clearPendingTimers(pending);
    const waitedMs = this.now() - entry.meta.createdAt;
    if (reason !== "bracketed_paste") {
      // Never the command text: it can carry a provider command.
      const fields = {
        tag: "terminal",
        op: "pending_input_fallback",
        id: entry.meta.id,
        reason,
        waitedMs,
        sawOutput: pending.sawOutput,
      };
      if (reason === "cap") {
        logger.warn(fields, "shell never showed a ready line editor; typing the held command anyway");
      } else {
        logger.info(fields, "shell went quiet without enabling bracketed paste; typing the held command");
      }
    }
    this.flushPendingInput(entry);
  }

  /**
   * Client input before the command is written: a chunk that is entirely
   * recognised terminal replies goes straight to the PTY; anything else
   * (a keystroke, an arrow/function/Alt key, or a chunk that mixes a reply
   * with something else) is dropped and counted. See `flushPendingInput` for
   * why.
   */
  private acceptPendingClientInput(entry: TerminalEntry, pending: PendingInput, data: string): void {
    if (isTerminalReplyChunk(data)) {
      entry.pty.write(data);
      return;
    }
    if (data.length > 0) pending.droppedKeystrokes += 1;
  }

  /** One log line for the keystrokes a waiting command dropped — a count only, never the characters. */
  private logDroppedKeystrokes(entry: TerminalEntry, pending: PendingInput): void {
    if (pending.droppedKeystrokes === 0) return;
    logger.info(
      {
        tag: "terminal",
        op: "pending_input_keystrokes_dropped",
        id: entry.meta.id,
        count: pending.droppedKeystrokes,
      },
      "dropped keystrokes typed before the setup command appeared",
    );
    pending.droppedKeystrokes = 0;
  }

  private clearPendingTimers(pending: PendingInput): void {
    for (const timer of [pending.quietTimer, pending.minDelayTimer, pending.capTimer]) {
      if (timer) clearTimeout(timer);
    }
    pending.quietTimer = null;
    pending.minDelayTimer = null;
    pending.capTimer = null;
  }

  private broadcastOutput(entry: TerminalEntry, data: string): void {
    if (entry.sockets.size === 0) return;
    const bytes = Buffer.from(data, "utf8");
    let maxBuffered = 0;
    for (const socket of entry.sockets) {
      socket.send(bytes);
      if (socket.bufferedAmount > maxBuffered) maxBuffered = socket.bufferedAmount;
    }
    // Flow control: a slow viewer (huge `cat`, suspended laptop) must not
    // buffer unbounded output in process memory. Standard node-pty trick.
    if (maxBuffered > FLOW_HIGH_WATER_BYTES && !entry.flowTimer) {
      entry.pty.pause();
      entry.flowTimer = setInterval(() => {
        const buffered = Math.max(
          0,
          ...[...entry.sockets].map((s) => s.bufferedAmount),
        );
        if (buffered < FLOW_LOW_WATER_BYTES) {
          if (entry.flowTimer) clearInterval(entry.flowTimer);
          entry.flowTimer = null;
          entry.pty.resume();
        }
      }, FLOW_POLL_MS);
    }
  }

  private sendControl(socket: AttachedSocket, msg: TerminalServerMessage): void {
    socket.send(JSON.stringify(msg));
  }

  /** Idempotent teardown: notify viewers, dispose, remove, broadcast list change. */
  private destroy(id: string, exitCode: number): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    this.sessions.delete(id);
    if (entry.flowTimer) clearInterval(entry.flowTimer);
    // Never type a held command into a dead PTY.
    if (entry.pending) {
      this.clearPendingTimers(entry.pending);
      this.logDroppedKeystrokes(entry, entry.pending);
      entry.pending = undefined;
    }
    entry.meta.status = "exited";
    for (const socket of entry.sockets) {
      try {
        this.sendControl(socket, { type: "exit", exitCode });
        socket.close(1000, "terminal exited");
      } catch {
        // socket already gone
      }
    }
    entry.sockets.clear();
    entry.headless.dispose();
    logger.info(
      { tag: "terminal", op: "exit", id, exitCode },
      "terminal session removed",
    );
    this.emitListChanged();
    if (entry.meta.purpose === "setup" && entry.meta.surface) {
      this.opts.onSetupTerminalExit?.(entry.meta.surface);
    }
  }

  private dedupeTitle(base: string): string {
    const titles = new Set([...this.sessions.values()].map((e) => e.meta.title));
    if (!titles.has(base)) return base;
    let n = 2;
    while (titles.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  private emitListChanged(): void {
    navigationEmitter.emit("refresh_query", { queryKey: "terminal-sessions" });
  }
}
