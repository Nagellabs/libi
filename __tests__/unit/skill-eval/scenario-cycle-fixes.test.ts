import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseScenario } from "@/scripts/skill-eval/scenario";
import { evaluate } from "@/scripts/skill-eval/assertions";
import type { Matcher, TraceCall, TranscriptView } from "@/scripts/skill-eval/types";

/**
 * Seven scenarios were stale against the merged-tool branch (a needle that collided with new skill text,
 * a pinned `run_model` where the agent used `submit_job`, a skill not mounted, a path needle that missed a
 * relative `cat`, a consent-shaped scripted reply). These run each scenario's REAL matchers over synthetic
 * transcripts in the harness's rendered format: the behaviour the agent showed in the cycle must pass, and
 * the failure each needle exists to catch must still fail.
 */

function load(group: string, file: string) {
  const path = `skill-eval/scenarios/${group}/${file}`;
  return parseScenario(readFileSync(join(process.cwd(), path), "utf8"), path);
}

/** Every matcher of the scenario that mentions `needle` (so a test names the assertion it exercises). */
function matchersWith(matchers: Matcher[], needle: string): Matcher[] {
  const found = matchers.filter((m) => JSON.stringify(m).includes(needle));
  expect(found.length, `no matcher mentions ${needle}`).toBeGreaterThan(0);
  return found;
}

/** One agent turn per entry: `all` is everything rendered, `agent` the agent's own words. */
function view(turns: Array<{ all: string; agent?: string }>): TranscriptView {
  const t = turns.map((x) => ({ all: x.all, agentText: x.agent ?? "" }));
  return { full: t.map((x) => x.all).join("\n"), agentText: t.map((x) => x.agentText).join("\n"), turns: t };
}

const call = (tool: string, args: unknown) => `[tool-call ${tool}] ${JSON.stringify(args)}`;
const verdicts = (trace: TraceCall[], matchers: Matcher[], v: string | TranscriptView) => evaluate(trace, matchers, v).map((r) => r.pass);

describe("ai-asset-generation/02: the absence needle is about what the AGENT wrote", () => {
  const s = load("ai-asset-generation", "02-voice-line-intake.md");
  const needles = matchersWith(s.assertions, "no dialogue");
  const READ_VOICE_MD = `[tool-result  ok] "...a clip is made with its voice, and its prompt carries no dialogue.\\n"`;
  const GOOD_CALL = call("mcp__fal-ai__submit_job", { endpoint_id: "bytedance/seedance-2.0/image-to-video", input: { prompt: 'The barista says: "Fresh." Pour, slow push-in.' } });

  it("passes when a skill reference the agent READ says 'no dialogue.'", () => {
    expect(verdicts([], needles, view([{ all: `${READ_VOICE_MD}\n${GOOD_CALL}`, agent: "I drafted a spoken line." }]))).toEqual(needles.map(() => true));
  });

  it("fails when the agent's own words decide there is no line", () => {
    const out = verdicts([], needles, view([{ all: GOOD_CALL, agent: "This clip has no dialogue." }]));
    expect(out).toContain(false);
  });

  it("fails when the prompt sent to fal carries the silent-ad phrase", () => {
    const bad = call("mcp__fal-ai__submit_job", { endpoint_id: "bytedance/seedance-2.0/image-to-video", input: { prompt: "Pour latte art. no speech, no music" } });
    expect(verdicts([], needles, view([{ all: bad }]))).toContain(false);
  });
});

describe("using-storyboard/02 and /03 accept the clip through run_model OR submit_job", () => {
  const generation = (tool: "run_model" | "submit_job", endpoint: string): TraceCall => ({ tool, endpoint_id: endpoint, input: { prompt: "p", image_url: "u" } });
  const lookup: TraceCall = { tool: "get_model_schema", endpoint_id: "bytedance/seedance-2.0/image-to-video", input: {} };
  const I2V = "bytedance/seedance-2.0/image-to-video";
  const T2V = "bytedance/seedance-2.0/text-to-video";

  for (const [file, max] of [["02-generation-spec-cache-gate.md", 4], ["03-sketch-slots.md", 2]] as const) {
    const s = load("using-storyboard", file);
    const clip = matchersWith(s.assertions, "image-to-video");
    const cap = matchersWith(s.assertions, "<=").filter((m) => m.endpoint_id === "*seedance*");

    it(`${file}: submit_job counts as the clip, and a schema lookup is not a generation`, () => {
      expect(verdicts([generation("submit_job", I2V), lookup], clip, "")).toEqual(clip.map(() => true));
      expect(verdicts([generation("run_model", I2V)], clip, "")).toEqual(clip.map(() => true));
      const withLookups = [generation("submit_job", I2V), ...Array.from({ length: max }, () => lookup)];
      expect(verdicts(withLookups, cap, "")).toEqual([true]);
    });

    it(`${file}: still fails on text-to-video, on no clip at all, and on a flood`, () => {
      expect(verdicts([generation("submit_job", T2V)], clip, "")).toContain(false);
      expect(verdicts([lookup], clip, "")).toContain(false);
      const flood = Array.from({ length: max + 1 }, () => generation("submit_job", I2V));
      expect(verdicts(flood, cap, "")).toEqual([false]);
    });
  }
});

