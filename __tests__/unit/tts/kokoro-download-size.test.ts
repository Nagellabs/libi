import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  KOKORO_DOWNLOAD_MB,
  KOKORO_MODEL_BYTES,
  KOKORO_VOICES_BYTES,
} from "@/lib/tts/model-size";
import { KOKORO_MODEL_URL, KOKORO_VOICES_URL } from "@/lib/tts/voices";
import { findProvider } from "@/lib/providers/catalog";

/**
 * Kokoro's download size was stated in three places by hand and they
 * disagreed: `lib/providers/catalog.ts` said "~350 MB" (the size of the
 * full-precision `kokoro-v1.0.onnx`, which libi never downloads), while
 * `lib/tts/synthesize.ts` and the agent manual said "~110 MB". The catalog's
 * copy is the one rendered on the extension's card — in the chat's provider
 * suggestion card and on the Agents page — i.e. the number a user reads
 * BEFORE deciding to install, so the wrong one was the one that mattered.
 *
 * The real figure comes from the two files `fetchModelFiles()` fetches:
 * 92,361,271 + 28,214,398 B = ~121 MB. `lib/tts/model-size.ts` is now the one
 * source; this test is what stops the copies drifting from it again — the
 * catalog's note is a template literal, the prose ones cannot be, so they are
 * checked as text.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Prose copies of the figure. Each must state the current number and none may
 *  carry either superseded one. */
const PROSE_COPIES = [
  "mcp/templates/instructions.md",
  "mcp/bundled-mcps/plans/local-tts.md",
  "lib/tts/synthesize.ts",
  "lib/jobs/runners/tts-model-download.ts",
];

describe("Kokoro download size — one source, no drift", () => {
  it("derives the MB figure from the two files the fetcher actually downloads", () => {
    // The INT8 model, not the full-precision one: `~350 MB` was the fp32
    // `kokoro-v1.0.onnx`, which no URL here points at.
    expect(KOKORO_MODEL_URL).toContain("kokoro-v1.0.int8.onnx");
    expect(KOKORO_VOICES_URL).toContain("voices-v1.0.bin");
    expect(KOKORO_DOWNLOAD_MB).toBe(
      Math.round((KOKORO_MODEL_BYTES + KOKORO_VOICES_BYTES) / 1_000_000),
    );
    expect(KOKORO_DOWNLOAD_MB).toBe(121);
  });

  it("the catalog note the Providers tab renders states that same figure", () => {
    const note = findProvider("kokoro").sizeNote ?? "";
    expect(note).toContain(`~${KOKORO_DOWNLOAD_MB} MB`);
    expect(note).not.toContain("350 MB");
  });

  it("every prose copy agrees, and neither superseded figure survives anywhere", () => {
    for (const rel of PROSE_COPIES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8");
      expect(text, `${rel} should state ~${KOKORO_DOWNLOAD_MB} MB`).toContain(
        `~${KOKORO_DOWNLOAD_MB} MB`,
      );
      expect(text, `${rel} still carries a stale Kokoro size`).not.toMatch(
        /~1?10 MB|~350 MB/,
      );
    }
  });

  it("the agent-facing tool description carries the figure too", () => {
    // Read as text rather than through `createLibiMcpServer()`: registering the
    // whole server pulls in the DB and every tool module for one string.
    const server = fs.readFileSync(path.join(REPO_ROOT, "mcp/server.ts"), "utf-8");
    const idx = server.indexOf('"libi.tts_download_model"');
    expect(idx).toBeGreaterThan(-1);
    const registration = server.slice(idx, idx + 1500);
    expect(registration).toContain("${KOKORO_DOWNLOAD_MB} MB");
  });
});
