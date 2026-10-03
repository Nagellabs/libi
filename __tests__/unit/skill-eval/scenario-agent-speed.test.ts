import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseScenario } from "@/scripts/skill-eval/scenario";
import { evaluate } from "@/scripts/skill-eval/assertions";
import { buildTranscriptView } from "@/scripts/skill-eval/harness";
import type { TraceCall, TranscriptView } from "@/scripts/skill-eval/types";
import * as batch from "@/skill-eval/scenarios/agent-speed/01-batch-edit-apply-ops.hooks";
import * as audio from "@/skill-eval/scenarios/agent-speed/02-audio-level-measure.hooks";
import * as retime from "@/skill-eval/scenarios/agent-speed/03-insert-time-folder.hooks";
import * as tpl from "@/skill-eval/scenarios/agent-speed/04-template-reflow-overrides.hooks";
import * as kit from "@/skill-eval/scenarios/agent-speed/05-code-kit-include.hooks";
import { KIT_STYLES, endCardBody } from "@/skill-eval/scenarios/_bench/dreams-six-pieces-hard.kit";

/**
 * The agent-speed scenarios (skill-eval/scenarios/agent-speed/) have to be able to FAIL. Two halves:
 *
 *  - the scenario's real matchers run over synthetic transcripts in the harness's rendered format
 *    (`harness.ts#renderPart`: a tool call is `[tool-call <title>] <args JSON>`, a Bash call's title is its
 *    command, a Read's is `Read <path>`): only the well-behaved run may pass, and each other run fails on the
 *    invariant it exists for (a call ceiling, the batch route, a shell dump of a body, a raw provider publish);
 *  - the hooks' pure `checkPiece` functions run over synthetic manifests: a right piece passes every check,
 *    and the wrong ones fail the check named for them.
 */

const DIR = "skill-eval/scenarios/agent-speed";
function load(file: string) {
  const path = `${DIR}/${file}`;
  return parseScenario(readFileSync(join(process.cwd(), path), "utf8"), path);
}

type Part = { type: string; rawTitle?: string; args?: unknown; text?: string };
const libi = (tool: string, args: unknown = {}): Part => ({ type: "tool-call", rawTitle: `mcp__libi__libi_${tool}`, args });
const bash = (command: string): Part => ({ type: "tool-call", rawTitle: command, args: { command } });
const read = (path: string, extra: Record<string, unknown> = {}): Part => ({ type: "tool-call", rawTitle: `Read ${path}`, args: { file_path: path, ...extra } });
const say = (text: string): Part => ({ type: "text", text });
/** One turn: the prompt, then the agent's parts. Further turns are `[user text, agent parts]` pairs. */
function view(turns: Part[][]): TranscriptView {
  const messages = turns.flatMap((parts, i) => [{ role: "user", parts: [{ type: "text", text: i === 0 ? "prompt" : `reply ${i}` }] }, { role: "agent", parts }]);
  return buildTranscriptView(messages);
}
function failed(file: string, v: TranscriptView, trace: TraceCall[] = []): number[] {
  return evaluate(trace, load(file).assertions, v).flatMap((r, i) => (r.pass ? [] : [i]));
}
const times = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));

const FILES = [
  "01-batch-edit-apply-ops.md",
  "02-audio-level-measure.md",
  "03-insert-time-folder.md",
  "04-template-reflow-overrides.md",
  "05-code-kit-include.md",
  "06-post-where-is-the-draft.md",
];

describe("agent-speed scenarios: parse", () => {
  it.each(FILES)("%s parses, has hard invariants, and its hooks and fixtures exist", (file) => {
    const s = load(file);
    expect(s.id).toMatch(/^agent-speed-/);
    expect(s.assertions.length).toBeGreaterThan(3);
    expect(s.skills).toEqual(["*"]);
    if (s.hooks) expect(existsSync(join(process.cwd(), s.hooks))).toBe(true);
    for (const f of s.fixtures) expect(existsSync(join(process.cwd(), f)), f).toBe(true);
    for (const t of s.templates) expect(existsSync(join(process.cwd(), t, "template.json")), t).toBe(true);
    expect(s.prompt.length).toBeGreaterThan(40);
  });

  it("every scenario with hooks asks the harness for the placeholder its prompt uses", () => {
    for (const file of FILES) expect(load(file).prompt.includes("{{seed:") ? !!load(file).hooks : true).toBe(true);
  });
});

