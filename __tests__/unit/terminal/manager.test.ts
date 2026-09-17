import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { navigationEmitter } from "@/lib/navigation-events";
import {
  TerminalManager,
  TerminalCapacityError,
  MAX_TERMINAL_SESSIONS,
  LINE_EDITOR_READY_SEQUENCE,
} from "@/lib/terminal/manager";
import { SETUP_TERMINAL_IDLE_MS } from "@/lib/terminal/types";
import type {
  AttachedSocket,
  PtyLike,
  PtySpawnOpts,
} from "@/lib/terminal/types";

class FakePty implements PtyLike {
  pid = 1234;
  cols = 80;
  rows = 24;
  written: string[] = [];
  killed = false;
  paused = false;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;

  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  kill(): void {
    this.killed = true;
    this.exitCb?.({ exitCode: 0 });
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCb = cb;
  }

  emitData(data: string): void {
    this.dataCb?.(data);
  }
  emitExit(exitCode: number): void {
    this.exitCb?.({ exitCode });
  }
}

class FakeSocket implements AttachedSocket {
  sent: Array<string | Uint8Array> = [];
  bufferedAmount = 0;
  closed: { code?: number; reason?: string } | null = null;
  private handlers = new Map<string, Array<(arg?: unknown) => void>>();

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    for (const cb of this.handlers.get("close") ?? []) cb();
  }
  on(event: "message" | "close", cb: (arg?: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }

  emitMessage(raw: string): void {
    for (const cb of this.handlers.get("message") ?? []) cb(Buffer.from(raw));
  }
  /** Text frames sent by the server, parsed as JSON. */
  jsonFrames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === "string")
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }
  /** Binary frames decoded to utf8. */
  binaryFrames(): string[] {
    return this.sent
      .filter((d): d is Uint8Array => typeof d !== "string")
      .map((d) => Buffer.from(d).toString("utf8"));
  }
}

function makeManager(maxSessions?: number) {
  const ptys: FakePty[] = [];
  const spawnOpts: PtySpawnOpts[] = [];
  const factory = (opts: PtySpawnOpts): PtyLike => {
    spawnOpts.push(opts);
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  };
  const manager = new TerminalManager(factory, {
    cwd: () => "/tmp/libi-agent-test",
    maxSessions,
  });
  return { manager, ptys, spawnOpts };
}

