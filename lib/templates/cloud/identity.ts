import { createHash, randomBytes } from "node:crypto";

// One definition, in the dependency-free rules module the UI can import too.
export { CREATOR_KEY_PATTERN } from "@/lib/templates/cloud/author-rules";

/** 256 random bits, base64url, no padding — 43 chars. Generated on this machine, never sent except as a bearer. */
export function generateCreatorKey(): string {
  return randomBytes(32).toString("base64url");
}

/** Must equal libi-site lib/templates/creator-key.ts#authorIdFromKey. */
export function authorIdFromKey(key: string): string {
  return createHash("sha256").update(key).digest("base64url");
}