describe("01 batch edit: apply_ops, not a loop", () => {
  const FILE = FILES[0];
  const good = view([[libi("read_manual"), libi("list_pieces"), libi("get_composition", { folderId: "f", view: "timeline" }), libi("apply_ops", { dryRun: true }), libi("apply_ops", {}), libi("render_overlay_frames", { pieceIds: ["a", "b"] }), libi("get_piece_state", { pieceIds: ["a", "b"] }), libi("show", {}), say("Done")]]);

  it("passes the batch route", () => expect(failed(FILE, good)).toEqual([]));
  it("fails a per-piece loop on update_overlay", () => {
    expect(failed(FILE, view([[libi("read_manual"), ...times(4, () => libi("update_overlay", {}))]])).length).toBeGreaterThan(0);
  });
  it("fails a per-piece read loop", () => {
    expect(failed(FILE, view([[libi("apply_ops", {}), ...times(4, () => libi("get_composition", {}))]]))).toContain(2);
    expect(failed(FILE, view([[libi("apply_ops", {}), ...times(3, () => libi("list_files", {}))]]))).toContain(3);
  });
  it("fails without apply_ops and over the whole-run ceiling", () => {
    expect(failed(FILE, view([[libi("read_manual"), libi("update_overlay", {})]]))).toContain(0);
    expect(failed(FILE, view([[libi("apply_ops", {}), ...times(15, () => libi("show", {}))]]))).toContain(4);
  });
  it("fails a shell read of composition.json", () => {
    expect(failed(FILE, view([[libi("apply_ops", {}), bash("cat /tmp/storage/ab/composition.json")]]))).toContain(5);
  });

  const ids = { titleId: "t", sublineId: "s", backdropId: "b" };
  const manifest = (over: Partial<Record<"title" | "sub" | "bd", object>> = {}) => ({
    overlays: [
      { id: "b", kind: "code", startTime: 0, duration: 8, ...over.bd },
      { id: "t", kind: "text", startTime: 0, duration: 6, content: "Summer Sale", color: "#ffb703", ...over.title },
      { id: "s", kind: "text", startTime: 0.5, duration: 4, content: "Free shipping on every order", color: "#9AD1D4", ...over.sub },
    ],
  });
  const names = (m: object) => batch.checkPiece(m as never, ids, { name: "P", sublineColor: "#9AD1D4" }).filter((c) => !c.pass).map((c) => c.name.replace("P: ", ""));
  it("checks the outcome: a right piece passes, each wrong one fails its check", () => {
    expect(names(manifest())).toEqual([]);
    expect(names(manifest({ title: { content: "Spring Sale" } }))).toEqual(["title says Summer Sale"]);
    expect(names(manifest({ title: { duration: 4 } }))).toEqual(["title is 6 s long, still starting at 0"]);
    expect(names(manifest({ title: { color: "#FFFFFF" } }))).toEqual(["title is #FFB703"]);
    expect(names(manifest({ sub: { color: "#FFB703" } }))).toEqual(["subline untouched"]);
    expect(names(manifest({ bd: { duration: 6 } }))).toEqual(["backdrop untouched"]);
    expect(names({ overlays: manifest().overlays.slice(0, 2) })).toContain("no layer added or lost");
  });
});

