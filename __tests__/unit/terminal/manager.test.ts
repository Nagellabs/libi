import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { navigationEmitter } from "@/lib/navigation-events";
import {
  TerminalManager,
  TerminalCapacityError,
  MAX_TERMINAL_SESSIONS,
} from "@/lib/terminal/manager";
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
 * three widths. Hence the flush-on-first-resize below.
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

    expect(ptys[0].written.join("")).toContain("codex login");
  });

  it("never appends a newline — the user reviews before running it", async () => {
    const { manager, ptys } = makeManager();
    const meta = manager.create({ cliId: "shell", initialInput: "codex login" });
    const socket = new FakeSocket();
    await manager.attach(meta.id, socket);
    socket.emitMessage(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));

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
