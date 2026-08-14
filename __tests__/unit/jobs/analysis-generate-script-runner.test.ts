import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { files, analysisSteps } from "@/lib/db/schema/sqlite";
import { extraAnalysisModelRunner } from "@/lib/jobs/runners/extra-analysis-model";
import {
  __resetScriptProviderRegistryForTests,
  registerScriptProvider,
} from "@/lib/analysis/script-providers/registry";
import type { Script } from "@/lib/analysis/types";

// ----------------------------------------------------------------------------
// DB mock — must be module-level so vitest hoists it before imports.
// ----------------------------------------------------------------------------

let db: ReturnType<typeof createTestDb>;

vi.mock("@/lib/db/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/db/client")>(
      "@/lib/db/client",
    );
  return { ...actual, getDb: () => db };
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeCtx(params: ExtraAnalysisModelParams): MockCtx {
  return {
    jobId: "job-1",
    params,
    resumeState: null,
    abortSignal: new AbortController().signal,
    reportProgress: vi.fn(),
    checkpoint: vi.fn(async () => {}),
    shouldCancel: () => false,
  };
}

type ExtraAnalysisModelParams = {
  fileId: string;
  providerId: string;
  modelId: string;
  pieceId?: string | null;
  forceFresh?: boolean;
};

type MockCtx = {
  jobId: string;
  params: ExtraAnalysisModelParams;
  resumeState: null;
  abortSignal: AbortSignal;
  reportProgress: ReturnType<typeof vi.fn>;
  checkpoint: ReturnType<typeof vi.fn>;
  shouldCancel: () => boolean;
};

function validScript(): Script {
  return {
    schema_version: "script_v1",
    duration: 5,
    overall_style: "cinematic",
    shots: [{ index: 0, start: 0, end: 5, description: "shot" }],
    music: { present: false },
    provider: {
      name: "fake",
      model: "fake-1",
      generatedAt: "2026-05-25T00:00:00.000Z",
    },
  };
}

function seedFile(): void {
  db.insert(files)
    .values({
      id: "file-1",
      pieceId: null,
      filename: "test.mp4",
      name: "test",
      description: "",
      type: "video",
      storagePath: "_global/test.mp4",
      mediaDuration: 5,
      mediaWidth: 1920,
      mediaHeight: 1080,
    } as Parameters<typeof db.insert>[0] extends never
      ? never
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        any)
    .run();
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("extraAnalysisModelRunner", () => {
  beforeEach(() => {
    db = createTestDb();
    seedFile();
    __resetScriptProviderRegistryForTests();
  });

  afterEach(() => {
    resetTestDb();
    vi.unstubAllEnvs();
  });

  it("F6: in test mode, returns a placeholder WITHOUT calling the provider (no real spend)", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");

    const generate = vi.fn(async () => {
      throw new Error("provider.generate must NOT be called in test mode");
    });
    registerScriptProvider({
      id: "fake",
      displayName: "Fake",
      defaultModelId: "fake-1",
      async isConfigured() {
        return true;
      },
      generate,
    });

    const result = await (extraAnalysisModelRunner as unknown as {
      run: (ctx: MockCtx) => Promise<{ script: Script }>;
    }).run(makeCtx({ fileId: "file-1", providerId: "fake", modelId: "fake-1" }));

    // The provider's generate (the real-spend path) was never invoked.
    expect(generate).not.toHaveBeenCalled();

    // The returned script is the marked, valid placeholder.
    expect(result.script.schema_version).toBe("script_v1");
    expect(result.script.shots.length).toBeGreaterThanOrEqual(1);
    expect(result.script.overall_style).toMatch(/TEST MODE/i);
    expect(result.script.custom?.testModePlaceholder).toBe(true);
    expect(result.script.provider.costUsd).toBe(0);

    // It was persisted through the normal path.
    const persisted = db.select().from(analysisSteps).all();
    expect(persisted.some((s) => s.kind === "script:fake:fake-1")).toBe(true);
  });

  it("calls the provider, validates, saves, and returns the script", async () => {
    const script = validScript();

    registerScriptProvider({
      id: "fake",
      displayName: "Fake",
      defaultModelId: "fake-1",
      async isConfigured() {
        return true;
      },
      async generate() {
        return {
          text: JSON.stringify(script),
          providerName: "fake",
          modelId: "fake-1",
        };
      },
    });

    const result = await (extraAnalysisModelRunner as unknown as {
      run: (ctx: MockCtx) => Promise<{ script: Script }>;
    }).run(makeCtx({ fileId: "file-1", providerId: "fake", modelId: "fake-1" }));

    expect(result.script.shots).toHaveLength(1);

    const persisted = db.select().from(analysisSteps).all();
    expect(persisted.some((s) => s.kind === "script:fake:fake-1")).toBe(true);
  });

  it("throws when provider returns invalid JSON twice", async () => {
    let calls = 0;

    registerScriptProvider({
      id: "fake",
      displayName: "Fake",
      defaultModelId: "fake-1",
      async isConfigured() {
        return true;
      },
      async generate() {
        calls += 1;
        return {
          text: `not json attempt ${calls}`,
          providerName: "fake",
          modelId: "fake-1",
        };
      },
    });

    await expect(
      (extraAnalysisModelRunner as unknown as {
        run: (ctx: MockCtx) => Promise<{ script: Script }>;
      }).run(makeCtx({ fileId: "file-1", providerId: "fake", modelId: "fake-1" })),
    ).rejects.toThrow();

    expect(calls).toBe(2);
  });

  it("recovers when first attempt fails validation and second attempt succeeds", async () => {
    let calls = 0;
    const script = validScript();

    registerScriptProvider({
      id: "fake",
      displayName: "Fake",
      defaultModelId: "fake-1",
      async isConfigured() {
        return true;
      },
      async generate(input) {
        calls += 1;
        if (calls === 1) {
          return {
            text: "still not json",
            providerName: "fake",
            modelId: "fake-1",
          };
        }
        // Second call: prompt should contain error details and retry language.
        expect(input.promptInstructions).toMatch(
          /previous output|invalid|retry/i,
        );
        return {
          text: JSON.stringify(script),
          providerName: "fake",
          modelId: "fake-1",
        };
      },
    });

    const result = await (extraAnalysisModelRunner as unknown as {
      run: (ctx: MockCtx) => Promise<{ script: Script }>;
    }).run(makeCtx({ fileId: "file-1", providerId: "fake", modelId: "fake-1" }));

    expect(result.script.shots).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