describe("TerminalManager", () => {
  let refreshEvents: Array<{ queryKey: string }>;
  const onRefresh = (e: { queryKey: string }) => refreshEvents.push(e);

  beforeEach(() => {
    refreshEvents = [];
    navigationEmitter.on("refresh_query", onRefresh);
  });
  afterEach(() => {
    navigationEmitter.off("refresh_query", onRefresh);
  });

  it("creates a session and types the preset command into the shell", () => {
    const { manager, ptys } = makeManager();
    const meta = manager.create({ cliId: "claude-code" });
    expect(meta.status).toBe("running");
    expect(meta.title).toBe("Claude Code");
    expect(ptys[0].written).toEqual(["claude\r"]);
  });

  it("types nothing for the plain shell preset", () => {
    const { manager, ptys } = makeManager();
    manager.create({ cliId: "shell" });
    expect(ptys[0].written).toEqual([]);
  });

  it("types a bare 'codex' for the codex preset (no -c overrides)", () => {
    const { manager, ptys } = makeManager();
    manager.create({ cliId: "codex" });
    expect(ptys[0].written).toEqual(["codex\r"]);
  });

  it("spawns every PTY with CODEX_HOME set (so codex reads libi's config)", () => {
    const { manager, spawnOpts } = makeManager();
    manager.create({ cliId: "codex" });
    const env = spawnOpts[0].env as Record<string, string>;
    expect(typeof env.CODEX_HOME).toBe("string");
    expect(env.CODEX_HOME.length).toBeGreaterThan(0);
  });

  it("spawns every PTY without the host Claude Code session's markers, keeping user configuration", () => {
    vi.stubEnv("CLAUDECODE", "1");
    vi.stubEnv("CLAUDE_CODE_CHILD_SESSION", "1");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/keep/me");
    try {
      const { manager, spawnOpts } = makeManager();
      manager.create({ cliId: "shell" });
      const env = spawnOpts[0].env as Record<string, string>;
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBe("/keep/me");
      expect(typeof env.CODEX_HOME).toBe("string");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("spawns every PTY, setup terminals included, without this server's LIBI_SERVER_PORT, so a CLI started there finds its server the way it would in any other shell", () => {
    vi.stubEnv("LIBI_SERVER_PORT", "55268");
    try {
      const { manager, spawnOpts } = makeManager();
      manager.create({ cliId: "shell" });
      manager.create({ cliId: "shell", purpose: "setup", surface: "agents" });
      expect(spawnOpts).toHaveLength(2);
      for (const opts of spawnOpts) {
        expect((opts.env as Record<string, string | undefined>).LIBI_SERVER_PORT).toBeUndefined();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falls back to plain shell for an unknown cliId", () => {
    const { manager, ptys } = makeManager();
    const meta = manager.create({ cliId: "nope" });
    expect(ptys[0].written).toEqual([]);
    expect(meta.title).toBe("Terminal");
  });

  it("dedupes default titles with a counter", () => {
    const { manager } = makeManager();
    const a = manager.create({ cliId: "claude-code" });
    const b = manager.create({ cliId: "claude-code" });
    const c = manager.create({ cliId: "claude-code" });
    expect(a.title).toBe("Claude Code");
    expect(b.title).toBe("Claude Code 2");
    expect(c.title).toBe("Claude Code 3");
  });

  it("lists sessions sorted by creation, newest first", () => {
    const { manager } = makeManager();
    const a = manager.create({ cliId: "shell" });
    const b = manager.create({ cliId: "shell" });
    const c = manager.create({ cliId: "shell" });
    expect(manager.list().map((s) => s.id)).toEqual([c.id, b.id, a.id]);
  });

  it("rejects creation at capacity and emits no kill", () => {
    const { manager } = makeManager(2);
    manager.create({ cliId: "shell" });
    manager.create({ cliId: "shell" });
    expect(() => manager.create({ cliId: "shell" })).toThrow(
      TerminalCapacityError,
    );
    expect(manager.list()).toHaveLength(2);
  });

  it("defaults capacity to 50", () => {
    expect(MAX_TERMINAL_SESSIONS).toBe(50);
  });

  it("renames a session and emits a terminal-sessions refresh", () => {
    const { manager } = makeManager();
    const meta = manager.create({ cliId: "shell" });
    refreshEvents = [];
    expect(manager.rename(meta.id, "my build box")).toBe(true);
    expect(manager.list()[0].title).toBe("my build box");
    expect(refreshEvents).toEqual([{ queryKey: "terminal-sessions" }]);
    expect(manager.rename("missing", "x")).toBe(false);
  });

  it("close kills the pty and removes the session", () => {
    const { manager, ptys } = makeManager();
    const meta = manager.create({ cliId: "shell" });
    refreshEvents = [];
    expect(manager.close(meta.id)).toBe(true);
    expect(ptys[0].killed).toBe(true);
    expect(manager.list()).toHaveLength(0);
    expect(refreshEvents.length).toBeGreaterThanOrEqual(1);
    expect(manager.close(meta.id)).toBe(false);
  });

  it("shell exit removes the session and notifies attached sockets", async () => {
    const { manager, ptys } = makeManager();
    const meta = manager.create({ cliId: "shell" });
    const socket = new FakeSocket();
    await manager.attach(meta.id, socket);
    refreshEvents = [];

    ptys[0].emitExit(7);

    expect(manager.list()).toHaveLength(0);
    const exit = socket.jsonFrames().find((f) => f.type === "exit");
    expect(exit).toEqual({ type: "exit", exitCode: 7 });
    expect(socket.closed).not.toBeNull();
    expect(refreshEvents).toEqual([{ queryKey: "terminal-sessions" }]);
  });

  it("attach sends a snapshot containing prior output, then streams live bytes as binary", async () => {
    const { manager, ptys } = makeManager();
    const meta = manager.create({ cliId: "shell" });
    ptys[0].emitData("hello from shell");

    const socket = new FakeSocket();
    await manager.attach(meta.id, socket);

    const first = socket.jsonFrames()[0];
    expect(first.type).toBe("snapshot");
    expect(String(first.data)).toContain("hello from shell");

    ptys[0].emitData("live!");
    expect(socket.binaryFrames()).toEqual(["live!"]);
  });

  it("routes input and resize messages to the pty", async () => {
    const { manager, ptys } = makeManager();
    const meta = manager.create({ cliId: "shell" });
    const socket = new FakeSocket();
    await manager.attach(meta.id, socket);

    socket.emitMessage(JSON.stringify({ type: "input", data: "ls\r" }));
    expect(ptys[0].written).toContain("ls\r");

    socket.emitMessage(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    expect(ptys[0].cols).toBe(120);
    expect(ptys[0].rows).toBe(40);
  });

  it("clamps an oversized resize to the max grid dimension", async () => {
    const { manager, ptys } = makeManager();
    const meta = manager.create({ cliId: "shell" });
    const socket = new FakeSocket();
    await manager.attach(meta.id, socket);

    socket.emitMessage(
      JSON.stringify({ type: "resize", cols: 99999, rows: 88888 }),
    );
    expect(ptys[0].cols).toBe(1000);
    expect(ptys[0].rows).toBe(1000);
  });

  it("rejects an oversized input frame without writing to the pty", async () => {
    const { manager, ptys } = makeManager();
    const meta = manager.create({ cliId: "shell" });
    const socket = new FakeSocket();
    await manager.attach(meta.id, socket);

    const huge = "x".repeat(70 * 1024); // frame JSON exceeds the 64 KiB cap
    socket.emitMessage(JSON.stringify({ type: "input", data: huge }));
    expect(ptys[0].written).not.toContain(huge);
    expect(ptys[0].written.some((w) => w.length > 64 * 1024)).toBe(false);
  });

  it("closes the socket with 4404 for an unknown session", async () => {
    const { manager } = makeManager();
    const socket = new FakeSocket();
    await manager.attach("term-missing", socket);
    expect(socket.closed?.code).toBe(4404);
  });

  it("detached sockets stop receiving output", async () => {
    const { manager, ptys } = makeManager();
    const meta = manager.create({ cliId: "shell" });
    const socket = new FakeSocket();
    await manager.attach(meta.id, socket);
    socket.close();
    ptys[0].emitData("after close");
    expect(socket.binaryFrames()).toEqual([]);
  });
});

/**
 * `initialInput` — a command placed at the prompt of a brand-new terminal,
 * used by the agent sign-in remedies.
 *
 * Reported bug: clicking "Sign in to Codex" with no terminal open produced a
 * terminal with NO command in it. Two client-side deliveries were tried and
 * both lost the race — a `TERMINAL_INSERT_TEXT_EVENT` broadcast is heard by
 * nobody (the view is a dynamic import that hasn't mounted), and pasting on
 * socket-open is wiped moments later by the `term.reset()` the client runs
 * when it replays the attach snapshot. So the text is handed to the SERVER at
 * spawn instead.
 *
 * Writing it at spawn is functionally fine but looks broken: the shell echoes
 * raw bytes before its prompt exists, redraws when zle initialises, and redraws
 * again on the client's first resize — the command appeared THREE times at
 * three widths. Hence it waits for the client's first resize.
 *
 * The first resize alone is NOT "shell up": a slow rc keeps the tty in
 * canonical mode, where macOS keeps only 1024 bytes of a typed line. So it
 * also waits for the line editor — the bracketed-paste-enable sequence these
 * tests emit, or a timed fallback (manager-pending-input-readiness.test.ts).
 */
describe("TerminalManager initialInput", () => {
  it("does not type the command at spawn, when the shell has no prompt yet", () => {
    const { manager, ptys } = makeManager();
    manager.create({ cliId: "shell", initialInput: "codex login" });
    expect(
      ptys[0].written.join(""),
      "writing at spawn renders the command three times at three widths",
    ).not.toContain("codex login");
  });

  it("types it once the client has attached and sized the grid", async () => {
    const { manager, ptys } = makeManager();
    const meta = manager.create({ cliId: "shell", initialInput: "codex login" });
    const socket = new FakeSocket();
    await manager.attach(meta.id, socket);

    socket.emitMessage(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    ptys[0].emitData(`${LINE_EDITOR_READY_SEQUENCE}% `);

    expect(ptys[0].written.join("")).toContain("codex login");
  });

  it("never appends a newline — the user reviews before running it", async () => {
    const { manager, ptys } = makeManager();
    const meta = manager.create({ cliId: "shell", initialInput: "codex login" });
    const socket = new FakeSocket();
    await manager.attach(meta.id, socket);
    socket.emitMessage(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    ptys[0].emitData(LINE_EDITOR_READY_SEQUENCE);

    const typed = ptys[0].written.join("");
    expect(typed).toContain("codex login");
    expect(
      typed,
      "a newline would EXECUTE a binary out of libi's own node_modules unasked",
    ).not.toContain("codex login\r");
  });

  it("types it only once, however many resizes arrive", async () => {
    const { manager, ptys } = makeManager();
    const meta = manager.create({ cliId: "shell", initialInput: "codex login" });
    const socket = new FakeSocket();
    await manager.attach(meta.id, socket);
    ptys[0].emitData(LINE_EDITOR_READY_SEQUENCE);

    for (const cols of [100, 120, 90]) {
      socket.emitMessage(JSON.stringify({ type: "resize", cols, rows: 30 }));
    }

    const occurrences = ptys[0].written.join("").split("codex login").length - 1;
    expect(occurrences).toBe(1);
  });

  it("leaves a terminal created without initialInput completely untouched", async () => {
    const { manager, ptys } = makeManager();
    const meta = manager.create({ cliId: "shell" });
    const socket = new FakeSocket();
    await manager.attach(meta.id, socket);
    socket.emitMessage(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));

    expect(ptys[0].written.join("")).toBe("");
  });
});

/**
 * Setup terminals — the Agents page prints ONE command into a fresh shell for
 * the user to submit. At most one lives per surface, they stay out of the chat
 * terminal list while still counting toward the session cap, and one nobody
 * is looking at is reaped after ten minutes.
 */
describe("setup terminals", () => {
  function setupManager(
    opts: {
      onSetupTerminalOpen?: (s: "agents" | "global-setup" | "providers") => void;
      onSetupTerminalExit?: (s: "agents" | "global-setup" | "providers") => void;
      now?: () => number;
    } = {},
  ) {
    const ptys: FakePty[] = [];
    const spawnOpts: PtySpawnOpts[] = [];
    const manager = new TerminalManager(
      (o) => {
        spawnOpts.push(o);
        const p = new FakePty();
        ptys.push(p);
        return p;
      },
      { cwd: () => "/agent-dir", ...opts },
    );
    return { manager, ptys, spawnOpts };
  }

  it("defaults purpose to chat and lists only chat terminals by default", () => {
    const { manager } = setupManager();
    const chat = manager.create({ cliId: "shell" });
    const setup = manager.create({ cliId: "shell", purpose: "setup", surface: "agents", initialInput: "echo hi" });
    expect(chat.purpose).toBe("chat");
    expect(setup.purpose).toBe("setup");
    expect(setup.surface).toBe("agents");
    expect(manager.list().map((m) => m.id)).toEqual([chat.id]);
    expect(manager.list("setup").map((m) => m.id)).toEqual([setup.id]);
  });

  it("refuses a setup terminal without a surface", () => {
    const { manager } = setupManager();
    expect(() => manager.create({ cliId: "shell", purpose: "setup" })).toThrow(/surface/);
  });

  it("spawns the PTY with purpose so the factory can pick the known shell", () => {
    const { manager, spawnOpts } = setupManager();
    manager.create({ cliId: "shell", purpose: "setup", surface: "providers" });
    expect(spawnOpts[0].purpose).toBe("setup");
    expect(spawnOpts[0].cwd).toBe("/agent-dir");
  });

  it("creating a second setup terminal for the SAME surface closes the first", () => {
    const { manager, ptys } = setupManager();
    const first = manager.create({ cliId: "shell", purpose: "setup", surface: "agents", initialInput: "a" });
    const second = manager.create({ cliId: "shell", purpose: "setup", surface: "agents", initialInput: "b" });
    expect(ptys[0].killed).toBe(true);
    expect(manager.list("setup").map((m) => m.id)).toEqual([second.id]);
    expect(manager.list("setup").find((m) => m.id === first.id)).toBeUndefined();
  });

  it("replacing a surface's setup terminal is never refused for capacity", () => {
    const { manager } = setupManager();
    for (let i = 0; i < MAX_TERMINAL_SESSIONS - 1; i++) manager.create({ cliId: "shell" });
    manager.create({ cliId: "shell", purpose: "setup", surface: "agents" });
    const replacement = manager.create({ cliId: "shell", purpose: "setup", surface: "agents" });
    expect(manager.list("setup").map((m) => m.id)).toEqual([replacement.id]);
  });

  it("keeps setup terminals on different surfaces side by side", () => {
    const { manager } = setupManager();
    manager.create({ cliId: "shell", purpose: "setup", surface: "agents" });
    manager.create({ cliId: "shell", purpose: "setup", surface: "global-setup" });
    expect(manager.list("setup")).toHaveLength(2);
  });

  it("holds initialInput until the first resize and a ready line editor, exactly like a chat terminal", async () => {
    const { manager, ptys } = setupManager();
    const meta = manager.create({ cliId: "shell", purpose: "setup", surface: "agents", initialInput: "claude mcp add …" });
    expect(ptys[0].written).toEqual([]);
    const socket = new FakeSocket();
    await manager.attach(meta.id, socket);
    socket.emitMessage(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    ptys[0].emitData(LINE_EDITOR_READY_SEQUENCE);
    expect(ptys[0].written).toEqual(["claude mcp add …"]);
  });

  it("is the plain shell whatever preset is asked for: no launch line is typed ahead of its command", async () => {
    const { manager, ptys } = setupManager();
    const meta = manager.create({ cliId: "claude-code", purpose: "setup", surface: "agents", initialInput: "claude mcp add …" });
    expect(meta.cliId).toBe("shell");
    expect(ptys[0].written).toEqual([]);
    const socket = new FakeSocket();
    await manager.attach(meta.id, socket);
    socket.emitMessage(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    ptys[0].emitData(LINE_EDITOR_READY_SEQUENCE);
    expect(ptys[0].written).toEqual(["claude mcp add …"]);
  });

  it("counts toward MAX_TERMINAL_SESSIONS", () => {
    const { manager } = setupManager();
    for (let i = 0; i < MAX_TERMINAL_SESSIONS - 1; i++) manager.create({ cliId: "shell" });
    manager.create({ cliId: "shell", purpose: "setup", surface: "agents" });
    expect(() => manager.create({ cliId: "shell" })).toThrow(TerminalCapacityError);
  });

  it("reaps a setup terminal with no attached socket for more than 10 minutes, never a chat one", () => {
    let clock = 1_000_000;
    const { manager, ptys } = setupManager({ now: () => clock });
    const chat = manager.create({ cliId: "shell" });
    manager.create({ cliId: "shell", purpose: "setup", surface: "providers" });
    clock += SETUP_TERMINAL_IDLE_MS - 1;
    expect(manager.sweepIdleSetupTerminals()).toBe(0);
    clock += 2;
    expect(manager.sweepIdleSetupTerminals()).toBe(1);
    expect(ptys[1].killed).toBe(true);
    expect(manager.list("setup")).toEqual([]);
    expect(manager.list().map((m) => m.id)).toEqual([chat.id]);
  });

  it("an attached viewer resets the idle clock; detaching starts it again", async () => {
    const t0 = 5_000_000;
    let clock = t0;
    const { manager } = setupManager({ now: () => clock });
    const meta = manager.create({ cliId: "shell", purpose: "setup", surface: "agents" });
    const socket = new FakeSocket();
    clock = t0 + 60_000;
    await manager.attach(meta.id, socket);
    clock = t0 + SETUP_TERMINAL_IDLE_MS + 1;
    expect(manager.sweepIdleSetupTerminals()).toBe(0); // attached — never idle
    clock = t0 + 60_000;
    socket.close(); // runs the registered close handlers, so the idle clock starts now
    clock = t0 + 60_000 + SETUP_TERMINAL_IDLE_MS - 1;
    expect(manager.sweepIdleSetupTerminals()).toBe(0);
    clock += 2;
    expect(manager.sweepIdleSetupTerminals()).toBe(1);
  });

  it("a viewer that disconnects while its snapshot is prepared leaves the terminal detached, so the reaper still collects it", async () => {
    const t0 = 5_000_000;
    let clock = t0;
    const { manager, ptys } = setupManager({ now: () => clock });
    const meta = manager.create({ cliId: "shell", purpose: "setup", surface: "agents" });
    const socket = new FakeSocket();
    const attaching = manager.attach(meta.id, socket);
    // The page goes away while the headless terminal is still flushing: its one `close` fires now.
    socket.close();
    expect(await attaching).toBe(false);
    expect(socket.jsonFrames()).toEqual([]); // nothing is sent to a socket that already closed
    clock = t0 + SETUP_TERMINAL_IDLE_MS + 1;
    expect(manager.sweepIdleSetupTerminals()).toBe(1);
    expect(ptys[0].killed).toBe(true);
  });

  it("tells the owner which surface's setup terminal exited", () => {
    const exited: string[] = [];
    const { manager, ptys } = setupManager({ onSetupTerminalExit: (s) => exited.push(s) });
    manager.create({ cliId: "shell", purpose: "setup", surface: "global-setup" });
    manager.create({ cliId: "shell" });
    ptys[0].emitExit(0);
    ptys[1].emitExit(0);
    expect(exited).toEqual(["global-setup"]);
  });

  it("tells the owner when a setup terminal opens — never for a chat terminal — and a replaced one reports its exit before the next opens", () => {
    const events: string[] = [];
    const { manager } = setupManager({
      onSetupTerminalOpen: (s) => events.push(`open:${s}`),
      onSetupTerminalExit: (s) => events.push(`exit:${s}`),
    });
    manager.create({ cliId: "shell" });
    manager.create({ cliId: "shell", purpose: "setup", surface: "providers" });
    expect(events).toEqual(["open:providers"]);
    manager.create({ cliId: "shell", purpose: "setup", surface: "providers" });
    expect(events).toEqual(["open:providers", "exit:providers", "open:providers"]);
  });

  it("a setup terminal whose setup fails after it was counted open is removed at once — even when killing it throws too — so its open is matched by an exit and the first error is the one thrown", () => {
    const events: string[] = [];
    const broken = new FakePty();
    broken.onData = () => {
      throw new Error("pty gone");
    };
    broken.kill = function (this: FakePty) {
      this.killed = true;
      throw new Error("kill failed");
    };
    const manager = new TerminalManager(() => broken, {
      cwd: () => "/agent-dir",
      onSetupTerminalOpen: (s) => events.push(`open:${s}`),
      onSetupTerminalExit: (s) => events.push(`exit:${s}`),
    });
    expect(() => manager.create({ cliId: "shell", purpose: "setup", surface: "agents" })).toThrow("pty gone");
    expect(events).toEqual(["open:agents", "exit:agents"]);
    expect(broken.killed).toBe(true);
    expect(manager.list("setup")).toEqual([]);
  });

  /**
   * Closing (the Close button, a DELETE) must drop the server's CLI and
   * registration memos exactly like an exit does — otherwise a re-read right
   * after closing can serve a value read before the command ran.
   */
  it("tells the owner once when a setup terminal is CLOSED, whether or not the PTY reports its exit", () => {
    const exited: string[] = [];
    const { manager, ptys } = setupManager({ onSetupTerminalExit: (s) => exited.push(s) });
    const reporting = manager.create({ cliId: "shell", purpose: "setup", surface: "global-setup" });
    expect(manager.close(reporting.id)).toBe(true);
    expect(ptys[0].killed).toBe(true);
    expect(exited).toEqual(["global-setup"]);

    const silent = manager.create({ cliId: "shell", purpose: "setup", surface: "agents" });
    ptys[1].kill = function (this: FakePty) {
      this.killed = true; // a PTY that never fires onExit
    };
    expect(manager.close(silent.id)).toBe(true);
    expect(exited).toEqual(["global-setup", "agents"]);
    expect(manager.close(silent.id)).toBe(false);
    expect(exited).toEqual(["global-setup", "agents"]);
  });
});
