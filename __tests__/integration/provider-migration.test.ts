import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import {
  migrateProviderRows,
  expireRescuedProviderKeys,
  LEGACY_KEY_TTL_DAYS,
} from "@/lib/db/migrate-providers";
import { seedDatabase } from "@/lib/db/init";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

/**
 * The providers migration, run against a DB as it existed BEFORE it: the
 * fixture is the verbatim schema of a real migration-0050 database (see the
 * header of `pre-providers.sql`), not a reconstruction. `migrate()` applies
 * only what comes after 0050 — the `DROP COLUMN`s of `enabled` and
 * `files.fal_uploaded_url` plus the new `legacy_provider_keys` table — and
 * then `migrateProviderRows` does the DATA half drizzle cannot emit.
 */
function preChangeDb(): { db: ReturnType<typeof drizzle>; raw: Database.Database } {
  const raw = new Database(":memory:");
  raw.exec(
    fs.readFileSync(path.join(process.cwd(), "__tests__/fixtures/db/pre-providers.sql"), "utf-8"),
  );
  return { db: drizzle(raw), raw };
}

function columns(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function ids(raw: Database.Database): string[] {
  return (raw.prepare("SELECT id FROM mcp_servers ORDER BY id").all() as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

/**
 * Note: the `await import(...)` inside the tests below is deliberate and
 * must stay. Each test installs its own in-memory DB on
 * `globalThis.__libi_test_db` in its body, and `afterEach` clears it — so the
 * modules under test are loaded only once a DB exists for them to reach, and
 * the Next route modules are never evaluated by a test that has not set one
 * up. The mirrored dynamic imports in `__tests__/unit/agents/runtime-packages.test.ts`
 * had no such reason (nothing there mocks or resets the module registry) and
 * were converted to static imports.
 */
let db: ReturnType<typeof drizzle>;
let raw: Database.Database;

beforeEach(() => {
  ({ db, raw } = preChangeDb());
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle/sqlite") });
});

afterEach(() => {
  globalThis.__libi_test_db = undefined;
  raw.close();
});

describe("provider migration", () => {
  it("the fixture really is pre-change: five rows, the enabled column present", () => {
    // Guards the fixture itself — if it drifted to a post-change shape every
    // assertion below would pass vacuously.
    const { raw: fresh } = preChangeDb();
    expect(columns(fresh, "mcp_servers")).toContain("enabled");
    expect(columns(fresh, "files")).toContain("fal_uploaded_url");
    expect(ids(fresh)).toEqual(["elevenlabs", "fal-ai", "libi", "my-custom-mcp", "youtube-downloader"]);
    fresh.close();
  });

  it("rescues the bundled providers' keys into legacy_provider_keys before deleting them", () => {
    migrateProviderRows(db);
    const rescued = raw
      .prepare("SELECT provider_id, env_vars, shown_at FROM legacy_provider_keys ORDER BY provider_id")
      .all() as Array<{ provider_id: string; env_vars: string; shown_at: number | null }>;
    expect(rescued.map((r) => r.provider_id)).toEqual(["fal-ai"]);
    expect(JSON.parse(rescued[0].env_vars)).toEqual({ FAL_KEY: "sk-legacy-123" });
    expect(rescued[0].shown_at).toBeNull();
  });

  it("deletes the three bundled third-party rows and every custom row", () => {
    migrateProviderRows(db);
    const after = ids(raw);
    expect(after).not.toContain("fal-ai");
    expect(after).not.toContain("elevenlabs");
    expect(after).not.toContain("youtube-downloader");
    expect(after).not.toContain("my-custom-mcp");
    expect(after).toContain("libi");
  });

  it("never rescues a custom row's env vars — only the three bundled ids are handed back", () => {
    migrateProviderRows(db);
    const rescued = (
      raw.prepare("SELECT provider_id FROM legacy_provider_keys").all() as Array<{ provider_id: string }>
    ).map((r) => r.provider_id);
    expect(rescued).not.toContain("my-custom-mcp");
  });

  it("rescues nothing for a row that had no key", () => {
    raw.prepare("UPDATE mcp_servers SET env_vars = NULL WHERE id = 'fal-ai'").run();
    migrateProviderRows(db);
    expect(raw.prepare("SELECT COUNT(*) c FROM legacy_provider_keys").get()).toEqual({ c: 0 });
  });

  it("rescues nothing for a row whose key is an empty string", () => {
    raw.prepare(`UPDATE mcp_servers SET env_vars = '{"FAL_KEY":""}' WHERE id = 'fal-ai'`).run();
    migrateProviderRows(db);
    expect(raw.prepare("SELECT COUNT(*) c FROM legacy_provider_keys").get()).toEqual({ c: 0 });
  });

  it("drops the enabled column and files.fal_uploaded_url, and keeps env_vars through the DDL", () => {
    expect(columns(raw, "mcp_servers")).not.toContain("enabled");
    expect(columns(raw, "mcp_servers")).toContain("require_approval");
    expect(columns(raw, "files")).not.toContain("fal_uploaded_url");
    // The DDL half must leave env_vars intact (a table recreate that forgot
    // the column would not) — the data half reads it AFTER migrate() has run.
    const row = raw.prepare("SELECT env_vars FROM mcp_servers WHERE id = 'fal-ai'").get() as {
      env_vars: string;
    };
    expect(JSON.parse(row.env_vars)).toEqual({ FAL_KEY: "sk-legacy-123" });
  });

  it("is idempotent — a second run adds nothing and throws nothing", () => {
    migrateProviderRows(db);
    const before = raw.prepare("SELECT COUNT(*) c FROM legacy_provider_keys").get();
    expect(() => migrateProviderRows(db)).not.toThrow();
    expect(raw.prepare("SELECT COUNT(*) c FROM legacy_provider_keys").get()).toEqual(before);
  });

  it("a second run after the notice was acknowledged does not resurrect the key", () => {
    migrateProviderRows(db);
    raw.prepare("UPDATE legacy_provider_keys SET env_vars = '{}', shown_at = 1 WHERE provider_id = 'fal-ai'").run();
    migrateProviderRows(db);
    expect(raw.prepare("SELECT env_vars FROM legacy_provider_keys WHERE provider_id = 'fal-ai'").get()).toEqual({
      env_vars: "{}",
    });
  });

  it("leaves seedDatabase with only libi-owned rows", () => {
    migrateProviderRows(db);
    seedDatabase(db);
    expect(ids(raw).sort()).toEqual(
      ["libi", "libi-export", "libi-tracking", "local-music", "local-tts", "whisper", "youtube-download"].sort(),
    );
    // …which is exactly the bundled registry, and nothing else.
    expect(ids(raw).sort()).toEqual(BUNDLED_MCP_SERVERS.map((d) => d.id).sort());
  });
});

describe("fresh database", () => {
  it("migrates 0000 through 0052 on an empty file and seeds only libi-owned rows", () => {
    const fresh = new Database(":memory:");
    const freshDb = drizzle(fresh);
    migrate(freshDb, { migrationsFolder: path.join(process.cwd(), "drizzle/sqlite") });
    expect(() => migrateProviderRows(freshDb)).not.toThrow();
    seedDatabase(freshDb);
    expect(columns(fresh, "mcp_servers")).not.toContain("enabled");
    expect(columns(fresh, "files")).not.toContain("fal_uploaded_url");
    expect(columns(fresh, "legacy_provider_keys")).toEqual([
      "provider_id",
      "env_vars",
      "shown_at",
      // Appended by 0052 — an ALTER TABLE, so it lands last whatever order
      // the schema declares it in.
      "rescued_at",
    ]);
    expect(ids(fresh).sort()).toEqual(BUNDLED_MCP_SERVERS.map((d) => d.id).sort());
    expect(fresh.prepare("SELECT COUNT(*) c FROM legacy_provider_keys").get()).toEqual({ c: 0 });
    fresh.close();
  });
});

describe("legacy key notice", () => {
  beforeEach(() => {
    migrateProviderRows(db);
    globalThis.__libi_test_db = db;
  });

  it("renders the add commands with the stored key substituted, then clears it", async () => {
    const { pendingLegacyKeyNotices, acknowledgeLegacyKey } = await import("@/lib/providers/legacy");
    const notices = pendingLegacyKeyNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].rowId).toBe("fal-ai");
    expect(notices[0].providerId).toBe("fal");
    expect(notices[0].providerName).toBe("fal.ai");
    expect(notices[0].command).toContain("Bearer sk-legacy-123");
    expect(notices[0].command).not.toContain("<your key>");
    expect(notices[0].commands.claude).toBe(notices[0].command);
    // fal's Codex command carries no placeholder (the key is an env-var NAME
    // there), so the export that puts the key into Codex's environment leads.
    expect(notices[0].commands.codex).toContain('export FAL_KEY="sk-legacy-123"');
    expect(notices[0].commands.codex).toContain("codex mcp add fal-ai");
    expect(notices[0].commands.codex).not.toContain("<your key>");

    acknowledgeLegacyKey("fal-ai");
    expect(pendingLegacyKeyNotices()).toHaveLength(0);
    // The VALUE is gone from the table, not merely hidden.
    expect(raw.prepare("SELECT env_vars, shown_at FROM legacy_provider_keys WHERE provider_id = 'fal-ai'").get()).toEqual({
      env_vars: "{}",
      shown_at: expect.any(Number),
    });
  });

  it("substitutes an ElevenLabs key into both commands' placeholder", async () => {
    raw
      .prepare(
        `INSERT INTO legacy_provider_keys (provider_id, env_vars, shown_at) VALUES ('elevenlabs', '{"ELEVENLABS_API_KEY":"el-key-9"}', NULL)`,
      )
      .run();
    const { pendingLegacyKeyNotices } = await import("@/lib/providers/legacy");
    const el = pendingLegacyKeyNotices().find((n) => n.rowId === "elevenlabs");
    expect(el?.providerId).toBe("elevenlabs");
    expect(el?.commands.claude).toContain('"ELEVENLABS_API_KEY=el-key-9"');
    expect(el?.commands.codex).toContain('"ELEVENLABS_API_KEY=el-key-9"');
    expect(el?.commands.codex).not.toContain("export ");
  });

  it("skips a rescued row the catalog has no command for", async () => {
    raw
      .prepare(
        `INSERT INTO legacy_provider_keys (provider_id, env_vars, shown_at) VALUES ('youtube-downloader', '{"X":"y"}', NULL)`,
      )
      .run();
    const { pendingLegacyKeyNotices } = await import("@/lib/providers/legacy");
    expect(pendingLegacyKeyNotices().map((n) => n.rowId)).toEqual(["fal-ai"]);
  });

  it("the HTTP route answers GET with the notices and POST clears one", async () => {
    const { GET, POST } = await import("@/app/api/providers/legacy/route");
    const listed = (await (await GET()).json()) as { notices: Array<{ rowId: string }> };
    expect(listed.notices.map((n) => n.rowId)).toEqual(["fal-ai"]);

    const bad = await POST(new Request("http://x/api/providers/legacy", { method: "POST", body: "{}" }));
    expect(bad.status).toBe(400);

    const ok = await POST(
      new Request("http://x/api/providers/legacy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rowId: "fal-ai" }),
      }),
    );
    expect(ok.status).toBe(200);
    const after = (await (await GET()).json()) as { notices: unknown[] };
    expect(after.notices).toEqual([]);
  });

  // The table can be unreadable for the same reasons GET already tolerates
  // (an older runtime opened this DB, a half-applied migration). GET degrades
  // to an empty list; POST must answer with a structured 500 the panel can
  // show, not a Next-rendered stack trace.
  it("POST answers a structured 500 when the acknowledgement cannot be written", async () => {
    const { GET, POST } = await import("@/app/api/providers/legacy/route");
    raw.exec("DROP TABLE legacy_provider_keys");
    const res = await POST(
      new Request("http://x/api/providers/legacy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rowId: "fal-ai" }),
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "legacy-ack-failed" });
    expect((await (await GET()).json()) as { notices: unknown[] }).toEqual({ notices: [] });
  });
});

