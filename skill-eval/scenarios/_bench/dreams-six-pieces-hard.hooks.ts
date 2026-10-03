/**
 * Seed and verify hooks for `_bench/dreams-six-pieces-hard.md` — the HARD variant of the
 * agent-speed benchmark (plan item S0b). Same folder-of-six-duplicates shape as
 * `dreams-six-pieces.hooks.ts`, plus the three things the first benchmark leaves out and the real
 * 2026-10-02 session paid for (docs-local/research/2026-10-03-dreams-session-analysis.md §P2–§P6):
 *
 *   - a CODE caption, full-length so its time is composition time, whose body hard-codes where the
 *     narration starts and ends: moving the narration forces touching the body;
 *   - a ~190-line "style kit" body in the end card (palette + helpers + scene) that differs in every
 *     piece, so "in the piece's own style" means reading that piece's kit;
 *   - a 16:9 "Closing card" template (staged from skill-eval/fixtures/dreams-bench/closing-card) to
 *     apply to these 9:16 pieces, whose layers land off-frame, at time 0 and in the template's colours.
 *
 *   0.0 – 5.0   intro video overlay (12 s source clip WITH audio, trimmed to 0–5; inline clip)
 *   5.3 – 16.3  narration (standalone audio clip, 11 s speech)
 *   0.0 – 20.5  caption (code overlay over the whole piece, one word at a time; the narration's
 *               composition start and the cue's end are baked in as constants, like the real session's
 *               `NARRATION_OFFSET = 8.3`)
 *  16.5 – 20.5  end card (code overlay, the style kit)
 *               + a 30 s song in each piece's files, NOT on the timeline, stamped copyrighted.
 *
 * VERIFY asserts OUTCOMES on all six pieces (never a tool sequence), from the manifest and from the
 * bodies' own output:
 *   - intro 5 → 8 s with the narration and the end card each +3 s, and the intro's own sound with it;
 *   - the caption still shows each word within 0.09 s of the narration's word times (the verify
 *     RUNS the caption body at probe times, with a recording canvas, and reads what it drew);
 *   - the song audible from the intro's end to the piece's end; −10 dB (±1.5) under the narration
 *     relative to its level over the end card, which is ~0 dB (full level, −1 … +3 dB). The level is
 *     the manifest's effective gain: volume × gainDb × the volume envelope, × the duck's reduction
 *     while its sidechain clip plays (fades and crossfades are ignored; probes sit away from edges);
 *   - the closing card applied: headline / subline / call to action present with the asked text,
 *     inside the 9:16 frame (keyframed rects included), over the end card's window, every text
 *     layer in a colour of THAT piece's palette (the template ships #E63946, in no palette);
 *   - the bodies run without throwing, and a real render of two frames per piece reports no
 *     render diagnostics.
 *
 * HTTP + fs only: nothing here may import `@/lib` (see ScenarioHooks in scripts/skill-eval/types.ts).
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ScenarioHookContext, StateCheck } from "../../../scripts/skill-eval/types";
import { KIT_STYLES, WORDS, captionBody, endCardBody, type KitStyle } from "./dreams-six-pieces-hard.kit";

export const FOLDER_NAME = "Tidewater Lights — 6 styles (hard)";
export const SONG = { title: "Tidewater Lights", artist: "The Bench Band" } as const;
/** What turn 3 asks the closing card to say. */
export const CARD_TEXT = { headline: "Out now", subline: "Tidewater Lights · The Bench Band", cta: "Listen on every platform" } as const;
/** The colour the template ships its text in: in no style's palette, so an untouched card fails the style check. */
export const TEMPLATE_DEFAULT_COLOR = "#e63946";

/** The original timeline (seconds). */
export const T = {
  introDur: 5,
  narrStart: 5.3,
  narrDur: 11,
  /** The caption spans the whole piece, so its overlay-local time IS composition time. */
  captionStart: 0,
  captionDur: 20.5,
  endStart: 16.5,
  endDur: 4,
  /** What the user asks the intro to grow by. */
  extendBy: 3,
} as const;

/** The 9:16 canvas. */
export const FRAME = { width: 1080, height: 1920 } as const;

interface PieceSeed {
  pieceId: string;
  name: string;
  styleIndex: number;
  narrationFileId: string;
  musicFileId: string;
}

