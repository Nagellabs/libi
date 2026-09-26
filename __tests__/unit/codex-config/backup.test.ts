// `codex mcp add` re-serializes the user's WHOLE `config.toml`
// (dropping `args = []`, `120` → `120.0`, env reordered) and `codex mcp remove`
// does not undo it. `libi connect` — the one libi command that runs it, from the
// user's own terminal — owes the user a copy of what was there before, and has
// to say where it went. The studio server's read-only `codex mcp list --json`
// writes nothing, so it takes no copy.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mcpLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { backupCodexConfig, ensureCodexConfigBackup, listCodexConfigBackups } from "@/lib/codex-config/backup";
import { mcpListJson } from "@/lib/codex-config/codex-cli";

const HANDWRITTEN = `[mcp_servers.node_repl]
command = "node"
args = []
startup_timeout_sec = 120
`;

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-codex-backup-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function writeConfig(contents: string): void {
  fs.writeFileSync(path.join(home, "config.toml"), contents);
}

describe("backupCodexConfig", () => {
  it("copies the exact bytes aside and returns where they went", () => {
    writeConfig(HANDWRITTEN);
    const backup = backupCodexConfig(home);
    expect(backup).toBeTruthy();
    expect(fs.readFileSync(backup as string, "utf-8")).toBe(HANDWRITTEN);
    // Named so a listing finds it next to older libi versions' backups.
    expect(path.basename(backup as string)).toMatch(/^config\.toml\.libi-backup-/);
  });

  it("has nothing to protect when there is no config, or an empty one", () => {
    expect(backupCodexConfig(home)).toBeNull();
    writeConfig("");
    expect(backupCodexConfig(home)).toBeNull();
  });

  it("does not re-copy unchanged bytes", () => {
    // `libi connect` can be re-run any number of times. Copying an unchanged
    // file each time would roll the one revision the user actually wants off
    // the end of the retention window.
    writeConfig(HANDWRITTEN);
    expect(backupCodexConfig(home)).toBeTruthy();
    expect(backupCodexConfig(home)).toBeNull();
    expect(listCodexConfigBackups(home)).toHaveLength(1);
  });

  it("copies again once codex has actually rewritten the file", () => {
    writeConfig(HANDWRITTEN);
    backupCodexConfig(home);
    writeConfig(HANDWRITTEN.replace("args = []\n", "").replace("120", "120.0"));
    expect(backupCodexConfig(home)).toBeTruthy();
    expect(listCodexConfigBackups(home)).toHaveLength(2);
  });

  it("retains a bounded number of revisions, newest first", () => {
    for (let i = 0; i < 9; i++) {
      writeConfig(`${HANDWRITTEN}# revision ${i}\n`);
      backupCodexConfig(home);
    }
    const kept = listCodexConfigBackups(home);
    expect(kept.length).toBeLessThanOrEqual(5);
    expect(kept.length).toBeGreaterThan(0);
  });

  it("never throws on an unwritable home", () => {
    expect(() => backupCodexConfig("/definitely/not/a/directory")).not.toThrow();
    expect(backupCodexConfig("/definitely/not/a/directory")).toBeNull();
  });
});

// `libi connect` needs the copy that holds what codex is about to rewrite, to
// warn about what the rewrite drops — whether that copy is new or a previous
// run already took it.
// QA 2026-09-19 D4: codex keeps config.toml at 0600 (it can hold
// bearer_token / http_headers); the copy was written 0644, world-readable.
// POSIX modes don't exist on Windows, so the assertion is skipped there.
describe("backup file permissions", () => {
  it.skipIf(process.platform === "win32")("writes the backup owner-only (0600), whatever the source mode or umask", () => {
    writeConfig(HANDWRITTEN);
    fs.chmodSync(path.join(home, "config.toml"), 0o644);
    const prevUmask = process.umask(0);
    try {
      const backup = backupCodexConfig(home);
      expect(backup).toBeTruthy();
      expect(fs.statSync(backup as string).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(prevUmask);
    }
  });
});

describe("ensureCodexConfigBackup", () => {
  it("a new copy is created: true", () => {
    writeConfig(HANDWRITTEN);
    const r = ensureCodexConfigBackup(home);
    expect(r?.created).toBe(true);
    expect(fs.readFileSync(r!.path, "utf-8")).toBe(HANDWRITTEN);
  });

  it("unchanged bytes name the existing copy, created: false, and write nothing", () => {
    writeConfig(HANDWRITTEN);
    const first = ensureCodexConfigBackup(home)!;
    expect(ensureCodexConfigBackup(home)).toEqual({ path: first.path, created: false });
    expect(listCodexConfigBackups(home)).toHaveLength(1);
  });

  it("nothing to protect → null", () => {
    expect(ensureCodexConfigBackup(home)).toBeNull();
  });
});

describe("the server's read-only codex call", () => {
  it("mcpListJson never takes a backup", async () => {
    writeConfig(HANDWRITTEN);
    let spawned = 0;
    await mcpListJson({
      codexHome: home,
      spawner: async () => {
        spawned += 1;
        return { stdout: "[]", stderr: "" };
      },
    });
    expect(spawned).toBe(1);
    expect(listCodexConfigBackups(home)).toHaveLength(0);
  });
});
