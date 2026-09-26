import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseScenario } from "@/scripts/skill-eval/scenario";
import { evaluate } from "@/scripts/skill-eval/assertions";
import type { TranscriptView } from "@/scripts/skill-eval/types";

/**
 * The ElevenLabs transcription scenarios' hard invariants have to be able to FAIL. 02's honest-refusal needle is a
 * regex over the agent's own words. Its first version ended its negation list in `[Nn]o` with no word boundary, so
 * the agent's opening narration ("Now let me … speaker labels") satisfied it and the refusal went unchecked
 * (G5 review I1). These cases run the scenario's REAL matcher over agent text.
 */

function load(file: string) {
  const path = `skill-eval/scenarios/audio-analysis/${file}`;
  return parseScenario(readFileSync(join(process.cwd(), path), "utf8"), path);
}

/** A one-turn transcript whose agent text is `agentText`; the user's prompt (which names speaker labels) is outside it. */
function view(agentText: string, extra = ""): TranscriptView {
  const all = `### [0] user\n\ntranscribe it with speaker labels using my ElevenLabs\n\n### [1] assistant\n\n${agentText}\n\n${extra}`;
  return { full: all, agentText, turns: [{ all, agentText }] };
}

describe("audio-analysis/02 — the honest-refusal needle", () => {
  const scenario = load("02-elevenlabs-no-speaker-labels.md");
  const needle = scenario.assertions.find((a) => a.transcript_matches !== undefined)!;
  const passes = (text: string) => evaluate([], [needle], view(text))[0].pass;

  it("is scoped to the agent's own words", () => {
    expect(needle).toMatchObject({ scope: "agent_text", expect: "present" });
  });

  it.each([
    "The connected ElevenLabs can't label speakers — its transcription returns plain text only.",
    "Your ElevenLabs can’t tell speakers apart.",
    "ElevenLabs cannot identify speakers on this server.",
    "It doesn't return speaker labels or word timings.",
    "It returns plain text with no speaker labels.",
    "It gives plain text without speaker labels.",
    "Speaker labels aren't available from the connected ElevenLabs.",
    "Speaker labels are not supported by its hosted transcription.",
    "Speaker diarization is unavailable there.",
    "I'm unable to get speaker labels from ElevenLabs.",
  ])("matches a refusal: %s", (line) => {
    expect(passes(line)).toBe(true);
  });

  it.each([
    "Now let me load the audio-analysis skill to transcribe with speaker labels.",
    "Note that I need to check for speaker labels.",
    "I'll transcribe this with speaker labels now.",
    "Here is the transcript, with speaker labels.",
    "Nothing else needed; speaker labels coming up.",
    "Uploading the file first.",
  ])("does NOT match narration: %s", (line) => {
    expect(passes(line)).toBe(false);
  });

  it("does not match the user's own prompt, only the agent's words", () => {
    expect(evaluate([], [needle], view("Uploading the file first."))[0].pass).toBe(false);
  });
});

describe("audio-analysis/03 — the flat text is never saved as the file's transcript", () => {
  const scenario = load("03-elevenlabs-plain-text-upload.md");
  const saves = scenario.assertions.filter(
    (a) => typeof a.transcript_contains === "string" && a.transcript_contains.includes("analysis_save_audio_chunk"),
  );

  it("asserts both save variants absent", () => {
    expect(saves).toHaveLength(2);
    for (const s of saves) expect(s.expect).toBe("absent");
  });

  it("fails a run that saved the text through Path B", () => {
    for (const tool of ["mcp__libi__libi_analysis_save_audio_chunk", "mcp__libi__libi_analysis_save_audio_chunk_from_file"]) {
      const results = evaluate([], saves, view("Saved.", `[tool-call ${tool}] {"chunkId":"c1","text":"x","words":[]}`));
      expect(results.some((r) => !r.pass), tool).toBe(true);
    }
    expect(evaluate([], saves, view("Here is the text: …")).every((r) => r.pass)).toBe(true);
  });
});
