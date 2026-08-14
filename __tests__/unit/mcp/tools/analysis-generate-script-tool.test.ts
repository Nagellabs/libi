import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { files, pieces, analysisSteps } from "@/lib/db/schema/sqlite";
import { getDb } from "@/lib/db/client";
import { extraAnalysisModel } from "@/mcp/tools/analysis-tools";
import {
  __resetScriptProviderRegistryForTests,
  registerScriptProvider,
} from "@/lib/analysis/script-providers/registry";
import type { Script } from "@/lib/analysis/types";

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

const runJobViaServerMock = vi.fn();

vi.mock("@/mcp/jobs-client", () => {
  class LibiServerUnavailableError extends Error {
    hint: string;
    constructor(message: string, hint = "start libi") {
      super(message);
      this.name = "LibiServerUnavailableError";
      this.hint = hint;
    }
  }
  return {
    runJobViaServer: (...args: unknown[]) => runJobViaServerMock(...args),
    LibiServerUnavailableError,
  };
});

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

function makeScript(): Script {
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

function makeProvider(id = "fake", model = "fake-1") {
  return {
    id,
    displayName: `Fake ${id}`,
    defaultModelId: model,
    async isConfigured() {
      return true;
    },
    async generate() {
      return { text: JSON.stringify(makeScript()), providerName: id, modelId: model };
    },
  };
}

async function seedFile(): Promise<string> {
  const db = getDb();
  const [piece] = await db.insert(pieces).values({ name: "test", description: "" }).returning();
  const [file] = await db
    .insert(files)
    .values({
      pieceId: piece.id,
      filename: "test.mp4",
      name: "test",
      description: "",
      type: "video",
      storagePath: "test.mp4",
    })
    .returning();
  return file.id;
}

// --------------------------------------------------------------------------
// Setup / teardown
// --------------------------------------------------------------------------

let fileId: string;

beforeEach(async () => {
  createTestDb();
  fileId = await seedFile();
  __resetScriptProviderRegistryForTests();
  registerScriptProvider(makeProvider());
  runJobViaServerMock.mockReset();
  runJobViaServerMock.mockResolvedValue({
    status: "new",
    jobId: "job-1",
    clientKey: "ck-1",
    result: { script: makeScript() },
  });
});

afterEach(() => {
  resetTestDb();
});

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("extraAnalysisModel MCP tool", () => {
  it("returns the script and enqueues the runner the first time", async () => {
    const result = await extraAnalysisModel({ fileId }, {});
    expect(result.success).toBe(true);
    expect(runJobViaServerMock).toHaveBeenCalledTimes(1);
    expect(runJobViaServerMock.mock.calls[0][0]).toBe("extra_analysis_model");
  });

  it("returns the cached script without enqueuing on a second call", async () => {
    const db = getDb();
    await db.insert(analysisSteps).values({
      fileId,
      kind: "script:fake:fake-1",
      status: "ready",
      content: JSON.stringify(makeScript()),
    });

    const result = await extraAnalysisModel({ fileId }, {});
    expect(result.success).toBe(true);
    expect(runJobViaServerMock).not.toHaveBeenCalled();
  });

  it("re-runs when regenerate: true even if cached", async () => {
    const db = getDb();
    await db.insert(analysisSteps).values({
      fileId,
      kind: "script:fake:fake-1",
      status: "ready",
      content: JSON.stringify(makeScript()),
    });

    const result = await extraAnalysisModel({ fileId, regenerate: true }, {});
    expect(result.success).toBe(true);
    expect(runJobViaServerMock).toHaveBeenCalledTimes(1);
    expect(
      (runJobViaServerMock.mock.calls[0][1] as { forceFresh?: boolean }).forceFresh,
    ).toBe(true);
  });

  it("returns a structured error when no providers are registered", async () => {
    __resetScriptProviderRegistryForTests();
    const result = await extraAnalysisModel({ fileId }, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no script provider|configured/i);
  });

  it("returns a structured error when provider is not configured", async () => {
    __resetScriptProviderRegistryForTests();
    registerScriptProvider({
      ...makeProvider(),
      async isConfigured() {
        return false;
      },
    });

    const result = await extraAnalysisModel({ fileId }, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not configured/i);
  });

  it("handles LibiServerUnavailableError", async () => {
    const { LibiServerUnavailableError } = await import("@/mcp/jobs-client");
    runJobViaServerMock.mockRejectedValue(
      new LibiServerUnavailableError("server down", "start libi server"),
    );

    const result = await extraAnalysisModel({ fileId }, {});
    expect(result.success).toBe(false);
    expect(result.error).toBe("libi_server_unavailable");
    expect((result.data as { hint?: string } | undefined)?.hint).toBe("start libi server");
  });
});
