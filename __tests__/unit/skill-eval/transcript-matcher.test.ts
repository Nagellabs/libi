import { describe, it, expect } from "vitest";
import { evaluate } from "@/scripts/skill-eval/assertions";
import type { TraceCall } from "@/scripts/skill-eval/types";

const NO_CALLS: TraceCall[] = [];

const TRANSCRIPT = `### [0] user

Make me a 5 second clip of a fox.

### [1] assistant

[tool-call mcp__libi__libi_suggest_provider] {"kind":"video"}

[tool-result mcp__libi__libi_suggest_provider ok] {"status":"card","kind":"video","connected":[],"covered":[],"suggested":["fal"]}

I don't have a video provider connected — here's a card with options.`;

describe("transcript_contains matcher", () => {
  it("passes when the substring is present", () => {
    const [r] = evaluate(
      NO_CALLS,
      [{ transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: "present" }],
      TRANSCRIPT,
    );
    expect(r.pass).toBe(true);
    expect(r.matchedCount).toBe(1);
  });

  it("passes an absent assertion when the substring is missing", () => {
    const [r] = evaluate(
      NO_CALLS,
      [{ transcript_contains: "[tool-call mcp__libi__libi_generate_music]", expect: "absent" }],
      TRANSCRIPT,
    );
    expect(r.pass).toBe(true);
  });

  it("fails a present assertion when the substring is missing, and says so", () => {
    const [r] = evaluate(
      NO_CALLS,
      [{ transcript_contains: "[tool-call mcp__libi__libi_upload_file]", expect: "present" }],
      TRANSCRIPT,
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("transcript");
  });

  it("counts repeated occurrences", () => {
    const [r] = evaluate(
      NO_CALLS,
      [{ transcript_contains: "mcp__libi__libi_suggest_provider", count: "==2" }],
      TRANSCRIPT,
    );
    expect(r.pass).toBe(true);
  });

  it("rejects a matcher that mixes transcript_contains with a trace selector", () => {
    expect(() =>
      evaluate(NO_CALLS, [{ transcript_contains: "x", tool: "run_model", expect: "present" }], ""),
    ).toThrow(/transcript_contains/);
  });

  it("leaves trace matchers working when a transcript is passed", () => {
    const trace: TraceCall[] = [{ tool: "run_model", endpoint_id: "openai/gpt-image-2" }];
    const [r] = evaluate(trace, [{ endpoint_id: "openai/gpt-image-2", expect: "present" }], TRANSCRIPT);
    expect(r.pass).toBe(true);
  });
});

describe("transcript_contains any-of", () => {
  const transcript = [
    "[tool-call mcp__libi__libi_generate_music] {}",
    "[tool-result  ok] needs_install",
  ].join("\n");

  it("passes `present` when the transcript took EITHER acceptable route", () => {
    const [direct] = evaluate([], [
      {
        transcript_contains: ["[tool-call mcp__libi__libi_generate_music]", "[tool-call mcp__libi__libi_music_"],
        expect: "present",
      },
    ], transcript);
    expect(direct.pass).toBe(true);

    const viaStyles = evaluate([], [
      {
        transcript_contains: ["[tool-call mcp__libi__libi_generate_music]", "[tool-call mcp__libi__libi_music_"],
        expect: "present",
      },
    ], "[tool-call mcp__libi__libi_music_list_styles] {}")[0];
    expect(viaStyles.pass).toBe(true);
  });

  it("fails `present` only when NO alternative appears", () => {
    const [r] = evaluate([], [
      {
        transcript_contains: ["[tool-call mcp__libi__libi_generate_music]", "[tool-call mcp__libi__libi_music_"],
        expect: "present",
      },
    ], "[tool-call mcp__ElevenLabs__text_to_speech] {}");
    expect(r.pass).toBe(false);
  });

  it("requires ALL alternatives absent for `absent`", () => {
    const [r] = evaluate([], [
      {
        transcript_contains: ["[tool-call mcp__libi__libi_generate_music]", "[tool-call mcp__libi__libi_music_"],
        expect: "absent",
      },
    ], transcript);
    expect(r.pass).toBe(false);
  });

  it("rejects an empty alternative list rather than passing vacuously", () => {
    expect(() =>
      evaluate([], [{ transcript_contains: [], expect: "present" }], transcript),
    ).toThrow(/must not be an empty list/);
  });
});

describe("transcript_matches (regex)", () => {
  const t = [
    '[tool-call mcp__libi__libi_get_piece_state] {"pieceId":"p"}',
    '[tool-result  ok] [{"type":"text","text":"{\\"renderDiagnostics\\":[{\\"time\\":0.067}]}"}]',
    '[tool-call mcp__libi__libi_render_overlay_frames] {"pieceId":"p","atTimes":[0.067]}',
  ].join("\n\n");

  it("counts matches, and a backreference ties a later call to an earlier result", () => {
    const re = String.raw`\\"time\\":([\d.]+)[\s\S]*?"atTimes":\[\1\]`;
    const [r] = evaluate([], [{ transcript_matches: re, expect: "present" }], t);
    expect(r.pass).toBe(true);
    const [other] = evaluate([], [{ transcript_matches: re, expect: "present" }], t.replace("[0.067]}", "[1.5]}"));
    expect(other.pass).toBe(false);
    expect(other.reason).toContain("regex");
  });

  it("supports count expressions", () => {
    const [r] = evaluate([], [{ transcript_matches: String.raw`\[tool-call mcp__libi__libi_\w+\]`, count: "==2" }], t);
    expect(r.pass).toBe(true);
  });

  it("refuses a pattern that can match the empty string, which could never fail `present`", () => {
    expect(() => evaluate([], [{ transcript_matches: "x*", expect: "present" }], t)).toThrow(/empty string/);
    expect(() => evaluate([], [{ transcript_matches: "(?=tool)", expect: "present" }], t)).toThrow(/empty string/);
    expect(() => evaluate([], [{ transcript_matches: "", expect: "present" }], t)).toThrow(/must not be empty/);
  });

  it("refuses an invalid pattern loudly", () => {
    expect(() => evaluate([], [{ transcript_matches: "(", expect: "present" }], t)).toThrow(/not a valid regular expression/);
  });

  it("cannot be combined with transcript_contains or a trace selector", () => {
    expect(() =>
      evaluate([], [{ transcript_matches: "a", transcript_contains: "a", expect: "present" }], t),
    ).toThrow(/transcript_matches cannot be combined/);
    expect(() =>
      evaluate([], [{ transcript_matches: "a", tool: "run_model", expect: "present" }], t),
    ).toThrow(/transcript_matches cannot be combined/);
  });

  it("a failing absent/count regex quotes what it matched (it has no trace call to show)", () => {
    const [r] = evaluate([], [{ transcript_matches: String.raw`\[tool-call mcp__libi__libi_render_overlay_frames\] \{[^\n]*`, expect: "absent" }], t);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('first: "[tool-call mcp__libi__libi_render_overlay_frames] {\\"pieceId\\":\\"p\\"');
    const [c] = evaluate([], [{ transcript_matches: String.raw`\[tool-call`, count: "==1" }], t);
    expect(c.reason).toContain('first: "[tool-call"');
  });
});
