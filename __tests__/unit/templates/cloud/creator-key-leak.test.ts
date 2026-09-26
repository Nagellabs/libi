// __tests__/unit/templates/cloud/creator-key-leak.test.ts
//
// Final review I1: a failed write of the creator identity must not carry the
// key anywhere. drizzle wraps every failed statement in a DrizzleQueryError
// whose MESSAGE quotes the statement's parameters, and every identity write
// binds the key. The database is made read-only (`PRAGMA query_only`), so the
// failure is the real driver's, not a stand-in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import type { ErrorEvent } from "@sentry/nextjs";
import pino from "pino";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";

vi.mock("@/lib/sentry/enabled", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sentry/enabled")>();
  // The build gate is off in tests; the scrubber must be exercised as it runs when it is on.
  return { ...real, shouldSendCrashReports: () => true };
});
vi.mock("@/lib/templates/cloud/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/templates/cloud/client")>();
  return { ...real, setNickname: vi.fn(), fetchMine: vi.fn() };
});

import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { jobs } from "@/lib/db/schema/sqlite";
import { DrizzleQueryError, eq } from "drizzle-orm";
import {
  TemplatesAuthorWriteError,
  getOrCreateTemplatesAuthor,
  getTemplatesAuthor,
  importTemplatesAuthorKey,
  setTemplatesAuthorNickname,
} from "@/lib/db/settings";
import { JobManager } from "@/lib/jobs/manager";
import { __resetRunnerRegistryForTests, registerRunner } from "@/lib/jobs/runners/registry";
import { serverLogger } from "@/lib/logger";
import { resetLiveSecretsForTests } from "@/lib/security/secret-scrub";
import { scrubEvent } from "@/lib/sentry/scrub";
import { fetchMine, setNickname } from "@/lib/templates/cloud/client";
import { generateCreatorKey } from "@/lib/templates/cloud/identity";
import { PUT as PUT_AUTHOR } from "@/app/api/templates/cloud/author/route";
import { POST as POST_KEY, PUT as PUT_KEY } from "@/app/api/templates/cloud/key/route";
import { GET as GET_MINE } from "@/app/api/templates/cloud/mine/route";
import { jobIdOf } from "@/__tests__/helpers/enqueue";

function readOnly(on: boolean): void {
  (getDb() as unknown as { $client: { pragma(s: string): unknown } }).$client.pragma(`query_only = ${on ? "ON" : "OFF"}`);
}

/** Everything an Error can carry out: message, stack, name, and a cause at any depth. */
function everything(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; e && i < 5; i += 1) {
    const x = e as { message?: unknown; stack?: unknown; name?: unknown; cause?: unknown };
    parts.push(String(x.message), String(x.stack), String(x.name), JSON.stringify(e, Object.getOwnPropertyNames(e as object)));
    e = x.cause;
  }
  return parts.join("\n");
}

