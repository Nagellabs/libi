// __tests__/unit/templates/cloud/use-reporter.test.ts
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { templateUses, templates } from "@/lib/db/schema/sqlite";
import type { reportUse as ReportUse } from "@/lib/templates/cloud/client";
import {
  __resetUseReporterForTests,
  backoffMs,
  CLAIM_MS,
  DRAIN_BATCH,
  DRAIN_INTERVAL_MS,
  drainUseReports,
  GIVE_UP_MS,
  REPORT_DELAY_MS,
  startUseReporter,
  stopUseReporter,
} from "@/lib/templates/cloud/use-reporter";

const NOW = 1_800_000_000_000;
const CLOUD = "abcdefghijklmnopqrst";
const CLOUD2 = "cccccccccccccccccccc";
function seed() {
  const db = getDb();
  db.insert(templates).values({ id: "inst", name: "I", description: "", tags: "[]", origin: "installed", cloudId: CLOUD, version: 1, hasCode: false, useCount: 0 }).run();
  db.insert(templates).values({ id: "inst2", name: "I2", description: "", tags: "[]", origin: "installed", cloudId: CLOUD2, version: 1, hasCode: false, useCount: 0 }).run();
  db.insert(templates).values({ id: "local", name: "L", description: "", tags: "[]", origin: "local", cloudId: null, version: 1, hasCode: false, useCount: 0 }).run();
  db.insert(templates).values({ id: "published", name: "P", description: "", tags: "[]", origin: "local", cloudId: "bbbbbbbbbbbbbbbbbbbb", version: 1, hasCode: false, useCount: 0 }).run();
}
function use(id: string, templateId: string, usedAt: number) {
  getDb().insert(templateUses).values({ id, templateId, pieceId: null, usedAt: new Date(usedAt), reported: false }).run();
}
const unreported = () => getDb().select().from(templateUses).all().filter((u) => !u.reported).map((u) => u.id).sort();
const row = (id: string) => getDb().select().from(templateUses).where(eq(templateUses.id, id)).get()!;
type Report = typeof ReportUse;
const answering = (...answers: Awaited<ReturnType<Report>>[]) => {
  const fn = vi.fn<Report>();
  for (const a of answers) fn.mockResolvedValueOnce(a);
  return fn;
};

beforeEach(() => {
  createTestDb();
  __resetUseReporterForTests();
  seed();
});
afterEach(() => {
  __resetUseReporterForTests();
  resetTestDb();
  vi.restoreAllMocks();
});

