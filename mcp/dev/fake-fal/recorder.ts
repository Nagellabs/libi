import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLibiHome } from "@/lib/libi-home";

export interface FakeFalCall {
  tool: string;
  endpoint_id?: string;
  /** Resolved canonical endpoint_id (set when the literal id was an alias). */
  canonical_endpoint_id?: string;
  /** Present (always `true`) when the endpoint_id is not in the KB. Absent = known. */
  unknown_endpoint?: true;
  input?: unknown;
  pieceId?: string | null;
  request_id?: string;
}

export function fakeFalRecordPath(): string {
  return join(getLibiHome(), "test-mode", "fal-calls.jsonl");
}

/** Append one JSON line per fake-fal tool call. Best-effort; never throws to the caller path. */
export function recordCall(call: FakeFalCall): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...call }) + "\n";
  const path = fakeFalRecordPath();
  try {
    mkdirSync(join(getLibiHome(), "test-mode"), { recursive: true });
    appendFileSync(path, line);
  } catch {
    // recording is diagnostic; swallow so a generation never fails on it
  }
}