/**
 * The rescue is a HAND-BACK, not a store: a row nobody ever
 * acknowledges must not keep a live API key in libi's database for the life
 * of the install. Two exits, and this describe owns the unconditional one.
 */
describe("rescued keys expire", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 8, 9);

  function rescueRow(providerId: string, rescuedAtMs: number, envVars = '{"FAL_KEY":"sk-old"}') {
    raw
      .prepare(
        "INSERT OR REPLACE INTO legacy_provider_keys (provider_id, env_vars, rescued_at, shown_at) VALUES (?, ?, ?, NULL)",
      )
      .run(providerId, envVars, Math.floor(rescuedAtMs / 1000));
  }
  function row(providerId: string) {
    return raw
      .prepare("SELECT env_vars, shown_at FROM legacy_provider_keys WHERE provider_id = ?")
      .get(providerId) as { env_vars: string; shown_at: number | null };
  }

  it("blanks a row older than the TTL and stamps it shown", () => {
    rescueRow("fal-ai", now - (LEGACY_KEY_TTL_DAYS + 1) * DAY_MS);
    expect(expireRescuedProviderKeys(db, now)).toBe(1);
    expect(row("fal-ai").env_vars).toBe("{}");
    expect(row("fal-ai").shown_at).toEqual(expect.any(Number));
  });

  it("leaves a row inside the TTL alone — the notice still has something to offer", () => {
    rescueRow("fal-ai", now - (LEGACY_KEY_TTL_DAYS - 1) * DAY_MS);
    expect(expireRescuedProviderKeys(db, now)).toBe(0);
    expect(JSON.parse(row("fal-ai").env_vars)).toEqual({ FAL_KEY: "sk-old" });
    expect(row("fal-ai").shown_at).toBeNull();
  });

  it("does not rewrite an already-blanked row (idempotent, and keeps its stamp)", () => {
    rescueRow("fal-ai", now - 400 * DAY_MS, "{}");
    raw.prepare("UPDATE legacy_provider_keys SET shown_at = 12345 WHERE provider_id = 'fal-ai'").run();
    expect(expireRescuedProviderKeys(db, now)).toBe(0);
    expect(row("fal-ai").shown_at).toBe(12345);
  });

  it("migrateProviderRows runs the expiry, and never expires what it rescued this boot", () => {
    // An ancient row from some earlier upgrade, plus the fixture's own fal-ai
    // key which this run is about to rescue.
    rescueRow("elevenlabs", now - 90 * DAY_MS, '{"ELEVENLABS_API_KEY":"el-old"}');
    migrateProviderRows(db);
    expect(row("elevenlabs").env_vars).toBe("{}");
    expect(JSON.parse(row("fal-ai").env_vars)).toEqual({ FAL_KEY: "sk-legacy-123" });
    expect(row("fal-ai").shown_at).toBeNull();
  });

  it("a row rescued now is stamped with a rescued_at the TTL can act on later", () => {
    migrateProviderRows(db);
    const stamped = raw
      .prepare("SELECT rescued_at FROM legacy_provider_keys WHERE provider_id = 'fal-ai'")
      .get() as { rescued_at: number };
    expect(stamped.rescued_at).toBeGreaterThan(0);
    // Wound the clock forward past the TTL and the same row goes.
    expect(
      expireRescuedProviderKeys(db, (stamped.rescued_at + LEGACY_KEY_TTL_DAYS * 24 * 60 * 60 + 1) * 1000),
    ).toBe(1);
  });

  it("an expired row shows no notice", async () => {
    migrateProviderRows(db);
    globalThis.__libi_test_db = db;
    const { pendingLegacyKeyNotices } = await import("@/lib/providers/legacy");
    expect(pendingLegacyKeyNotices()).toHaveLength(1);
    expireRescuedProviderKeys(db, Date.now() + (LEGACY_KEY_TTL_DAYS + 1) * DAY_MS);
    expect(pendingLegacyKeyNotices()).toHaveLength(0);
  });
});