describe("02 audio level: set on the clip, measured, never baked", () => {
  const FILE = FILES[1];
  const good = view([[libi("read_manual"), libi("audio_analyze", { action: "measure", pieceId: "p" }), libi("audio_clip", { action: "update", gainDb: -10 }), libi("audio_analyze", { action: "measure", pieceId: "p" }), say("Under narration -23 LUFS")]]);

  it("passes a measured clip-level edit", () => expect(failed(FILE, good)).toEqual([]));
  it("fails without a measure", () => {
    expect(failed(FILE, view([[libi("audio_clip", { action: "update", gainDb: -10 })]]))).toContain(0);
  });
  it("fails an ffmpeg level read and an upload of a mixed file", () => {
    expect(failed(FILE, view([[libi("audio_analyze", { action: "measure" }), bash("ffmpeg -i song.m4a -af volumedetect -f null -")]]))).toContain(3);
    expect(failed(FILE, view([[libi("audio_analyze", { action: "measure" }), bash("python3 -c 'import numpy as np; print(np.mean([1]))'")]]))).toContain(3);
    expect(failed(FILE, view([[libi("audio_analyze", { action: "measure" }), libi("upload_file", { filePath: "/tmp/ducked.wav" })]]))).toContain(2);
  });
  it("fails a measure loop", () => {
    expect(failed(FILE, view([times(6, () => libi("audio_analyze", { action: "measure" }))]))).toContain(1);
  });

  const ids = { pieceId: "p", narrationFileId: "fN", songFileId: "fS", narrationClipId: "n", musicClipId: "m" };
  const narr = { id: "n", kind: "standalone", fileId: "fN", startTime: 5.3, duration: 11, volume: 1, enabled: true };
  const song = (extra: object = {}) => ({ id: "m", kind: "standalone", fileId: "fS", startTime: 0, duration: 20.5, volume: 1, enabled: true, ...extra });
  const bad = (clips: object[], audioFiles = 2) => audio.checkPiece({ audioClips: clips } as never, audioFiles, ids).filter((c) => !c.pass).map((c) => c.name);
  it("checks the outcome from the clip model", () => {
    const duck = { sidechainClipIds: ["n"], reductionDb: -10 };
    expect(bad([narr, song({ duck })])).toEqual([]);
    // an envelope that dips 10 dB over the narration and returns
    const env = { keyframes: [{ t: 5, value: 0 }, { t: 5.3, value: -10 }, { t: 16.3, value: -10 }, { t: 16.4, value: 0 }] };
    expect(bad([narr, song({ volumeKeyframes: env })])).toEqual([]);
    // gain lowered everywhere: the end card is no longer at full level
    expect(bad([narr, song({ gainDb: -10 })])).toContain("over the end card the song is at full level");
    // the default duck (-12 dB) is outside the asked 10 dB (±1.5)
    expect(bad([narr, song({ duck: { sidechainClipIds: ["n"], reductionDb: -12 } })])).toContain("under the narration it is 10 dB quieter than over the end card");
    // untouched
    expect(bad([narr, song()])).toContain("under the narration it is 10 dB quieter than over the end card");
    // a baked file
    expect(bad([narr, song({ fileId: "fBaked", duck })], 3)).toEqual(expect.arrayContaining(["nothing was baked: no audio file besides the narration and the song", "the song is still on its original file"]));
  });
});

