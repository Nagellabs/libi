import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import {
  serializeAiGenerationMeta,
  type AiGenerationMeta,
} from "@/lib/ai-generation/types";

// ---------------------------------------------------------------------------
// Mocks — must come before route-handler imports
// ---------------------------------------------------------------------------

let testDb: ReturnType<typeof createTestDb>;

vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

// Replace the cost-fetcher registry with a controllable fake so we don't hit
// the real fal billing API or depend on FAL_KEY being in the test DB.
import type { CostFetchOutcome } from "@/lib/providers/cost-outcome";
const fakeFetchResult = {
  value: { kind: "pending" } as CostFetchOutcome | Error,
};
const fetcherCalls: Array<{ providerJobId: string; generatedAt?: string }> = [];
vi.mock("@/lib/ai-generation/cost-fetchers", () => ({
  registerBuiltinAiGenerationCostFetchers: vi.fn(),
  getCostFetcher: vi.fn((provider: string) => {
    if (provider === "no-fetcher-here") return null;
    return async (input: { providerJobId: string; generatedAt?: string }) => {
      fetcherCalls.push(input);
      if (fakeFetchResult.value instanceof Error) throw fakeFetchResult.value;
      return fakeFetchResult.value;
    };
  }),
}));

vi.mock("@/lib/navigation-events", () => ({
  navigationEmitter: { emit: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Import the handler AFTER mocks are wired
// ---------------------------------------------------------------------------

import { POST } from "@/app/api/files/by-id/[fileId]/generation/refresh-cost/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedGeneratedFile(
  id: string,
  pieceId: string | null,
  meta: AiGenerationMeta | null,
): void {
  testDb
    .insert(files)
    .values({
      id,
      pieceId,
      filename: `${id}.mp4`,
      name: id,
      description: "",
      type: "video",
      storagePath: pieceId ? `${pieceId}/${id}.mp4` : `_global/${id}.mp4`,
      contentType: "video/mp4",
      size: 1,
      mediaDuration: 5,
      mediaWidth: 720,
      mediaHeight: 1280,
      hasAudio: false,
      proxyFilename: null,
      proxyStatus: "idle",
      proxyGeneratedAt: null,
      falUploadedUrl: null,
      notes: null,
      aiGeneration: serializeAiGenerationMeta(meta),
      createdAt: new Date(),
    })
    .run();
}

const baseMeta: AiGenerationMeta = {
  provider: "fal-ai",
  model: "veo3.1-fast",
  prompt: "a cat dancing",
  costEstimate: { amount: 0.5, currency: "USD", tier: "veo3.1-fast/720p/9:16" },
  startedAt: "2026-05-27T10:00:00.000Z",
  completedAt: "2026-05-27T10:00:40.000Z",
  durationMs: 40_000,
  providerJobId: "req_abc123",
};

/** The union of JSON fields the refresh-cost route returns. */
type RefreshCostBody = {
  status?: string;
  error?: string;
  hint?: string;
  aiGeneration?: { costActual?: Record<string, unknown> };
};

async function callRoute(fileId: string): Promise<{ status: number; body: RefreshCostBody }> {
  const req = new Request("http://localhost/x", { method: "POST" });
  const ctx = { params: Promise.resolve({ fileId }) };
  const resp = await POST(req, ctx);
  return { status: resp.status, body: await resp.json() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/files/by-id/[fileId]/generation/refresh-cost", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb, { id: "p1" });
    fakeFetchResult.value = { kind: "pending" };
    fetcherCalls.length = 0;
  });

  it("returns file_not_found when the file row is missing", async () => {
    const { status, body } = await callRoute("missing-id");
    expect(status).toBe(404);
    expect(body.error).toBe("file_not_found");
  });

  it("returns no_meta when aiGeneration is null", async () => {
    seedGeneratedFile("f1", "p1", null);
    const { status, body } = await callRoute("f1");
    expect(status).toBe(200);
    expect(body.status).toBe("no_meta");
  });

  it("returns no_request_id when providerJobId is missing", async () => {
    const { providerJobId: _drop, ...metaNoJobId } = baseMeta;
    seedGeneratedFile("f2", "p1", metaNoJobId);
    const { status, body } = await callRoute("f2");
    expect(status).toBe(200);
    expect(body.status).toBe("no_request_id");
  });

  it("returns no_provider_fetch_support when fetcher missing for provider", async () => {
    seedGeneratedFile("f3", "p1", { ...baseMeta, provider: "no-fetcher-here" });
    const { status, body } = await callRoute("f3");
    expect(status).toBe(200);
    expect(body.status).toBe("no_provider_fetch_support");
  });

  it("returns already_resolved when costActual is already set", async () => {
    seedGeneratedFile("f4", "p1", {
      ...baseMeta,
      costActual: {
        amount: 0.42,
        currency: "USD",
        tier: "veo3.1-fast/720p/9:16",
        source: "tool",
      },
    });
    const { status, body } = await callRoute("f4");
    expect(status).toBe(200);
    expect(body.status).toBe("already_resolved");
  });

  it("resolves and writes costActual when the fetcher resolves an amount", async () => {
    seedGeneratedFile("f5", "p1", baseMeta);
    fakeFetchResult.value = { kind: "resolved", amountUsd: 0.47 };
    const { status, body } = await callRoute("f5");
    expect(status).toBe(200);
    expect(body.status).toBe("resolved");
    expect(body.aiGeneration?.costActual).toEqual({
      amount: 0.47,
      currency: "USD",
      tier: "veo3.1-fast/720p/9:16",
      source: "tool",
    });

    // Verify the DB row was updated in place
    const [row] = testDb.select().from(files).where(eq(files.id, "f5")).all();
    const persisted = JSON.parse(row.aiGeneration!);
    expect(persisted.costActual.amount).toBe(0.47);
  });

  it("passes the generation timestamp to the fetcher (bounds fal's 24h-default billing window)", async () => {
    seedGeneratedFile("f5b", "p1", baseMeta);
    fakeFetchResult.value = { kind: "pending" };
    await callRoute("f5b");
    expect(fetcherCalls).toHaveLength(1);
    expect(fetcherCalls[0].generatedAt).toBe(baseMeta.completedAt);
  });

  it("returns still_pending when the fetcher reports pending (does not write)", async () => {
    seedGeneratedFile("f6", "p1", baseMeta);
    fakeFetchResult.value = { kind: "pending" };
    const { status, body } = await callRoute("f6");
    expect(status).toBe(200);
    expect(body.status).toBe("still_pending");

    const [row] = testDb.select().from(files).where(eq(files.id, "f6")).all();
    const persisted = JSON.parse(row.aiGeneration!);
    expect(persisted.costActual).toBeUndefined();
  });

  it("returns provider_permission_denied with a hint when the fetcher is forbidden (does not write)", async () => {
    seedGeneratedFile("f7", "p1", baseMeta); // provider: fal-ai
    fakeFetchResult.value = {
      kind: "forbidden",
      message: "needs an ADMIN-scoped key",
    };
    const { status, body } = await callRoute("f7");
    expect(status).toBe(200);
    expect(body.status).toBe("provider_permission_denied");
    expect(body.hint).toBe("needs an ADMIN-scoped key");

    const [row] = testDb.select().from(files).where(eq(files.id, "f7")).all();
    const persisted = JSON.parse(row.aiGeneration!);
    expect(persisted.costActual).toBeUndefined();
  });

  it("surfaces provider_fetch_failed (502) when the fetcher reports an error outcome", async () => {
    seedGeneratedFile("f7b", "p1", baseMeta);
    fakeFetchResult.value = {
      kind: "error",
      status: 500,
      message: "fal billing API returned HTTP 500",
    };
    const { status, body } = await callRoute("f7b");
    expect(status).toBe(502);
    expect(body.error).toBe("provider_fetch_failed");
  });

  it("treats fake-ai-assets 0 as free (and writes costActual)", async () => {
    seedGeneratedFile("f8", "p1", {
      ...baseMeta,
      provider: "fake-ai-assets",
      model: "test-mode",
      costEstimate: { amount: 0, currency: "USD", tier: "test-mode" },
    });
    const { status, body } = await callRoute("f8");
    expect(status).toBe(200);
    expect(body.status).toBe("free");
    expect(body.aiGeneration?.costActual).toEqual({
      amount: 0,
      currency: "USD",
      tier: "test-mode",
      source: "tool",
    });
  });

  it("surfaces provider_fetch_failed (502) when fetcher throws", async () => {
    seedGeneratedFile("f9", "p1", baseMeta);
    fakeFetchResult.value = new Error("fal timed out");
    const { status, body } = await callRoute("f9");
    expect(status).toBe(502);
    expect(body.error).toBe("provider_fetch_failed");
  });
});
