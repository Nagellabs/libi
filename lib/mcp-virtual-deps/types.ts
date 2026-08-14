import type { DependencyStatus } from "@/lib/queries/mcp-servers";

/** A non-binary install gate that should surface as a chip in the
 *  Settings UI alongside binary deps. Examples: ACE-Step model weights,
 *  the librosa uv env, Whisper's faster-whisper env, etc.
 *
 *  The four states a chip can show (installed / installing / failed /
 *  pending) are already handled by components/settings/dependency-chip;
 *  we just need to provide the same data shape DependencyManager returns
 *  for binary deps. */
export interface VirtualDep {
  /** Stable id used as the chip key + the body of POST /retry-dep. */
  id: string;
  /** Chip label text. Keep terse — e.g. "ace-step weights (7.7 GB)". */
  label: string;
  /** Snapshot the current install state. Cheap (≤100 ms) — called per UI poll. */
  inspect(): Promise<DependencyStatus>;
  /** Kick off the install/re-warm. May delegate to a JobManager runner
   *  for progress streaming. Resolves on success, throws on failure. */
  install(): Promise<void>;
}