describe("03 insert_time across a folder", () => {
  const FILE = FILES[2];
  const good = view([[libi("read_manual"), libi("list_pieces"), libi("get_composition", { folderId: "f", view: "timeline" }), libi("apply_ops", { dryRun: true, ops: [{ op: "clip", action: "insert_time", at: 5, seconds: 3, extendTarget: "vid" }] }), libi("apply_ops", { ops: [{ op: "clip", action: "insert_time", at: 5, seconds: 3, extendTarget: "vid" }] }), libi("get_piece_state", { pieceIds: ["a"] })]]);

  it("passes the batch insert", () => expect(failed(FILE, good)).toEqual([]));
  it("fails manual retime math with per-layer edits", () => {
    const manual = view([[libi("apply_ops", { ops: [{ op: "update_overlay", overlayId: "x", startTime: 8.3 }] }), ...times(6, () => libi("update_overlay", {})), ...times(3, () => libi("audio_clip", { action: "update" }))]]);
    const f = failed(FILE, manual);
    expect(f).toContain(0);
    expect(f).toContain(2);
    expect(f).toContain(3);
  });
  it("fails per-piece direct clip calls", () => {
    expect(failed(FILE, view([[libi("apply_ops", { ops: [{ action: "insert_time" }] }), ...times(3, () => libi("clip", { action: "insert_time" }))]]))).toContain(4);
  });

  const ids = { videoId: "v", captionId: "c", endCardId: "e", backdropId: "bd", narrationClipId: "n", musicClipId: "m" };
  const right = () => ({
    overlays: [
      { id: "bd", kind: "code", startTime: 0, duration: 23.5 },
      { id: "v", kind: "video", startTime: 0, duration: 8, trim: { start: 0, end: 8 } },
      { id: "c", kind: "text", startTime: 8.3, duration: 11 },
      { id: "e", kind: "code", startTime: 19.5, duration: 4 },
    ],
    audioClips: [
      { id: "i", kind: "inline", fileId: "fV", startTime: 0, duration: 8, volume: 1, enabled: true, linkedOverlayId: "v" },
      { id: "n", kind: "standalone", fileId: "fN", startTime: 8.3, duration: 11, volume: 1, enabled: true },
      { id: "m", kind: "standalone", fileId: "fS", startTime: 0, duration: 23.5, volume: 1, enabled: true },
    ],
  });
  const names = (m: { overlays: object[]; audioClips: object[] }) => retime.checkPiece(m as never, ids, { name: "P" }).filter((c) => !c.pass).map((c) => c.name.replace("P: ", ""));
  it("checks the outcome: a right piece passes, each wrong one fails its check", () => {
    expect(names(right())).toEqual([]);
    const noStretch = right();
    (noStretch.overlays[0] as { duration: number }).duration = 20.5;
    (noStretch.audioClips[2] as { duration: number }).duration = 20.5;
    expect(names(noStretch)).toEqual(["backdrop still covers the piece", "music bed still covers the piece"]);
    const noShift = right();
    (noShift.overlays[2] as { startTime: number }).startTime = 5.3;
    expect(names(noShift)).toEqual(["caption moved +3 s"]);
    const introOnly = right();
    (introOnly.audioClips[0] as { duration: number }).duration = 5;
    expect(names(introOnly)).toEqual(["intro's own sound is 3 s longer"]);
  });
});

