import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLibiHome } from "@/lib/libi-home";

export interface FakeZernioCall {
  tool: string;
  /** How the name was dispatched — direct, or through the `call_tool` hop. */
  via?: "direct" | "call_tool";
  input?: unknown;
  post_id?: string;
  /** `metadata.libi.requestId` when the caller stamped one. */
  request_id?: string;
  /** Present (always `true`) when the call was refused. */
  rejected?: true;
}

export function fakeZernioRecordPath(): string {
  return join(getLibiHome(), "test-mode", "zernio-calls.jsonl");
}

/** Append one JSON line per fake-zernio tool call. Best-effort; never throws to the caller path. */
export function recordCall(call: FakeZernioCall): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...call }) + "\n";
  try {
    mkdirSync(join(getLibiHome(), "test-mode"), { recursive: true });
    appendFileSync(fakeZernioRecordPath(), line);
  } catch {
    // recording is diagnostic; swallow so a call never fails on it
  }
}
