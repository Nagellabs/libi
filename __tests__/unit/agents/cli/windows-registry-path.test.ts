// Windows' fresh PATH, read from the registry (lib/agents/cli/windows-registry-path.ts): the machine's `Path`, then the
// user's, `%VAR%` expanded, bounded; a failed or timed-out read is "no answer", never "an empty PATH". The platform is
// pinned inside each case (CI is ubuntu).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MACHINE_ENVIRONMENT_KEY,
  USER_ENVIRONMENT_KEY,
  __clearWindowsRegistryPathMemo,
  expandWindowsEnv,
  lastWindowsRegistryPathDirs,
  parseRegQueryPath,
  refreshWindowsRegistryPath,
  type RegQuery,
} from "@/lib/agents/cli/windows-registry-path";
import { serverLogger } from "@/lib/logger";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const pin = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...platform, value: p });

const out = (type: string, value: string) =>
  `\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    ${type}    ${value}\r\n\r\n`;

function fakeReg(answers: Record<string, string | Error | "hang">): { run: RegQuery; calls: string[][] } {
  const calls: string[][] = [];
  const run: RegQuery = (args) => {
    calls.push(args);
    const a = answers[args[1]];
    if (a === "hang") return new Promise(() => {});
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve(a ?? "");
  };
  return { run, calls };
}

beforeEach(() => {
  __clearWindowsRegistryPathMemo();
  pin("win32");
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
});

describe("parseRegQueryPath / expandWindowsEnv", () => {
  it("reads the Path value's data, REG_SZ or REG_EXPAND_SZ, spaces kept", () => {
    expect(parseRegQueryPath(out("REG_EXPAND_SZ", "C:\\Program Files\\x;%USERPROFILE%\\bin"))).toBe("C:\\Program Files\\x;%USERPROFILE%\\bin");
    expect(parseRegQueryPath(out("REG_SZ", "C:\\a"))).toBe("C:\\a");
    expect(parseRegQueryPath("\r\nHKEY_CURRENT_USER\\Environment\r\n    TEMP    REG_SZ    C:\\t\r\n")).toBeNull();
  });

  it("expands %VAR% case-insensitively and leaves an unknown one as written", () => {
    expect(expandWindowsEnv("%userprofile%\\.local\\bin;%NOPE%\\x", { USERPROFILE: "C:\\Users\\me" })).toBe("C:\\Users\\me\\.local\\bin;%NOPE%\\x");
  });
});