describe("04 template reflow and overrides in one apply", () => {
  const FILE = FILES[3];
  const apply = { templateId: "t", pieceId: "p", layerOverrides: { headline: { color: "#FFB703" } }, omitLayers: ["logo"], startAt: 16.5 };
  const good = view([[libi("read_manual"), libi("template", { action: "get" }), libi("apply_template", apply), libi("render_overlay_frames", {}), say("Applied")]]);

  it("passes one apply that carries the fit work", () => expect(failed(FILE, good)).toEqual([]));
  it("fails a second apply, a missing override or omission or start, and layer-by-layer repair", () => {
    expect(failed(FILE, view([[libi("apply_template", apply), libi("apply_template", apply)]]))).toContain(0);
    expect(failed(FILE, view([[libi("apply_template", { ...apply, layerOverrides: undefined })]]))).toContain(1);
    expect(failed(FILE, view([[libi("apply_template", { ...apply, omitLayers: undefined })]]))).toContain(2);
    expect(failed(FILE, view([[libi("apply_template", { ...apply, startAt: undefined })]]))).toContain(3);
    expect(failed(FILE, view([[libi("apply_template", apply), ...times(5, () => libi("update_overlay", {}))]]))).toContain(4);
    expect(failed(FILE, view([[libi("apply_template", apply), libi("add_keyframe", {})]]))).toContain(6);
  });

  const L = (suffix: string, extra: object = {}) => ({ id: suffix, kind: "text", displayName: `Closing · ${suffix}`, startTime: 16.5, duration: 4, rect: { x: 100, y: 200, width: 800, height: 150 }, ...extra });
  const right = () => ({
    overlays: [
      { id: "bd0", kind: "code", startTime: 0, duration: 20.5 },
      L("Backdrop", { kind: "image", rect: { x: 0, y: 0, width: 1080, height: 1920 } }),
      L("Wordmark", { content: "TIDEWATER", keyframes: { rect: { keyframes: [{ t: 0, value: { x: 100, y: 200, width: 800, height: 90 } }, { t: 0.25, value: { x: 100, y: 150, width: 800, height: 90 } }] } } }),
      L("Headline", { content: "Out now", color: "#ffb703" }),
      L("Subline", { content: "Tidewater Lights · The Bench Band" }),
      L("Call to action", { content: "Listen on every platform" }),
    ],
  });
  const names = (m: { overlays: object[] }) => tpl.checkPiece(m as never, { pieceId: "p", backdropId: "bd0" }).filter((c) => !c.pass).map((c) => c.name);
  it("checks the outcome", () => {
    expect(names(right())).toEqual([]);
    const logo = right();
    logo.overlays.push(L("Logo"));
    expect(names(logo)).toEqual(["the card landed once: one of each layer, the logo left out"]);
    const off = right();
    (off.overlays[2] as unknown as { keyframes: { rect: { keyframes: Array<{ value: { x: number } }> } } }).keyframes.rect.keyframes[0].value.x = 1900;
    expect(names(off)).toEqual(["every card layer, keyframed rects included, is inside the 9:16 frame"]);
    const early = right();
    (early.overlays[3] as { startTime: number }).startTime = 0;
    expect(names(early)).toEqual(["the card plays over the piece's last 4 s"]);
    const colour = right();
    (colour.overlays[3] as unknown as { color: string }).color = "#E63946";
    expect(names(colour)).toEqual(["headline says Out now, in #FFB703"]);
    const doubled = right();
    doubled.overlays.push(L("Headline", { id: "h2", content: "Out now", color: "#FFB703" }));
    expect(names(doubled)).toContain("the card landed once: one of each layer, the logo left out");
  });
});

