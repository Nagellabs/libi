import { mkdirSync } from "node:fs";
import { elevenlabsTestOutDir } from "@/lib/providers/elevenlabs-test-media";
import { studioBaseUrl } from "@/mcp/notify";

/** Where placeholders are written: `<LIBI_HOME>/test-mode/elevenlabs-out`, created on demand. */
export function resolveOutputDir(): string {
  const dir = elevenlabsTestOutDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The URL a placeholder is served at: the studio's test-mode route
 * (app/api/test-mode/elevenlabs), standing in for ElevenLabs' short-lived output URL.
 */
export function outputUrl(fileName: string): string {
  return `${studioBaseUrl() ?? "http://127.0.0.1:3456"}/api/test-mode/elevenlabs/out/${fileName}`;
}

/** The presigned PUT URL for an upload the fake started. */
export function uploadUrl(assetId: string): string {
  return `${studioBaseUrl() ?? "http://127.0.0.1:3456"}/api/test-mode/elevenlabs/upload/${assetId}`;
}