describe("refreshWindowsRegistryPath", () => {
  it("is the machine's Path then the user's, expanded, each folder once; the last good read is remembered", async () => {
    const { run, calls } = fakeReg({
      [MACHINE_ENVIRONMENT_KEY]: out("REG_EXPAND_SZ", "%SystemRoot%\\system32;C:\\Windows;"),
      [USER_ENVIRONMENT_KEY]: out("REG_EXPAND_SZ", "%USERPROFILE%\\.local\\bin;C:\\Windows"),
    });
    const dirs = await refreshWindowsRegistryPath({ runReg: run, env: { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\me" } });
    expect(dirs).toEqual(["C:\\Windows\\system32", "C:\\Windows", "C:\\Users\\me\\.local\\bin"]);
    expect(lastWindowsRegistryPathDirs()).toEqual(dirs);
    expect(calls).toEqual([
      ["query", MACHINE_ENVIRONMENT_KEY, "/v", "Path"],
      ["query", USER_ENVIRONMENT_KEY, "/v", "Path"],
      ["query", MACHINE_ENVIRONMENT_KEY],
      ["query", USER_ENVIRONMENT_KEY],
    ]);
  });

  it("a user with no Path of their own is an answer, not a failure", async () => {
    const notFound = Object.assign(new Error("Command failed"), {
      code: 1,
      stderr: "ERROR: The system was unable to find the specified registry key or value.\r\n",
    });
    const { run } = fakeReg({ [MACHINE_ENVIRONMENT_KEY]: out("REG_SZ", "C:\\Windows"), [USER_ENVIRONMENT_KEY]: notFound });
    expect(await refreshWindowsRegistryPath({ runReg: run, env: {} })).toEqual(["C:\\Windows"]);
  });

  it("a query that hangs is bounded: null, logged, and the last good read is left as it was", async () => {
    const good = fakeReg({ [MACHINE_ENVIRONMENT_KEY]: out("REG_SZ", "C:\\old"), [USER_ENVIRONMENT_KEY]: "" });
    await refreshWindowsRegistryPath({ runReg: good.run, env: {}, now: () => 0 });
    const warn = vi.spyOn(serverLogger, "warn");
    const hang = fakeReg({ [MACHINE_ENVIRONMENT_KEY]: "hang", [USER_ENVIRONMENT_KEY]: out("REG_SZ", "C:\\new") });
    const started = Date.now();
    expect(await refreshWindowsRegistryPath({ runReg: hang.run, env: {}, timeoutMs: 30, now: () => 60_000 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(lastWindowsRegistryPathDirs()).toEqual(["C:\\old"]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ tag: "agent-cli", op: "registry_path_read_failed", timedOut: true }), expect.any(String));
  });

  // Review M3: a hanging `reg` cost up to 2 s on every spawn and every new chat, and warned each time.
  it("a failure is memoized for 5 s like an answer, and warned about once until reads recover", async () => {
    const warn = vi.spyOn(serverLogger, "warn");
    const info = vi.spyOn(serverLogger, "info");
    const hang = fakeReg({ [MACHINE_ENVIRONMENT_KEY]: "hang", [USER_ENVIRONMENT_KEY]: "" });
    let t = 0;
    expect(await refreshWindowsRegistryPath({ runReg: hang.run, env: {}, timeoutMs: 20, now: () => t })).toBeNull();
    t = 4_000;
    expect(await refreshWindowsRegistryPath({ runReg: hang.run, env: {}, timeoutMs: 20, now: () => t })).toBeNull();
    expect(hang.calls).toHaveLength(4); // one read (four queries: Path + full env dump, each key), not two
    t = 6_000;
    expect(await refreshWindowsRegistryPath({ runReg: hang.run, env: {}, timeoutMs: 20, now: () => t })).toBeNull();
    expect(hang.calls).toHaveLength(8);
    expect(warn.mock.calls.filter(([o]) => (o as { op?: string }).op === "registry_path_read_failed")).toHaveLength(1);
    const good = fakeReg({ [MACHINE_ENVIRONMENT_KEY]: out("REG_SZ", "C:\\a"), [USER_ENVIRONMENT_KEY]: "" });
    t = 12_000;
    expect(await refreshWindowsRegistryPath({ runReg: good.run, env: {}, now: () => t })).toEqual(["C:\\a"]);
    expect(info.mock.calls.some(([o]) => (o as { op?: string }).op === "registry_path_read_recovered")).toBe(true);
  });

  it("any other failure (no `reg` at all) is no answer too", async () => {
    const { run } = fakeReg({ [MACHINE_ENVIRONMENT_KEY]: Object.assign(new Error("spawn reg ENOENT"), { code: "ENOENT" }) });
    expect(await refreshWindowsRegistryPath({ runReg: run, env: {} })).toBeNull();
    expect(lastWindowsRegistryPathDirs()).toBeNull();
  });

  // PRV M4: a fresh nvm-windows / Volta install writes its own vars (NVM_HOME, NVM_SYMLINK) into the registry's
  // Environment key AFTER libi booted, so they are not in this process's env — but they ARE in the very registry
  // dump this read just fetched. Expand against that first.
  it("expands %VAR% from the registry's own Environment values first", async () => {
    const run: RegQuery = (args) => {
      const [, key, flag] = args;
      if (flag === "/v") {
        if (key === MACHINE_ENVIRONMENT_KEY) return Promise.resolve(out("REG_EXPAND_SZ", "%NVM_HOME%\\bin"));
        return Promise.resolve(out("REG_SZ", ""));
      }
      // `reg query <key>` with no `/v`: the whole Environment key, several values.
      if (key === MACHINE_ENVIRONMENT_KEY) {
        return Promise.resolve(
          "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n" +
            "    NVM_HOME    REG_SZ    C:\\nvm\r\n    NVM_SYMLINK    REG_SZ    C:\\nvm\\current\r\n",
        );
      }
      return Promise.resolve("\r\nHKEY_CURRENT_USER\\Environment\r\n");
    };
    // `env` stands in for libi's boot-time process.env: it does NOT have NVM_HOME, proving the expansion came
    // from the registry dump, not from `env`.
    expect(await refreshWindowsRegistryPath({ runReg: run, env: {} })).toEqual(["C:\\nvm\\bin"]);
  });

  // PRV M4: `NOT_FOUND_RE` only matches the English "unable to find the specified registry key or value" message.
  // On a localized Windows a user with no HKCU `Path` gets a translated message instead, which used to fail the
  // WHOLE read (both machine and user PATH lost) instead of being treated as "no user Path".
  it("a localized 'not found' (exit 1, non-English stderr) is still an answer", async () => {
    const localizedNotFound = Object.assign(new Error("Command failed"), {
      code: 1,
      stderr: "FEHLER: Der angegebene Registrierungsschlüssel oder -wert wurde nicht gefunden.\r\n",
    });
    const { run } = fakeReg({ [MACHINE_ENVIRONMENT_KEY]: out("REG_SZ", "C:\\Windows"), [USER_ENVIRONMENT_KEY]: localizedNotFound });
    expect(await refreshWindowsRegistryPath({ runReg: run, env: {} })).toEqual(["C:\\Windows"]);
  });

  // PRV M4: `reg.exe`'s stdout is decoded as utf8 here, but `reg` actually writes the console's OEM codepage — a
  // non-ASCII folder name garbles into U+FFFD replacement characters. Dropping just that folder (not failing the
  // whole read) is safer than handing agents a directory that can never exist.
  it("a dir that decoded with U+FFFD is dropped, the rest kept", async () => {
    const { run } = fakeReg({
      [MACHINE_ENVIRONMENT_KEY]: out("REG_SZ", "C:\\Wind\uFFFDows\\bin;C:\\Good"),
      [USER_ENVIRONMENT_KEY]: "",
    });
    expect(await refreshWindowsRegistryPath({ runReg: run, env: {} })).toEqual(["C:\\Good"]);
  });

  it("reads once per 5 s, and never off Windows", async () => {
    const { run, calls } = fakeReg({ [MACHINE_ENVIRONMENT_KEY]: out("REG_SZ", "C:\\a"), [USER_ENVIRONMENT_KEY]: "" });
    let t = 0;
    await refreshWindowsRegistryPath({ runReg: run, env: {}, now: () => t });
    t = 4_000;
    await refreshWindowsRegistryPath({ runReg: run, env: {}, now: () => t });
    expect(calls).toHaveLength(4);
    t = 6_000;
    await refreshWindowsRegistryPath({ runReg: run, env: {}, now: () => t });
    expect(calls).toHaveLength(8);

    __clearWindowsRegistryPathMemo();
    pin("darwin");
    const other = fakeReg({});
    expect(await refreshWindowsRegistryPath({ runReg: other.run })).toBeNull();
    expect(other.calls).toHaveLength(0);
  });
});
