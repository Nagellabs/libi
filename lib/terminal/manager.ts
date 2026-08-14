import { randomUUID } from "node:crypto";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { navigationEmitter } from "@/lib/navigation-events";
import { serverLogger as logger } from "@/lib/logger";
import { getPreset } from "./presets";
import { launchCommandForPreset } from "./launch-command";
import { resolveCodexHome } from "@/lib/codex-config/canonical";
import { MAX_TERMINAL_SESSIONS } from "./types";
import type {
  AttachedSocket,
  PtyFactory,
  PtyLike,
  TerminalClientMessage,
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

export class TerminalCapacityError extends Error {
  constructor(max: number) {
    super(
      `Terminal session limit reached (${max}). Close a terminal before opening a new one.`,
    );
    this.name = "TerminalCapacityError";
  }
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
   * Text to type into the shell once a viewer has attached and sized it.
   * Cleared on first flush — see `flushPendingInput`.
   */
  pendingInput?: string;
}

export interface TerminalManagerOpts {
  /** Working directory for new PTYs, resolved at spawn time. */
  cwd: () => string;
  maxSessions?: number;
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

  constructor(
    private ptyFactory: PtyFactory,
    private opts: TerminalManagerOpts,
  ) {
    this.maxSessions = opts.maxSessions ?? MAX_TERMINAL_SESSIONS;
  }

  /**
   * `initialInput` is typed into the new shell WITHOUT a trailing newline, so
   * it sits at the prompt for the user to read and press Enter on. Used by the
   * agent sign-in remedies (`lib/agents/terminal-remedy.ts`).
   *
   * It is delivered HERE, server-side, and not pasted from the browser — that
   * matters. A client-side paste has to survive the view mounting, a WebSocket
   * connecting, and the server's attach `snapshot`, which the client replays
   * with a `term.reset()` that wipes anything echoed before it. Two client-side
   * attempts were tried and both lost that race.
   *
   * The text is HELD here rather than typed immediately — see
   * `flushPendingInput` for why the first client resize is the right moment.
   */
  create({
    cliId,
    initialInput,
  }: {
    cliId: string;
    initialInput?: string;
  }): TerminalSessionMeta {
    if (this.sessions.size >= this.maxSessions) {
      throw new TerminalCapacityError(this.maxSessions);
    }

    const preset = getPreset(cliId);
    const id = `term-${randomUUID()}`;
    const cwd = this.opts.cwd();

    // Point any codex launched in this terminal at the codex home libi manages
    // for THIS instance: the real `~/.codex` on the canonical app, a scoped
    // `<LIBI_HOME>/.codex` in a worktree/dev build. This is the same home the
    // "Install" button writes libi's MCP servers into, so a bare `codex` here
    // picks up libi's tools. Harmless for non-codex presets (claude ignores it).
    const pty = this.ptyFactory({
      cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      env: { ...process.env, CODEX_HOME: resolveCodexHome() },
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
        title: this.dedupeTitle(preset?.label ?? "Terminal"),
        cliId: preset?.id ?? "shell",
        createdAt: Date.now(),
        status: "running",
      },
      pty,
      headless,
      serialize,
      sockets: new Set(),
      flowTimer: null,
    };
    this.sessions.set(id, entry);

    pty.onData((data) => {
      entry.headless.write(data);
      this.broadcastOutput(entry, data);
    });
    pty.onExit(({ exitCode }) => {
      this.destroy(id, exitCode);
    });

    // Resolve the command to type (e.g. `claude`, `codex`) — the static preset
    // command; `null` for the plain shell.
    const launchCommand = launchCommandForPreset(cliId);
    if (launchCommand) {
      // Typed into the shell (kernel pty input buffer holds it until the
      // shell reads), not exec'd — the user keeps a live shell when the
      // CLI exits and the command stays editable in history.
      pty.write(`${launchCommand}\r`);
    }

    // Held, not written yet — see flushPendingInput for why the first client
    // resize is the right moment. No `\r` when it does go in: the user reviews
    // the command and presses Enter themselves, because we are about to run a
    // binary out of libi's own node_modules.
    if (initialInput) {
      entry.pendingInput = initialInput;
    }

    logger.info(
      { tag: "terminal", op: "spawn", id, cliId: entry.meta.cliId, cwd, pid: pty.pid },
      "terminal session spawned",
    );
    this.emitListChanged();
    return { ...entry.meta };
  }

  list(): TerminalSessionMeta[] {
    return [...this.sessions.values()]
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

    await new Promise<void>((resolve) => entry.headless.write("", resolve));
    this.sendControl(socket, {
      type: "snapshot",
      data: entry.serialize.serialize({ scrollback: SCROLLBACK_LINES }),
      cols: entry.headless.cols,
      rows: entry.headless.rows,
    });

    entry.sockets.add(socket);
    socket.on("message", (raw) => {
      this.handleClientMessage(entry, raw);
    });
    socket.on("close", () => {
      entry.sockets.delete(socket);
    });

    logger.info(
      { tag: "terminal", op: "attach", id, viewers: entry.sockets.size },
      "terminal viewer attached",
    );
    return true;
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
      entry.pty.write(data);
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
      this.flushPendingInput(entry);
    }
  }

  /**
   * Type the queued `initialInput` once, at the first client resize.
   *
   * Timing is the whole point. Writing it at SPAWN works functionally — the
   * kernel PTY buffer holds it — but looks broken: the shell echoes the raw
   * bytes before its prompt exists, redraws when zle initialises, and redraws
   * AGAIN when the client's first resize arrives, so the user sees the command
   * three times at three widths. The first client `resize` is the earliest
   * moment everything is settled: shell up, grid at its real width, viewer
   * attached and streaming. Event-driven, so no timer to tune.
   */
  private flushPendingInput(entry: TerminalEntry): void {
    const text = entry.pendingInput;
    if (!text) return;
    entry.pendingInput = undefined;
    entry.pty.write(text);
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
