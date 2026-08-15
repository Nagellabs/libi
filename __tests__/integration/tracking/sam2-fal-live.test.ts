/**
 * Live E2E integration test for the fal.ai SAM2 tracking backend.
 *
 * Gated by LIBI_FAL_LIVE_TEST=1 — will NOT run in CI or normal npm test.
 *
 * To run:
 *   LIBI_FAL_LIVE_TEST=1 npm test -- sam2-fal-live
 *
 * ## Verified contract (2026-05-14)
 *
 * This test was used to verify the following against the live fal.ai API:
 *
 *   - Model slug: "fal-ai/sam2/video" (confirmed correct via OpenAPI schema)
 *   - Auth header: "Authorization: Key <FAL_KEY>" (not Bearer)
 *   - Storage upload: POST /storage/upload/initiate?storage_type=fal-cdn-v3
 *     → { upload_url, file_url }, then PUT raw bytes to upload_url
 *   - Submit body: { video_url, box_prompts: [{x_min, y_min, x_max, y_max, frame_index}] }
 *     NOTE: "prompts" is for points ({x, y, label, frame_index}); box_prompts is separate.
 *     NOTE: No "fps" field in input schema.
 *   - Submit response: { request_id, status_url, response_url, cancel_url, status, ... }
 *   - Poll: GET status_url → { status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" }
 *     (FAILED not in schema but handled defensively)
 *   - Cancel: PUT cancel_url (not DELETE)
 *   - Result: GET response_url → { video: { url, content_type, file_name, file_size },
 *     boundingbox_frames_zip?: { url, ... } | null }
 *   - The video is a mask video (non-black pixels = tracked region on black background)
 *   - Per-frame bboxes extracted by decoding mask video with ffmpeg + scanning pixels (streaming)
 *   - Multi-anchor: all anchors submitted as separate box_prompts entries
 *
 * ## Cost
 *
 * Uses fal.ai's own example video (8s, publicly accessible) to keep cost low (~$0.05/run).
 * The test does NOT upload the real piece file — it substitutes the public example URL
 * after the upload step to avoid the cost and time of uploading+processing a 197s video.
 * The full upload code path is exercised separately in "upload round-trip" test.
 *
 * Total estimated cost per run: <$0.10 of fal.ai credits.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { files, mcpServers } from "@/lib/db/schema/sqlite";
import { getDb, migrateDatabase } from "@/lib/db/client";
import {
  runSam2FalBackend,
  type FalClient,
  type Sam2BackendParams,
} from "@/lib/tracking/sam2-fal-backend";
import type { JobContext } from "@/lib/jobs/types";

// ---------------------------------------------------------------------------
// Gate: skip unless explicitly opted in
// ---------------------------------------------------------------------------

const SHOULD_RUN = process.env.LIBI_FAL_LIVE_TEST === "1";

// Test piece that must exist in the libi SQLite DB at ~/.libi/libi.sqlite
const TEST_PIECE_ID = "28adee56-3120-4cac-93de-99e71df890c6";
// File confirmed in this piece as of 2026-05-14
const TEST_FILE_ID = "a113e948-27bd-4a49-8be1-ad2981297e4e";

// fal.ai's own example video — short (8s), publicly accessible, no upload needed.
// Used as the video_url to keep cost low and avoid uploading the 197s piece video.
// Confirmed working in live probe on 2026-05-14.
const FAL_EXAMPLE_VIDEO_URL = "https://drive.google.com/uc?id=1iOFYbNITYwrebBBp9kaEGhBndFSRLz8k";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve FAL_KEY using the same fallback chain as defaultLoadFalKey. */
async function resolveFalKey(): Promise<string | null> {
  // 1. Try DB row
  try {
    const db = getDb();
    const rows = await db.select().from(mcpServers).where(eq(mcpServers.id, "fal-ai")).limit(1);
    const row = rows[0];
    if (row?.envVars) {
      const env = JSON.parse(row.envVars) as Record<string, string>;
      if (env.FAL_KEY?.trim()) return env.FAL_KEY.trim();
    }
  } catch {
    // DB not available — fall through
  }
  // 2. Env fallback
  return process.env.FAL_AI_KEY ?? process.env.FAL_KEY ?? null;
}

