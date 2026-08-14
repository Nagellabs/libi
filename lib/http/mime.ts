import path from "node:path";

/**
 * Shared MIME-type map for local-file routes.
 *
 * Kept intentionally small — only extensions libi actually serves from
 * disk (uploaded media, model bundles, generated assets). Anything not
 * listed falls back to `application/octet-stream`.
 */
export const MIME_TYPES: Record<string, string> = {
  // audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  // video
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  // images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  // scripts / data
  ".js": "application/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  // model weights / opaque binaries
  ".bin": "application/octet-stream",
  ".tflite": "application/octet-stream",
  ".onnx": "application/octet-stream",
};

export function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}
