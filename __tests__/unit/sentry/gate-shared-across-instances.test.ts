/**
 * The crash-report gate must be ONE answer per process, not one per bundle
 * chunk.
 *
 * Found by running the real thing rather than by reading it. In a production
 * `next build`, with the DSN pointed at a local sink and NO browser involved:
 *
 *   * opt out at runtime via the Privacy toggle, idle 70s → 4 envelopes still
 *     left the machine: two full transactions, a client report, and an
 *     aggregate session.
 *   * boot the same server with the choice already `"off"` in the DB → ZERO.
 *
 * So the gate itself works; the runtime WRITE never reached the reader. The
 * build emits two server chunks containing `shouldSendCrashReports` — the API
 * route that writes the choice, and the Sentry config whose transport gate and
 * `beforeSend*` scrubbers read it — and with module-level state each held its
 * own copy. `PUT /api/settings/crash-reports` carries a comment saying that
 * without its `setCrashReportChoice` call "the running server would keep
 * sending crash reports until restart"; that is precisely what happened WITH
 * it.
 *
 * The Privacy tab tells the user the switch takes effect immediately, so this
 * is a promise, not just a bug. Same defect and same remedy as G1
 * (`lib/server/lifecycle/relaunch.ts`): a `globalThis` slot, which is
 * process-wide by construction.
 *
 * `vi.resetModules()` is what a second bundle chunk looks like from inside a
 * test — a fresh module instance in the same process.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/sentry/config", () => ({
  SENTRY_ENABLED: true,
  SENTRY_KILL_SWITCHED: false,
  SENTRY_DSN: "https://x@example.ingest.sentry.io/1",
  SENTRY_ENVIRONMENT: "test",
}));

beforeEach(() => {
  vi.resetModules();
  delete (globalThis as unknown as Record<string, unknown>).__libiCrashReportGate;
});

/** Two independent instances of the module, as two chunks would produce. */
async function twoInstances() {
  const writer = await import("@/lib/sentry/enabled");
  vi.resetModules();
  const reader = await import("@/lib/sentry/enabled");
  expect(writer, "resetModules did not produce a distinct instance").not.toBe(reader);
  return { writer, reader };
}

describe("the gate is shared across module instances", () => {
  it("an opt-out written through one instance closes the gate in the other", async () => {
    const { writer, reader } = await twoInstances();
    expect(reader.shouldSendCrashReports()).toBe(true); // default-on, as disclosed
    writer.setCrashReportChoice("off");
    expect(
      reader.shouldSendCrashReports(),
      "this is the transport gate + beforeSend hooks reading what the API route wrote",
    ).toBe(false);
  });

  it("re-enabling propagates the same way", async () => {
    const { writer, reader } = await twoInstances();
    writer.setCrashReportChoice("off");
    expect(reader.shouldSendCrashReports()).toBe(false);
    writer.setCrashReportChoice("on");
    expect(reader.shouldSendCrashReports()).toBe(true);
  });

  it("the kill switch propagates too", async () => {
    const { writer, reader } = await twoInstances();
    writer.setServerKillSwitch(true);
    expect(reader.getServerKillSwitch()).toBe(true);
    expect(reader.shouldSendCrashReports()).toBe(false);
  });

  // The revision counter guards the reconcile ordering hazard. Split across
  // instances it would compare a snapshot from one counter against another,
  // making the guard either always-fire or never-fire depending on which
  // instance ran first.
  it("the reconcile revision counter is shared", async () => {
    const { writer, reader } = await twoInstances();
    const rev = reader.getCrashReportChoiceRevision();
    writer.setCrashReportChoice("off");
    expect(reader.getCrashReportChoiceRevision()).toBe(rev + 1);
    // A reconcile holding the PRE-write snapshot must decline, exactly as it
    // would within a single instance.
    expect(reader.reconcileCrashReportChoice("on", rev)).toBe(false);
    expect(reader.getCrashReportChoice()).toBe("off");
  });
});
