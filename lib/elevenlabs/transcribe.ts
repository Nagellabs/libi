/**
 * Thin ElevenLabs speech-to-text wrapper that calls the HTTP API directly
 * and returns the full response including word-level timing.
 *
 * The bundled `elevenlabs-mcp` PyPI package discards `words[]`,
 * `language_code`, and `language_probability`. This module is the override
 * that preserves the complete response for video analysis transcript storage.
 */

import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscribeOptions {
  audioPath: string;
  modelId?: string; // default "scribe_v1"
  languageCode?: string; // ISO code, optional
  diarize?: boolean; // default false
  tagAudioEvents?: boolean; // default true
  numSpeakers?: number; // optional
  /** When provided, used directly — skips the DB lookup. Used by the
   *  golden-data generator which runs outside the app. */
  apiKey?: string;
}

export interface ElevenLabsWord {
  text: string;
  start: number;
  end: number;
  type?: "word" | "spacing" | "audio_event";
  speaker_id?: string | null;
}

export interface ElevenLabsTranscription {
  language_code: string;
  language_probability: number;
  text: string;
  words: ElevenLabsWord[];
}

// ---------------------------------------------------------------------------
// API key helper
// ---------------------------------------------------------------------------

/**
 * Read ELEVENLABS_API_KEY from the elevenlabs MCP server row's envVars JSON,
 * falling back to `process.env.ELEVENLABS_API_KEY` when the DB row is absent
 * or has no usable value. The env fallback lets contributors keep the key in
 * a top-level `.env.local` (auto-loaded by Next.js) without having to also
 * paste it into Settings → MCP Servers, and lets worktree processes inherit
 * it from the parent shell.
 *
 * Returns null when neither source produces a non-empty string.
 */
export async function getElevenLabsApiKey(): Promise<string | null> {
  const db = getDb();
  const [row] = db
    .select({ envVars: mcpServers.envVars })
    .from(mcpServers)
    .where(eq(mcpServers.id, "elevenlabs"))
    .limit(1)
    .all();

  if (row?.envVars) {
    try {
      const parsed = JSON.parse(row.envVars) as Record<string, unknown>;
      const key = parsed["ELEVENLABS_API_KEY"];
      if (typeof key === "string" && key.trim() !== "") return key.trim();
    } catch {
      /* malformed envVars JSON — fall through to env */
    }
  }

  const envKey = process.env.ELEVENLABS_API_KEY;
  if (typeof envKey === "string" && envKey.trim() !== "") return envKey.trim();

  return null;
}

// ---------------------------------------------------------------------------
// HTTP transcription
// ---------------------------------------------------------------------------

const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";

/**
 * POST audio file to ElevenLabs /v1/speech-to-text and return the parsed
 * full response (text + words + language).
 *
 * Throws an Error with a useful message if:
 *   - API key not configured
 *   - audioPath does not exist
 *   - HTTP response is non-2xx (includes status + body excerpt)
 *   - response JSON shape is unexpected (no `text` field)
 */
export async function transcribeAudio(
  opts: TranscribeOptions,
): Promise<ElevenLabsTranscription> {
  const apiKey = opts.apiKey ?? (await getElevenLabsApiKey());
  if (!apiKey) {
    throw new Error(
      "ELEVENLABS_API_KEY is not configured. Open Settings → MCP Servers → ElevenLabs to set it.",
    );
  }

  // Resolve and verify the audio file exists before reading
  const resolvedPath = path.resolve(opts.audioPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Audio file not found: ${resolvedPath}`,
    );
  }

  const audioBytes = fs.readFileSync(resolvedPath);
  const filename = path.basename(resolvedPath);

  // Build the multipart form data — let fetch set Content-Type + boundary
  const formData = new FormData();
  formData.append("file", new Blob([audioBytes]), filename);
  formData.append("model_id", opts.modelId ?? "scribe_v1");

  // Only append optional fields when explicitly provided to avoid sending
  // empty strings (ElevenLabs treats absence and empty string differently)
  if (opts.languageCode !== undefined) {
    formData.append("language_code", opts.languageCode);
  }
  if (opts.diarize !== undefined) {
    formData.append("diarize", String(opts.diarize));
  }
  // tagAudioEvents defaults to true to match bundled MCP behavior
  const tagAudioEvents = opts.tagAudioEvents ?? true;
  formData.append("tag_audio_events", String(tagAudioEvents));

  if (opts.numSpeakers !== undefined) {
    formData.append("num_speakers", String(opts.numSpeakers));
  }

  const res = await fetch(ELEVENLABS_STT_URL, {
    method: "POST",
    headers: {
      // Do NOT set Content-Type — fetch sets it with the multipart boundary
      "xi-api-key": apiKey,
    },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `ElevenLabs HTTP ${res.status}: ${body.slice(0, 500)}`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error("ElevenLabs returned a non-JSON response");
  }

  if (
    typeof json !== "object" ||
    json === null ||
    !("text" in json) ||
    typeof (json as Record<string, unknown>).text !== "string"
  ) {
    throw new Error(
      `ElevenLabs response missing expected 'text' field: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }

  const typed = json as ElevenLabsTranscription;

  // Ensure words is at least an empty array if absent
  if (!Array.isArray(typed.words)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (typed as unknown as Record<string, unknown>).words = [];
  }

  return typed;
}
