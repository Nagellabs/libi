import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLibiHome } from "@/lib/libi-home";

/** One line of `<LIBI_HOME>/test-mode/elevenlabs-calls.jsonl`, which the skill-eval harness reads. */
export interface ElevenLabsCall {
  tool: string;
  /** The arguments exactly as the agent sent them (a `where: "input.<field> …"` matcher reads these). */
  input?: unknown;
  voice_id?: string;
  model_id?: string;
  node_type?: string;
  /** The EFFECTIVE count: what the agent passed, else the hosted default of 4. */
  generations_count?: number;
  estimate_only?: boolean;
  flow_id?: string;
  node_id?: string;
  session_ids?: string[];
  asset_id?: string;
  /** The audio URLs a finished status poll handed back (its `media[].url`). */
  output_urls?: string[];
  prompt?: string;
  /** Set when the fake refused the call, with the message it answered. */
  rejected?: true;
  error?: string;
}

export function elevenlabsRecordPath(): string {
  return join(getLibiHome(), "test-mode", "elevenlabs-calls.jsonl");
}

/** Append one JSON line per fake-elevenlabs tool call. Best-effort; never throws. */
export function recordCall(call: ElevenLabsCall): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...call }) + "\n";
  try {
    mkdirSync(join(getLibiHome(), "test-mode"), { recursive: true });
    appendFileSync(elevenlabsRecordPath(), line);
  } catch {
    // recording is diagnostic; swallow so a generation never fails on it
  }
}
