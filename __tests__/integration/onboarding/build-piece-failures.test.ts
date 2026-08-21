/**
 * Rollback is the feature here, not a nicety.
 *
 * This runs during a brand-new user's first two minutes. If the network drops
 * at asset 14 of 21, what they must get is a clear "the demo could not be
 * downloaded" and an otherwise clean slate — not a half-built piece they can
 * neither escape nor make sense of. So every failure path asserts the same
 * three things: no piece row, no file rows, no storage directory.
 *
 * Fixtures come from docs-local/onboarding-v1/assets (gitignored). Skip with a
 * loud message rather than a silent pass when they are absent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createTempStorageDir, cleanupTempDir } from "../../helpers/test-storage";
import { createTestDb, resetTestDb } from "../../helpers/test-db";
import {
  startOnboardingAssetServer,
  haveOnboardingFixtures,
  missingFixturesMessage,
  type OnboardingAssetServer,
} from "../../helpers/onboarding-asset-server";
import { ONBOARDING_ASSETS_V1 } from "@/lib/onboarding/piece/v1/assets";
import type {
  OnboardingPieceParams,
  OnboardingPieceResult,
} from "@/lib/jobs/runners/onboarding-piece";

let storageRoot: string;

vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

/** The runner mints the piece it may have to delete, so the only way for a
 *  test to name the directory that must NOT survive is to watch `createPiece`
 *  hand the id out. */
let lastPieceId: string | null = null;
vi.mock("@/mcp/tools/piece-discovery-tools", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/mcp/tools/piece-discovery-tools")
  >();
  return {
    ...actual,
    createPiece: async (params: { name?: string; description?: string }) => {
      const res = await actual.createPiece(params);
      lastPieceId = (res.data as { id?: string } | undefined)?.id ?? null;
      return res;
    },
  };
});

const SLUGS = ONBOARDING_ASSETS_V1.map((a) => a.slug);
const HAVE_FIXTURES = haveOnboardingFixtures(SLUGS);
if (!HAVE_FIXTURES) process.stderr.write(`\n${missingFixturesMessage()}\n\n`);

let server: OnboardingAssetServer;
let closedPort: number;
let piecesBefore: number;
let filesBefore: number;

function pieceStorageDir(pieceId: string): string {
  return join(storageRoot, "storage", pieceId);
}

async function runRunner(params: OnboardingPieceParams): Promise<OnboardingPieceResult> {
  const { onboardingPieceRunner } = await import("@/lib/jobs/runners/onboarding-piece");
  return onboardingPieceRunner.run({
    jobId: `job-${Math.random().toString(36).slice(2)}`,
    params,
    resumeState: null,
    reportProgress: () => {},
    checkpoint: async () => {},
    shouldCancel: () => false,
  });
}

async function countPieces(): Promise<number> {
  const { getDb } = await import("@/lib/db/client");
  const { pieces } = await import("@/lib/db/schema/sqlite");
  return getDb().select().from(pieces).all().length;
}

async function countFiles(): Promise<number> {
  const { getDb } = await import("@/lib/db/client");
  const { files } = await import("@/lib/db/schema/sqlite");
  return getDb().select().from(files).all().length;
}

/** An ephemeral port that was bound and then released — nothing answers on it. */
async function reserveClosedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe.skipIf(!HAVE_FIXTURES)("onboarding piece build — failure paths", () => {
  beforeAll(async () => {
    storageRoot = createTempStorageDir();
    createTestDb();
    server = await startOnboardingAssetServer();
    closedPort = await reserveClosedPort();
  }, 60_000);

  afterAll(async () => {
    delete process.env.LIBI_ONBOARDING_ASSET_BASE;
    await server?.close();
    resetTestDb();
    cleanupTempDir();
  });

  beforeEach(async () => {
    server.reset();
    lastPieceId = null;
    process.env.LIBI_ONBOARDING_ASSET_BASE = server.baseEnvValue;
    piecesBefore = await countPieces();
    filesBefore = await countFiles();
  });

  it("leaves no piece behind when the base is unreachable", async () => {
    // Onboarding must be able to say "the demo could not be downloaded" and
    // move on. A half-piece is a dead end the user cannot get out of.
    process.env.LIBI_ONBOARDING_ASSET_BASE = `http://127.0.0.1:${closedPort}/x`;
    await expect(runRunner({ version: "v1", force: true })).rejects.toThrow();
    expect(await countPieces()).toBe(piecesBefore);
    expect(await countFiles()).toBe(filesBefore);
    expect(lastPieceId).not.toBeNull();
    expect(fs.existsSync(pieceStorageDir(lastPieceId!))).toBe(false);
  }, 60_000);

  it("hard-fails naming the slug when a hash does not match", async () => {
    server.serveCorruptedSlug("logo-mark.png");
    await expect(runRunner({ version: "v1", force: true })).rejects.toThrow(
      /logo-mark\.png/,
    );
    expect(await countPieces()).toBe(piecesBefore);
    expect(await countFiles()).toBe(filesBefore);
    expect(fs.existsSync(pieceStorageDir(lastPieceId!))).toBe(false);
  }, 120_000);

  it("rolls back a partial download", async () => {
    server.failAfterNFiles(5);
    await expect(runRunner({ version: "v1", force: true })).rejects.toThrow();
    // Five files really did land before the failure — otherwise this test
    // proves nothing about unwinding partial work.
    expect(server.servedCount()).toBe(5);
    expect(await countPieces()).toBe(piecesBefore);
    expect(await countFiles()).toBe(filesBefore);
    expect(fs.existsSync(pieceStorageDir(lastPieceId!))).toBe(false);
  }, 120_000);

  it("rolls back when the job is cancelled mid-download", async () => {
    // A cancel is a failure like any other: the user pressed Stop, and what
    // they must be left with is nothing, not three of twenty-one clips.
    const { onboardingPieceRunner } = await import("@/lib/jobs/runners/onboarding-piece");
    let done = 0;
    await expect(
      onboardingPieceRunner.run({
        jobId: "job-cancel",
        params: { version: "v1", force: true },
        resumeState: null,
        reportProgress: (n: number) => {
          done = n;
        },
        checkpoint: async () => {},
        shouldCancel: () => done >= 3,
      }),
    ).rejects.toThrow();
    expect(await countPieces()).toBe(piecesBefore);
    expect(await countFiles()).toBe(filesBefore);
    expect(fs.existsSync(pieceStorageDir(lastPieceId!))).toBe(false);
  }, 120_000);

  it("leaves nothing on disk at all — no orphan piece directories", () => {
    const dirs = fs.existsSync(join(storageRoot, "storage"))
      ? fs.readdirSync(join(storageRoot, "storage"))
      : [];
    expect(dirs).toEqual([]);
  });
});