describe("use reporter", () => {
  it("backs off exponentially from 30 s, capped at an hour", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(20)).toBe(3_600_000);
  });

  it("reports only installed templates' uses older than 30 s — one notice per cloudId — and marks them reported", async () => {
    use("u1", "inst", NOW - REPORT_DELAY_MS - 1);
    use("u2", "inst", NOW - REPORT_DELAY_MS - 2);
    use("u3", "inst", NOW - 1_000); // too fresh
    use("u4", "local", NOW - 60_000); // never
    use("u5", "published", NOW - 60_000); // own published template used locally: the local row is origin local — never reported
    use("u6", "inst2", NOW - 60_000);
    const reportUse = vi.fn<Report>().mockResolvedValue({ ok: true });
    const r = await drainUseReports({ now: () => NOW, reportUse });
    expect(r).toEqual({ sent: 3, failed: 0, skipped: 0 });
    // The site counts one use per client per template per UTC day, so a second
    // notice for the same template in one drain could never count: one per cloudId.
    expect(reportUse.mock.calls.map((c) => c[0]).sort()).toEqual([CLOUD, CLOUD2]);
    expect(unreported()).toEqual(["u3", "u4", "u5"]);
    // Nothing left to send: the next drain sends nothing.
    reportUse.mockClear();
    expect(await drainUseReports({ now: () => NOW + 1_000, reportUse })).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(reportUse).not.toHaveBeenCalled();
  });

  it("a failing cloudId backs off as a group and is retried after the backoff", async () => {
    use("u1", "inst", NOW - 60_000);
    use("u2", "inst", NOW - 60_000);
    const reportUse = vi.fn<Report>().mockResolvedValue({ ok: false, error: "catalog answered 503", status: 503 });
    expect(await drainUseReports({ now: () => NOW, reportUse })).toEqual({ sent: 0, failed: 2, skipped: 0 });
    expect(reportUse).toHaveBeenCalledTimes(1);
    // A use of the same template made during the backoff waits with its group.
    use("u3", "inst", NOW - REPORT_DELAY_MS - 500);
    expect(await drainUseReports({ now: () => NOW + 1_000, reportUse })).toEqual({ sent: 0, failed: 0, skipped: 3 });
    expect(reportUse).toHaveBeenCalledTimes(1);
    // Another template is not held back by this one's backoff.
    use("other", "inst2", NOW - 60_000);
    reportUse.mockResolvedValue({ ok: true });
    expect(await drainUseReports({ now: () => NOW + 2_000, reportUse })).toEqual({ sent: 1, failed: 0, skipped: 3 });
    expect(reportUse).toHaveBeenLastCalledWith(CLOUD2);
    expect(await drainUseReports({ now: () => NOW + backoffMs(1) + 1, reportUse })).toEqual({ sent: 3, failed: 0, skipped: 0 });
    expect(unreported()).toEqual([]);
  });

  it("each further failure doubles the group's backoff, and a success resets it", async () => {
    const end = NOW + backoffMs(1) + backoffMs(2) + backoffMs(3);
    use("u1", "inst", NOW - 60_000);
    // Made later: too fresh for every drain below (used_at is whole seconds), but part of the group all along.
    use("u2", "inst", end - REPORT_DELAY_MS + 1_000);
    const reportUse = vi.fn<Report>().mockResolvedValue({ ok: false, error: "fetch failed" });
    let t = NOW;
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await drainUseReports({ now: () => t, reportUse })).toEqual({ sent: 0, failed: 1, skipped: 0 });
      expect(row("u1").reportAttempts).toBe(attempt);
      expect(row("u1").reportNextAt?.getTime()).toBe(t + backoffMs(attempt));
      expect(row("u2").reportAttempts).toBe(attempt);
      expect(await drainUseReports({ now: () => t + backoffMs(attempt) - 1, reportUse })).toEqual({ sent: 0, failed: 0, skipped: 1 });
      t += backoffMs(attempt);
    }
    expect(t).toBe(end);
    reportUse.mockResolvedValue({ ok: true });
    expect(await drainUseReports({ now: () => t, reportUse })).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(row("u2")).toMatchObject({ reported: false, reportAttempts: 0, reportNextAt: null });
  });

  it("gives up on uses older than 7 days without touching them", async () => {
    use("old", "inst", NOW - GIVE_UP_MS - 1);
    const reportUse = vi.fn<Report>().mockResolvedValue({ ok: true });
    expect(await drainUseReports({ now: () => NOW, reportUse })).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(reportUse).not.toHaveBeenCalled();
    expect(unreported()).toEqual(["old"]);
  });

  it("a failure or a success on a template never rewrites its uses older than 7 days", async () => {
    use("old", "inst", NOW - GIVE_UP_MS - 1);
    use("u1", "inst", NOW - 60_000);
    const reportUse = answering({ ok: false, error: "fetch failed" }, { ok: true });
    expect(await drainUseReports({ now: () => NOW, reportUse })).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(row("u1")).toMatchObject({ reportAttempts: 1 });
    expect(row("old")).toMatchObject({ reported: false, reportAttempts: 0, reportNextAt: null });
    expect(await drainUseReports({ now: () => NOW + backoffMs(1), reportUse })).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(row("old")).toMatchObject({ reported: false, reportAttempts: 0, reportNextAt: null });
  });

  it("a 404 not_found is done: the rows leave the queue and are never sent again", async () => {
    use("u1", "inst", NOW - 60_000);
    use("u2", "inst", NOW - 61_000);
    const reportUse = answering({ ok: false, status: 404, code: "not_found", error: "No such template." });
    expect(await drainUseReports({ now: () => NOW, reportUse })).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(unreported()).toEqual([]);
    expect(await drainUseReports({ now: () => NOW + GIVE_UP_MS / 2, reportUse })).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(reportUse).toHaveBeenCalledTimes(1);
    // The rows stay: they are the local use history (uses7d, useCount).
    expect(getDb().select().from(templateUses).all()).toHaveLength(2);
  });

  it("a 404 WITHOUT the site's not_found code (a proxy, a wrong base) is a failure, not done", async () => {
    use("u1", "inst", NOW - 60_000);
    const reportUse = answering({ ok: false, status: 404, error: "catalog answered 404" });
    expect(await drainUseReports({ now: () => NOW, reportUse })).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(unreported()).toEqual(["u1"]);
  });

  it("honours Retry-After on 503 contended: retried after exactly that, and contention is not a failed attempt", async () => {
    use("u1", "inst", NOW - 60_000);
    const reportUse = answering(
      { ok: false, status: 503, code: "contended", error: "busy", retryAfterMs: 5_000 },
      { ok: true },
    );
    expect(await drainUseReports({ now: () => NOW, reportUse })).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(row("u1")).toMatchObject({ reportAttempts: 0 });
    expect(await drainUseReports({ now: () => NOW + 4_999, reportUse })).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(await drainUseReports({ now: () => NOW + 5_000, reportUse })).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(reportUse).toHaveBeenCalledTimes(2);
  });

  it("honours Retry-After on any other refusal too, when it is longer than the backoff — capped at an hour", async () => {
    use("u1", "inst", NOW - 60_000);
    use("u2", "inst2", NOW - 60_000);
    const reportUse = vi.fn<Report>(async (id) =>
      id === CLOUD
        ? { ok: false, status: 429, code: "rate_limited", error: "slow down", retryAfterMs: 120_000 }
        : { ok: false, status: 503, code: "contended", error: "busy", retryAfterMs: 10 * 86_400_000 },
    );
    await drainUseReports({ now: () => NOW, reportUse });
    expect(row("u1").reportNextAt?.getTime()).toBe(NOW + 120_000);
    expect(row("u2").reportNextAt?.getTime()).toBe(NOW + 3_600_000);
  });

  it("the queue is the rows: a backoff survives a restart", async () => {
    use("u1", "inst", NOW - 60_000);
    const reportUse = vi.fn<Report>().mockResolvedValue({ ok: false, error: "fetch failed" });
    await drainUseReports({ now: () => NOW, reportUse });
    __resetUseReporterForTests(); // a new process: no in-memory state carries over
    expect(await drainUseReports({ now: () => NOW + 1_000, reportUse })).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(reportUse).toHaveBeenCalledTimes(1);
  });

  it("two drains at once (two processes on one LIBI_HOME) send each use once: a row is claimed before it is sent", async () => {
    use("u1", "inst", NOW - 60_000);
    use("u2", "inst2", NOW - 60_000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reportUse = vi.fn<Report>(async () => {
      await gate;
      return { ok: true };
    });
    const a = drainUseReports({ now: () => NOW, reportUse });
    const b = drainUseReports({ now: () => NOW, reportUse });
    await new Promise((r) => setTimeout(r, 0));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(reportUse).toHaveBeenCalledTimes(2);
    expect(reportUse.mock.calls.map((c) => c[0]).sort()).toEqual([CLOUD, CLOUD2]);
    expect(ra.sent + rb.sent).toBe(2);
    expect(unreported()).toEqual([]);
  });

  it("a row another process holds is skipped; a claim left by a crash expires and the row is sent", async () => {
    use("held", "inst", NOW - 60_000);
    getDb().update(templateUses).set({ reportNextAt: new Date(NOW + CLAIM_MS) }).where(eq(templateUses.id, "held")).run();
    const reportUse = vi.fn<Report>().mockResolvedValue({ ok: true });
    expect(await drainUseReports({ now: () => NOW, reportUse })).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(reportUse).not.toHaveBeenCalled();
    expect(await drainUseReports({ now: () => NOW + CLAIM_MS, reportUse })).toEqual({ sent: 1, failed: 0, skipped: 0 });
  });

  it("a claim outlives the slowest notice (the client's 15 s timeout, read cap included)", () => {
    expect(CLAIM_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("drains at most DRAIN_BATCH rows per pass, oldest first", async () => {
    for (let i = 0; i < DRAIN_BATCH + 5; i++) use(`u${String(i).padStart(2, "0")}`, "inst", NOW - 60_000 - (DRAIN_BATCH + 5 - i) * 1_000);
    const reportUse = vi.fn<Report>().mockResolvedValue({ ok: true });
    expect(await drainUseReports({ now: () => NOW, reportUse })).toEqual({ sent: DRAIN_BATCH, failed: 0, skipped: 0 });
    expect(unreported()).toEqual(["u20", "u21", "u22", "u23", "u24"]);
  });

  it("a notice that throws (a bug below) fails its group and the drain goes on", async () => {
    use("u1", "inst", NOW - 60_000);
    use("u2", "inst2", NOW - 60_000);
    const reportUse = vi.fn<Report>(async (id) => {
      if (id === CLOUD) throw new Error("boom");
      return { ok: true };
    });
    expect(await drainUseReports({ now: () => NOW, reportUse })).toEqual({ sent: 1, failed: 1, skipped: 0 });
    expect(row("u1")).toMatchObject({ reported: false, reportAttempts: 1 });
  });

  it("sends whether or not product analytics is on: nothing about analytics is read", async () => {
    const { setAnalyticsSettings } = await import("@/lib/db/settings");
    setAnalyticsSettings({ enabled: false });
    use("u1", "inst", NOW - 60_000);
    const reportUse = vi.fn<Report>().mockResolvedValue({ ok: true });
    expect(await drainUseReports({ now: () => NOW, reportUse })).toEqual({ sent: 1, failed: 0, skipped: 0 });
    const source = fs.readFileSync(path.join(process.cwd(), "lib/templates/cloud/use-reporter.ts"), "utf8");
    const imports = source.split("\n").filter((l) => /^import /.test(l)).join("\n");
    expect(imports).not.toMatch(/analytics|settings|test-mode/i);
    expect(source).not.toMatch(/process\.env|getAnalyticsSettings|ANALYTICS_/);
  });

  it("startUseReporter drains on the next turn and every DRAIN_INTERVAL_MS, never twice at a time; stopUseReporter stops it", async () => {
    const every = vi.spyOn(globalThis, "setInterval");
    const stop = vi.spyOn(globalThis, "clearInterval");
    use("u1", "inst", NOW - 60_000);
    use("u2", "inst2", NOW - 60_000);
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    const reportUse = vi.fn<Report>(async () => {
      await gate;
      return { ok: false, error: "fetch failed" };
    });
    let t = NOW;
    startUseReporter({ now: () => t, reportUse });
    startUseReporter({ now: () => t, reportUse }); // idempotent
    expect(every).toHaveBeenCalledTimes(1);
    // Nothing ran inside the call: boot's register() is not held up by the first pass's SQL.
    expect(row("u1").reportNextAt).toBeNull();
    const [tick, ms] = every.mock.calls[0];
    expect(ms).toBe(DRAIN_INTERVAL_MS);
    await vi.waitFor(() => expect(reportUse).toHaveBeenCalledTimes(1)); // the drain at start
    (tick as () => void)(); // a tick while that drain is still out: skipped
    release();
    await vi.waitFor(() => expect(row("u2").reportAttempts).toBe(1));
    expect(reportUse).toHaveBeenCalledTimes(2); // both groups, one drain
    gate = Promise.resolve();
    t += backoffMs(1);
    (tick as () => void)();
    await vi.waitFor(() => expect(reportUse).toHaveBeenCalledTimes(4));
    stopUseReporter();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stopUseReporter before the first pass runs cancels it", async () => {
    use("u1", "inst", NOW - 60_000);
    const reportUse = vi.fn<Report>().mockResolvedValue({ ok: true });
    startUseReporter({ now: () => NOW, reportUse });
    stopUseReporter();
    await new Promise((r) => setTimeout(r, 5));
    expect(reportUse).not.toHaveBeenCalled();
  });

  it("a drain that fails every pass warns once, then logs at debug until a pass succeeds", async () => {
    const { serverLogger } = await import("@/lib/logger");
    const warn = vi.spyOn(serverLogger, "warn").mockImplementation(() => undefined);
    const debug = vi.spyOn(serverLogger, "debug").mockImplementation(() => undefined);
    const failures = () => [...warn.mock.calls, ...debug.mock.calls].filter((c) => (c[0] as { op?: string }).op === "use_drain_failed").length;
    let broken = true;
    const reportUse = vi.fn<Report>().mockResolvedValue({ ok: true });
    const every = vi.spyOn(globalThis, "setInterval");
    startUseReporter({
      now: () => {
        if (broken) throw new Error("no such column: report_next_at");
        return NOW;
      },
      reportUse,
    });
    const tick = every.mock.calls[0][0] as () => void;
    await vi.waitFor(() => expect(failures()).toBe(1));
    tick();
    await vi.waitFor(() => expect(failures()).toBe(2));
    tick();
    await vi.waitFor(() => expect(failures()).toBe(3));
    const warned = () => warn.mock.calls.filter((c) => (c[0] as { op?: string }).op === "use_drain_failed").length;
    expect(warned()).toBe(1);
    broken = false;
    tick(); // a pass that succeeds (nothing due)
    await new Promise((r) => setTimeout(r, 5));
    broken = true;
    tick();
    await vi.waitFor(() => expect(failures()).toBe(4));
    expect(warned()).toBe(2); // a success in between: the next failure warns again
  });

  it("boot starts the reporter on its own, outside the analytics block, so an analytics failure cannot stop it", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "instrumentation.ts"), "utf8");
    const reporter = source.indexOf('import("./lib/templates/cloud/use-reporter")');
    expect(reporter).toBeGreaterThan(-1);
    const analyticsBlock = source.slice(source.indexOf("getOrCreateAnalyticsUserId, markAnalyticsMilestoneOnce"), source.indexOf("startAnalyticsDrain();"));
    expect(analyticsBlock).not.toContain("use-reporter");
    // Its own try, opened after the analytics block's catch.
    const between = source.slice(source.indexOf('op: "boot_init_failed"'), reporter);
    expect(between).toMatch(/try \{/);
  });
});

