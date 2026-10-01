// Can a local (stdio) MCP server's launch command be found? (lib/providers/launcher.ts)
// Provider detection asks this for every stdio row, every few seconds while a setup terminal is open, so the
// lookup never spawns anything: it walks folders with stat calls only. Every case pins its platform — CI is
// ubuntu, and a lookup that silently followed the host would pass here and fail there.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launcherLookupForPass, launcherName, lookupLauncher, type LauncherDeps } from "@/lib/providers/launcher";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-launcher-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A POSIX lookup over fixed folders and a fixed set of executable files. */
function posix(files: string[], over: Partial<LauncherDeps> = {}): LauncherDeps {
  const set = new Set(files);
  return {
    platform: "linux",
    loginShellDirs: () => ["/login/bin"],
    processPathDirs: () => ["/proc/bin"],
    isExecutable: (p) => set.has(p),
    ...over,
  };
}

describe("lookupLauncher — POSIX", () => {
  it("an absolute path that is not there is missing, even while no login-shell PATH is known", () => {
    expect(lookupLauncher("/opt/nope/bin/uvx", posix([], { loginShellDirs: () => null }))).toBe("missing");
  });

  it("an absolute path that is there and executable is found", () => {
    expect(lookupLauncher("/opt/tools/bin/uvx", posix(["/opt/tools/bin/uvx"]))).toBe("found");
  });

  // The execute bit is POSIX-only: Windows has none to clear (chmod 0o644 leaves the file runnable, and the product
  // skips X_OK there), and a `C:\…` temp path is not absolute to a linux-pinned lookup. Windows' own real file check
  // is under "lookupLauncher — Windows", and runs on every host.
  it.skipIf(process.platform === "win32")("the real file check: a file without the execute bit is missing, one with it is found", () => {
    const plain = path.join(tmp, "plain");
    const exec = path.join(tmp, "exec");
    fs.writeFileSync(plain, "#!/bin/sh\n");
    fs.writeFileSync(exec, "#!/bin/sh\n");
    fs.chmodSync(plain, 0o644);
    fs.chmodSync(exec, 0o755);
    const deps: LauncherDeps = { platform: "linux", loginShellDirs: () => [], processPathDirs: () => [] };
    expect(lookupLauncher(plain, deps)).toBe("missing");
    expect(lookupLauncher(exec, deps)).toBe("found");
    // A folder is not a launcher.
    expect(lookupLauncher(tmp, deps)).toBe("missing");
  });

  it("a bare name on no folder, with the login-shell PATH known, is missing", () => {
    expect(lookupLauncher("uvx", posix([]))).toBe("missing");
  });

  it.each([
    ["the login-shell PATH", "/login/bin/uvx"],
    ["this process's PATH", "/proc/bin/uvx"],
  ])("a bare name found on %s is found", (_where, file) => {
    expect(lookupLauncher("uvx", posix([file]))).toBe("found");
  });

  // The agent that launches the server gets a PATH, not the CLI resolver's known install folders: a launcher only
  // in uv's default ~/.local/bin (UV_NO_MODIFY_PATH) is exactly what fails with "Executable not found in $PATH".
  it("a bare name that sits only in a known install folder, off every PATH, is missing", () => {
    const home = os.homedir();
    for (const dir of [path.posix.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
      expect(lookupLauncher("uvx", posix([path.posix.join(dir, "uvx")])), dir).toBe("missing");
    }
  });

  it("with no login-shell PATH known yet, a bare name it can't find is unknown — never missing", () => {
    expect(lookupLauncher("uvx", posix([], { loginShellDirs: () => null }))).toBe("unknown");
    // What it CAN find is still found.
    expect(lookupLauncher("uvx", posix(["/proc/bin/uvx"], { loginShellDirs: () => null }))).toBe("found");
  });

  it.each([
    ["a relative path (depends on the agent's folder)", "./server.sh"],
    ["a nested relative path", "bin/server"],
    ["a variable the agent expands", "${HOME}/bin/uvx"],
    ["a $VAR", "$HOME/bin/uvx"],
    ["a home-relative path", "~/bin/uvx"],
    ["an empty command", ""],
    ["a blank command", "   "],
  ])("%s is unknown", (_what, command) => {
    expect(lookupLauncher(command, posix([]))).toBe("unknown");
  });
});

describe("lookupLauncher — Windows (PATHEXT)", () => {
  /** Windows file names are case-insensitive: the fake compares lower-case, as NTFS would. */
  function win(files: string[], over: Partial<LauncherDeps> = {}): LauncherDeps {
    const set = new Set(files.map((f) => f.toLowerCase()));
    return {
      platform: "win32",
      pathExt: ".COM;.EXE;.BAT;.CMD",
      loginShellDirs: () => null, // Windows has no login shell: this process's PATH is the answer
      processPathDirs: () => ["C:\\tools", "C:\\Users\\u\\bin"],
      isExecutable: (p) => set.has(p.toLowerCase()),
      ...over,
    };
  }

  it("a bare name resolves through PATHEXT on this process's PATH", () => {
    expect(lookupLauncher("uvx", win(["C:\\Users\\u\\bin\\uvx.EXE"]))).toBe("found");
    expect(lookupLauncher("npx", win(["C:\\tools\\npx.cmd"]))).toBe("found");
  });

  it("a launcher only in %USERPROFILE%\\.local\\bin, off this process's PATH, is missing — the agent inherits that PATH", () => {
    expect(lookupLauncher("uvx", win(["C:\\Users\\u\\.local\\bin\\uvx.exe"]))).toBe("missing");
  });

  it("a bare name found nowhere is missing — there is no login shell to wait for", () => {
    expect(lookupLauncher("uvx", win([]))).toBe("missing");
  });

  it("an extensionless file is not a launcher Windows can run", () => {
    expect(lookupLauncher("uvx", win(["C:\\tools\\uvx"]))).toBe("missing");
  });

  it("an extension outside PATHEXT is not tried", () => {
    expect(lookupLauncher("uvx", win(["C:\\tools\\uvx.ps1"]))).toBe("missing");
  });

  it("a name that already carries a PATHEXT extension is looked up as written", () => {
    expect(lookupLauncher("uvx.exe", win(["C:\\tools\\uvx.exe"]))).toBe("found");
    expect(lookupLauncher("uvx.exe", win(["C:\\tools\\uvx.exe.cmd"]))).toBe("missing");
  });

  it("an absolute path honours PATHEXT too", () => {
    expect(lookupLauncher("C:\\tools\\uvx", win(["C:\\tools\\uvx.exe"]))).toBe("found");
    expect(lookupLauncher("C:\\tools\\uvx.exe", win([]))).toBe("missing");
  });

  it("PATHEXT unset → the Windows default list", () => {
    vi.stubEnv("PATHEXT", undefined);
    try {
      expect(lookupLauncher("uvx", win(["C:\\tools\\uvx.bat"], { pathExt: undefined }))).toBe("found");
      expect(lookupLauncher("uvx", win(["C:\\tools\\uvx.ps1"], { pathExt: undefined }))).toBe("missing");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("PATHEXT from the environment when the caller passes none", () => {
    vi.stubEnv("PATHEXT", ".EXE;.PS1");
    try {
      expect(lookupLauncher("uvx", win(["C:\\tools\\uvx.ps1"], { pathExt: undefined }))).toBe("found");
      expect(lookupLauncher("uvx", win(["C:\\tools\\uvx.bat"], { pathExt: undefined }))).toBe("missing");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the real file check on Windows: no execute bit to read, so the PATHEXT spelling decides, and a folder is not a launcher", () => {
    fs.writeFileSync(path.join(tmp, "uvx.exe"), "MZ");
    fs.writeFileSync(path.join(tmp, "plain"), "#!/bin/sh\n");
    fs.mkdirSync(path.join(tmp, "dir.exe"));
    const deps: LauncherDeps = { platform: "win32", processPathDirs: () => [], pathExt: ".exe" };
    expect(lookupLauncher(path.join(tmp, "uvx"), deps)).toBe("found");
    expect(lookupLauncher(path.join(tmp, "uvx.exe"), deps)).toBe("found");
    expect(lookupLauncher(path.join(tmp, "plain"), deps)).toBe("missing");
    expect(lookupLauncher(path.join(tmp, "dir"), deps)).toBe("missing");
  });

  // Review I3: a launcher installed after libi booted is on the registry's PATH, which a new agent process and a new
  // chat get (PRV-1). Detection reads the same PATH, so the tab no longer says "can't start" for what the agent can run.
  it("a launcher only on the registry's fresh PATH is found", () => {
    const fresh = { loginShellDirs: () => ["C:\\Users\\u\\.local\\bin"] };
    expect(lookupLauncher("uvx", win(["C:\\Users\\u\\.local\\bin\\uvx.exe"], fresh))).toBe("found");
    expect(lookupLauncher("npx", win([], fresh))).toBe("missing");
  });

  it("by default reads the registry PATH last read (lib/agents/cli/windows-registry-path.ts), never reading it itself", async () => {
    const reg = await import("@/lib/agents/cli/windows-registry-path");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      reg.__clearWindowsRegistryPathMemo();
      const deps = win(["C:\\Users\\u\\.local\\bin\\uvx.exe"], { loginShellDirs: undefined });
      expect(lookupLauncher("uvx", deps)).toBe("missing");
      await reg.refreshWindowsRegistryPath({
        runReg: async (args) => (args[1] === reg.USER_ENVIRONMENT_KEY ? "    Path    REG_SZ    C:\\Users\\u\\.local\\bin\r\n" : ""),
        env: {},
      });
      expect(lookupLauncher("uvx", deps)).toBe("found");
      expect(launcherLookupForPass(deps)("uvx")).toBe("found");
    } finally {
      reg.__clearWindowsRegistryPathMemo();
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("%VAR% in the command is unknown", () => {
    expect(lookupLauncher("%USERPROFILE%\\bin\\uvx.exe", win([]))).toBe("unknown");
  });
});

describe("launcherLookupForPass — one detection pass", () => {
  it("reads the login-shell PATH once, on first use, however many rows it checks", () => {
    const loginShellDirs = vi.fn(() => ["/login/bin"]);
    const lookup = launcherLookupForPass(posix(["/login/bin/uvx"], { loginShellDirs }));
    expect(loginShellDirs).not.toHaveBeenCalled();
    expect(lookup("uvx")).toBe("found");
    expect(lookup("npx")).toBe("missing");
    expect(lookup("node")).toBe("missing");
    expect(loginShellDirs).toHaveBeenCalledTimes(1);
    // An unknown login PATH is remembered for the pass too.
    const unknown = vi.fn(() => null);
    const pass = launcherLookupForPass(posix([], { loginShellDirs: unknown }));
    expect([pass("uvx"), pass("npx")]).toEqual(["unknown", "unknown"]);
    expect(unknown).toHaveBeenCalledTimes(1);
  });
});

describe("launcherName — the command as the user reads it", () => {
  it("is the bare name only: never a folder", () => {
    expect(launcherName("uvx", "linux")).toBe("uvx");
    expect(launcherName("/Users/someone/.local/bin/uvx", "darwin")).toBe("uvx");
    expect(launcherName("C:\\Users\\someone\\tools\\uvx.exe", "win32")).toBe("uvx.exe");
    expect(launcherName("  npx  ", "linux")).toBe("npx");
  });
});