export interface SeedState {
  folderId: string;
  videoOverlayId: string;
  captionOverlayId: string;
  endCardOverlayId: string;
  narrationClipId: string;
  pieces: PieceSeed[];
}

// ---------------------------------------------------------------- HTTP

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

/** One of the agent's tools, through the test-only route (same validation as an agent's call). */
async function runTool<T = Record<string, unknown>>(base: string, tool: string, args: Record<string, unknown>): Promise<T> {
  const r = (await call(base, "POST", "/api/e2e/run-tool", { tool, args })) as { success?: boolean; data?: T; error?: string };
  if (!r?.success) throw new Error(`${tool} failed: ${JSON.stringify(r).slice(0, 400)}`);
  return r.data as T;
}

async function upload(base: string, pieceId: string, path: string, name: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(path)]), basename(path));
  form.append("name", name);
  const res = await fetch(`${base}/api/pieces/${pieceId}/upload`, { method: "POST", body: form });
  const json = (await res.json()) as { file?: { id: string }; error?: string };
  if (!res.ok || !json.file) throw new Error(`upload ${basename(path)} failed: ${res.status} ${json.error ?? ""}`);
  return json.file.id;
}

async function waitForJob(base: string, jobId: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const s = (await call(base, "GET", `/api/jobs/${jobId}`)) as { status?: string; error?: unknown };
    if (s.status === "completed") return;
    if (s.status === "failed" || s.status === "cancelled") throw new Error(`job ${jobId} ${s.status}: ${JSON.stringify(s.error)}`);
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} still ${s.status} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const fixture = (ctx: ScenarioHookContext, name: string): string => {
  const hit = ctx.fixtures.find((p) => basename(p) === name);
  if (!hit) throw new Error(`dreams hard bench: fixture ${name} was not staged (got ${ctx.fixtures.map((p) => basename(p)).join(", ")})`);
  return hit;
};

/**
 * The file a code overlay's body lives in (what the agent edits): `libi.get_overlays` names it; if
 * that tool's shape moves, fall back to the storage layout `<storage>/<pieceId>/overlays/<overlayId>/<file>`.
 */
async function codeFileOf(ctx: ScenarioHookContext, pieceId: string, overlayId: string): Promise<string> {
  try {
    const data = await runTool<{ overlays?: Array<{ id: string; codeFilePath?: string }> }>(ctx.base, "libi.get_overlays", { pieceId });
    const hit = data.overlays?.find((o) => o.id === overlayId)?.codeFilePath;
    if (hit) return hit;
  } catch {
    /* fall through to the layout */
  }
  const found = findOverlayDir(ctx.home, pieceId, overlayId, 0);
  if (!found) throw new Error(`no code file for overlay ${overlayId} of piece ${pieceId} under ${ctx.home}`);
  const file = readdirSync(found).find((f) => statSync(join(found, f)).isFile());
  if (!file) throw new Error(`overlay dir ${found} holds no file`);
  return join(found, file);
}