// Test mode and a normal boot share LIBI_HOME: a use goes only to the catalog
// it was made against, and only for a template installed from that catalog.
describe("use reporter — one catalog's uses never reach another", () => {
  const FIXTURE = "aaaaaaaaaaaaaaaaaaa2";
  function seedFixtureInstall() {
    getDb().insert(templates).values({ id: "fixture", name: "F", description: "", tags: "[]", origin: "installed", cloudId: FIXTURE, cloudSource: "test-mode", version: 1, hasCode: false, useCount: 0 }).run();
  }
  const sourced = (id: string, templateId: string, usedAt: number, source: string | null) =>
    getDb().insert(templateUses).values({ id, templateId, pieceId: null, usedAt: new Date(usedAt), reported: false, source }).run();
  afterEach(() => vi.unstubAllEnvs());

  it("in a normal boot, uses made in test mode are never reported to the real site — and stay, unreported", async () => {
    seedFixtureInstall();
    vi.stubEnv("LIBI_TEST_MODE", undefined);
    sourced("t1", "fixture", NOW - 60_000, "test-mode"); // a fixture template, used in test mode
    sourced("t2", "inst", NOW - 60_000, "test-mode"); // a real template, used in test mode
    sourced("n1", "inst2", NOW - 60_000, "https://libi.nagellabs.com"); // a real template, used in a normal boot
    const reportUse = vi.fn<Report>().mockResolvedValue({ ok: true });
    expect(await drainUseReports({ now: () => NOW, reportUse })).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(reportUse.mock.calls.map((c) => c[0])).toEqual([CLOUD2]);
    expect(unreported()).toEqual(["t1", "t2"]);
    // Kept as the local use history, never deleted.
    expect(row("t1").reportAttempts).toBe(0);
  });

  it("in test mode, only test-mode uses of fixture templates go to the fixture — never a real template's", async () => {
    seedFixtureInstall();
    vi.stubEnv("LIBI_TEST_MODE", "1");
    sourced("t1", "fixture", NOW - 60_000, "test-mode");
    sourced("t2", "inst", NOW - 60_000, "test-mode"); // a real template, used in test mode: nowhere to go
    sourced("n1", "inst2", NOW - 60_000, "https://libi.nagellabs.com"); // a normal boot's use: its own catalog's
    sourced("n2", "fixture", NOW - 60_000, "https://libi.nagellabs.com");
    const reportUse = vi.fn<Report>().mockResolvedValue({ ok: true });
    expect(await drainUseReports({ now: () => NOW, reportUse })).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(reportUse.mock.calls.map((c) => c[0])).toEqual([FIXTURE]);
    expect(unreported()).toEqual(["n1", "n2", "t2"]);
  });

  it("a use and a template recorded before the source existed count as the real catalog's", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    use("legacy", "inst", NOW - 60_000);
    const reportUse = vi.fn<Report>().mockResolvedValue({ ok: true });
    expect((await drainUseReports({ now: () => NOW, reportUse })).sent).toBe(0);
    vi.stubEnv("LIBI_TEST_MODE", undefined);
    expect((await drainUseReports({ now: () => NOW, reportUse })).sent).toBe(1);
    expect(reportUse.mock.calls.map((c) => c[0])).toEqual([CLOUD]);
  });
});

