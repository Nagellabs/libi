import { describe, it, expect } from "vitest";
import { evaluate } from "@/scripts/skill-eval/assertions";
import type { TraceCall } from "@/scripts/skill-eval/types";

describe("provider-aware assertions", () => {
  const trace: TraceCall[] = [
    { tool: "run_model", endpoint_id: "openai/gpt-image-2", provider: "fal", ts: "2026-06-05T00:00:01Z" },
    { tool: "text_to_speech", voice_id: "v1", model_id: "eleven_multilingual_v2", provider: "elevenlabs", ts: "2026-06-05T00:00:02Z" },
    { tool: "voice_clone", voice_id: "fakevoiceabc", provider: "elevenlabs", ts: "2026-06-05T00:00:03Z" },
  ];

  it("selects only ElevenLabs calls when provider is set", () => {
    const [r] = evaluate(trace, [{ provider: "elevenlabs", tool: "text_to_speech", expect: "present" }]);
    expect(r.pass).toBe(true);
    expect(r.matchedCount).toBe(1);
  });

  it("a fal endpoint matcher ignores ElevenLabs calls", () => {
    const [r] = evaluate(trace, [{ endpoint_id: "openai/gpt-image-2", expect: "present" }]);
    expect(r.pass).toBe(true);
    expect(r.matchedCount).toBe(1);
  });

  it("can assert on voice_id via glob", () => {
    const [r] = evaluate(trace, [{ provider: "elevenlabs", voice_id: "fakevoice*", expect: "present" }]);
    expect(r.pass).toBe(true);
    expect(r.matchedCount).toBe(1);
  });
});
