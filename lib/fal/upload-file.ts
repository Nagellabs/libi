/**
 * Server-side helper: upload a LOCAL libi file to fal.ai storage and return a
 * fal CDN URL. Runs in the Next.js server process where the FAL key already
 * resolves — the agent NEVER handles the key.
 *
 * The fal CDN URL is persisted on `files.falUploadedUrl` so repeat calls are
 * free (no re-upload). Mirrors the two-step upload + cache pattern used by
 * `lib/tracking/sam2-fal-backend.ts` and
 * `lib/analysis/script-providers/fal-video-understanding.ts`.
 */

import { promises as fs } from "fs";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files, mcpServers } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { serverLogger as logger } from "@/lib/logger";

const FAL_STORAGE_URL = "https://rest.alpha.fal.ai";

/**
 * Resolve the fal.ai API key.
 *
 * Resolution order (first non-empty value wins):
 *   1. DB: mcp_servers row id="fal-ai", envVars JSON field "FAL_KEY"
 *   2. process.env.FAL_AI_KEY
 *   3. process.env.FAL_KEY
 *
 * Throws Error("fal_ai_not_configured") if none is found.
 */
export async function loadFalKey(): Promise<string> {
  // --- Try DB row first (production path) ---
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "fal-ai"))
      .limit(1);
    const row = rows[0];
    if (row?.envVars) {
      const env = JSON.parse(row.envVars) as Record<string, string>;
      const key = env.FAL_KEY;
      if (key && key.trim()) return key.trim();
    }
  } catch {
    // DB may not be available (tests, CLI mode) — fall through to env.
  }

  // --- Env fallback (dev ergonomics) ---
  const envKey = process.env.FAL_AI_KEY ?? process.env.FAL_KEY;
  if (envKey && envKey.trim()) return envKey.trim();

  throw new Error("fal_ai_not_configured");
}

export interface FalUploadResult {
  url: string;
  cached: boolean;
}

/**
 * Upload the libi file identified by `fileId` to fal.ai storage and return a
 * fal CDN URL. Cached via `files.falUploadedUrl` — a second call for the same
 * file returns `{ cached: true }` without contacting fal.
 *
 * @throws Error("file_not_found") when no file row matches `fileId`.
 * @throws Error("fal_ai_not_configured") when the FAL key cannot be resolved.
 */
export async function uploadLibiFileToFal(fileId: string): Promise<FalUploadResult> {
  const db = getDb();

  const rows = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
  const file = rows[0];
  if (!file) {
    throw new Error("file_not_found");
  }

  // Cache hit: reuse the persisted URL.
  if (typeof file.falUploadedUrl === "string" && file.falUploadedUrl.length > 0) {
    logger.info(
      { tag: "fal-upload", op: "upload.cache_hit", fileId, url: file.falUploadedUrl },
      "Using persisted fal.ai storage URL (skipping re-upload)",
    );
    return { url: file.falUploadedUrl, cached: true };
  }

  const storage = await getStorage();
  const localPath = storage.localPath(file.pieceId, file.filename);

  const key = await loadFalKey();
  const contentType = file.contentType ?? "application/octet-stream";

  logger.info(
    { tag: "fal-upload", op: "upload.start", fileId, pieceId: file.pieceId },
    "Uploading libi file to fal.ai storage",
  );

  // Step 1: initiate — get a signed upload URL + the public file URL.
  const initRes = await fetch(
    `${FAL_STORAGE_URL}/storage/upload/initiate?storage_type=fal-cdn-v3`,
    {
      method: "POST",
      headers: {
        Authorization: `Key ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file_name: file.filename, content_type: contentType }),
    },
  );
  if (!initRes.ok) {
    const body = await initRes.text().catch(() => "");
    throw new Error(
      `fal storage initiate failed: ${initRes.status} ${body.slice(0, 300)}`,
    );
  }
  const { upload_url, file_url } = (await initRes.json()) as {
    upload_url: string;
    file_url: string;
  };

  // Step 2: PUT the raw bytes to the signed upload URL.
  const bytes = await fs.readFile(localPath);
  const putRes = await fetch(upload_url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
    },
    body: bytes,
  });
  if (!putRes.ok) {
    const body = await putRes.text().catch(() => "");
    throw new Error(
      `fal storage upload PUT failed: ${putRes.status} ${body.slice(0, 300)}`,
    );
  }

  // Persist the CDN URL so future calls skip re-upload.
  await db.update(files).set({ falUploadedUrl: file_url }).where(eq(files.id, fileId));

  logger.info(
    { tag: "fal-upload", op: "upload.done", fileId, url: file_url },
    "libi file uploaded to fal.ai storage",
  );

  return { url: file_url, cached: false };
}