describe("05 code kit: outline, include, no shell dump", () => {
  const FILE = FILES[4];
  const KIT = "/var/folders/T/libi-skilleval-x/storage/p1/overlays/code-abc123/draw.jsx";
  const good = view([[libi("read_manual"), libi("code_outline", { pieceId: "p", overlayId: "o" }), libi("code_outline", { pieceId: "p", overlayId: "o", includeSource: { from: 100, to: 140 } }), libi("add_overlay", { kind: "code", body: "textAt('x')", include: { fromOverlayId: "o", names: ["textAt"] } }), libi("render_overlay_frames", {})]]);

  it("passes outline then include", () => expect(failed(FILE, good)).toEqual([]));
  it("passes a ranged Read of the kit", () => {
    expect(failed(FILE, view([[libi("code_outline", {}), read(KIT, { offset: 100, limit: 40 }), libi("add_overlay", { include: { fromOverlayId: "o" } })]]))).toEqual([]);
  });
  it("fails a shell dump of draw.jsx, whatever the command", () => {
    for (const cmd of [`cat ${KIT}`, `sed -n '1,200p' ${KIT}`, `cd /x/storage; for p in */; do sed -n '60,400p' $p/overlays/code-ib4/draw.jsx; done`, `head -80 ${KIT} | grep -n textAt`]) {
      expect(failed(FILE, view([[libi("code_outline", {}), libi("add_overlay", { include: { fromOverlayId: "o" } }), bash(cmd)]]))).toContain(2);
    }
  });
  it("fails a whole-file Read of the kit", () => {
    expect(failed(FILE, view([[libi("code_outline", {}), libi("add_overlay", { include: { fromOverlayId: "o" } }), read(KIT)]]))).toContain(3);
  });
  it("fails without the outline or without include", () => {
    expect(failed(FILE, view([[libi("add_overlay", { include: { fromOverlayId: "o" } })]]))).toContain(0);
    expect(failed(FILE, view([[libi("code_outline", {}), libi("add_overlay", { body: "x" })]]))).toContain(1);
  });
  it("is not fooled by an unrelated shell command that mentions a shell word", () => {
    expect(failed(FILE, view([[libi("code_outline", {}), libi("add_overlay", { include: { fromOverlayId: "o" } }), bash("ls /tmp && echo head")]]))).toEqual([]);
  });

  const ids = { pieceId: "p", introCardId: "i", backdropId: "b" };
  it("checks the placement of the new overlay", () => {
    const m = (extra: object[]) => ({ overlays: [{ id: "b", kind: "code", startTime: 0, duration: 20 }, { id: "i", kind: "code", startTime: 0, duration: 4 }, ...extra] });
    expect(kit.checkPlacement(m([{ id: "n", kind: "code", startTime: 16, duration: 4 }]) as never, ids).checks[0].pass).toBe(true);
    expect(kit.checkPlacement(m([{ id: "n", kind: "code", startTime: 10, duration: 4 }]) as never, ids).checks[0].pass).toBe(false);
    expect(kit.checkPlacement(m([]) as never, ids).checks[0].pass).toBe(false);
  });
  const bad = (body: string) => kit.checkBody(body).filter((c) => !c.pass).map((c) => c.name);
  it("checks the new body: it says the words, carries the kit's palette and reuses its helpers", () => {
    const seeded = endCardBody(KIT_STYLES[0]);
    // a body that copied the kit's declarations (what `include` produces) and draws the new text
    const reused = seeded.split("// ---- scene ----")[0] + "textAt('See you Friday', W / 2, H * 0.5, 80, P.ink, '800', FONT.display, 'center');\nbadge('NEXT WEEK', W / 2, H * 0.94, P.accent, P.bg);\n";
    expect(bad(reused)).toEqual([]);
    // redrawn from scratch: right words, none of the kit
    expect(bad("ctx.fillStyle = 'red'; ctx.fillText('See you Friday', 10, 10); ctx.fillText('NEXT WEEK', 10, 40);")).toEqual(["it carries the kit's palette", "it reuses at least two of the kit's own helpers"]);
    expect(bad(reused.replace("See you Friday", "Bye"))).toEqual(["the new card says \"See you Friday\" with the \"NEXT WEEK\" badge"]);
  });
});

describe("06 posting: where the draft is", () => {
  const FILE = FILES[5];
  const draft = (isDraft: boolean): TraceCall => ({ tool: "posts_create_post", provider: "zernio", input: { is_draft: isDraft } });
  const turn1 = [libi("social_status", {}), libi("post_piece", { pieceId: "p", targets: ["tiktok"] }), say("A draft is in the piece's Posting tab, not in TikTok yet.")];
  const answer = [say("It is in libi and at the provider, not in TikTok. Open the Posting tab and press Send to TikTok inbox, then open the TikTok app's notification.")];

  it("passes the draft, then the pointer at the button", () => {
    expect(failed(FILE, view([turn1, answer]), [draft(true)])).toEqual([]);
  });
  it("fails an answer that does not name the button, or the tab", () => {
    expect(failed(FILE, view([turn1, [say("I will publish it for you now.")]]), [draft(true)])).toContain(10);
    expect(failed(FILE, view([[libi("post_piece", {}), say("done")], [say("Press Send to TikTok inbox.")]]), [draft(true)])).toContain(11);
  });
  it("fails a raw provider publish, update or second create", () => {
    for (const tool of ["posts_publish_now", "posts_update_post", "posts_update", "posts_cross_post", "posts_create", "posts_retry"]) {
      expect(failed(FILE, view([turn1, answer]), [draft(true), { tool, provider: "zernio", input: {} }]).length, tool).toBeGreaterThan(0);
    }
    expect(failed(FILE, view([turn1, answer]), [draft(true), draft(true)])).toContain(1);
    expect(failed(FILE, view([turn1, answer]), [draft(false)])).toContain(3);
  });
  it("scripts the user's complaint as the only reply", () => {
    expect(load(FILE).replies).toHaveLength(1);
    expect(load(FILE).replies[0]).toMatch(/don't see it/);
  });
});
