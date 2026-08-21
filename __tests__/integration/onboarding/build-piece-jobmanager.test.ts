/**
 * The seam the other two onboarding suites bypass.
 *
 * `build-piece.test.ts` and `build-piece-failures.test.ts` call
 * `onboardingPieceRunner.run()` directly, which is right for testing the build
 * itself but skips JobManager entirely — and JobManager is where `force` gets
 * interesting. `force` lives in `paramsSchema` (deliberately, see the runner's
 * module comment: a forced build produces a SEPARATE piece, so the two hashes
 * describe two genuinely different outputs). But `enqueue` returns
 * `matching_completed` for ANY terminal row with the same hash, so a second
 * `{ v1, force: true }` enqueue replays the first job's result and builds
 * nothing at all.
 *
 * That is not a bug in the runner — it is a REQUIREMENT ON ITS CALLER, and this
 * file is the executable statement of it: Task 5's `libi.build_onboarding_piece`
 * must pair `force: true` with `forceNew: true`.
 *
 * Fixtures come from docs-local/onboarding-v1/assets (gitignored). Skip with a
 * loud message rather than a silent pass when they are absent.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { join } from "node:path";
import { createTempStorageDir, cleanupTempDir } from "../../helpers/test-storage";
import { createTestDb, resetTestDb } from "../../helpers/test-db";
import {
  startOnboardingAssetServer,
  haveOnboardingFixtures,
  missingFixturesMessage,
  type OnboardingAssetServer,
} from "../../helpers/onboarding-asset-server";
import { ONBOARDING_ASSETS_V1 } from "@/lib/onboarding/piece/v1/assets";
import type { OnboardingPieceResult } from "@/lib/jobs/runners/onboarding-piece";

let storageRoot: string;

vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

// Progress notifications cross a process boundary in production; stub them so
// the manager can emit freely here.
vi.mock("@/mcp/notify", () => ({ notify: { jobProgress: vi.fn() } }));

const SLUGS = ONBOARDING_ASSETS_V1.map((a) => a.slug);
const HAVE_FIXTURES = haveOnboardingFixtures(SLUGS);
if (!HAVE_FIXTURES) process.stderr.write(`\n${missingFixturesMessage()}\n\n`);

let server: OnboardingAssetServer;

describe.skipIf(!HAVE_FIXTURES)("onboarding piece build — through JobManager", () => {
  beforeAll(async () => {
    storageRoot = createTempStorageDir();
    createTestDb();
    server = await startOnboardingAssetServer();
    process.env.LIBI_ONBOARDING_ASSET_BASE = server.baseEnvValue;
    const { __resetRunnerRegistryForTests, registerRunner } = await import(
      "@/lib/jobs/runners/registry"
    );
    const { onboardingPieceRunner } = await import("@/lib/jobs/runners/onboarding-piece");
    __resetRunnerRegistryForTests();
    registerRunner(onboardingPieceRunner);
  }, 60_000);

  afterAll(async () => {
    delete process.env.LIBI_ONBOARDING_ASSET_BASE;
    await server?.close();
    resetTestDb();
    cleanupTempDir();
  });

  it("a plain re-enqueue of force:true replays the old result and builds nothing", async () => {
    const { JobManager } = await import("@/lib/jobs/manager");
    const mgr = new JobManager();

    const first = await mgr.enqueue("onboarding_piece", { version: "v1", force: true });
    expect(first.status).toBe("new");
    if (first.status !== "new") throw new Error("expected new");
    const built = await mgr.runToCompletion<OnboardingPieceResult>(first.jobId);
    expect(built.reused).toBe(false);

    // Same params, no `forceNew`: the terminal row's hash matches, so the
    // caller is handed the previous result. No second piece exists.
    const servedBefore = server.servedCount();
    const second = await mgr.enqueue("onboarding_piece", { version: "v1", force: true });
    expect(second.status).toBe("matching_completed");
    if (second.status !== "matching_completed") throw new Error("expected matching_completed");
    expect(second.existingJob.jobId).toBe(first.jobId);
    expect(server.servedCount()).toBe(servedBefore);

    // The caller gets the FIRST job's result back verbatim — which is exactly
    // why a tool that means "rebuild" must not stop at `force: true`.
    const replayed = second.existingJob.result as OnboardingPieceResult;
    expect(replayed.pieceId).toBe(built.pieceId);
    expect(replayed.reused).toBe(false);
  }, 180_000);

  it("force:true PAIRED with forceNew really rebuilds — the Task 5 contract", async () => {
    const { JobManager } = await import("@/lib/jobs/manager");
    const { getDb } = await import("@/lib/db/client");
    const { pieces } = await import("@/lib/db/schema/sqlite");
    const mgr = new JobManager();

    const before = getDb().select({ id: pieces.id }).from(pieces).all().length;
    const forced = await mgr.enqueue(
      "onboarding_piece",
      { version: "v1", force: true },
      { forceNew: true },
    );
    expect(forced.status).toBe("new");
    if (forced.status !== "new") throw new Error("expected new");

    const rebuilt = await mgr.runToCompletion<OnboardingPieceResult>(forced.jobId);
    expect(rebuilt.reused).toBe(false);
    expect(rebuilt.assets).toBe(21);
    expect(getDb().select({ id: pieces.id }).from(pieces).all().length).toBe(before + 1);
  }, 180_000);

  it("reports progress through the manager, so the chat bridge has a denominator", async () => {
    const { JobManager } = await import("@/lib/jobs/manager");
    const mgr = new JobManager();
    // `force: false` — by now a built piece exists, so this is the dedupe path.
    const r = await mgr.enqueue("onboarding_piece", { version: "v1", force: false });
    if (r.status !== "new") throw new Error("expected new");
    const ticks: { done: number; total: number; unit: string }[] = [];
    const out = await mgr.runToCompletion<OnboardingPieceResult>(r.jobId, (p) =>
      ticks.push({ done: p.done, total: p.total, unit: p.unit }),
    );
    expect(out.reused).toBe(true);
    expect(ticks.at(-1)).toEqual({ done: 21, total: 21, unit: "files" });
  }, 60_000);
});