async function thrown(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

let key = "";

beforeEach(() => {
  resetLiveSecretsForTests();
  createTestDb();
  key = getOrCreateTemplatesAuthor().key;
});
afterEach(() => {
  resetTestDb();
  resetLiveSecretsForTests();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("a failed creator-identity write carries no key (I1)", () => {
  it("a DrizzleQueryError quoting the key (drizzle's async query path) leaves every writer as a bare TemplatesAuthorWriteError", async () => {
    // On drizzle 0.45 the better-sqlite3 SYNC `.run()` rethrows the driver's
    // own SqliteError (no parameters); `queryWithCache` — any awaited query —
    // wraps it in a DrizzleQueryError whose message quotes them. Both must be
    // caught; this is the one that would carry the key.
    const db = getDb();
    const other = generateCreatorKey();
    const leak = () => {
      const cause = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      return new DrizzleQueryError(`update "settings" set "templates_author" = ?`, [JSON.stringify({ key, other })], cause);
    };
    expect(leak().message).toContain(key);
    const failing = { run: () => { throw leak(); } };
    const chain: Record<string, unknown> = new Proxy({}, { get: (_t, p) => (p === "run" ? failing.run : () => chain) });
    vi.spyOn(db, "update").mockImplementation(() => chain as never);
    vi.spyOn(db, "insert").mockImplementation(() => chain as never);
    for (const write of [() => setTemplatesAuthorNickname(key, "nadav"), () => importTemplatesAuthorKey(other)]) {
      const err = await thrown(write);
      expect(err).toBeInstanceOf(TemplatesAuthorWriteError);
      expect((err as Error).message).toBe("could not save the creator identity (SQLITE_BUSY)");
      expect((err as Error).cause).toBeUndefined();
      expect(everything(err)).not.toContain(key);
      expect(everything(err)).not.toContain(other);
    }
  });

  it("each writer throws a TemplatesAuthorWriteError naming only the SQLite code, with no cause", async () => {
    readOnly(true);
    const other = generateCreatorKey();
    for (const write of [
      () => setTemplatesAuthorNickname(key, "nadav"),
      () => importTemplatesAuthorKey(other),
    ]) {
      const err = await thrown(write);
      expect(err).toBeInstanceOf(TemplatesAuthorWriteError);
      expect((err as Error).message).toBe("could not save the creator identity (SQLITE_READONLY)");
      expect((err as Error).cause).toBeUndefined();
      expect(everything(err)).not.toContain(key);
      expect(everything(err)).not.toContain(other);
    }
    // The mint path (getOrCreate with nothing stored) goes through the same guard.
    readOnly(false);
    getDb().update(settings).set({ templatesAuthor: null }).where(eq(settings.id, 1)).run();
    readOnly(true);
    const minted = await thrown(() => getOrCreateTemplatesAuthor());
    expect(minted).toBeInstanceOf(TemplatesAuthorWriteError);
  });

  it("the routes answer a 500 in libi's words, never the key", async () => {
    vi.mocked(setNickname).mockResolvedValue({ ok: true, nickname: "nadav" });
    vi.mocked(fetchMine).mockResolvedValue({ ok: true, nickname: "fromsite", templates: [] });
    readOnly(true);

    const page = { host: "127.0.0.1:3461", origin: "http://127.0.0.1:3461", "sec-fetch-site": "same-origin" };
    const author = await PUT_AUTHOR(new Request("http://127.0.0.1:3461/api/templates/cloud/author", { method: "PUT", body: JSON.stringify({ nickname: "nadav" }), headers: page }));
    expect(author.status).toBe(500);
    expect(await author.text()).not.toContain(key);

    const other = generateCreatorKey();
    const imported = await PUT_KEY(new Request("http://127.0.0.1:3461/api/templates/cloud/key", { method: "PUT", body: JSON.stringify({ key: other, replace: true }), headers: page }));
    expect(imported.status).toBe(500);
    const importedBody = await imported.text();
    expect(importedBody).not.toContain(other);
    expect(importedBody).not.toContain(key);
    expect(importedBody).toMatch(/SQLITE_READONLY/);

    // /mine never 5xxs: a write-back that fails still answers the site's list.
    const mine = await GET_MINE(new Request("http://127.0.0.1:3461/api/templates/cloud/mine", { headers: { host: "127.0.0.1:3461", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } }));
    expect(mine.status).toBe(200);
    expect(await mine.text()).not.toContain(key);

    readOnly(false);
    getDb().update(settings).set({ templatesAuthor: null }).where(eq(settings.id, 1)).run();
    readOnly(true);
    const created = await POST_KEY();
    expect(created.status).toBe(500);
    expect(await created.text()).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it("the logger masks a registered key inside any string, whatever the field", () => {
    const hooks = (serverLogger as unknown as Record<symbol, { streamWrite?: (s: string) => string }>)[pino.symbols.hooksSym];
    expect(hooks.streamWrite).toBeTypeOf("function");
    const line = JSON.stringify({ level: 50, err: `Failed query: update "settings" ...\nparams: {"key":"${key}"}`, msg: `x ${key}` });
    const out = hooks.streamWrite!(line);
    expect(out).not.toContain(key);
    expect(out).toContain("[redacted]");
  });

  it("the Sentry scrubber masks the key in the message, the exception, extra and breadcrumbs", () => {
    const leak = `Failed query: insert into "settings" params: 1,{"key":"${key}"}`;
    const event = scrubEvent({
      type: undefined,
      message: leak,
      exception: { values: [{ type: "DrizzleQueryError", value: leak }] },
      extra: { note: leak },
      breadcrumbs: [{ message: leak, data: { detail: leak } }],
    } as ErrorEvent);
    expect(JSON.stringify(event)).not.toContain(key);
  });

  it("a job that fails with the key in its message stores, emits, logs and rethrows it masked", async () => {
    // A runner that did NOT wrap its error — the manager's backstop.
    __resetRunnerRegistryForTests();
    registerRunner({
      kind: "leaky",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run() {
        throw new Error(`Failed query: update "settings" ...\nparams: ${key}`);
      },
    });
    const logged: string[] = [];
    vi.spyOn(serverLogger, "error").mockImplementation(((obj: unknown) => void logged.push(JSON.stringify(obj))) as never);
    const mgr = new JobManager();
    const emitted: string[] = [];
    mgr.on("failed", (e: unknown) => void emitted.push(JSON.stringify(e)));
    const jobId = jobIdOf(await mgr.enqueue("leaky", {}));
    const err = await thrown(() => mgr.runToCompletion(jobId));
    expect(everything(err)).not.toContain(key);
    const [row] = getDb().select().from(jobs).where(eq(jobs.id, jobId)).all();
    expect(row.status).toBe("failed");
    expect(row.error).toContain("[redacted]");
    expect(row.error).not.toContain(key);
    expect(logged.join("\n")).not.toContain(key);
    expect(emitted).toHaveLength(1);
    expect(emitted.join("\n")).not.toContain(key);
  });

  it("the key still reads back after all this (the guard changed no data)", () => {
    expect(getTemplatesAuthor()?.key).toBe(key);
  });
});
