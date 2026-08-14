import { describe, expect, it } from "vitest";
import { buildScriptPrompt, buildRetryPrompt } from "@/lib/analysis/script-providers/prompt-builder";

describe("buildScriptPrompt", () => {
  it("returns a non-empty prompt", () => {
    const prompt = buildScriptPrompt();
    expect(prompt.length).toBeGreaterThan(200);
  });

  it("mentions strict JSON output and schema_version literal", () => {
    const prompt = buildScriptPrompt();
    expect(prompt).toMatch(/JSON/);
    expect(prompt).toMatch(/script_v1/);
  });

  it("mentions music, sound design, and shots", () => {
    const prompt = buildScriptPrompt();
    expect(prompt.toLowerCase()).toMatch(/music/);
    expect(prompt.toLowerCase()).toMatch(/sound/);
    expect(prompt.toLowerCase()).toMatch(/shot/);
  });

  it("forbids markdown fences in the output", () => {
    const prompt = buildScriptPrompt();
    expect(prompt.toLowerCase()).toMatch(/no markdown|no commentary|only the json|only json/);
  });

  it("uses the canonical shot field names (start, end, text_on_screen) — not the old aliases", () => {
    const prompt = buildScriptPrompt();
    expect(prompt).not.toMatch(/startTime|endTime|on_screen_text/);
    // start/end appear in lots of contexts; verify text_on_screen specifically.
    expect(prompt).toMatch(/text_on_screen/);
  });
});

describe("buildRetryPrompt", () => {
  const base = buildScriptPrompt();

  it("includes the base prompt and a short error verbatim", () => {
    const err = "shots[2].end must be > start";
    const out = buildRetryPrompt(base, err, 5000);
    expect(out).toContain(base);
    expect(out).toContain(err);
    expect(out.toLowerCase()).toMatch(/failed validation/);
  });

  it("keeps the retry prompt under the provider cap when the error is huge", () => {
    // Simulate a truncated-JSON validation error that embeds the model's
    // multi-thousand-char output — the exact case that produced HTTP 422.
    const hugeError = "X".repeat(20_000);
    const out = buildRetryPrompt(base, hugeError, 5000);
    expect(out.length).toBeLessThanOrEqual(5000);
    // Base instructions must survive intact (we trim the error, never the schema).
    expect(out).toContain(base);
    expect(out).toMatch(/error truncated/);
  });

  it("keeps head and tail of the error so both ends stay diagnostic", () => {
    const err = "HEAD_MARKER" + "y".repeat(20_000) + "TAIL_MARKER";
    const out = buildRetryPrompt(base, err, 5000);
    expect(out.length).toBeLessThanOrEqual(5000);
    expect(out).toContain("HEAD_MARKER");
    expect(out).toContain("TAIL_MARKER");
  });

  it("does not bound the error when no cap is given", () => {
    const hugeError = "Z".repeat(20_000);
    const out = buildRetryPrompt(base, hugeError);
    expect(out.length).toBeGreaterThan(20_000);
    expect(out).toContain(hugeError);
  });
});
