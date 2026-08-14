import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { chunkAudio, transcribeAudio } from "@/lib/analysis/manager";
import { getDb } from "@/lib/db/client";
import { files, analysisSteps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { hfCacheDirName, whisperModelsDir } from "@/lib/whisper/models";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-wint-"));
  process.env.LIBI_HOME = tmp;
  // Fake an installed `small` model so the needs_install gate passes.
  const snap = path.join(
    whisperModelsDir(),
    hfCacheDirName("small"),
    "snapshots",
    "r1",
  );
  fs.mkdirSync(snap, { recursive: true });
  fs.writeFileSync(path.join(snap, "model.bin"), "x");
  createTestDb();
});

afterEach(() => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("provider metadata on the aggregate", () => {
  it("stamps provider=whisper when whisper sttFn is injected", async () => {
    const db = getDb();
    const fileId = "f-int-1";
    await db
      .insert(files)
      .values({
        id: fileId,
        pieceId: null,
        filename: "a.wav",
        name: "a.wav",
        description: "",
        type: "audio",
        storagePath: "a.wav",
        mediaDuration: 2,
      })
      .run();

    await chunkAudio({ fileId, skipExtraction: true });

    const fakeStt = async () => ({
      text: "hello world",
      words: [
        { text: "hello", start: 0, end: 0.5, type: "word", speaker_id: null },
        { text: "world", start: 0.5, end: 1.0, type: "word", speaker_id: null },
      ],
      language_code: "en",
      language_probability: 0.99,
    });

    const res = await transcribeAudio({
      fileId,
      provider: "whisper",
      sttFn: fakeStt,
    });
    expect(res.status).toBe("ready");

    const [step] = db
      .select()
      .from(analysisSteps)
      .where(
        and(
          eq(analysisSteps.fileId, fileId),
          eq(analysisSteps.kind, "transcript"),
        ),
      )
      .limit(1)
      .all();
    const meta = JSON.parse(step.metadata!);
    expect(meta.provider).toBe("whisper");
    expect(meta.schema_version).toBe("transcript_v1");
  });
});