describe("a dev build with a production and a development catalog", () => {
  const PROD = "https://libi.nagellabs.com";
  const DEV = "https://libi-site-git-templates-nagellabs.vercel.app";
  const D = "dddddddddddddddddddd";
  let m: { setTemplatesCatalogSetting: typeof import("@/lib/db/settings").setTemplatesCatalogSetting; recordUse: typeof import("@/lib/templates/store").recordUse; catalogSource: () => string; resetDevBuild: () => void };
  const use = (choice: "production" | "development") => m.setTemplatesCatalogSetting({ choice, devOrigin: DEV, bypassToken: null });
  beforeEach(async () => {
    m = {
      setTemplatesCatalogSetting: (await import("@/lib/db/settings")).setTemplatesCatalogSetting,
      recordUse: (await import("@/lib/templates/store")).recordUse,
      catalogSource: (await import("@/lib/templates/cloud/catalog-source")).catalogSource,
      resetDevBuild: (await import("@/lib/templates/cloud/catalog-setting")).__resetDevBuildForTests,
    };
    m.resetDevBuild();
    getDb().insert(templates).values({ id: "devInst", name: "D", description: "", tags: "[]", origin: "installed", cloudId: D, cloudSource: DEV, version: 1, hasCode: false, useCount: 0 }).run();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    m.resetDevBuild();
  });
  /** What was reported, to which catalog. */
  const reporter = () => {
    const sent: Array<[string, string]> = [];
    const fn = vi.fn<Report>().mockImplementation(async (cloudId) => {
      sent.push([cloudId, m.catalogSource()]);
      return { ok: true };
    });
    return { fn, sent };
  };
  const age = () => getDb().update(templateUses).set({ usedAt: new Date(NOW - 60_000) }).run();

  it("a use of a template installed from Development is reported to Development — after switching to Production too", async () => {
    use("development");
    m.recordUse("devInst", null);
    use("production");
    m.recordUse("devInst", null);
    m.recordUse("inst", null); // installed from production
    expect(getDb().select().from(templateUses).all().map((u) => [u.templateId, u.source]).sort()).toEqual([
      ["devInst", DEV],
      ["devInst", DEV],
      ["inst", PROD],
    ]);
    age();
    const { fn, sent } = reporter();
    expect(await drainUseReports({ now: () => NOW, reportUse: fn })).toEqual({ sent: 3, failed: 0, skipped: 0 });
    expect(sent.sort()).toEqual([
      [CLOUD, PROD],
      [D, DEV],
    ]);
  });

  it("switching back and forth: every use still goes to its own catalog, and only there", async () => {
    for (const choice of ["production", "development", "production", "development"] as const) {
      use(choice);
      m.recordUse("devInst", null);
      m.recordUse("inst", null);
    }
    age();
    const { fn, sent } = reporter();
    expect(await drainUseReports({ now: () => NOW, reportUse: fn })).toEqual({ sent: 8, failed: 0, skipped: 0 });
    expect(sent.sort()).toEqual([
      [CLOUD, PROD],
      [D, DEV],
    ]);
    expect(unreported()).toEqual([]);
  });

  it("a packaged build never reports a development template's use (a copied database can't redirect it)", async () => {
    use("development");
    m.recordUse("devInst", null);
    m.recordUse("inst", null);
    age();
    vi.stubEnv("LIBI_RUNTIME_SOURCE", "bundled");
    m.resetDevBuild();
    const { fn, sent } = reporter();
    await drainUseReports({ now: () => NOW, reportUse: fn });
    expect(sent).toEqual([[CLOUD, PROD]]);
    expect(getDb().select().from(templateUses).all().filter((u) => !u.reported).map((u) => u.templateId)).toEqual(["devInst"]);
  });

  it("test mode records its own marker, so nothing it does reaches either real catalog", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    m.recordUse("devInst", null);
    m.recordUse("inst", null);
    expect(getDb().select().from(templateUses).all().map((u) => u.source)).toEqual(["test-mode", "test-mode"]);
    vi.stubEnv("LIBI_TEST_MODE", undefined);
    age();
    const { fn } = reporter();
    await drainUseReports({ now: () => NOW, reportUse: fn });
    expect(fn).not.toHaveBeenCalled();
  });
});