function makeCtx(params: Sam2BackendParams): JobContext<Sam2BackendParams> {
  return {
    jobId: "live-test-job",
    params,
    resumeState: null,
    reportProgress: () => {},
    checkpoint: async () => {},
    shouldCancel: () => false,
  };
}

/**
 * Build a live FalClient that uses the real fal.ai queue/status/result APIs
 * but substitutes the upload step with a known public video URL to avoid
 * uploading and processing the 197-second piece video.
 */
function makeLiveFalClientWithPublicVideo(key: string): FalClient {
  const FAL_BASE = "https://queue.fal.run";

  return {
    // Skip upload — use the public example video URL directly
    async uploadFile(_bytes, _filename, _opts) {
      return { url: FAL_EXAMPLE_VIDEO_URL };
    },

    async submitJob(modelSlug, body, opts) {
      const res = await fetch(`${FAL_BASE}/${modelSlug}`, {
        method: "POST",
        headers: {
          Authorization: `Key ${opts.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`fal submit failed: ${res.status} ${await res.text()}`);
      }
      return res.json() as Promise<{
        request_id: string;
        status_url: string;
        response_url: string;
        cancel_url?: string;
      }>;
    },

    async pollStatus(statusUrl, opts) {
      const res = await fetch(statusUrl, {
        headers: { Authorization: `Key ${opts.key}` },
      });
      if (!res.ok) throw new Error(`fal poll failed: ${res.status}`);
      return res.json() as Promise<{ status: string; progress?: number }>;
    },

    async fetchResult(responseUrl, opts) {
      const res = await fetch(responseUrl, {
        headers: { Authorization: `Key ${opts.key}` },
      });
      if (!res.ok) throw new Error(`fal result failed: ${res.status}`);
      return res.json();
    },

    async cancel(cancelUrl, opts) {
      // PUT — verified 2026-05-14
      await fetch(cancelUrl, {
        method: "PUT",
        headers: { Authorization: `Key ${opts.key}` },
      }).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

if (!SHOULD_RUN)
  console.info(
    "[skip] sam2-fal live E2E — set LIBI_FAL_LIVE_TEST=1 to run (live fal.ai call: needs a FAL key and spends ~$0.10 of credits)",
  );

describe.skipIf(!SHOULD_RUN)("sam2-fal live E2E", () => {
  let falKey: string | null = null;

  beforeAll(async () => {
    // Ensure any pending DB migrations (including fal_uploaded_url column) are applied.
    try {
      migrateDatabase();
    } catch {
      // Already up to date — ignore.
    }
    falKey = await resolveFalKey();
  });

  it("resolves FAL_KEY from DB or env", () => {
    // If this fails, configure FAL_KEY in Settings → MCP Servers → fal-ai
    // OR set FAL_AI_KEY in .env.local / environment.
    expect(falKey).toBeTruthy();
    expect(typeof falKey).toBe("string");
    expect((falKey as string).length).toBeGreaterThan(10);
  });

  it(
    "runs full SAM2 E2E: submit → poll → result → bbox extract → TrackSamples",
    async () => {
      if (!falKey) return;

      const params: Sam2BackendParams = {
        fileId: TEST_FILE_ID,
        pieceId: TEST_PIECE_ID,
        fileUrl: `http://127.0.0.1:3000/api/files/by-id/${TEST_FILE_ID}/content`,
        fps: 25,
        objectKind: "object",
        anchors: [
          {
            fileId: TEST_FILE_ID,
            // t=0 → frame_index 0; bbox covers center ~30% of a 960×540 frame
            time: 0,
            bbox: [200, 100, 400, 300],
          },
        ],
      };

      // We need the file row to exist so the DB lookup in runSam2FalBackend succeeds.
      // Clear falUploadedUrl so our upload interception actually fires (otherwise the
      // backend would re-use the cached 197s WebM URL from a previous run).
      const db = getDb();
      const fileRows = await db.select().from(files).where(eq(files.id, TEST_FILE_ID)).limit(1);
      if (fileRows.length === 0) {
        console.warn(
          `Test file ${TEST_FILE_ID} not found in production DB. ` +
            "Start libi at least once with the 'Smiley Faces Overlay' piece to seed the file row.",
        );
        return;
      }

      // Clear the cached upload URL so the test FalClient's uploadFile is called.
      // This also resets the file for fresh validation of the upload code path.
      await db
        .update(files)
        .set({ falUploadedUrl: null })
        .where(eq(files.id, TEST_FILE_ID));

      const liveClient = makeLiveFalClientWithPublicVideo(falKey);
      const ctx = makeCtx(params);
      const startWall = Date.now();

      const result = await runSam2FalBackend(ctx, {
        falClient: liveClient,
        // loadFalKey not injected — uses real DB/env key
      });

      const wallMs = Date.now() - startWall;

      // -------------------------------------------------------------------
      // Assertions — verified contract 2026-05-14
      // -------------------------------------------------------------------

      // Must return samples (at least some visible)
      expect(result.samples.length).toBeGreaterThan(0);
      expect(result.framerate).toBe(25);

      const visibleSamples = result.samples.filter((s) => s.visible);
      expect(visibleSamples.length).toBeGreaterThan(0);

      const visibilityRatio = visibleSamples.length / result.samples.length;
      expect(visibilityRatio).toBeGreaterThan(0);

      // Visible samples have valid positive-dimension bboxes
      for (const s of visibleSamples.slice(0, 5)) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.w).toBeGreaterThan(0);
        expect(s.h).toBeGreaterThan(0);
        expect(s.confidence).toBeGreaterThan(0);
      }

      // Times are monotonically increasing
      for (let i = 1; i < result.samples.length; i++) {
        expect(result.samples[i].t).toBeGreaterThanOrEqual(result.samples[i - 1].t);
      }

      // Perf baseline (informational)
      console.log(
        [
          `SAM2 live E2E completed (2026-05-14 verified contract):`,
          `  model slug: fal-ai/sam2/video`,
          `  submit/poll/result shape: verified`,
          `  wall time: ${(wallMs / 1000).toFixed(1)}s`,
          `  total samples: ${result.samples.length}`,
          `  visible: ${visibleSamples.length} (${(visibilityRatio * 100).toFixed(0)}%)`,
          `  video: ${FAL_EXAMPLE_VIDEO_URL.slice(0, 50)}`,
        ].join("\n"),
      );
    },
    // SAM2 video jobs take 15-60s on fal.ai; add headroom for download + decode
    120_000,
  );

  it(
    "upload round-trip: storage initiate + PUT returns a working file_url",
    async () => {
      if (!falKey) return;

      // Verify the storage upload endpoint works with the correct ?storage_type=fal-cdn-v3 param
      const FAL_STORAGE = "https://rest.alpha.fal.ai";
      const initRes = await fetch(
        `${FAL_STORAGE}/storage/upload/initiate?storage_type=fal-cdn-v3`,
        {
          method: "POST",
          headers: {
            Authorization: `Key ${falKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ file_name: "probe-test.txt", content_type: "text/plain" }),
        },
      );
      expect(initRes.status).toBe(200);

      const initData = (await initRes.json()) as { upload_url?: string; file_url?: string };
      expect(typeof initData.upload_url).toBe("string");
      expect(typeof initData.file_url).toBe("string");

      // PUT a tiny payload to the upload_url
      const tinyPayload = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
      const putRes = await fetch(initData.upload_url!, {
        method: "PUT",
        body: tinyPayload,
      });
      expect(putRes.ok).toBe(true);

      // The file_url should now be accessible
      const fileRes = await fetch(initData.file_url!);
      expect(fileRes.ok).toBe(true);
    },
    30_000,
  );
});
