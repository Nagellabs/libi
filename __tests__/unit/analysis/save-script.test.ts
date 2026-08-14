import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, resetTestDb } from "../../helpers/test-db";
import { files, pieces } from "@/lib/db/schema/sqlite";
import { getDb } from "@/lib/db/client";
import { saveScript } from "@/lib/analysis/manager";
import type { Script } from "@/lib/analysis/types";

beforeEach(() => {
  createTestDb();
});

afterEach(() => {
  resetTestDb();
});

function makeScript(): Script {
  return {
    schema_version: "script_v1",
    duration: 10,
    overall_style: "cinematic",
    shots: [{ index: 0, start: 0, end: 10, description: "shot a" }],
    music: { present: false },
    provider: {
      name: "fal-video-understanding",
      model: "gemini-2.5-pro",
      generatedAt: "2026-05-25T00:00:00.000Z",
    },
  };
}

async function seedFile(): Promise<string> {
  const db = getDb();
  const [piece] = await db.insert(pieces).values({ name: "test", description: "" }).returning();
  const [file] = await db.insert(files).values({
    pieceId: piece.id,
    filename: "test.mp4",
    name: "test",
    description: "",
    type: "video",
    storagePath: "test.mp4",
  }).returning();
  return file.id;
}

describe("saveScript", () => {
  it("inserts a script:{provider}:{model} step row", async () => {
    const fileId = await seedFile();
    const script = makeScript();
    const step = await saveScript({
      fileId,
      providerId: "fal-video-understanding",
      modelId: "gemini-2.5-pro",
      script,
    });

    expect(step.kind).toBe("script:fal-video-understanding:gemini-2.5-pro");
    expect(step.status).toBe("ready");
    expect(JSON.parse(step.content!)).toMatchObject({ schema_version: "script_v1" });
  });

  it("overwrites an existing row for the same (fileId, providerId, modelId)", async () => {
    const fileId = await seedFile();
    await saveScript({
      fileId,
      providerId: "fal-video-understanding",
      modelId: "gemini-2.5-pro",
      script: makeScript(),
    });

    const updated = { ...makeScript(), overall_style: "documentary" };
    const step = await saveScript({
      fileId,
      providerId: "fal-video-understanding",
      modelId: "gemini-2.5-pro",
      script: updated,
    });

    expect(JSON.parse(step.content!).overall_style).toBe("documentary");
  });

  it("creates a parallel row for a different model", async () => {
    const fileId = await seedFile();
    await saveScript({
      fileId,
      providerId: "fal-video-understanding",
      modelId: "gemini-2.5-pro",
      script: makeScript(),
    });
    const stepB = await saveScript({
      fileId,
      providerId: "fal-video-understanding",
      modelId: "gemini-2.5-flash",
      script: makeScript(),
    });
    expect(stepB.kind).toBe("script:fal-video-understanding:gemini-2.5-flash");
  });
});
