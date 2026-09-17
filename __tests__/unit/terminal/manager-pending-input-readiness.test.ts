import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { serverLogger } from "@/lib/logger";
import {
  TerminalManager,
  LINE_EDITOR_READY_SEQUENCE,
  PENDING_INPUT_QUIET_MS,
  PENDING_INPUT_MIN_DELAY_MS,
  PENDING_INPUT_MAX_WAIT_MS,
} from "@/lib/terminal/manager";
import type { AttachedSocket, PtyLike } from "@/lib/terminal/types";

/**
 * A setup terminal's command is typed into a login shell whose rc may take
 * seconds (oh-my-zsh, nvm, conda). Until the shell's line editor starts, the
 * tty is in canonical mode and macOS keeps only the first 1024 bytes of a typed
 * line — a ~2 KB setup command was cut short, the shell sat at a continuation
 * prompt, and the secret the user typed next landed on screen and in history.
 *
 * So the command waits for the line editor: the bracketed-paste-enable
 * sequence zsh/bash emit when it starts, or — for shells that never emit it —
 * a quiet period after output, never before a minimum delay, capped overall.
 * It is still never typed before a viewer has sized the grid.
 */

class FakePty implements PtyLike {
  pid = 4321;
  written: string[] = [];
  killed = false;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;

  write(data: string): void {
    this.written.push(data);
  }
  resize(): void {}
  kill(): void {
    this.killed = true;
    this.exitCb?.({ exitCode: 0 });
  }
  pause(): void {}
  resume(): void {}
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
  typed(): string {
    return this.written.join("");
  }
}

