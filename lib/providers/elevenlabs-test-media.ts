/**
 * Test mode's stand-in for ElevenLabs' media hosting, behind the studio's own
 * `/api/test-mode/elevenlabs/*` (app/api/test-mode/elevenlabs).
 *
 * ElevenLabs' hosted MCP returns a generation as a short-lived output URL, and
 * takes a local file through a presigned PUT URL (`creative_create_asset_upload`,
 * then `creative_finalize_asset_upload`). The test-mode fake
 * (mcp/dev/fake-elevenlabs) is a stdio child with no HTTP server of its own,
 * so the studio serves both ends for it, and the agent walks the same path it
 * walks against ElevenLabs: download the output URL, PUT the upload's bytes.
 *
 *   GET  out/<file>          a placeholder the fake wrote under
 *                            <LIBI_HOME>/test-mode/elevenlabs-out/ (an mp3
 *                            generation, a transcript's .txt, or an uploaded
 *                            file's copy that a transcript names as its source)
 *   PUT  upload/<asset id>   the bytes of an upload the fake started; like a
 *                            presigned URL, the Content-Type must be exactly the
 *                            mime_type the upload was started with (403 otherwise)
 *
 * Outside test mode every method on every path answers a bare 404 (the route
 * checks that before calling in here). Names are checked against a strict
 * pattern, so nothing outside those two folders can be named.
 */
import fs from "node:fs";
import path from "node:path";
import { getLibiHome } from "@/lib/libi-home";

/** A placeholder file name the fake writes: letters, digits, `_`, `-`, one extension. */
const OUT_FILE = /^[A-Za-z0-9_-]{1,120}\.(wav|mp3|txt)$/;
/** An asset id the fake mints. */
export const FAKE_ASSET_ID = /^asset_fake_[a-f0-9]{16}$/;
/** Well above any audio a skill uploads; a presigned URL has a ceiling too. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

const CONTENT_TYPE: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", txt: "text/plain; charset=utf-8" };

export function elevenlabsTestOutDir(): string {
  return path.join(getLibiHome(), "test-mode", "elevenlabs-out");
}

export function elevenlabsTestUploadDir(): string {
  return path.join(getLibiHome(), "test-mode", "elevenlabs-uploads");
}

/** What `creative_create_asset_upload` was told, kept beside the upload for the PUT and the finalize. */
export interface UploadExpectation {
  mime_type: string;
  file_size: number;
  name: string;
}

export function uploadExpectationPath(assetId: string): string {
  return path.join(elevenlabsTestUploadDir(), `${assetId}.json`);
}

export function uploadBytesPath(assetId: string): string {
  return path.join(elevenlabsTestUploadDir(), `${assetId}.bin`);
}

export interface MediaResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const text = (status: number, message: string): MediaResponse => ({
  status,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body: Buffer.from(message),
});

function readExpectation(assetId: string): UploadExpectation | null {
  try {
    return JSON.parse(fs.readFileSync(uploadExpectationPath(assetId), "utf8")) as UploadExpectation;
  } catch {
    return null;
  }
}

export function handleElevenLabsTestMedia(
  method: string,
  segments: string[],
  body: Buffer,
  headers: Record<string, string>,
): MediaResponse {
  const [area, name, ...rest] = segments;
  if (!name || rest.length > 0) return text(404, "Not found");

  if (area === "out") {
    if (method !== "GET" && method !== "HEAD") return text(405, "Method not allowed");
    if (!OUT_FILE.test(name)) return text(404, "Not found");
    const file = path.join(elevenlabsTestOutDir(), name);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return text(404, "Not found");
    }
    const ext = name.slice(name.lastIndexOf(".") + 1);
    return { status: 200, headers: { "content-type": CONTENT_TYPE[ext], "content-length": String(bytes.length) }, body: bytes };
  }

  if (area === "upload") {
    if (method !== "PUT") return text(405, "Method not allowed");
    if (!FAKE_ASSET_ID.test(name)) return text(404, "Not found");
    const expected = readExpectation(name);
    if (!expected) return text(404, "No upload was started for this asset.");
    const contentType = headers["content-type"] ?? "";
    // A presigned URL is signed over the Content-Type: any other value is refused.
    if (contentType !== expected.mime_type) {
      return text(403, `SignatureDoesNotMatch: Content-Type must be exactly "${expected.mime_type}", got "${contentType}".`);
    }
    if (body.length > MAX_UPLOAD_BYTES) return text(413, "Upload too large.");
    fs.writeFileSync(uploadBytesPath(name), body);
    // The live upload URL is a GCS resumable session: a good PUT answers 200 with the stored object.
    const stored = Buffer.from(JSON.stringify({
      kind: "storage#object",
      name: `content_asset/${name}/${expected.name}`,
      bucket: "fake-elevenlabs",
      contentType: expected.mime_type,
      size: String(body.length),
    }));
    return { status: 200, headers: { "content-type": "application/json; charset=UTF-8", "content-length": String(stored.length) }, body: stored };
  }

  return text(404, "Not found");
}
