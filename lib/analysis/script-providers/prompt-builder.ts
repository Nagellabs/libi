import { buildCaptionAnalysisPrompt } from "./caption-prompt";

/**
 * Builds the Gemini prompt asking for a script_v1 JSON output.
 *
 * The prompt is intentionally hand-written rather than schema-rendered:
 * a hand-written prompt with clear rules produces more reliable structured
 * output than a raw JSON-schema dump that the model has to translate.
 */
export function buildScriptPrompt(): string {
  return [
    "You are watching a video and producing a production script that another text-to-video model could use to recreate it.",
    "",
    "Output STRICTLY ONE JSON object with this shape. NO markdown fences. NO prose before or after. ONLY the JSON object.",
    "",
    "Schema (script_v1):",
    "{",
    '  "schema_version": "script_v1",',
    '  "duration": <number>,                        // seconds',
    '  "overall_style": "<one or two sentence look-and-feel summary>",',
    '  "pacing": "<optional short phrase>",',
    '  "shots": [                                   // chronological, non-overlapping, covers full duration',
    "    {",
    '      "index": <0-based>,',
    '      "start": <seconds>,',
    '      "end": <seconds>,',
    '      "description": "<detailed enough for a text-to-video model to recreate: subject, action, environment, lighting, framing, mood>",',
    '      "action": "<optional verb-phrase>",',
    '      "camera": { "shot": "close-up|medium|wide|extreme-wide", "angle": "eye-level|high|low|dutch", "motion": "static|pan|zoom|dolly|tracking|handheld|shake", "lens": "<optional>" },',
    '      "lighting": "<optional, e.g. golden hour, low key>",',
    '      "mood": "<optional>",',
    '      "dialogue": "<spoken in this shot, verbatim if heard>",',
    '      "text_on_screen": ["<optional>"],',
    '      "transition_out": "cut|fade|dissolve|wipe|match"',
    "    }",
    "  ],",
    '  "music": {                                   // required',
    '    "present": <true|false>,',
    '    "genre": "<optional>",',
    '    "mood": "<optional>",',
    '    "tempo": "<optional, e.g. fast ~130bpm>",',
    '    "instruments": ["<optional>"],',
    '    "cues": [ { "timestamp": <seconds>, "description": "<music change point>" } ]',
    "  },",
    '  "sound_design": [ { "timestamp": <seconds>, "description": "<notable non-music audio event>" } ],',
    '  "dialogue_summary": "<paraphrased; do NOT verbatim-transcribe long speeches>"',
    "}",
    "",
    "Rules:",
    "- Walk the video chronologically. Cut a new shot when there is a visible cut, hard music change, or location change.",
    "- start / end are seconds from the start of the clip. They must not overlap and must cover the full duration.",
    "- description must be detailed enough for a text-to-video model to recreate the shot WITHOUT seeing it.",
    "- music.present is false if no music plays; otherwise fill genre/mood/tempo/instruments as best you can hear.",
    "- sound_design lists notable non-music audio events with timestamps (knocks, footsteps, dings, ambient).",
    "- dialogue_summary is paraphrased; full speech goes in shot.dialogue when relevant.",
    "- overall_style summarizes look-and-feel in one or two sentences (cinematic / UGC / animated / cartoon / etc.).",
    "- pacing is one short phrase (e.g. fast cuts, 8s avg shot, slow contemplative single take).",
    "- Do NOT include a `provider` field. The caller fills that in.",
    "",
    "Output budget (so the JSON is never truncated):",
    "- Keep each shot.description ≤ 240 characters — dense, not flowery.",
    "- Merge adjacent near-identical shots. Aim for ≤ 16 shots total even for long videos.",
    "- Keep every other free-text field to one short phrase. The whole JSON must fit well under 5000 characters.",
    "",
    "Return only the JSON object — no markdown, no commentary.",
  ].join("\n");
}

/**
 * Truncate `text` to at most `budget` chars, keeping the head and tail (the
 * most diagnostically useful parts of a validation error) and inserting a
 * marker in the middle. Returns "" if the budget is non-positive.
 */
function boundText(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (text.length <= budget) return text;
  const marker = "\n…[error truncated]…\n";
  if (budget <= marker.length) return text.slice(0, budget);
  const keep = budget - marker.length;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

/**
 * Build the retry prompt after a first attempt failed validation. The
 * validation error can embed the model's (possibly long / truncated) output,
 * so we bound the embedded error to whatever budget remains under the
 * provider's prompt-length cap. Without this, the retry call to
 * fal-ai/video-understanding is rejected with HTTP 422
 * ("String should have at most 5000 characters") *before* it bills — so a bad
 * first response permanently blocks the analysis.
 *
 * When `maxChars` is undefined the prompt is returned unbounded (providers
 * with no declared cap).
 */
export function buildRetryPrompt(
  basePrompt: string,
  validationError: string,
  maxChars?: number,
): string {
  const header =
    "\n\nYour previous output failed validation with the following errors:\n";
  const footer =
    "\n\nReturn ONLY valid JSON conforming to script_v1 this time. NO markdown, NO commentary.";

  let error = validationError;
  if (typeof maxChars === "number" && maxChars > 0) {
    const margin = 64; // stay safely under the hard cap
    const budget = maxChars - basePrompt.length - header.length - footer.length - margin;
    error = boundText(validationError, budget);
  }

  return basePrompt + header + error + footer;
}

/** Selects the analysis prompt by focus. "captions" → per-caption recreation
 *  spec (free-form); anything else (incl. undefined) → full production script. */
export function pickAnalysisPrompt(focus?: "script" | "captions"): string {
  return focus === "captions" ? buildCaptionAnalysisPrompt() : buildScriptPrompt();
}