class FakeSocket implements AttachedSocket {
  sent: Array<string | Uint8Array> = [];
  bufferedAmount = 0;
  private handlers = new Map<string, Array<(arg?: unknown) => void>>();
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    for (const cb of this.handlers.get("close") ?? []) cb();
  }
  on(event: "message" | "close", cb: (arg?: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  emitMessage(msg: Record<string, unknown>): void {
    for (const cb of this.handlers.get("message") ?? []) cb(Buffer.from(JSON.stringify(msg)));
  }
  resize(cols = 120, rows = 40): void {
    this.emitMessage({ type: "resize", cols, rows });
  }
  input(data: string): void {
    this.emitMessage({ type: "input", data });
  }
}

/** Wall-clock timing for the matcher-cost test, bound before any test fakes the clocks. */
const realNow = performance.now.bind(performance);

/** A setup command the size of the real keyed ones: over macOS's 1024-byte canonical line. */
const COMMAND = `echo ${"A".repeat(2000)}`;
const READY = LINE_EDITOR_READY_SEQUENCE;

function makeSetupTerminal(initialInput: string = COMMAND) {
  const ptys: FakePty[] = [];
  const manager = new TerminalManager(
    () => {
      const p = new FakePty();
      ptys.push(p);
      return p;
    },
    { cwd: () => "/agent-dir" },
  );
  const meta = manager.create({ cliId: "shell", purpose: "setup", surface: "providers", initialInput });
  return { manager, meta, pty: ptys[0] };
}

/** Attach a viewer. The headless xterm flushes on a timer, so let fake time run it (0 ms passes). */
async function attach(manager: TerminalManager, id: string): Promise<FakeSocket> {
  const socket = new FakeSocket();
  const attaching = manager.attach(id, socket);
  await vi.advanceTimersByTimeAsync(0);
  expect(await attaching).toBe(true);
  return socket;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("TerminalManager pending input waits for the shell's line editor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the named timing values the design calls for", () => {
    expect(READY).toBe("\x1b[?2004h");
    expect(PENDING_INPUT_QUIET_MS).toBe(750);
    expect(PENDING_INPUT_MIN_DELAY_MS).toBe(1500);
    expect(PENDING_INPUT_MAX_WAIT_MS).toBe(15_000);
  });

  it("does NOT type the command on the first resize while the shell is still starting", async () => {
    const { manager, meta, pty } = makeSetupTerminal();
    const socket = await attach(manager, meta.id);
    socket.resize();
    expect(
      pty.typed(),
      "typed into a canonical-mode tty, a 2 KB line is cut at 1024 bytes",
    ).not.toContain("echo A");
  });

  it("types it the moment the line editor enables bracketed paste", async () => {
    const { manager, meta, pty } = makeSetupTerminal();
    const socket = await attach(manager, meta.id);
    socket.resize();
    pty.emitData("Last login: today\r\n");
    expect(pty.typed()).toBe("");
    pty.emitData(`${READY}%                 \r\x1b[0m\x1b[27m\x1b[24m\x1b[Jhost% `);
    expect(pty.typed()).toBe(COMMAND);
  });

  it("recognises the sequence split across two output chunks", async () => {
    const { manager, meta, pty } = makeSetupTerminal();
    const socket = await attach(manager, meta.id);
    socket.resize();
    pty.emitData("prompt\x1b[?20");
    expect(pty.typed()).toBe("");
    pty.emitData("04hmore");
    expect(pty.typed()).toBe(COMMAND);
  });

  it("recognises the sequence delivered one byte per chunk", async () => {
    const { manager, meta, pty } = makeSetupTerminal();
    const socket = await attach(manager, meta.id);
    socket.resize();
    const chars = [...READY];
    for (const ch of chars.slice(0, -1)) pty.emitData(ch);
    expect(pty.typed()).toBe("");
    pty.emitData(chars[chars.length - 1]);
    expect(pty.typed()).toBe(COMMAND);
  });

  it("is not fooled by bracketed paste being DISABLED", async () => {
    const { manager, meta, pty } = makeSetupTerminal();
    const socket = await attach(manager, meta.id);
    socket.resize();
    pty.emitData("\x1b[?2004l");
    expect(pty.typed()).toBe("");
  });

  it("a line editor that is ready before any viewer still waits for the first resize", async () => {
    const { manager, meta, pty } = makeSetupTerminal();
    pty.emitData(`${READY}host% `);
    expect(pty.typed(), "nobody is watching yet — the command must be seen arriving").toBe("");
    const socket = await attach(manager, meta.id);
    expect(pty.typed()).toBe("");
    socket.resize();
    expect(pty.typed()).toBe(COMMAND);
  });

  describe("fallback for shells that never enable bracketed paste", () => {
    it("types it once output has been quiet for the quiet period", async () => {
      const { manager, meta, pty } = makeSetupTerminal();
      const socket = await attach(manager, meta.id);
      socket.resize();
      await vi.advanceTimersByTimeAsync(2000); // past the minimum delay, rc still running silently
      expect(pty.typed()).toBe("");
      pty.emitData("bash-3.2$ ");
      await vi.advanceTimersByTimeAsync(PENDING_INPUT_QUIET_MS - 1);
      expect(pty.typed()).toBe("");
      await vi.advanceTimersByTimeAsync(1);
      expect(pty.typed()).toBe(COMMAND);
    });

    it("restarts the quiet period whenever more output arrives", async () => {
      const { manager, meta, pty } = makeSetupTerminal();
      const socket = await attach(manager, meta.id);
      socket.resize();
      await vi.advanceTimersByTimeAsync(2000);
      pty.emitData("loading nvm...\r\n");
      await vi.advanceTimersByTimeAsync(PENDING_INPUT_QUIET_MS - 100);
      pty.emitData("bash-3.2$ ");
      await vi.advanceTimersByTimeAsync(PENDING_INPUT_QUIET_MS - 1);
      expect(pty.typed()).toBe("");
      await vi.advanceTimersByTimeAsync(1);
      expect(pty.typed()).toBe(COMMAND);
    });

    it("never types it earlier than the minimum delay after spawn, however quiet", async () => {
      const { manager, meta, pty } = makeSetupTerminal();
      const socket = await attach(manager, meta.id);
      socket.resize();
      pty.emitData("$ ");
      await vi.advanceTimersByTimeAsync(PENDING_INPUT_QUIET_MS);
      expect(pty.typed(), "quiet, but too soon after spawn").toBe("");
      await vi.advanceTimersByTimeAsync(PENDING_INPUT_MIN_DELAY_MS - PENDING_INPUT_QUIET_MS - 1);
      expect(pty.typed()).toBe("");
      await vi.advanceTimersByTimeAsync(1);
      expect(pty.typed()).toBe(COMMAND);
    });

    it("never takes a silent shell as ready: with no output at all it waits for the cap", async () => {
      const info = vi.spyOn(serverLogger, "info");
      const warn = vi.spyOn(serverLogger, "warn");
      const { manager, meta, pty } = makeSetupTerminal();
      const socket = await attach(manager, meta.id);
      socket.resize();
      await vi.advanceTimersByTimeAsync(PENDING_INPUT_MAX_WAIT_MS - 1);
      expect(pty.typed()).toBe("");
      await vi.advanceTimersByTimeAsync(1);
      expect(pty.typed()).toBe(COMMAND);

      const calls = [...info.mock.calls, ...warn.mock.calls];
      const fallback = calls.find(
        ([obj]) => (obj as { op?: string }).op === "pending_input_fallback",
      );
      expect(fallback?.[0]).toMatchObject({ tag: "terminal", op: "pending_input_fallback", reason: "cap" });
      expect(JSON.stringify(calls), "no command text in the logs").not.toContain("AAAA");
    });

    it("types it at the cap even while the shell keeps talking", async () => {
      const { manager, meta, pty } = makeSetupTerminal();
      const socket = await attach(manager, meta.id);
      socket.resize();
      for (let t = 0; t < PENDING_INPUT_MAX_WAIT_MS - 500; t += 500) {
        pty.emitData(".");
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(pty.typed()).toBe("");
      await vi.advanceTimersByTimeAsync(500);
      expect(pty.typed()).toBe(COMMAND);
    });

    it("logs the quiet fallback with its reason and no command text", async () => {
      const info = vi.spyOn(serverLogger, "info");
      const warn = vi.spyOn(serverLogger, "warn");
      const { manager, meta, pty } = makeSetupTerminal();
      const socket = await attach(manager, meta.id);
      socket.resize();
      pty.emitData("$ ");
      await vi.advanceTimersByTimeAsync(PENDING_INPUT_MIN_DELAY_MS);
      expect(pty.typed()).toBe(COMMAND);
      const calls = [...info.mock.calls, ...warn.mock.calls];
      const fallback = calls.find(
        ([obj]) => (obj as { op?: string }).op === "pending_input_fallback",
      );
      expect(fallback?.[0]).toMatchObject({ tag: "terminal", op: "pending_input_fallback", reason: "quiet" });
      expect(JSON.stringify(calls)).not.toContain("AAAA");
    });

    it("a fallback that fires before any viewer still waits for the first resize", async () => {
      const { manager, meta, pty } = makeSetupTerminal();
      await vi.advanceTimersByTimeAsync(PENDING_INPUT_MAX_WAIT_MS + 1000);
      expect(pty.typed()).toBe("");
      const socket = await attach(manager, meta.id);
      socket.resize();
      expect(pty.typed()).toBe(COMMAND);
    });
  });

  it("types it exactly once, whatever readiness signals and resizes follow", async () => {
    const { manager, meta, pty } = makeSetupTerminal();
    const socket = await attach(manager, meta.id);
    socket.resize();
    pty.emitData(READY);
    pty.emitData(READY);
    socket.resize(100, 30);
    pty.emitData("$ ");
    await vi.advanceTimersByTimeAsync(PENDING_INPUT_MAX_WAIT_MS * 2);
    socket.resize(90, 30);
    expect(occurrences(pty.typed(), COMMAND)).toBe(1);
    expect(pty.written.filter((w) => w === COMMAND)).toHaveLength(1);
  });

  it("drops the command when the shell exits before it is ready — nothing is written to a dead PTY", async () => {
    const { manager, meta, pty } = makeSetupTerminal();
    const socket = await attach(manager, meta.id);
    socket.resize();
    pty.emitData("Last login\r\n");
    pty.emitExit(1);
    pty.emitData(READY); // a straggling chunk after exit
    await vi.advanceTimersByTimeAsync(PENDING_INPUT_MAX_WAIT_MS * 2);
    expect(pty.written).toEqual([]);
    expect(manager.list("setup")).toEqual([]);
  });

  it("drops the command when the terminal is closed before it is ready", async () => {
    const { manager, meta, pty } = makeSetupTerminal();
    const socket = await attach(manager, meta.id);
    socket.resize();
    expect(manager.close(meta.id)).toBe(true);
    pty.emitData(READY);
    await vi.advanceTimersByTimeAsync(PENDING_INPUT_MAX_WAIT_MS * 2);
    expect(pty.written).toEqual([]);
  });

  it("leaves no timer behind once the command is typed, or once the terminal is gone", async () => {
    const typed = makeSetupTerminal();
    const socket = await attach(typed.manager, typed.meta.id);
    socket.resize();
    typed.pty.emitData(READY);
    expect(typed.pty.typed()).toBe(COMMAND);

    const closed = makeSetupTerminal();
    closed.manager.close(closed.meta.id);

    await vi.advanceTimersByTimeAsync(0); // let the headless xterm finish parsing
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * Client input that arrives while the command is still waiting falls in two
   * kinds, treated differently:
   *
   * - A chunk made up ENTIRELY of recognised terminal-reply formats — cursor
   *   position report, device-attributes replies, device status/mode reports,
   *   OSC replies, DCS replies — goes to the shell at once. The rc is blocked
   *   on them; holding them behind a command that waits for that very rc to
   *   finish stalls it for up to the cap.
   * - Anything else is DROPPED: a plain keystroke, an arrow key, Escape alone,
   *   an Alt-combo, an F-key, a focus event, or a chunk that mixes a reply
   *   with any of those (matching "starts with ESC" alone would let an early
   *   Up-arrow recall a zsh history line before the command lands). Written
   *   before the command they corrupt it; written after it, an Enter pressed
   *   before the command even appeared runs an installer or config write the
   *   user never got to read. Only a count is logged, never the characters.
   */
  describe("client input while the command waits", () => {
    function droppedLogs(...spies: Array<ReturnType<typeof vi.spyOn>>) {
      return spies
        .flatMap((spy) => spy.mock.calls)
        .filter(([obj]) => (obj as { op?: string }).op === "pending_input_keystrokes_dropped");
    }

    it("passes a terminal reply (ESC-prefixed) straight to the shell before readiness", async () => {
      const { manager, meta, pty } = makeSetupTerminal();
      const socket = await attach(manager, meta.id);
      socket.resize();
      socket.input("\x1b[12;1R");
      expect(pty.written, "the rc is waiting for this reply — it cannot wait for the rc").toEqual(["\x1b[12;1R"]);
      socket.input("\x1b[?62;22c");
      expect(pty.written).toEqual(["\x1b[12;1R", "\x1b[?62;22c"]);
      pty.emitData(READY);
      expect(pty.written).toEqual(["\x1b[12;1R", "\x1b[?62;22c", COMMAND]);
    });

    it("passes a terminal reply through even before any viewer has sized the grid", async () => {
      const { manager, meta, pty } = makeSetupTerminal();
      const socket = await attach(manager, meta.id);
      socket.input("\x1b[1;1R");
      expect(pty.written).toEqual(["\x1b[1;1R"]);
    });

    describe("only real terminal-reply formats pass; everything else is dropped", () => {
      const REPLIES: Array<[string, string]> = [
        ["cursor position report", "\x1b[24;80R"],
        ["device attributes (DA1)", "\x1b[?62;22c"],
        ["device attributes (DA2)", "\x1b[>1;95;0c"],
        ["device status report", "\x1b[0n"],
        ["mode report (DECRPM)", "\x1b[?2004;1$y"],
        ["OSC reply terminated by BEL", "\x1b]10;rgb:0000/0000/0000\x07"],
        ["OSC reply terminated by ST", "\x1b]11;rgb:ffff/ffff/ffff\x1b\\"],
        ["DCS reply (e.g. XTVERSION/DECRQSS)", "\x1bP1$r0\x1b\\"],
      ];
      it.each(REPLIES)("passes a %s straight through before readiness", async (_label, reply) => {
        const { manager, meta, pty } = makeSetupTerminal();
        const socket = await attach(manager, meta.id);
        socket.resize();
        socket.input(reply);
        expect(pty.written).toEqual([reply]);
        pty.emitData(READY);
        expect(pty.written).toEqual([reply, COMMAND]);
      });

      it("passes a chunk of several concatenated replies through whole", async () => {
        const { manager, meta, pty } = makeSetupTerminal();
        const socket = await attach(manager, meta.id);
        socket.resize();
        const combined = "\x1b[24;80R\x1b[?62;22c\x1b]10;rgb:0000/0000/0000\x07";
        socket.input(combined);
        expect(pty.written).toEqual([combined]);
      });

      const NON_REPLIES: Array<[string, string]> = [
        ["Up arrow", "\x1b[A"],
        ["Escape alone", "\x1b"],
        ["Alt-x", "\x1bx"],
        ["F1", "\x1bOP"],
        ["a focus-in event", "\x1b[I"],
      ];
      it.each(NON_REPLIES)("drops %s and counts it, never writing it to the PTY", async (_label, chunk) => {
        const info = vi.spyOn(serverLogger, "info");
        const warn = vi.spyOn(serverLogger, "warn");
        const { manager, meta, pty } = makeSetupTerminal();
        const socket = await attach(manager, meta.id);
        socket.resize();
        socket.input(chunk);
        expect(pty.written, "an early Up-arrow must not reach the shell and recall a history line").toEqual([]);
        pty.emitData(READY);
        expect(pty.written).toEqual([COMMAND]);
        const logs = droppedLogs(info, warn);
        expect(logs).toHaveLength(1);
        expect(logs[0][0]).toMatchObject({ op: "pending_input_keystrokes_dropped", count: 1 });
      });

      it("drops a chunk that mixes a real reply with a keystroke — the whole chunk, not just the extra byte", async () => {
        const info = vi.spyOn(serverLogger, "info");
        const warn = vi.spyOn(serverLogger, "warn");
        const { manager, meta, pty } = makeSetupTerminal();
        const socket = await attach(manager, meta.id);
        socket.resize();
        socket.input("\x1b[24;80Rx");
        expect(pty.written, "a reply glued to a keystroke is not a pure reply chunk").toEqual([]);
        pty.emitData(READY);
        expect(pty.written).toEqual([COMMAND]);
        const logs = droppedLogs(info, warn);
        expect(logs).toHaveLength(1);
        expect(logs[0][0]).toMatchObject({ op: "pending_input_keystrokes_dropped", count: 1 });
      });
    });

    it("drops a long run of OSC-looking units ending in a stray byte quickly, without stalling the event loop", async () => {
      // Each unit must parse one way only: a lazy OSC body could also span the next unit's
      // BEL, so a near-miss chunk made the matcher try every split — exponential in the count.
      const { manager, meta, pty } = makeSetupTerminal();
      const socket = await attach(manager, meta.id);
      socket.resize();
      const chunk = "\x1b]a\x07".repeat(2000) + "x";
      const started = realNow();
      socket.input(chunk);
      const elapsedMs = realNow() - started;
      expect(pty.written, "a reply run glued to a keystroke is not a pure reply chunk").toEqual([]);
      expect(elapsedMs, "matching a 64 K-bounded chunk must stay linear").toBeLessThan(500);
      pty.emitData(READY);
      expect(pty.written).toEqual([COMMAND]);
    });

    it("drops plain keystrokes typed before the command is written, and logs only their count", async () => {
      const info = vi.spyOn(serverLogger, "info");
      const warn = vi.spyOn(serverLogger, "warn");
      const { manager, meta, pty } = makeSetupTerminal();
      const socket = await attach(manager, meta.id);
      socket.resize();
      socket.input("s3cr3t");
      socket.input("\x7f");
      socket.input("\r");
      expect(pty.written, "nothing typed may reach the shell ahead of the command").toEqual([]);
      pty.emitData(READY);
      expect(
        pty.written,
        "an early Enter replayed after the command would run it unseen",
      ).toEqual([COMMAND]);
      await vi.advanceTimersByTimeAsync(PENDING_INPUT_MAX_WAIT_MS * 2);
      expect(pty.written).toEqual([COMMAND]);

      const logs = droppedLogs(info, warn);
      expect(logs, "logged once").toHaveLength(1);
      expect(logs[0][0]).toMatchObject({ tag: "terminal", op: "pending_input_keystrokes_dropped", count: 3 });
      const all = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
      expect(all, "never the characters").not.toContain("s3cr3t");
      expect(all).not.toContain("AAAA");
    });

    it("keystrokes typed after the command is written pass straight through, in order", async () => {
      const info = vi.spyOn(serverLogger, "info");
      const warn = vi.spyOn(serverLogger, "warn");
      const { manager, meta, pty } = makeSetupTerminal();
      const socket = await attach(manager, meta.id);
      socket.resize();
      pty.emitData(READY);
      expect(pty.written).toEqual([COMMAND]);
      socket.input("x");
      socket.input("\x7f");
      socket.input("\x1b[D");
      socket.input("\r");
      expect(pty.written).toEqual([COMMAND, "x", "\x7f", "\x1b[D", "\r"]);
      expect(droppedLogs(info, warn), "nothing was dropped, so nothing is logged").toEqual([]);
    });

    it("still types the command exactly once at readiness, whatever input came first", async () => {
      const { manager, meta, pty } = makeSetupTerminal();
      const socket = await attach(manager, meta.id);
      socket.resize();
      socket.input("a");
      socket.input("\x1b[5;1R");
      socket.input("\r");
      expect(pty.typed()).not.toContain("echo A");
      pty.emitData(READY);
      pty.emitData(READY);
      socket.resize(100, 30);
      await vi.advanceTimersByTimeAsync(PENDING_INPUT_MAX_WAIT_MS * 2);
      expect(pty.written.filter((w) => w === COMMAND)).toHaveLength(1);
      expect(pty.written).toEqual(["\x1b[5;1R", COMMAND]);
    });

    it("counts keystrokes dropped before the terminal is closed, once", async () => {
      const info = vi.spyOn(serverLogger, "info");
      const warn = vi.spyOn(serverLogger, "warn");
      const { manager, meta, pty } = makeSetupTerminal();
      const socket = await attach(manager, meta.id);
      socket.resize();
      socket.input("y");
      socket.input("\r");
      expect(manager.close(meta.id)).toBe(true);
      expect(pty.written).toEqual([]);
      const logs = droppedLogs(info, warn);
      expect(logs).toHaveLength(1);
      expect(logs[0][0]).toMatchObject({ op: "pending_input_keystrokes_dropped", count: 2 });
    });
  });

  it("a terminal without initialInput passes input straight through from the start", async () => {
    const ptys: FakePty[] = [];
    const manager = new TerminalManager(
      () => {
        const p = new FakePty();
        ptys.push(p);
        return p;
      },
      { cwd: () => "/agent-dir" },
    );
    const meta = manager.create({ cliId: "shell" });
    const socket = await attach(manager, meta.id);
    socket.input("ls\r");
    expect(ptys[0].written).toEqual(["ls\r"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
