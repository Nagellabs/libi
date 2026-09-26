import fs from "node:fs";
import { SocialError } from "@/lib/social/errors";

/**
 * A cheap identity for the BYTES at `p` — size plus last-modified, the usual
 * stat fingerprint, as a string.
 *
 * This is part of the `social-upload` job's params, which is how that job
 * dedupes (JobManager hashes params): the same export uploads ONCE and every
 * later pass reuses it, while a re-export to the same path — the file changed
 * underneath an unchanged path — hashes differently and uploads again.
 *
 * Yes, it embeds a timestamp, and `AGENTS.md` says not to put timestamps in a
 * `paramsSchema`. That rule is about TRANSIENT values (a toolCallId, a
 * sessionId, `Date.now()`) which differ on every call and therefore DEFEAT
 * dedupe. This is the opposite: it is a property of the file, stable for as
 * long as the file is, and it is what makes dedupe CORRECT here. Without it
 * the choice was re-upload always (three permanent, undeletable media objects
 * for one 1.3 MB export in eight minutes — QA 2026-09-21, finding 5) or reuse
 * always (post to the provider with last week's render).
 */
export function exportFingerprint(p: string): string {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw new SocialError("validation", "that export file could not be found");
  }
  return `${st.size}-${Math.round(st.mtimeMs)}`;
}
