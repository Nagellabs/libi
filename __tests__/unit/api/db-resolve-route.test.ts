import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateDatabase, resetDbClient } from "@/lib/db/client";
import { getOrCreateTemplatesAuthor, getSettings, getTemplatesAuthor, updateSettings } from "@/lib/db/settings";
import { serverLogger } from "@/lib/logger";

// Switches for the failure paths. Off, every function is the real one.
const fail = vi.hoisted(() => ({ backup: false, migrate: false, restore: false }));

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return {
    ...actual,
    backupDb: (p?: string) => (fail.backup ? null : actual.backupDb(p)),
    migrateDatabase: (p?: string) => {
      if (fail.migrate) throw new Error("migration exploded");
      return actual.migrateDatabase(p);
    },
  };
});
vi.mock("@/lib/db/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/settings")>();
  return {
    ...actual,
    restoreTemplatesAuthorsAfterReset: (...args: Parameters<typeof actual.restoreTemplatesAuthorsAfterReset>) => {
      if (fail.restore) throw new actual.TemplatesAuthorWriteError("SQLITE_BUSY");
      return actual.restoreTemplatesAuthorsAfterReset(...args);
    },
  };
});
vi.mock("@/mcp/registry/dependency-manager", () => ({
  DependencyManager: class {
    async ensureAll(): Promise<void> {}
  },
}));
vi.mock("@/lib/mcp-config", () => ({ invalidateMcpConfig: vi.fn() }));

import { POST } from "@/app/api/db/resolve/route";

describe("POST /api/db/resolve (reset)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    fail.backup = fail.migrate = fail.restore = false;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-db-resolve-"));
    dbPath = path.join(tmpDir, "libi.sqlite");
    process.env.DB_PATH = dbPath;
    resetDbClient();
    migrateDatabase(dbPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDbClient();
    delete process.env.DB_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function reset(): Promise<Response> {
    return POST(new Request("http://x/api/db/resolve", { method: "POST", body: JSON.stringify({ mode: "reset" }) }));
  }

  /** Every log call the route made, flattened, so a test can assert the key is in none of them. */
  function spyLogs() {
    const spies = (["info", "warn", "error"] as const).map((level) => vi.spyOn(serverLogger, level));
    return {
      ops: () => spies.flatMap((s) => s.mock.calls.map((c) => (c[0] as { op?: string }).op)),
      call: (op: string) =>
        spies.flatMap((s) => s.mock.calls).find((c) => (c[0] as { op?: string }).op === op)?.[0] as
          | Record<string, unknown>
          | undefined,
      text: () => JSON.stringify(spies.flatMap((s) => s.mock.calls)),
    };
  }

  it("carries the creator key across the reset, and clears everything else", async () => {
    updateSettings({ preferredAgent: "codex" });
    const author = getOrCreateTemplatesAuthor();

    const res = await reset();
    expect(res.status).toBe(200);

    expect(getSettings().preferredAgent).toBeNull(); // the reset really happened
    expect(getTemplatesAuthor()).toEqual(author);
  });

  // Test mode keeps its identity in a row of its own (final review Minor 1): a reset in either mode keeps both.
  it("a reset in test mode carries the production key AND test mode's own, each to its own row", async () => {
    const production = getOrCreateTemplatesAuthor();
    vi.stubEnv("LIBI_TEST_MODE", "1");
    try {
      const testIdentity = getOrCreateTemplatesAuthor();
      expect(testIdentity.key).not.toBe(production.key);
      const res = await reset();
      expect(res.status).toBe(200);
      expect(getTemplatesAuthor()).toEqual(testIdentity);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(getTemplatesAuthor()).toEqual(production);
  });

  it("still resets when there is no creator key", async () => {
    const res = await reset();
    expect(res.status).toBe(200);
    expect(getTemplatesAuthor()).toBeNull();
  });

  it("still resets when there is no database to back up", async () => {
    resetDbClient();
    fs.unlinkSync(dbPath);

    const res = await reset();
    expect(res.status).toBe(200);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("reports a completed reset as successful when restoring the key fails, and logs where the key is", async () => {
    const author = getOrCreateTemplatesAuthor();
    const logs = spyLogs();
    fail.restore = true;

    const res = await reset();
    const body = (await res.json()) as { success: boolean; backupPath: string };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(logs.call("templates_author_restore_failed")).toMatchObject({ tag: "db-resolve", backupPath: body.backupPath });
    expect(body.backupPath).toEqual(expect.any(String));
    expect(logs.text()).not.toContain(author.key);
  });

  it("names the backup holding the key when the reset fails after the database was deleted", async () => {
    const author = getOrCreateTemplatesAuthor();
    const logs = spyLogs();
    fail.migrate = true;

    const res = await reset();
    const body = (await res.json()) as { success: boolean; error: string; backupPath: string };

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.backupPath).toEqual(expect.any(String));
    expect(fs.existsSync(body.backupPath)).toBe(true);
    expect(body.error).toContain("migration exploded");
    expect(body.error).toContain(`your creator key is in ${body.backupPath}`);
    expect(logs.call("templates_author_not_restored")).toMatchObject({ tag: "db-resolve", backupPath: body.backupPath });
    expect(logs.text()).not.toContain(author.key);
    expect(body.error).not.toContain(author.key);
  });

  it("does not mention a creator key in a failed reset when there was none", async () => {
    const logs = spyLogs();
    fail.migrate = true;

    const res = await reset();
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(500);
    expect(body.error).not.toContain("creator key");
    expect(logs.ops()).not.toContain("templates_author_not_restored");
  });

  it("refuses to delete the database when the backup failed and a creator key exists", async () => {
    updateSettings({ preferredAgent: "codex" });
    const author = getOrCreateTemplatesAuthor();
    fail.backup = true;

    const res = await reset();
    const body = (await res.json()) as { success: boolean; error: string };

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/nothing was deleted/i);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(getSettings().preferredAgent).toBe("codex"); // untouched
    expect(getTemplatesAuthor()).toEqual(author);
  });

  it("refuses to delete the database when the backup failed, even with no creator key", async () => {
    updateSettings({ preferredAgent: "codex" });
    fail.backup = true;

    const res = await reset();
    const body = (await res.json()) as { success: boolean; error: string };

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(getSettings().preferredAgent).toBe("codex");
  });
});