function findOverlayDir(dir: string, pieceId: string, overlayId: string, depth: number): string | undefined {
  if (depth > 6) return undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  if (basename(dir) === overlayId && basename(join(dir, "..")) === "overlays" && basename(join(dir, "..", "..")) === pieceId) return dir;
  for (const n of names) {
    const sub = join(dir, n);
    try {
      if (!statSync(sub).isDirectory()) continue;
    } catch {
      continue;
    }
    const hit = findOverlayDir(sub, pieceId, overlayId, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

// ---------------------------------------------------------------- seed

export async function seed(ctx: ScenarioHookContext): Promise<{ placeholders: Record<string, string>; state: SeedState }> {
  const { base } = ctx;
  const p1 = ctx.pieceId;
  const style0 = KIT_STYLES[0];
  const pieceName = (s: KitStyle) => `Tidewater · ${s.name}`;

  const folder = (await call(base, "POST", "/api/folders", { name: FOLDER_NAME })) as { id?: string; folder?: { id: string } };
  const folderId = folder.id ?? folder.folder?.id;
  if (!folderId) throw new Error(`create folder returned no id: ${JSON.stringify(folder)}`);

  await call(base, "PATCH", `/api/pieces/${p1}`, { name: pieceName(style0), folderId });
  await call(base, "PATCH", `/api/pieces/${p1}/composition/dimensions`, { width: FRAME.width, height: FRAME.height });

  const introFileId = await upload(base, p1, fixture(ctx, "intro-clip-12s.mp4"), "Original clip");
  const narrationFileId = await upload(base, p1, fixture(ctx, "jfk.wav"), "Narration");
  const musicFileId = await upload(base, p1, fixture(ctx, "tidewater-lights-30s.m4a"), `${SONG.title} (song)`);
  // An upload is the user's own (`owned`); this one is a commercial song. A class other than
  // owned is not a user-only decision, so no page headers.
  await call(base, "PATCH", `/api/files/by-id/${musicFileId}/audio-rights`, { class: "copyrighted", track: { ...SONG } });

  const video = await runTool<{ overlayId: string }>(base, "libi.add_overlay", {
    pieceId: p1,
    kind: "video",
    fileId: introFileId,
    startTime: 0,
    duration: T.introDur,
    trim: { start: 0, end: T.introDur },
    displayName: "Original clip",
  });
  const narration = await runTool<{ clipId?: string; clip?: { id: string } }>(base, "libi.audio_add_clip", {
    pieceId: p1,
    fileId: narrationFileId,
    kind: "standalone",
    startTime: T.narrStart,
    duration: T.narrDur,
    label: "narration",
  });
  const narrationClipId = narration.clipId ?? narration.clip?.id;
  if (!narrationClipId) throw new Error(`audio_add_clip returned no clip id: ${JSON.stringify(narration)}`);
  const caption = await runTool<{ overlayId: string }>(base, "libi.add_overlay", {
    pieceId: p1,
    kind: "code",
    startTime: T.captionStart,
    duration: T.captionDur,
    rect: { x: 0, y: 0, width: FRAME.width, height: FRAME.height },
    body: captionBody(style0, T.narrStart, T.narrStart + T.narrDur),
    displayName: "Caption",
    z: 2,
  });
  const endCard = await runTool<{ overlayId: string }>(base, "libi.add_overlay", {
    pieceId: p1,
    kind: "code",
    startTime: T.endStart,
    duration: T.endDur,
    rect: { x: 0, y: 0, width: FRAME.width, height: FRAME.height },
    body: endCardBody(style0),
    displayName: "End card",
    z: 3,
  });
  await call(base, "POST", `/api/pieces/${p1}/snapshot/commit`, { summary: "Seeded piece 01" });

  const pieces: PieceSeed[] = [{ pieceId: p1, name: pieceName(style0), styleIndex: 0, narrationFileId, musicFileId }];
  for (const [styleIndex, style] of KIT_STYLES.entries()) {
    if (styleIndex === 0) continue;
    const name = pieceName(style);
    const dup = (await call(base, "POST", `/api/pieces/${p1}/duplicate`, { name, folderId, source: "snapshot" })) as { pieceId: string; jobId: string };
    await waitForJob(base, dup.jobId);
    // The duplicate shares every id with piece 01, bodies included; this piece's own style goes
    // into its two body files (a body is only ever edited as a file — update_overlay takes no code).
    writeFileSync(await codeFileOf(ctx, dup.pieceId, caption.overlayId), captionBody(style, T.narrStart, T.narrStart + T.narrDur));
    writeFileSync(await codeFileOf(ctx, dup.pieceId, endCard.overlayId), endCardBody(style));
    await call(base, "POST", `/api/pieces/${dup.pieceId}/snapshot/commit`, { summary: "Seeded style" });
    const files = (await call(base, "GET", `/api/pieces/${dup.pieceId}/files`)) as { files: Array<{ id: string; name: string | null; filename: string }> };
    const byName = (n: string) => files.files.find((f) => f.name === n)?.id;
    const nId = byName("Narration");
    const mId = byName(`${SONG.title} (song)`);
    if (!nId || !mId) throw new Error(`duplicate ${name} is missing its files: ${JSON.stringify(files.files.map((f) => f.name))}`);
    pieces.push({ pieceId: dup.pieceId, name, styleIndex, narrationFileId: nId, musicFileId: mId });
  }

  return {
    placeholders: { folder: FOLDER_NAME },
    state: {
      folderId,
      videoOverlayId: video.overlayId,
      captionOverlayId: caption.overlayId,
      endCardOverlayId: endCard.overlayId,
      narrationClipId,
      pieces,
    },
  };
}

// ---------------------------------------------------------------- verify: model

interface Keyframed {
  keyframes?: Array<{ t: number; value: number }>;
}
interface Clip {
  id: string;
  kind: "inline" | "standalone";
  fileId: string;
  startTime: number;
  duration: number;
  volume: number;
  /** Static gain in dB (absent = 0): the agent-speed gain model. */
  gainDb?: number;
  /** Volume envelope: `t` seconds from the clip's start, `value` a dB offset. */
  volumeKeyframes?: Keyframed;
  enabled: boolean;
  linkedOverlayId?: string;
  duck?: { sidechainClipIds?: string[]; sidechainClipId?: string; reductionDb?: number };
}
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Overlay {
  id: string;
  kind: string;
  displayName?: string;
  startTime: number;
  duration: number;
  rect?: Rect;
  fileId?: string;
  trim?: { start: number; end: number };
  drawFunction?: string;
  content?: string;
  color?: string;
  keyframes?: { rect?: { keyframes?: Array<{ t: number; value: Rect }> } };
}
type Manifest = { overlays?: Overlay[]; audioClips?: Clip[] };

const TOL = 0.15;
/** The caption must be within this many seconds of a word's start and end ("within 0.1 s"). */
export const WORD_SLOP = 0.09;
const near = (a: number | undefined, b: number, tol = TOL) => typeof a === "number" && Math.abs(a - b) <= tol;
const end = (x: { startTime: number; duration: number }) => x.startTime + x.duration;
const f2 = (x: number | undefined) => (typeof x === "number" ? x.toFixed(2) : String(x));
const db = (lin: number) => (lin <= 0 ? -Infinity : 20 * Math.log10(lin));
const fdb = (lin: number) => (lin <= 0 ? "-inf dB" : `${db(lin).toFixed(1)} dB`);

/** A clip's volume envelope's dB offset `localSec` seconds in: linear in dB between keys, held outside. */
function envelopeDb(c: Clip, localSec: number): number {
  const keys = [...(c.volumeKeyframes?.keyframes ?? [])].sort((a, b) => a.t - b.t);
  if (keys.length === 0) return 0;
  if (localSec <= keys[0].t) return keys[0].value;
  const last = keys[keys.length - 1];
  if (localSec >= last.t) return last.value;
  for (let i = 1; i < keys.length; i++) {
    if (localSec <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      return a.value + ((b.value - a.value) * (localSec - a.t)) / (b.t - a.t || 1);
    }
  }
  return 0;
}

/** The music's linear level at `t`: each covering clip's volume × gainDb × envelope × its duck reduction while a sidechain clip plays. */
export function musicLevelAt(t: number, music: Clip[], all: Clip[]): number {
  let level = 0;
  for (const c of music) {
    if (!c.enabled || t < c.startTime || t >= end(c)) continue;
    let gain = c.volume * 10 ** ((c.gainDb ?? 0) / 20) * 10 ** (envelopeDb(c, t - c.startTime) / 20);
    const sidechain = c.duck?.sidechainClipIds ?? (c.duck?.sidechainClipId ? [c.duck.sidechainClipId] : []);
    const reduction = c.duck?.reductionDb ?? 0;
    if (reduction < 0 && all.some((s) => sidechain.includes(s.id) && s.enabled && t >= s.startTime && t < end(s))) {
      gain *= 10 ** (reduction / 20);
    }
    level += gain;
  }
  return level;
}

// ---------------------------------------------------------------- verify: running a body

interface BodyRun {
  texts: string[];
  error?: string;
}

/** A canvas that records the text it is asked to draw and swallows everything else. */
function recordingCtx(texts: string[]): unknown {
  const store: Record<string, unknown> = { globalAlpha: 1, lineWidth: 1, shadowBlur: 0, font: "10px sans-serif" };
  const noop = () => undefined;
  return new Proxy(store, {
    get(target, prop: string) {
      if (prop === "fillText" || prop === "strokeText") return (s: unknown) => void texts.push(String(s));
      if (prop === "measureText") return (s: unknown) => ({ width: String(s).length * 12 });
      if (prop === "createLinearGradient" || prop === "createRadialGradient" || prop === "createConicGradient" || prop === "createPattern") {
        return () => ({ addColorStop: noop });
      }
      return prop in target ? target[prop] : noop;
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  });
}

/** The names the runtime injects into every code body (keys of `DRAW_HELPERS`, lib/engine/draw-helpers.ts). */
const INJECTED_HELPERS = [
  "interpolate", "spring", "linear", "easeIn", "easeOut", "easeInOut", "easeInCubic", "easeOutCubic", "easeInOutCubic",
  "easeInBack", "easeOutBack", "easeOutElastic", "stagger", "drawSvg", "drawRoundedRect", "drawGradient", "drawTextBlock",
  "drawCircle", "loadImage", "svgToImage", "nearestBeat", "beatPulse", "cumulativeLabel", "currentWord", "activeWordIndex",
  "fadeWordsAlphaByTime", "typewriterRevealedText", "typewriterVisibleGlyphCount",
];

/** Compile a body once; run it at composition time `tc`. The draw context carries every field the runtime may offer, composition time included. */
function compileBody(body: string): ((o: Overlay, tc: number, pieceDuration: number) => BodyRun) | { error: string } {
  let fn: (context: unknown) => void;
  try {
    // As the runtime builds it (lib/ai/scene-validator.ts#createDrawFunction): the helper bag's names are PARAMETERS, so a body
    // that declares one of them again (`const easeOut`) fails to compile — which a bare `new Function(body)` would not catch.
    const stub = () => undefined;
    const factory = new Function(...INJECTED_HELPERS, "context", body) as (...a: unknown[]) => void;
    fn = (context) => factory(...INJECTED_HELPERS.map(() => stub), context);
  } catch (e) {
    return { error: `does not compile: ${(e as Error).message}` };
  }
  return (o, tc, pieceDuration) => {
    const texts: string[] = [];
    if (tc < o.startTime || tc >= end(o)) return { texts };
    const local = tc - o.startTime;
    const fps = 30;
    try {
      fn({
        ctx: recordingCtx(texts),
        width: o.rect?.width ?? FRAME.width,
        height: o.rect?.height ?? FRAME.height,
        fps,
        frame: Math.round(local * fps),
        time: local,
        totalFrames: Math.round(o.duration * fps),
        duration: o.duration,
        progress: o.duration > 0 ? local / o.duration : 0,
        images: {},
        compositionTime: tc,
        overlayStart: o.startTime,
        pieceDuration,
      });
      return { texts };
    } catch (e) {
      return { texts, error: (e as Error).message };
    }
  };
}

// ---------------------------------------------------------------- verify: checks

const hex = (c: string | undefined) => (c ?? "").trim().toLowerCase();
const inFrame = (r: Rect) => r.x >= -1 && r.y >= -1 && r.x + r.width <= FRAME.width + 1 && r.y + r.height <= FRAME.height + 1;

/** All checks for one piece's composition. Exported for tests. */
export function checkPiece(
  manifest: Manifest,
  ids: Pick<SeedState, "videoOverlayId" | "captionOverlayId" | "endCardOverlayId" | "narrationClipId">,
  piece: Pick<PieceSeed, "name" | "narrationFileId" | "styleIndex">,
): StateCheck[] {
  const overlays = manifest.overlays ?? [];
  const clips = manifest.audioClips ?? [];
  const palette = new Set(Object.values(KIT_STYLES[piece.styleIndex].palette).map(hex));
  const out: StateCheck[] = [];
  const check = (name: string, pass: boolean, detail: string) => out.push({ name: `${piece.name}: ${name}`, pass, detail });

  const video = overlays.find((o) => o.id === ids.videoOverlayId) ?? overlays.find((o) => o.kind === "video");
  const caption = overlays.find((o) => o.id === ids.captionOverlayId) ?? overlays.find((o) => o.displayName === "Caption");
  const endCard = overlays.find((o) => o.id === ids.endCardOverlayId) ?? overlays.find((o) => o.displayName === "End card");
  const narration =
    clips.find((c) => c.id === ids.narrationClipId) ?? clips.find((c) => c.fileId === piece.narrationFileId && c.kind === "standalone");

  // ---- turn 1: the +3 s, and the caption staying in sync
  const introEnd = T.introDur + T.extendBy;
  check(
    "intro is 3 s longer",
    !!video && near(video.startTime, 0) && near(video.duration, introEnd) && (!video.trim || near(video.trim.end - video.trim.start, video.duration)),
    video ? `video ${f2(video.startTime)}+${f2(video.duration)} trim ${video.trim ? `${f2(video.trim.start)}–${f2(video.trim.end)}` : "none"}` : "no video overlay",
  );
  const inline = clips.find((c) => c.kind === "inline" && !!video && c.linkedOverlayId === video.id);
  check(
    "intro's own sound follows the intro",
    !inline || !inline.enabled || (near(inline.startTime, 0) && near(end(inline), introEnd)),
    inline ? `inline clip ${f2(inline.startTime)}+${f2(inline.duration)}${inline.enabled ? "" : " (disabled)"}` : "no inline clip",
  );
  check(
    "narration shifted +3 s",
    !!narration && narration.enabled && near(narration.startTime, T.narrStart + T.extendBy) && near(narration.duration, T.narrDur),
    narration ? `narration ${f2(narration.startTime)}+${f2(narration.duration)}${narration.enabled ? "" : " (disabled)"}` : "no narration clip",
  );
  check(
    "end card shifted +3 s",
    !!endCard && near(endCard.startTime, T.endStart + T.extendBy) && near(endCard.duration, T.endDur),
    endCard ? `end card ${f2(endCard.startTime)}+${f2(endCard.duration)}` : "no end card overlay",
  );

  const pieceEnd = Math.max(0, ...overlays.map(end), ...clips.filter((c) => c.enabled && !isMusic(c, narration, piece)).map(end));

  // ---- the caption: run its body at word edges, with the narration's real position
  if (caption?.kind === "code" && caption.drawFunction && narration) {
    const compiled = compileBody(caption.drawFunction);
    if ("error" in compiled) {
      check("caption body runs without throwing", false, compiled.error);
      check("captions stay in sync with the narration", false, "caption body does not compile");
    } else {
      const bad: string[] = [];
      let thrown: string | undefined;
      const shows = (tc: number, word: string) => {
        const r = compiled(caption, tc, pieceEnd);
        thrown ??= r.error;
        return r.texts.includes(word);
      };
      for (const [s, e, word] of WORDS) {
        const ws = narration.startTime + s;
        const we = narration.startTime + e;
        if (!shows(ws + WORD_SLOP, word)) bad.push(`"${word}" not up ${f2(WORD_SLOP)} s after it starts (${f2(ws)})`);
        if (shows(ws - WORD_SLOP, word)) bad.push(`"${word}" already up ${f2(WORD_SLOP)} s before it starts (${f2(ws)})`);
        if (!shows(we - WORD_SLOP, word)) bad.push(`"${word}" gone ${f2(WORD_SLOP)} s before it ends (${f2(we)})`);
        if (shows(we + WORD_SLOP, word)) bad.push(`"${word}" still up ${f2(WORD_SLOP)} s after it ends (${f2(we)})`);
      }
      check("caption body runs without throwing", !thrown, thrown ?? "ran at every word edge");
      check(
        "captions stay in sync with the narration",
        bad.length === 0,
        bad.length === 0
          ? `all ${WORDS.length} words start and end within ${f2(WORD_SLOP)} s of the narration (starts ${f2(narration.startTime)})`
          : `${bad.length} edge(s) off, e.g. ${bad.slice(0, 3).join("; ")}`,
      );
    }
  } else if (!narration) {
    check("captions stay in sync with the narration", false, "no narration clip to sync to");
  } else if (!caption || caption.kind !== "code" || !caption.drawFunction) {
    check("captions stay in sync with the narration", false, "no code caption body to run");
  }
  if (endCard?.kind === "code" && endCard.drawFunction) {
    const compiled = compileBody(endCard.drawFunction);
    if ("error" in compiled) check("end card body runs without throwing", false, compiled.error);
    else {
      const errs = [0.5, 2, 3.5]
        .map((dt) => compiled(endCard, endCard.startTime + dt, pieceEnd).error)
        .filter((e): e is string => !!e);
      check("end card body runs without throwing", errs.length === 0, errs[0] ?? "ran at 3 times");
    }
  } else {
    check("end card body runs without throwing", false, endCard ? `end card is ${endCard.kind}, no code body` : "no end card overlay");
  }

  // ---- turn 2: the song
  const music = clips.filter((c) => isMusic(c, narration, piece));
  const audible = music.filter((c) => c.enabled && c.volume > 0);
  const firstStart = audible.length ? Math.min(...audible.map((c) => c.startTime)) : NaN;
  const gaps: string[] = [];
  for (let i = 0; introEnd + 0.25 + i * 0.1 <= pieceEnd - 0.25; i++) {
    const t = introEnd + 0.25 + i * 0.1;
    if (musicLevelAt(t, music, clips) <= 0.0005) gaps.push(t.toFixed(2));
  }
  check(
    "song plays from the intro's end to the piece's end",
    audible.length > 0 && near(firstStart, introEnd, 0.5) && gaps.length === 0,
    `${music.length} music clip(s) [${music.map((c) => `${f2(c.startTime)}+${f2(c.duration)} v${f2(c.volume)}${c.gainDb ? ` ${c.gainDb}dB` : ""}${c.enabled ? "" : " off"}`).join(", ")}], piece ends ${f2(pieceEnd)}${gaps.length ? `, silent at ${gaps.slice(0, 5).join(", ")}${gaps.length > 5 ? "…" : ""}` : ""}`,
  );

  const ns = narration ? narration.startTime : T.narrStart + T.extendBy;
  const es = endCard ? endCard.startTime : T.endStart + T.extendBy;
  const endLevels = [1.5, 3].map((dt) => musicLevelAt(es + dt, music, clips));
  const narrLevels = [2, T.narrDur / 2, T.narrDur - 2].map((dt) => musicLevelAt(ns + dt, music, clips));
  const endOk = endLevels.every((l) => l > 0 && db(l) >= -1 && db(l) <= 3);
  check(
    "song over the end card is at full level (~0 dB)",
    endOk,
    `end card levels ${endLevels.map(fdb).join(", ")} at +1.5 s and +3 s into the card (−1 … +3 dB wanted)`,
  );
  const refEnd = Math.min(...endLevels);
  const rel = narrLevels.map((l) => (l > 0 && refEnd > 0 ? db(l) - db(refEnd) : -Infinity));
  check(
    "song is 10 dB under the narration",
    rel.every((r) => Number.isFinite(r) && r >= -11.5 && r <= -8.5),
    `under the narration ${rel.map((r) => (Number.isFinite(r) ? `${r.toFixed(1)} dB` : "silent")).join(", ")} relative to the end card, at 2 s / mid / 2 s from the end (−10 ±1.5 wanted)`,
  );

  // ---- turn 3: the closing card
  const layers = overlays.filter(
    (o) => (o.displayName ?? "").startsWith("Closing") || (o.kind === "text" && (Object.values(CARD_TEXT) as string[]).includes(o.content ?? "")),
  );
  const textLayers = layers.filter((o) => o.kind === "text");
  const byText = (s: string) => textLayers.filter((o) => (o.content ?? "").trim() === s);
  const wanted = Object.entries(CARD_TEXT).map(([k, s]) => ({ k, s, hits: byText(s) }));
  check(
    "closing card applied once, with the asked text",
    wanted.every((w) => w.hits.length === 1),
    wanted.map((w) => `${w.k}: ${w.hits.length === 1 ? "ok" : `${w.hits.length} layer(s) say "${w.s}"`}`).join("; ") + `; ${layers.length} template layer(s) in all`,
  );
  const off: string[] = [];
  for (const l of layers) {
    const rects: Array<[string, Rect]> = [];
    if (l.rect) rects.push(["rect", l.rect]);
    for (const k of l.keyframes?.rect?.keyframes ?? []) rects.push([`keyframe t=${f2(k.t)}`, k.value]);
    for (const [what, r] of rects) if (!inFrame(r)) off.push(`${l.displayName ?? l.id} ${what} ${f2(r.x)},${f2(r.y)} ${f2(r.width)}×${f2(r.height)}`);
  }
  check(
    "closing card layers sit inside the 9:16 frame",
    layers.length > 0 && off.length === 0,
    layers.length === 0 ? "no closing card layers" : off.length ? `${off.length} outside ${FRAME.width}×${FRAME.height}: ${off.slice(0, 3).join("; ")}` : `${layers.length} layers, rects and keyframes inside ${FRAME.width}×${FRAME.height}`,
  );
  // A keyframed rect pins ABSOLUTE values: moving the layer without its keyframes snaps it back to the old spot.
  const strays: string[] = [];
  for (const l of layers) {
    if (!l.rect) continue;
    const cx = l.rect.x + l.rect.width / 2;
    const cy = l.rect.y + l.rect.height / 2;
    for (const k of l.keyframes?.rect?.keyframes ?? []) {
      const d = Math.hypot(k.value.x + k.value.width / 2 - cx, k.value.y + k.value.height / 2 - cy);
      if (d > 150) strays.push(`${l.displayName ?? l.id} keyframe t=${f2(k.t)} is ${Math.round(d)} px from its layer`);
    }
  }
  check("keyframed closing card layers move with their keyframes", strays.length === 0, strays.length ? strays.slice(0, 3).join("; ") : "every keyframe rect is next to its layer");
  const winStart = es;
  const winEnd = es + T.endDur;
  const late = layers.filter((l) => l.startTime < winStart - 0.3 || end(l) > winEnd + 0.3);
  check(
    "closing card sits over the end card",
    layers.length > 0 && late.length === 0,
    layers.length === 0 ? "no closing card layers" : late.length ? `${late.length} outside ${f2(winStart)}–${f2(winEnd)}: ${late.slice(0, 3).map((l) => `${l.displayName ?? l.id} ${f2(l.startTime)}+${f2(l.duration)}`).join("; ")}` : `${layers.length} layers inside ${f2(winStart)}–${f2(winEnd)}`,
  );
  const wrong = textLayers.filter((l) => !palette.has(hex(l.color)));
  check(
    "closing card is in this piece's own style",
    textLayers.length > 0 && wrong.length === 0,
    textLayers.length === 0
      ? "no closing card text layers"
      : wrong.length
        ? `${wrong.length}/${textLayers.length} text layers outside the ${KIT_STYLES[piece.styleIndex].name} palette [${[...palette].join(" ")}]: ${wrong.slice(0, 3).map((l) => `${l.displayName ?? l.id} ${l.color}`).join("; ")}`
        : `${textLayers.length} text layers all in the palette`,
  );
  return out;
}

/** A music clip: standalone, not a video's own sound, not the narration. */
function isMusic(c: Clip, narration: Clip | undefined, piece: Pick<PieceSeed, "narrationFileId">): boolean {
  return c.kind === "standalone" && !c.linkedOverlayId && c.id !== narration?.id && c.fileId !== piece.narrationFileId;
}

/** Two real frames per piece through the renderer: the end card's middle and a caption word. Body failures land in `renderDiagnostics`. */
async function renderDiagnostics(base: string, pieceId: string, manifest: Manifest, ids: SeedState): Promise<StateCheck["detail"] & string> {
  const overlays = manifest.overlays ?? [];
  const end0 = overlays.find((o) => o.id === ids.endCardOverlayId);
  const narration = (manifest.audioClips ?? []).find((c) => c.id === ids.narrationClipId);
  const atTimes = [end0 ? end0.startTime + 2 : T.endStart + T.extendBy + 2, (narration ? narration.startTime : T.narrStart + T.extendBy) + 5.5];
  const res = await call(base, "POST", "/api/render/frames", { pieceId, atTimes });
  const r = res as { renderDiagnostics?: Array<{ message?: string; overlayId?: string; time?: number }> };
  const d = r.renderDiagnostics ?? [];
  const g = (await call(base, "GET", `/api/pieces/${pieceId}/render-diagnostics`)) as { diagnostics?: unknown[]; unattributed?: unknown[] };
  const all = [...d, ...(g.diagnostics ?? []), ...(g.unattributed ?? [])];
  return all.length === 0 ? "no diagnostics" : `${all.length} diagnostic(s): ${JSON.stringify(all[0]).slice(0, 300)}`;
}

export async function verify(ctx: ScenarioHookContext & { state: unknown }): Promise<StateCheck[]> {
  const state = ctx.state as SeedState;
  const out: StateCheck[] = [];
  for (const p of state.pieces) {
    let manifest: Manifest | undefined;
    try {
      const comp = (await call(ctx.base, "GET", `/api/pieces/${p.pieceId}/composition`)) as { manifest: Manifest };
      manifest = comp.manifest;
      out.push(...checkPiece(manifest, state, p));
    } catch (e) {
      out.push({ name: `${p.name}: composition readable`, pass: false, detail: (e as Error).message });
    }
    if (manifest) {
      try {
        const detail = await renderDiagnostics(ctx.base, p.pieceId, manifest, state);
        out.push({ name: `${p.name}: renders without body errors`, pass: detail === "no diagnostics", detail });
      } catch (e) {
        out.push({ name: `${p.name}: renders without body errors`, pass: false, detail: `render failed: ${(e as Error).message}` });
      }
    }
  }
  const failed = out.filter((c) => !c.pass);
  out.unshift({
    name: `all ${state.pieces.length} pieces right`,
    pass: failed.length === 0,
    detail: failed.length ? `${failed.length} check(s) failed` : "every check passed",
  });
  return out;
}
