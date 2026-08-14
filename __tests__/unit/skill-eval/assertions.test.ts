import { describe, it, expect } from "vitest";
import { evaluate } from "@/scripts/skill-eval/assertions";
import type { TraceCall } from "@/scripts/skill-eval/types";

const TRACE: TraceCall[] = [
  { tool: "recommend_model", endpoint_id: undefined, input: { prompt: "nails" } },
  { tool: "run_model", endpoint_id: "openai/gpt-image-2", input: { prompt: "hero shot" } },
  { tool: "submit_job", endpoint_id: "bytedance/seedance-2.0/image-to-video", input: { generate_audio: true } },
  { tool: "submit_job", endpoint_id: "bytedance/seedance-2.0/reference-to-video", input: { generate_audio: true } },
];

describe("evaluate", () => {
  it("passes present when a matching call exists", () => {
    const [r] = evaluate(TRACE, [{ tool: "run_model", endpoint_id: "openai/gpt-image-2", expect: "present" }]);
    expect(r.pass).toBe(true);
    expect(r.matchedCount).toBe(1);
  });

  it("passes absent (glob) when no call matches", () => {
    const [r] = evaluate(TRACE, [{ endpoint_id: "fal-ai/nano-banana*", expect: "absent" }]);
    expect(r.pass).toBe(true);
    expect(r.matchedCount).toBe(0);
  });

  it("fails absent and reports the offending call", () => {
    const [r] = evaluate(TRACE, [{ endpoint_id: "openai/gpt-image-2", expect: "absent" }]);
    expect(r.pass).toBe(false);
    expect(r.offendingCalls).toHaveLength(1);
    expect(r.offendingCalls![0].endpoint_id).toBe("openai/gpt-image-2");
  });

  it("evaluates a where predicate on a nested input field", () => {
    const [r] = evaluate(TRACE, [{ tool: "submit_job", where: "input.generate_audio == false", expect: "absent" }]);
    expect(r.pass).toBe(true); // no submit_job has generate_audio==false
    const [r2] = evaluate(TRACE, [{ tool: "submit_job", where: "input.generate_audio == true", expect: "present" }]);
    expect(r2.pass).toBe(true);
    expect(r2.matchedCount).toBe(2);
  });

  it("evaluates count comparisons with a glob endpoint", () => {
    const [r] = evaluate(TRACE, [{ endpoint_id: "bytedance/seedance-2.0/*", count: ">=1" }]);
    expect(r.pass).toBe(true);
    expect(r.matchedCount).toBe(2);
    const [r2] = evaluate(TRACE, [{ endpoint_id: "bytedance/seedance-2.0/*", count: "==3" }]);
    expect(r2.pass).toBe(false);
  });

  it("throws on a matcher with neither expect nor count", () => {
    expect(() => evaluate(TRACE, [{ tool: "run_model" }])).toThrow(/expect.*count/i);
  });

  it("throws on a malformed where predicate", () => {
    expect(() => evaluate(TRACE, [{ where: "generate_audio == false", expect: "present" }])).toThrow(/where/i);
  });
});

describe("endpoint fidelity matching", () => {
  const T: TraceCall[] = [
    { tool: "run_model", endpoint_id: "openai/gpt-image-2", input: {} },
    {
      tool: "submit_job",
      // synthetic alias string (any non-canonical id the recorder annotated) —
      // tests that the matcher matches on canonical, not the literal endpoint_id.
      endpoint_id: "legacy/seedance-i2v-alias",
      canonical_endpoint_id: "bytedance/seedance-2.0/image-to-video",
      input: {},
    },
    { tool: "submit_job", endpoint_id: "fal-ai/made-up", unknown_endpoint: true, input: {} },
  ];

  it("matches a canonical endpoint_id even when the agent used an alias", () => {
    const [r] = evaluate(T, [{ endpoint_id: "bytedance/seedance-2.0/image-to-video", expect: "present" }]);
    expect(r.pass).toBe(true);
    expect(r.matchedCount).toBe(1);
  });

  it("matches a canonical glob even when the agent used an alias", () => {
    const [r] = evaluate(T, [{ endpoint_id: "bytedance/seedance-2.0/*", count: ">=1" }]);
    expect(r.pass).toBe(true);
    expect(r.matchedCount).toBe(1);
  });

  it("fails absent when an unknown endpoint exists", () => {
    const [r] = evaluate(T, [{ unknown_endpoint: true, expect: "absent" }]);
    expect(r.pass).toBe(false);          // there IS one unknown
    expect(r.matchedCount).toBe(1);
  });

  it("passes unknown-absent on a clean trace", () => {
    const clean = T.slice(0, 2);
    const [r] = evaluate(clean, [{ unknown_endpoint: true, expect: "absent" }]);
    expect(r.pass).toBe(true);
  });
});
