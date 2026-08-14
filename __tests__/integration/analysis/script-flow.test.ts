import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { files, analysisSteps } from "@/lib/db/schema/sqlite";
import {
  extraAnalysisModelRunner,
  type ExtraAnalysisModelParams,
} from "@/lib/jobs/runners/extra-analysis-model";
import type { JobContext } from "@/lib/jobs/types";
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

function makeCtx(
  params: ExtraAnalysisModelParams,
): JobContext<ExtraAnalysisModelParams> {
  return {
    jobId: "job-1",
    params,
    resumeState: null,
    reportProgress: () => {},
    checkpoint: async () => {},
    shouldCancel: () => false,
  };
}

function validScript(): Script {
  return {
    schema_version: "script_v1",
    duration: 8,
    overall_style: "documentary",
    shots: [
      { index: 0, start: 0, end: 4, description: "intro" },
      { index: 1, start: 4, end: 8, description: "outro" },
    ],
    music: { present: true, genre: "ambient", mood: "calm" },
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
      filename: "video.mp4",
      name: "video",
      description: "",
      type: "video",
      storagePath: "_global/video.mp4",
      mediaDuration: 8,
      mediaWidth: 1920,
      mediaHeight: 1080,
    })
    .run();
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("end-to-end script flow", () => {
  beforeEach(() => {
    db = createTestDb();
    seedFile();
    __resetScriptProviderRegistryForTests();
    registerScriptProvider({
      id: "fake",
      displayName: "Fake",
      defaultModelId: "fake-1",
      async isConfigured() {
        return true;
      },
      async generate() {
        return {
          text: JSON.stringify(validScript()),
          providerName: "fake",
          modelId: "fake-1",
        };
      },
    });
  });

  afterEach(() => {
    resetTestDb();
  });

  it("runs end-to-end: runner → validator → DB row visible to analysis_get-style query", async () => {
    const result = await extraAnalysisModelRunner.run(
      makeCtx({ fileId: "file-1", providerId: "fake", modelId: "fake-1" }),
    );

    expect(result.script?.shots).toHaveLength(2);

    const steps = db.select().from(analysisSteps).all();
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("script:fake:fake-1");
    expect(steps[0].status).toBe("ready");
    expect(JSON.parse(steps[0].content!).schema_version).toBe("script_v1");
  });

  it("re-running with the same provider+model overwrites the row", async () => {
    await extraAnalysisModelRunner.run(
      makeCtx({ fileId: "file-1", providerId: "fake", modelId: "fake-1" }),
    );

    await extraAnalysisModelRunner.run(
      makeCtx({ fileId: "file-1", providerId: "fake", modelId: "fake-1" }),
    );

    const steps = db.select().from(analysisSteps).all();
    expect(steps).toHaveLength(1);
  });

  it("registering a second provider stores a parallel row", async () => {
    registerScriptProvider({
      id: "fake2",
      displayName: "Fake 2",
      defaultModelId: "fake2-x",
      async isConfigured() {
        return true;
      },
      async generate() {
        return {
          text: JSON.stringify(validScript()),
          providerName: "fake2",
          modelId: "fake2-x",
        };
      },
    });

    await extraAnalysisModelRunner.run(
      makeCtx({ fileId: "file-1", providerId: "fake", modelId: "fake-1" }),
    );

    await extraAnalysisModelRunner.run(
      makeCtx({ fileId: "file-1", providerId: "fake2", modelId: "fake2-x" }),
    );

    const steps = db.select().from(analysisSteps).all();
    expect(steps.map((s) => s.kind).sort()).toEqual([
      "script:fake2:fake2-x",
      "script:fake:fake-1",
    ]);
  });
});