describe("removing-backgrounds/02 mounts video-generation-craft", () => {
  it("lists it with the other two skills", () => {
    const s = load("removing-backgrounds", "02-local-video-cutout.md");
    expect(s.skills).toEqual(["removing-and-replacing-backgrounds", "ai-asset-generation", "video-generation-craft"]);
  });
});

describe("video-generation-craft/01 accepts the reference read by any path form", () => {
  const s = load("video-generation-craft", "01-physical-action-reads-provider-reference.md");
  const ref = matchersWith(s.assertions, "references/providers/fal.md");

  it("a relative `cat providers/fal.md` after a cd, whose result prints the reference", () => {
    const t = [
      call("Terminal", { command: "cd /x/mcp/skills/video-generation-craft/references; cat providers/fal.md" }),
      `[tool-result  ok] "**Verify at runtime.** ... Submit only to an id the schema tool confirms; a 404 or an empty schema means the path is wrong."`,
    ].join("\n");
    expect(verdicts([], ref, t)).toEqual([true]);
  });

  it("the absolute path form", () => {
    expect(verdicts([], ref, call("Read", { file_path: "/x/video-generation-craft/references/providers/fal.md" }))).toEqual([true]);
  });

  it("not satisfied by ai-asset-generation's own providers/fal.md", () => {
    const t = call("Read", { file_path: "/x/ai-asset-generation/references/providers/fal.md" }) + '\n[tool-result  ok] "Call fal\'s recommend_model with the user\'s intent"';
    expect(verdicts([], ref, t)).toEqual([false]);
  });
});

describe("video-generation-craft/02 accepts either skill load", () => {
  const s = load("video-generation-craft", "02-the-video-provider-is-the-voice.md");
  const load_ = matchersWith(s.assertions, "Launching skill");
  it.each(["generic-video", "video-generation-craft"])("%s", (skill) => {
    expect(verdicts([], load_, `[tool-result ok] "Launching skill: ${skill}"`)).toEqual([true]);
  });
  it("neither is a miss", () => {
    expect(verdicts([], load_, `[tool-result ok] "Launching skill: using-effects"`)).toEqual([false]);
  });
});

describe("voice-replacement/02: the free estimate is allowed, the reply is not a yes", () => {
  const s = load("voice-replacement", "02-revoice-talking-face-lipsync.md");
  const early = s.assertions.filter((m) => JSON.stringify(m.turn) === "[1,2]" && m.expect === "absent");
  const voiceMade = matchersWith(s.assertions, "creative_generate_speech").filter((m) => m.turn === 3 && m.expect === "present");

  const SPEECH = "mcp__elevenlabs__creative_generate_speech";
  const estimate = call(SPEECH, { text: "I have used this serum", voice_id: "v", estimate_only: true });
  const spend = call(SPEECH, { text: "I have used this serum", voice_id: "v" });

  it("a free estimate_only call in turn 1 trips nothing", () => {
    expect(early.length).toBeGreaterThan(1);
    expect(verdicts([], early, view([{ all: estimate }, { all: "" }, { all: "" }]))).toEqual(early.map(() => true));
  });

  it("a real generate_speech before the yes still fails", () => {
    expect(verdicts([], early, view([{ all: estimate }, { all: spend }, { all: "" }]))).toContain(false);
  });

  it("turn 3 needs a real voice: an estimate alone does not count, a spend does", () => {
    expect(verdicts([], voiceMade, view([{ all: "" }, { all: "" }, { all: estimate }]))).toEqual([false]);
    expect(verdicts([], voiceMade, view([{ all: "" }, { all: "" }, { all: spend }]))).toEqual([true]);
    expect(verdicts([], voiceMade, view([{ all: "" }, { all: "" }, { all: call("mcp__libi__libi_generate_speech", { text: "x" }) }]))).toEqual([true]);
  });

  it("the first scripted reply no longer reads as consent to spend", () => {
    const raw = readFileSync(join(process.cwd(), "skill-eval/scenarios/voice-replacement/02-revoice-talking-face-lipsync.md"), "utf8");
    const reply = /\n1\. (.+)\n/.exec(raw.slice(raw.indexOf("## Replies")))![1];
    expect(reply).toMatch(/don't generate or spend anything yet/);
    expect(reply).not.toMatch(/is fine|go ahead/i);
  });
});
