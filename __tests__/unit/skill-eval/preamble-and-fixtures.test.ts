import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  preambleFor,
  resolveFixturePlaceholders,
  stageFixtures,
} from "@/scripts/skill-eval/harness";

let home: string;
let repo: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "skilleval-home-"));
  repo = mkdtempSync(join(tmpdir(), "skilleval-repo-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

/**
 * The two preambles differ on exactly one thing — whether the agent may spend the
 * user's money — and that is the whole reason the key exists. "Free before paid" is a
 * product promise with no agent-level test anywhere in the suite, because the default
 * preamble tells the agent the opposite; a scenario that asserts a paid call is ABSENT is
 * only meaningful under the opt-out.
 */
describe("preambleFor", () => {
  it("pre-authorizes paid tools by default", () => {
    const text = preambleFor({ preauthorize: true });
    expect(text).toContain("PRE-AUTHORIZED");
    expect(text).toMatch(/run every paid generation tool the workflow needs, without asking/);
  });

  /**
   * The default preamble's own regression (2026-09-10). Its pre-authorization used to be
   * unbounded — "run the entire workflow to completion … Do NOT pause to ask for
   * confirmation, approval, or clarification" — and an agent read that as permission to run
   * a *product* gate as well, firing `libi.music_download_model` (~8.3 GB) without the
   * install plan's disclosure, twice, in two scenarios, on two days. Only a missing `uv`
   * kept those runs cheap. Four `preauthorize: true` scenarios assert that gate holds, so
   * the scoping words below are the thing keeping those assertions winnable.
   */
  it("scopes the default pre-authorization to money, and holds install gates open", () => {
    const text = preambleFor({ preauthorize: true });
    expect(text).toMatch(/about MONEY ONLY/);
    // Free is not ungated — stated by the size of the download, not by the price.
    expect(text).toMatch(/bind you just as hard when the tool is FREE/);
    expect(text).toMatch(/multi-gigabyte model download costs nothing and is still gated/);
    // A step only the user can perform is a full stop, and stopping is a PASS. Without
    // this an agent reasons that an unanswerable gate is pointless and proceeds — the
    // exact failure observed under the old text.
    expect(text).toMatch(/you cannot take it and you may not step over it/);
    expect(text).toMatch(/END YOUR TURN THERE/);
    expect(text).toMatch(/stopping at that point is a CORRECT outcome/);
    // The confabulation half: the failing run invented "the user clicked Download".
    expect(text).toMatch(/Never state that the user did something they did not do/);
  });

  /**
   * The carve-out must never be phrased as "free tools need no asking" — that sentence, in
   * EVAL_PREAMBLE_NO_SPEND's first draft, is what STARTED the 8.3 GB download. Both
   * preambles gate on the plan's steps, not on the price tag.
   */
  it("neither preamble tells the agent that free work needs no approval", () => {
    for (const preauthorize of [true, false]) {
      const text = preambleFor({ preauthorize });
      expect(text).not.toMatch(/free[^.]{0,40}(need|require)s? no (asking|approval)/i);
    }
  });

  /**
   * `using-object-tracking/03` is the counter-case the scoping must not break: its whole
   * point is that after disclosing ~2 GB the agent REACHES `libi.install_tracking_engine`
   * and handles an honest refusal. So the stop is scoped to a step the agent cannot
   * perform, not to installs in general.
   */
  it("stops the agent only at a step it cannot perform, not at every install", () => {
    const text = preambleFor({ preauthorize: true });
    expect(text).toMatch(/needs an action only the user can take in the app/);
    expect(text).not.toMatch(/never (run|start) an install/i);
  });

  it("forbids spending under preauthorize: false, and says stopping is the pass", () => {
    const text = preambleFor({ preauthorize: false });
    expect(text).not.toContain("PRE-AUTHORIZED");
    expect(text).toMatch(/NOT authorized to spend/);
    expect(text).toMatch(/do NOT run it/);
    // The observed failure mode: an agent decides an unanswerable question is pointless and
    // proceeds. The preamble has to name stopping as the correct outcome, or the opt-out
    // buys nothing.
    expect(text).toMatch(/stopping at that question is the CORRECT and expected outcome/);
    // …while still keeping the half that exists for the harness, not for the product.
    expect(text).toMatch(/Do not pause on anything that costs nothing/);
    // Free is not unbounded. On this preamble's own first run the agent read "free tools
    // need no asking" as permission to start an 8.3 GB model download, skipping the two
    // disclosure steps its install plan puts in front of it; only a missing `uv` kept the
    // run cheap. A harness preamble must not override the product's own approval gates.
    expect(text).toMatch(/EXCEPT where a skill or an install plan tells you to disclose/);
    expect(text).toMatch(/honour those gates exactly as written, and stop at them too/);
  });

  it("the two preambles are actually different text", () => {
    expect(preambleFor({ preauthorize: true })).not.toBe(preambleFor({ preauthorize: false }));
  });
});

/** A scenario needing input media had no way to get any: the harness creates an empty
 *  piece and seeds nothing. Staging is a COPY into the hermetic home for the same reason
 *  `share` is a copy — the run must not be able to write back into the repo. */
describe("stageFixtures", () => {
  it("copies declared files into <home>/fixtures and returns their staged paths", () => {
    mkdirSync(join(repo, "__tests__/fixtures/audio"), { recursive: true });
    writeFileSync(join(repo, "__tests__/fixtures/audio/jfk.wav"), "RIFFfake");
    const staged = stageFixtures({
      home,
      repoRoot: repo,
      fixtures: ["__tests__/fixtures/audio/jfk.wav"],
    });
    expect(staged).toEqual([join(home, "fixtures", "jfk.wav")]);
    expect(readFileSync(staged[0], "utf8")).toBe("RIFFfake");
  });

  it("is a copy, not a link — writing the staged file cannot reach the source", () => {
    mkdirSync(join(repo, "fx"), { recursive: true });
    const src = join(repo, "fx/clip.mp4");
    writeFileSync(src, "original");
    const [staged] = stageFixtures({ home, repoRoot: repo, fixtures: ["fx/clip.mp4"] });
    writeFileSync(staged, "clobbered by the run");
    expect(readFileSync(src, "utf8")).toBe("original");
  });

  it("does nothing when a scenario declares none", () => {
    expect(stageFixtures({ home, repoRoot: repo, fixtures: [] })).toEqual([]);
    expect(existsSync(join(home, "fixtures"))).toBe(false);
  });

  it("throws on a missing fixture rather than running against an empty home", () => {
    expect(() => stageFixtures({ home, repoRoot: repo, fixtures: ["fx/nope.wav"] })).toThrow(
      /is not a file/,
    );
  });

  it("throws on a directory", () => {
    mkdirSync(join(repo, "fx"), { recursive: true });
    expect(() => stageFixtures({ home, repoRoot: repo, fixtures: ["fx"] })).toThrow(/is not a file/);
  });

  it("refuses a path that resolves outside the repo", () => {
    // The parser rejects `..` too; this is the second, independent gate.
    expect(() =>
      stageFixtures({ home, repoRoot: repo, fixtures: ["../escape.wav"] }),
    ).toThrow(/outside the repo/);
  });

  it("refuses two fixtures that would collide on basename", () => {
    mkdirSync(join(repo, "a"), { recursive: true });
    mkdirSync(join(repo, "b"), { recursive: true });
    writeFileSync(join(repo, "a/clip.mp4"), "1");
    writeFileSync(join(repo, "b/clip.mp4"), "2");
    expect(() =>
      stageFixtures({ home, repoRoot: repo, fixtures: ["a/clip.mp4", "b/clip.mp4"] }),
    ).toThrow(/share the basename/);
  });
});

/** The staged path lives under a `mkdtemp` home the scenario author cannot know, so the
 *  prompt reaches it through a placeholder. A placeholder left unresolved would send the
 *  agent hunting the filesystem — the failed run that motivated fixtures at all — so an
 *  unknown name is an error, never a pass-through. */
describe("resolveFixturePlaceholders", () => {
  it("substitutes the absolute staged path", () => {
    const staged = ["/tmp/h/fixtures/jfk.wav", "/tmp/h/fixtures/clip.mp4"];
    expect(
      resolveFixturePlaceholders("Transcribe {{fixture:jfk.wav}} then trim {{fixture:clip.mp4}}.", staged),
    ).toBe("Transcribe /tmp/h/fixtures/jfk.wav then trim /tmp/h/fixtures/clip.mp4.");
  });

  it("tolerates whitespace inside the placeholder", () => {
    expect(resolveFixturePlaceholders("x {{fixture: jfk.wav }}", ["/tmp/h/fixtures/jfk.wav"])).toBe(
      "x /tmp/h/fixtures/jfk.wav",
    );
  });

  it("leaves a prompt with no placeholders alone", () => {
    expect(resolveFixturePlaceholders("plain prompt", [])).toBe("plain prompt");
  });

  it("throws — never passes through — on a name the scenario did not stage", () => {
    expect(() => resolveFixturePlaceholders("use {{fixture:missing.wav}}", [])).toThrow(
      /staged no fixtures/,
    );
    expect(() =>
      resolveFixturePlaceholders("use {{fixture:missing.wav}}", ["/tmp/h/fixtures/jfk.wav"]),
    ).toThrow(/jfk\.wav/);
  });
});
