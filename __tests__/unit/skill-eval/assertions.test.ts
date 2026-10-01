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

describe("where: exists", () => {
  const stamped: TraceCall[] = [
    { tool: "posts_create_post", provider: "zernio", input: { is_draft: true, metadata: { libi: { pieceId: "p1" } } } },
    { tool: "posts_create_post", provider: "zernio", input: { is_draft: true, metadata: {} } },
  ];

  it("matches only the calls that actually carried the path", () => {
    const [r] = evaluate(stamped, [
      { provider: "zernio", tool: "posts_create_post", where: "input.metadata.libi.pieceId exists", count: "==1" },
    ]);
    expect(r.pass).toBe(true);
    expect(r.matchedCount).toBe(1);
  });

  it("fails `present` when nothing carried the path", () => {
    const [r] = evaluate(stamped, [
      { provider: "zernio", where: "input.metadata.libi.mediaUrl exists", expect: "present" },
    ]);
    expect(r.pass).toBe(false);
  });

  /**
   * Why `exists` had to be added at all: `null` is not a literal here, so the
   * obvious spelling matches every call in the trace — including the one that
   * never sent the field — and an assertion written that way can never fail.
   */
  it("`!= null` is NOT an existence check (the trap this replaces)", () => {
    const [r] = evaluate(stamped, [
      { provider: "zernio", where: "input.metadata.libi.pieceId != null", count: "==2" },
    ]);
    expect(r.pass).toBe(true);
  });
});

/**
 * `*` in a where path: a scenario that asserts on ONE element of an array must
 * not depend on the order the agent listed the elements in (social-music/02
 * asserted `input.platforms.1…` and failed whenever TikTok came first).
 */
describe("where: * matches any array element", () => {
  const posts: TraceCall[] = [
    {
      tool: "posts_create_post",
      provider: "zernio",
      input: {
        is_draft: true,
        platforms: [
          { platform: "tiktok", platformSpecificData: { tiktokSettings: { musicSoundInfo: { musicSoundId: "t1" } } } },
          { platform: "instagram", platformSpecificData: {} },
        ],
      },
    },
    {
      tool: "posts_create_post",
      provider: "zernio",
      input: { is_draft: true, platforms: [{ platform: "instagram", platformSpecificData: {} }] },
    },
    { tool: "posts_create_post", provider: "zernio", input: { is_draft: true, platforms: [] } },
    { tool: "posts_create_post", provider: "zernio", input: { is_draft: true, platforms: "not-an-array" } },
  ];

  it("`exists` holds when any element carries the rest of the path, wherever it sits", () => {
    const [r] = evaluate(posts, [
      { provider: "zernio", where: "input.platforms.*.platformSpecificData.tiktokSettings.musicSoundInfo.musicSoundId exists", count: "==1" },
    ]);
    expect(r.pass).toBe(true);
    const reversed: TraceCall[] = [{ ...posts[0], input: { platforms: [...(posts[0].input as { platforms: unknown[] }).platforms].reverse() } }];
    const [r2] = evaluate(reversed, [
      { provider: "zernio", where: "input.platforms.*.platformSpecificData.tiktokSettings.musicSoundInfo.musicSoundId exists", expect: "present" },
    ]);
    expect(r2.pass).toBe(true);
  });

  it("a comparison holds when any element satisfies it", () => {
    const [r] = evaluate(posts, [{ provider: "zernio", where: "input.platforms.*.platform == tiktok", count: "==1" }]);
    expect(r.pass).toBe(true);
    const [r2] = evaluate(posts, [{ provider: "zernio", where: "input.platforms.*.platform == instagram", count: "==2" }]);
    expect(r2.pass).toBe(true);
  });

  it("an empty array or a non-array reaches nothing — not even `!=`", () => {
    const [r] = evaluate(posts.slice(2), [{ provider: "zernio", where: "input.platforms.*.platform != tiktok", expect: "absent" }]);
    expect(r.pass).toBe(true);
    const [r2] = evaluate(posts.slice(2), [{ provider: "zernio", where: "input.platforms.* exists", expect: "absent" }]);
    expect(r2.pass).toBe(true);
  });

  it("a `*` can fan out twice, and index paths keep working", () => {
    const nested: TraceCall[] = [
      { tool: "t", input: { a: [{ b: [{ c: 1 }, { c: 2 }] }, { b: [{ c: 3 }] }] } },
    ];
    expect(evaluate(nested, [{ tool: "t", where: "input.a.*.b.*.c == 3", expect: "present" }])[0].pass).toBe(true);
    expect(evaluate(nested, [{ tool: "t", where: "input.a.*.b.*.c == 4", expect: "absent" }])[0].pass).toBe(true);
    expect(evaluate(nested, [{ tool: "t", where: "input.a.0.b.1.c == 2", expect: "present" }])[0].pass).toBe(true);
  });
});