/**
 * The other exit: the user reconnected the provider themselves, so the key
 * libi is holding is already in their own agent config.
 */
describe("rescued keys clear when the provider is reconnected", () => {
  beforeEach(() => {
    migrateProviderRows(db);
    globalThis.__libi_test_db = db;
  });

  function envVars(providerId: string): string {
    return (
      raw
        .prepare("SELECT env_vars FROM legacy_provider_keys WHERE provider_id = ?")
        .get(providerId) as { env_vars: string }
    ).env_vars;
  }

  it("drops the fal key once the detector reports a connected fal", async () => {
    const { clearLegacyKeysForConnected, pendingLegacyKeyNotices } = await import(
      "@/lib/providers/legacy"
    );
    expect(pendingLegacyKeyNotices()).toHaveLength(1);
    clearLegacyKeysForConnected([{ providerId: "fal" }]);
    expect(envVars("fal-ai")).toBe("{}");
    expect(pendingLegacyKeyNotices()).toHaveLength(0);
  });

  it("leaves the key alone when a DIFFERENT provider is connected", async () => {
    const { clearLegacyKeysForConnected } = await import("@/lib/providers/legacy");
    clearLegacyKeysForConnected([{ providerId: "elevenlabs" }, { providerId: null }]);
    expect(JSON.parse(envVars("fal-ai"))).toEqual({ FAL_KEY: "sk-legacy-123" });
  });

  it("does nothing, and never throws, on an empty detection or an unreadable table", async () => {
    const { clearLegacyKeysForConnected } = await import("@/lib/providers/legacy");
    expect(() => clearLegacyKeysForConnected([])).not.toThrow();
    expect(JSON.parse(envVars("fal-ai"))).toEqual({ FAL_KEY: "sk-legacy-123" });
    raw.exec("DROP TABLE legacy_provider_keys");
    expect(() => clearLegacyKeysForConnected([{ providerId: "fal" }])).not.toThrow();
  });
});
