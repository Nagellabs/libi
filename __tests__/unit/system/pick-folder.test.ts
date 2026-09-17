import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const logInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({
  serverLogger: { info: (...a: unknown[]) => logInfo(...a), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  PICK_FOLDER_PROMPT,
  mapPickFolderExit,
  normalizePickedPath,
  pickFolder,
  pickFolderCommand,
  isPickFolderBusy,
  type ChildLike,
} from "@/lib/system/pick-folder";

type SpawnOptions = { env: NodeJS.ProcessEnv; windowsHide: boolean };

/**
 * A fake child whose exit the test controls. Never spawns anything.
 * `closesOnKill: false` models a dialog that ignores its kill and never emits `close`.
 */
function fakeChild({ closesOnKill = true }: { closesOnKill?: boolean } = {}) {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child: ChildLike & { killed: NodeJS.Signals | undefined; kills: NodeJS.Signals[] } = {
    stdout,
    stderr,
    killed: undefined,
    kills: [],
    on: (event, cb) => emitter.on(event, cb as (...a: unknown[]) => void),
    kill: (signal = "SIGTERM") => {
      child.killed = signal;
      child.kills.push(signal);
      // A killed dialog closes with a signal and no code, as osascript does.
      if (closesOnKill) queueMicrotask(() => emitter.emit("close", null, signal));
      return true;
    },
  };
  return {
    child,
    stdout,
    exit(code: number, out = "", err = "") {
      if (out) stdout.write(out);
      if (err) stderr.write(err);
      stdout.end();
      stderr.end();
      // `close` fires after both stdio streams ended — the event the module listens for.
      setTimeout(() => emitter.emit("close", code, null), 0);
    },
    /** A killed dialog finally closing, as `closesOnKill` would have done straight away. */
    closeKilled(signal: NodeJS.Signals) {
      emitter.emit("close", null, signal);
    },
    fail(err: NodeJS.ErrnoException) {
      setTimeout(() => emitter.emit("error", err), 0);
    },
  };
}

function settledFlag(p: Promise<unknown>) {
  const state = { settled: false };
  void p.then(() => {
    state.settled = true;
  });
  return state;
}

beforeEach(() => logInfo.mockClear());

describe("pickFolderCommand — one exact command per platform", () => {
  it("macOS: osascript with argv, default location only when a start folder is given", () => {
    expect(pickFolderCommand("darwin", "/Users/me/start here")).toEqual({
      command: "osascript",
      args: [
        "-e", "on run argv",
        "-e", "POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))",
        "-e", "end run",
        PICK_FOLDER_PROMPT,
        "/Users/me/start here",
      ],
    });
    expect(pickFolderCommand("darwin", null)).toEqual({
      command: "osascript",
      args: ["-e", "on run argv", "-e", "POSIX path of (choose folder with prompt (item 1 of argv))", "-e", "end run", PICK_FOLDER_PROMPT],
    });
    // Never an Apple Event to another app: that is what triggers the Automation prompt.
    expect(pickFolderCommand("darwin", "/x").args.join(" ")).not.toContain("System Events");
  });

  it("Windows: STA PowerShell, a TopMost owner form, start dir via the environment (never spliced into -Command)", () => {
    const cmd = pickFolderCommand("win32", "C:\\Users\\me\\proj");
    expect(cmd.command).toBe("powershell.exe");
    expect(cmd.args.slice(0, 4)).toEqual(["-NoProfile", "-STA", "-Command"].concat([cmd.args[3]]));
    const script = cmd.args[3];
    expect(script).toContain("[Console]::OutputEncoding = [Text.Encoding]::UTF8");
    expect(script).toContain("Add-Type -AssemblyName System.Windows.Forms");
    expect(script).toContain("TopMost=$true");
    expect(script).toContain("New-Object System.Windows.Forms.FolderBrowserDialog");
    expect(script).toContain(`$d.Description = '${PICK_FOLDER_PROMPT}'`);
    expect(script).toContain("if ($env:LIBI_START_DIR) { $d.SelectedPath = $env:LIBI_START_DIR }");
    expect(script).toContain("[Console]::Out.Write($d.SelectedPath); exit 0 } else { exit 1 }");
    expect(script).not.toContain("C:\\Users\\me\\proj");
    expect(cmd.env).toEqual({ LIBI_START_DIR: "C:\\Users\\me\\proj" });
    expect(pickFolderCommand("win32", null).env).toEqual({});
  });

  it("Linux: zenity directory selection, --filename only with a start folder", () => {
    expect(pickFolderCommand("linux", "/home/me/proj")).toEqual({
      command: "zenity",
      args: ["--file-selection", "--directory", `--title=${PICK_FOLDER_PROMPT}`, "--filename=/home/me/proj/"],
    });
    expect(pickFolderCommand("linux", null).args).toEqual(["--file-selection", "--directory", `--title=${PICK_FOLDER_PROMPT}`]);
  });
});

describe("mapPickFolderExit", () => {
  const base = { code: null, signal: null, stdout: "", stderr: "", timedOut: false } as const;
  it("macOS: 0 = picked (trailing slash stripped), 1 with (-128) = cancelled, anything else = unavailable", () => {
    expect(mapPickFolderExit("darwin", { ...base, code: 0, stdout: "/private/tmp/my folder/\n" })).toEqual({ status: "picked", path: "/private/tmp/my folder" });
    expect(mapPickFolderExit("darwin", { ...base, code: 0, stdout: "/\n" })).toEqual({ status: "picked", path: "/" });
    expect(mapPickFolderExit("darwin", { ...base, code: 1, stderr: "0:17: execution error: User canceled. (-128)\n" })).toEqual({ status: "cancelled" });
    expect(mapPickFolderExit("darwin", { ...base, code: 1, stderr: "27:87: execution error: Can’t make file into type alias. (-1700)\n" })).toEqual({
      status: "unavailable",
      reason: "27:87: execution error: Can’t make file into type alias. (-1700)",
    });
    // macOS keeps its measured rule: a cancel always says (-128), so a silent exit 1 is not one.
    expect(mapPickFolderExit("darwin", { ...base, code: 1 })).toEqual({ status: "unavailable", reason: "exited with code 1" });
    expect(mapPickFolderExit("darwin", { ...base, code: 3 })).toEqual({ status: "unavailable", reason: "exited with code 3" });
  });
  it("a dialog libi killed at the timeout reads 'timed out'", () => {
    expect(mapPickFolderExit("darwin", { ...base, signal: "SIGTERM", timedOut: true })).toEqual({ status: "unavailable", reason: "timed out" });
    expect(mapPickFolderExit("linux", { ...base, code: 5 })).toEqual({ status: "unavailable", reason: "timed out" });
  });
  it("Windows and Linux: 0 = picked, 1 with nothing on stderr = cancelled", () => {
    expect(mapPickFolderExit("win32", { ...base, code: 0, stdout: "C:\\Users\\me\\proj" })).toEqual({ status: "picked", path: "C:\\Users\\me\\proj" });
    expect(mapPickFolderExit("win32", { ...base, code: 1 })).toEqual({ status: "cancelled" });
    expect(mapPickFolderExit("win32", { ...base, code: 1, stderr: "  \r\n" })).toEqual({ status: "cancelled" });
    expect(mapPickFolderExit("linux", { ...base, code: 0, stdout: "/home/me/proj\n" })).toEqual({ status: "picked", path: "/home/me/proj" });
    expect(mapPickFolderExit("linux", { ...base, code: 1 })).toEqual({ status: "cancelled" });
    expect(mapPickFolderExit("linux", { ...base, code: 255 })).toEqual({ status: "unavailable", reason: "exited with code 255" });
  });
  it("Windows and Linux: exit 1 that printed to stderr is a failure with its first line, not a cancel", () => {
    expect(
      mapPickFolderExit("linux", { ...base, code: 1, stderr: "\n(zenity:4242): Gtk-WARNING **: 10:00:00.000: cannot open display: \n" }),
    ).toEqual({ status: "unavailable", reason: "(zenity:4242): Gtk-WARNING **: 10:00:00.000: cannot open display:" });
    expect(
      mapPickFolderExit("win32", {
        ...base,
        code: 1,
        stderr: 'Exception calling "ShowDialog" with "1" argument(s): "not running in UserInteractive mode"\r\nAt line:1 char:300\r\n',
      }),
    ).toEqual({ status: "unavailable", reason: 'Exception calling "ShowDialog" with "1" argument(s): "not running in UserInteractive mode"' });
  });
  it("Linux: GTK's informational Gtk-Message chatter on a cancel is still a cancel", () => {
    const chatter = "Gtk-Message: 10:00:00.000: GtkDialog mapped without a transient parent. This is discouraged.\n";
    expect(mapPickFolderExit("linux", { ...base, code: 1, stderr: chatter })).toEqual({ status: "cancelled" });
    expect(mapPickFolderExit("linux", { ...base, code: 1, stderr: `${chatter}(zenity:1): Gtk-WARNING **: cannot open display: \n` })).toEqual({
      status: "unavailable",
      reason: "(zenity:1): Gtk-WARNING **: cannot open display:",
    });
  });
  it("Linux: harmless dbus/theme warning noise on a normal Cancel is still a cancel, not unavailable", () => {
    expect(
      mapPickFolderExit("linux", {
        ...base,
        code: 1,
        stderr: "(zenity:123): dbind-WARNING **: 10:00:00.000: Couldn't connect to accessibility bus: Failed to connect to socket /tmp/dbus: Connection refused\n",
      }),
    ).toEqual({ status: "cancelled" });
    expect(
      mapPickFolderExit("linux", { ...base, code: 1, stderr: "(zenity:123): Adwaita-WARNING **: 10:00:00.000: Failed to register with bus\n" }),
    ).toEqual({ status: "cancelled" });
  });
  it("Linux: exit 1 is unavailable only for a known display failure, whatever its case", () => {
    expect(mapPickFolderExit("linux", { ...base, code: 1, stderr: "cannot open display: :0\n" })).toEqual({
      status: "unavailable",
      reason: "cannot open display: :0",
    });
    expect(mapPickFolderExit("linux", { ...base, code: 1, stderr: "Cannot open display: :0\n" })).toEqual({
      status: "unavailable",
      reason: "Cannot open display: :0",
    });
    expect(mapPickFolderExit("linux", { ...base, code: 1, stderr: "Failed to open display\n" })).toEqual({
      status: "unavailable",
      reason: "Failed to open display",
    });
  });
  it("a missing dialog program is unavailable with its name", () => {
    const enoent = Object.assign(new Error("spawn zenity ENOENT"), { code: "ENOENT" });
    expect(mapPickFolderExit("linux", { ...base, spawnError: enoent })).toEqual({ status: "unavailable", reason: "zenity is not installed" });
    expect(mapPickFolderExit("darwin", { ...base, spawnError: enoent })).toEqual({ status: "unavailable", reason: "osascript is not installed" });
  });
});

describe("normalizePickedPath", () => {
  it("strips whitespace and one trailing separator, keeps a root", () => {
    expect(normalizePickedPath("/a/b/\n")).toBe("/a/b");
    expect(normalizePickedPath("C:\\a\\")).toBe("C:\\a");
    expect(normalizePickedPath("/")).toBe("/");
    expect(normalizePickedPath("C:\\")).toBe("C:\\");
  });
});

describe("pickFolder — spawn, start folder, encoding", () => {
  it("spawns the platform's command, omits a start folder that is not a directory, and maps the exit", async () => {
    const fake = fakeChild();
    const spawnImpl = vi.fn(() => fake.child);
    const p = pickFolder({ initialPath: "/nope", platform: "darwin", spawnImpl, isDirectory: () => false });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnImpl.mock.calls[0] as unknown as [string, string[], SpawnOptions];
    expect(command).toBe("osascript");
    expect(args).not.toContain("/nope");
    expect(options.windowsHide).toBe(true);
    fake.exit(0, "/picked/\n");
    await expect(p).resolves.toEqual({ status: "picked", path: "/picked" });
  });

  it("Windows: the dialog is not started hidden, and an existing start directory travels in LIBI_START_DIR", async () => {
    const fake = fakeChild();
    const spawnImpl = vi.fn(() => fake.child);
    const start = "C:\\Users\\me\\proj";
    const p = pickFolder({ initialPath: start, platform: "win32", spawnImpl, isDirectory: (d) => d === start });
    const [command, args, options] = spawnImpl.mock.calls[0] as unknown as [string, string[], SpawnOptions];
    expect(command).toBe("powershell.exe");
    // windowsHide's SW_HIDE would apply to the dialog's first ShowWindow and start it hidden.
    expect(options.windowsHide).toBe(false);
    expect(options.env.LIBI_START_DIR).toBe(start);
    expect(args.join(" ")).not.toContain(start);
    fake.exit(1);
    await expect(p).resolves.toEqual({ status: "cancelled" });
  });

  it("a relative initial path is dropped without being looked at", async () => {
    const isDirectory = vi.fn(() => true);
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const fake = fakeChild();
      const spawnImpl = vi.fn(() => fake.child);
      const p = pickFolder({ initialPath: "projects/mine", platform, spawnImpl, isDirectory });
      const [, args, options] = spawnImpl.mock.calls[0] as unknown as [string, string[], SpawnOptions];
      expect(args).toEqual(pickFolderCommand(platform, null).args);
      expect(options.env.LIBI_START_DIR).toBeUndefined();
      fake.exit(1);
      await p;
    }
    expect(isDirectory).not.toHaveBeenCalled();
  });

  it("by default only an existing DIRECTORY is a start folder: a file or a missing path is omitted (macOS fails with -1700 on those)", async () => {
    // The real filesystem decides here, so the platform follows the host's path flavour: a Windows
    // temp path is not absolute to the macOS branch, and the CI/Windows runs must pass as well.
    // macOS carries the start folder in argv; Windows carries it in LIBI_START_DIR.
    const platform = process.platform === "win32" ? "win32" : "darwin";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-pick-folder-"));
    const file = path.join(dir, "not-a-folder.txt");
    fs.writeFileSync(file, "x");
    try {
      const startFor = async (initialPath: string) => {
        const fake = fakeChild();
        const spawnImpl = vi.fn(() => fake.child);
        const p = pickFolder({ initialPath, platform, spawnImpl });
        const [, args, options] = spawnImpl.mock.calls[0] as unknown as [string, string[], SpawnOptions];
        fake.exit(1, "", platform === "darwin" ? "0:17: execution error: User canceled. (-128)\n" : "");
        await p;
        return { args, startDir: options.env.LIBI_START_DIR };
      };
      const expected = (startDir: string | null) => {
        const cmd = pickFolderCommand(platform, startDir);
        return { args: cmd.args, startDir: cmd.env?.LIBI_START_DIR };
      };
      expect(expected(dir), "the start folder must be visible in the spawn").not.toEqual(expected(null));
      expect(await startFor(dir)).toEqual(expected(dir));
      expect(await startFor(file)).toEqual(expected(null));
      expect(await startFor(path.join(dir, "missing"))).toEqual(expected(null));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a path with multi-byte characters split across two data events arrives intact", async () => {
    const fake = fakeChild();
    const p = pickFolder({ platform: "darwin", spawnImpl: () => fake.child });
    const bytes = Buffer.from("/Users/me/סרטים é 日本/\n", "utf8");
    const splitAt = Buffer.from("/Users/me/", "utf8").length + 1; // inside the first two-byte character
    fake.stdout.write(bytes.subarray(0, splitAt));
    await new Promise((r) => setImmediate(r));
    fake.stdout.write(bytes.subarray(splitAt));
    await new Promise((r) => setImmediate(r));
    fake.exit(0);
    await expect(p).resolves.toEqual({ status: "picked", path: "/Users/me/סרטים é 日本" });
  });
});

describe("pickFolder — busy guard, failures, timeout, abort", () => {
  it("refuses a second dialog while one is open, then accepts again", async () => {
    const fake = fakeChild();
    const p = pickFolder({ platform: "darwin", spawnImpl: () => fake.child, isDirectory: () => true });
    expect(isPickFolderBusy()).toBe(true);
    await expect(pickFolder({ platform: "darwin", spawnImpl: () => fake.child })).resolves.toEqual({ status: "busy" });
    fake.exit(1, "", "0:17: execution error: User canceled. (-128)\n");
    await expect(p).resolves.toEqual({ status: "cancelled" });
    expect(isPickFolderBusy()).toBe(false);
  });

  it("a spawn error (no zenity) is unavailable, not a rejection, and clears the busy flag", async () => {
    const fake = fakeChild();
    const p = pickFolder({ platform: "linux", spawnImpl: () => fake.child });
    fake.fail(Object.assign(new Error("spawn zenity ENOENT"), { code: "ENOENT" }));
    await expect(p).resolves.toEqual({ status: "unavailable", reason: "zenity is not installed" });
    expect(isPickFolderBusy()).toBe(false);
  });

  it("a spawn that throws synchronously resolves unavailable with its reason and releases busy", async () => {
    const spawnImpl = vi.fn((): ChildLike => {
      throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
    });
    await expect(pickFolder({ platform: "linux", spawnImpl })).resolves.toEqual({ status: "unavailable", reason: "spawn EPERM" });
    expect(isPickFolderBusy()).toBe(false);
  });

  it("kills the dialog at the timeout and reports 'timed out'", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeChild();
      const p = pickFolder({ platform: "linux", spawnImpl: () => fake.child, timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1001);
      expect(fake.child.killed).toBe("SIGTERM");
      await expect(p).resolves.toEqual({ status: "unavailable", reason: "timed out" });
      expect(isPickFolderBusy()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a dialog that never closes after SIGTERM gets SIGKILL 3 s later, and the flag is released anyway", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeChild({ closesOnKill: false });
      const p = pickFolder({ platform: "darwin", spawnImpl: () => fake.child, timeoutMs: 1000 });
      const state = settledFlag(p);
      await vi.advanceTimersByTimeAsync(1001);
      expect(fake.child.kills).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(2998);
      expect(state.settled).toBe(false);
      expect(isPickFolderBusy()).toBe(true);
      await vi.advanceTimersByTimeAsync(2);
      expect(fake.child.kills).toEqual(["SIGTERM", "SIGKILL"]);
      await expect(p).resolves.toEqual({ status: "unavailable", reason: "timed out" });
      expect(isPickFolderBusy()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a timeout kill followed by an abort during the SIGKILL grace period still reports 'timed out', not cancelled", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeChild({ closesOnKill: false });
      const controller = new AbortController();
      const p = pickFolder({ platform: "darwin", spawnImpl: () => fake.child, timeoutMs: 1000, signal: controller.signal });
      await vi.advanceTimersByTimeAsync(1001);
      expect(fake.child.kills).toEqual(["SIGTERM"]);
      controller.abort();
      await vi.advanceTimersByTimeAsync(3000);
      expect(fake.child.kills).toEqual(["SIGTERM", "SIGKILL"]);
      await expect(p).resolves.toEqual({ status: "unavailable", reason: "timed out" });
      expect(isPickFolderBusy()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a timeout kill followed by an abort during the grace period reports 'timed out' when the dialog then closes, too", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeChild({ closesOnKill: false });
      const controller = new AbortController();
      const p = pickFolder({ platform: "darwin", spawnImpl: () => fake.child, timeoutMs: 1000, signal: controller.signal });
      await vi.advanceTimersByTimeAsync(1001);
      expect(fake.child.kills).toEqual(["SIGTERM"]);
      controller.abort();
      await vi.advanceTimersByTimeAsync(1000);
      // The dialog honours the SIGTERM within the grace period — no SIGKILL needed.
      fake.closeKilled("SIGTERM");
      await expect(p).resolves.toEqual({ status: "unavailable", reason: "timed out" });
      expect(fake.child.kills).toEqual(["SIGTERM"]);
      expect(isPickFolderBusy()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an abandoned request kills the dialog and resolves cancelled, releasing the flag", async () => {
    const fake = fakeChild();
    const controller = new AbortController();
    const p = pickFolder({ platform: "darwin", spawnImpl: () => fake.child, signal: controller.signal });
    expect(isPickFolderBusy()).toBe(true);
    controller.abort();
    expect(fake.child.killed).toBe("SIGTERM");
    await expect(p).resolves.toEqual({ status: "cancelled" });
    expect(isPickFolderBusy()).toBe(false);
  });

  it("an abandoned request whose dialog ignores SIGTERM escalates to SIGKILL and still settles", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeChild({ closesOnKill: false });
      const controller = new AbortController();
      const p = pickFolder({ platform: "win32", spawnImpl: () => fake.child, signal: controller.signal });
      controller.abort();
      await vi.advanceTimersByTimeAsync(3000);
      expect(fake.child.kills).toEqual(["SIGTERM", "SIGKILL"]);
      await expect(p).resolves.toEqual({ status: "cancelled" });
      expect(isPickFolderBusy()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a request already abandoned opens no dialog", async () => {
    const spawnImpl = vi.fn(() => fakeChild().child);
    const controller = new AbortController();
    controller.abort();
    await expect(pickFolder({ platform: "darwin", spawnImpl, signal: controller.signal })).resolves.toEqual({ status: "cancelled" });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(isPickFolderBusy()).toBe(false);
  });
});

describe("pickFolder — logging", () => {
  it("logs the reason next to an unavailable status", async () => {
    const fake = fakeChild();
    const p = pickFolder({ platform: "linux", spawnImpl: () => fake.child });
    fake.fail(Object.assign(new Error("spawn zenity ENOENT"), { code: "ENOENT" }));
    await p;
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "skills", op: "pick_folder", platform: "linux", status: "unavailable", reason: "zenity is not installed" }),
      "pick_folder",
    );
  });

  it("never logs the folder the user picked", async () => {
    const fake = fakeChild();
    const p = pickFolder({ platform: "darwin", spawnImpl: () => fake.child });
    fake.exit(0, "/Users/me/secret place/\n");
    await p;
    expect(logInfo).toHaveBeenCalledTimes(1);
    const [fields] = logInfo.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toEqual({ tag: "skills", op: "pick_folder", platform: "darwin", status: "picked" });
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain("secret place");
  });
});
