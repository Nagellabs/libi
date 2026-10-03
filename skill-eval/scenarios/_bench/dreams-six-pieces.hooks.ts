/**
 * Seed and verify hooks for `_bench/dreams-six-pieces.md` — the agent-speed benchmark modelled
 * on the 2026-10-02 "Dreams × Ocean Spray — 6 styles" session
 * (docs-local/research/2026-10-03-dreams-session-analysis.md).
 *
 * SEED builds, through the studio's own routes and `/api/e2e/run-tool` (the agent's tool
 * functions, validated exactly as an agent's call is), a folder of six 9:16 pieces that are
 * duplicates of one another — so, like the real six, they share every overlay and clip id:
 *
 *   0.0 – 5.0   intro video overlay (12 s source clip WITH audio, trimmed to 0–5; inline clip)
 *   5.3 – 16.3  narration (standalone audio clip, 11 s speech)
 *   5.3 – 16.3  caption text overlay (its colour differs per piece: the "style")
 *  16.5 – 20.5  end card (code overlay)
 *               + a 30 s song in each piece's files, NOT on the timeline, stamped
 *                 copyrighted with a track title so the rights paths run.
 *
 * VERIFY asserts OUTCOMES on all six pieces, never a tool sequence, using only what today's
 * tools can express: intro +3 s with everything after it shifted; the song from the intro's
 * end to the piece's end; ducked under the narration (a duck keyed on it, or a lower bed
 * under it); and over the end card at full level and no quieter than under the narration.
 *
 * HTTP only: nothing here may import `@/lib` (see ScenarioHooks in scripts/skill-eval/types.ts).
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ScenarioHookContext, StateCheck } from "../../../scripts/skill-eval/types";

export const FOLDER_NAME = "Tidewater Lights — 6 styles";
export const SONG = { title: "Tidewater Lights", artist: "The Bench Band" } as const;

/** The original timeline (seconds). */
export const T = {
  introDur: 5,
  narrStart: 5.3,
  narrDur: 11,
  captionStart: 5.3,
  captionDur: 11,
  endStart: 16.5,
  endDur: 4,
  /** What the user asks the intro to grow by. */
  extendBy: 3,
} as const;

const STYLES = [
  { name: "01 Neon", color: "#39FF14" },
  { name: "02 Paper", color: "#1F2A44" },
  { name: "03 Chrome", color: "#C0C7D1" },
  { name: "04 Sunset", color: "#FF7A45" },
  { name: "05 Mono", color: "#FFFFFF" },
  { name: "06 Pastel", color: "#F5B8D1" },
] as const;

const END_CARD_BODY = `const { ctx, width: W, height: H, progress } = context;
const a = Math.min(1, progress * 4);
ctx.fillStyle = '#0B1E3A';
ctx.fillRect(0, 0, W, H);
ctx.globalAlpha = a;
ctx.fillStyle = '#FFFFFF';
ctx.textAlign = 'center';
ctx.font = '700 ' + Math.round(W * 0.09) + 'px sans-serif';
ctx.fillText('Made with libi', W / 2, H * 0.48);
ctx.font = '400 ' + Math.round(W * 0.045) + 'px sans-serif';
ctx.fillText('npx @nagellabs/libi', W / 2, H * 0.56);
ctx.globalAlpha = 1;
`;

interface PieceSeed {
  pieceId: string;
  name: string;
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
  if (!hit) throw new Error(`dreams bench: fixture ${name} was not staged (got ${ctx.fixtures.map((p) => basename(p)).join(", ")})`);
  return hit;
};

// ---------------------------------------------------------------- seed

export async function seed(ctx: ScenarioHookContext): Promise<{ placeholders: Record<string, string>; state: SeedState }> {
  const { base } = ctx;
  const p1 = ctx.pieceId;

  const folder = (await call(base, "POST", "/api/folders", { name: FOLDER_NAME })) as { id?: string; folder?: { id: string } };
  const folderId = folder.id ?? folder.folder?.id;
  if (!folderId) throw new Error(`create folder returned no id: ${JSON.stringify(folder)}`);

  await call(base, "PATCH", `/api/pieces/${p1}`, { name: `Tidewater · ${STYLES[0].name}`, folderId });
  await call(base, "PATCH", `/api/pieces/${p1}/composition/dimensions`, { width: 1080, height: 1920 });

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
    kind: "text",
    startTime: T.captionStart,
    duration: T.captionDur,
    rect: { x: 90, y: 1500, width: 900, height: 220 },
    content: "Ask not what your country can do for you",
    color: STYLES[0].color,
    displayName: "Caption",
    z: 2,
  });
  const endCard = await runTool<{ overlayId: string }>(base, "libi.add_overlay", {
    pieceId: p1,
    kind: "code",
    startTime: T.endStart,
    duration: T.endDur,
    rect: { x: 0, y: 0, width: 1080, height: 1920 },
    body: END_CARD_BODY,
    displayName: "End card",
    z: 3,
  });
  await call(base, "POST", `/api/pieces/${p1}/snapshot/commit`, { summary: "Seeded piece 01" });

  const pieces: PieceSeed[] = [{ pieceId: p1, name: `Tidewater · ${STYLES[0].name}`, narrationFileId, musicFileId }];
  for (const style of STYLES.slice(1)) {
    const name = `Tidewater · ${style.name}`;
    const dup = (await call(base, "POST", `/api/pieces/${p1}/duplicate`, { name, folderId, source: "snapshot" })) as { pieceId: string; jobId: string };
    await waitForJob(base, dup.jobId);
    await runTool(base, "libi.update_overlay", { pieceId: dup.pieceId, overlayId: caption.overlayId, color: style.color });
    await call(base, "POST", `/api/pieces/${dup.pieceId}/snapshot/commit`, { summary: "Seeded style" });
    const files = (await call(base, "GET", `/api/pieces/${dup.pieceId}/files`)) as { files: Array<{ id: string; name: string | null; filename: string }> };
    const byName = (n: string) => files.files.find((f) => f.name === n)?.id;
    const nId = byName("Narration");
    const mId = byName(`${SONG.title} (song)`);
    if (!nId || !mId) throw new Error(`duplicate ${name} is missing its files: ${JSON.stringify(files.files.map((f) => f.name))}`);
    pieces.push({ pieceId: dup.pieceId, name, narrationFileId: nId, musicFileId: mId });
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

// ---------------------------------------------------------------- verify

interface Clip {
  id: string;
  kind: "inline" | "standalone";
  fileId: string;
  startTime: number;
  duration: number;
  volume: number;
  /** B3: static gain in dB and a volume envelope (clip-local seconds, dB offsets), both on top of `volume`. */
  gainDb?: number;
  volumeKeyframes?: { keyframes: { t: number; value: number }[] };
  enabled: boolean;
  linkedOverlayId?: string;
  duck?: { sidechainClipIds?: string[]; sidechainClipId?: string; reductionDb?: number };
}
interface Overlay {
  id: string;
  kind: string;
  startTime: number;
  duration: number;
  fileId?: string;
  trim?: { start: number; end: number };
}

const TOL = 0.15;
const near = (a: number | undefined, b: number, tol = TOL) => typeof a === "number" && Math.abs(a - b) <= tol;
const end = (x: { startTime: number; duration: number }) => x.startTime + x.duration;
const f2 = (x: number | undefined) => (typeof x === "number" ? x.toFixed(2) : String(x));

/** The envelope's dB offset `local` seconds into a clip: linear between keys (easing ignored), held at the ends. */
function envelopeDb(c: Clip, local: number): number {
  const keys = [...(c.volumeKeyframes?.keyframes ?? [])].sort((a, b) => a.t - b.t);
  if (keys.length === 0) return 0;
  if (local <= keys[0].t) return keys[0].value;
  const last = keys[keys.length - 1];
  if (local >= last.t) return last.value;
  const i = keys.findIndex((k, j) => k.t <= local && local < keys[j + 1].t);
  const f = (local - keys[i].t) / (keys[i + 1].t - keys[i].t);
  return keys[i].value + (keys[i + 1].value - keys[i].value) * f;
}

/** The music level at `t`: each covering music clip's volume × gainDb × volume envelope × its duck reduction while a sidechain clip plays. */
export function musicLevelAt(t: number, music: Clip[], all: Clip[]): number {
  let level = 0;
  for (const c of music) {
    if (!c.enabled || t < c.startTime || t >= end(c)) continue;
    let gain = c.volume * 10 ** (((c.gainDb ?? 0) + envelopeDb(c, t - c.startTime)) / 20);
    const sidechain = c.duck?.sidechainClipIds ?? (c.duck?.sidechainClipId ? [c.duck.sidechainClipId] : []);
    const reduction = c.duck?.reductionDb ?? 0;
    if (reduction < 0 && all.some((s) => sidechain.includes(s.id) && s.enabled && t >= s.startTime && t < end(s))) {
      gain *= 10 ** (reduction / 20);
    }
    level += gain;
  }
  return level;
}

/** All checks for one piece's composition. Exported for the unit test. */
export function checkPiece(
  manifest: { overlays?: Overlay[]; audioClips?: Clip[] },
  ids: Pick<SeedState, "videoOverlayId" | "captionOverlayId" | "endCardOverlayId" | "narrationClipId">,
  piece: Pick<PieceSeed, "name" | "narrationFileId">,
): StateCheck[] {
  const overlays = manifest.overlays ?? [];
  const clips = manifest.audioClips ?? [];
  const out: StateCheck[] = [];
  const check = (name: string, pass: boolean, detail: string) => out.push({ name: `${piece.name}: ${name}`, pass, detail });

  const video = overlays.find((o) => o.id === ids.videoOverlayId) ?? overlays.find((o) => o.kind === "video");
  const caption = overlays.find((o) => o.id === ids.captionOverlayId) ?? overlays.find((o) => o.kind === "text");
  const endCard = overlays.find((o) => o.id === ids.endCardOverlayId) ?? overlays.find((o) => o.kind === "code");
  const narration =
    clips.find((c) => c.id === ids.narrationClipId) ?? clips.find((c) => c.fileId === piece.narrationFileId && c.kind === "standalone");

  const introEnd = T.introDur + T.extendBy;
  check(
    "intro is 3 s longer",
    !!video && near(video.startTime, 0) && near(video.duration, introEnd) && (!video.trim || near(video.trim.end - video.trim.start, video.duration)),
    video ? `video ${f2(video.startTime)}+${f2(video.duration)} trim ${video.trim ? `${f2(video.trim.start)}–${f2(video.trim.end)}` : "none"}` : "no video overlay",
  );
  check(
    "narration shifted +3 s",
    !!narration && narration.enabled && near(narration.startTime, T.narrStart + T.extendBy) && near(narration.duration, T.narrDur),
    narration ? `narration ${f2(narration.startTime)}+${f2(narration.duration)}${narration.enabled ? "" : " (disabled)"}` : "no narration clip",
  );
  check(
    "caption shifted +3 s",
    !!caption && near(caption.startTime, T.captionStart + T.extendBy) && near(caption.duration, T.captionDur),
    caption ? `caption ${f2(caption.startTime)}+${f2(caption.duration)}` : "no caption overlay",
  );
  check(
    "end card shifted +3 s",
    !!endCard && near(endCard.startTime, T.endStart + T.extendBy) && near(endCard.duration, T.endDur),
    endCard ? `end card ${f2(endCard.startTime)}+${f2(endCard.duration)}` : "no end card overlay",
  );

  // Music: every standalone clip that is neither the narration nor a video's own sound.
  const music = clips.filter(
    (c) => c.kind === "standalone" && !c.linkedOverlayId && c.id !== narration?.id && c.fileId !== piece.narrationFileId,
  );
  const pieceEnd = Math.max(0, ...overlays.map(end), ...clips.filter((c) => c.enabled).map(end));
  const audible = music.filter((c) => c.enabled && c.volume > 0);
  const firstStart = audible.length ? Math.min(...audible.map((c) => c.startTime)) : NaN;
  const gaps: string[] = [];
  for (let i = 0; introEnd + 0.25 + i * 0.1 <= pieceEnd - 0.25; i++) {
    const t = introEnd + 0.25 + i * 0.1;
    if (musicLevelAt(t, music, clips) <= 0) gaps.push(t.toFixed(2));
  }
  check(
    "song plays from the intro's end to the piece's end",
    audible.length > 0 && near(firstStart, introEnd, 0.5) && gaps.length === 0,
    `${music.length} music clip(s) [${music.map((c) => `${f2(c.startTime)}+${f2(c.duration)} v${f2(c.volume)}${c.enabled ? "" : " off"}`).join(", ")}], piece ends ${f2(pieceEnd)}${gaps.length ? `, silent at ${gaps.slice(0, 5).join(", ")}${gaps.length > 5 ? "…" : ""}` : ""}`,
  );

  const narrMid = (narration ? narration.startTime : T.narrStart + T.extendBy) + T.narrDur / 2;
  const endProbe = (endCard ? endCard.startTime : T.endStart + T.extendBy) + 1;
  const under = musicLevelAt(narrMid, music, clips);
  const overEnd = musicLevelAt(endProbe, music, clips);
  const keyed = music.some((c) => {
    if (!(c.startTime <= narrMid && narrMid < end(c)) || !c.duck || (c.duck.reductionDb ?? 0) >= 0) return false;
    const sc = c.duck.sidechainClipIds ?? (c.duck.sidechainClipId ? [c.duck.sidechainClipId] : []);
    return !!narration && sc.includes(narration.id);
  });
  const bed = under > 0 && under <= 0.7 * overEnd;
  check(
    "song ducks under the narration",
    under > 0 && (keyed || bed),
    `level under narration ${f2(under)} (${keyed ? "duck keyed on the narration" : bed ? "lower bed under the narration" : "not ducked"}), over the end card ${f2(overEnd)}`,
  );
  check(
    "song over the end card is no quieter than under the narration",
    overEnd > 0 && overEnd + 1e-6 >= under,
    `end card ${f2(overEnd)} vs under narration ${f2(under)}`,
  );
  check("song over the end card is at full level", overEnd >= 0.9, `end card level ${f2(overEnd)} (≥ 0.90 wanted)`);
  return out;
}

export async function verify(ctx: ScenarioHookContext & { state: unknown }): Promise<StateCheck[]> {
  const state = ctx.state as SeedState;
  const out: StateCheck[] = [];
  for (const p of state.pieces) {
    try {
      const comp = (await call(ctx.base, "GET", `/api/pieces/${p.pieceId}/composition`)) as { manifest: { overlays?: Overlay[]; audioClips?: Clip[] } };
      out.push(...checkPiece(comp.manifest, state, p));
    } catch (e) {
      out.push({ name: `${p.name}: composition readable`, pass: false, detail: (e as Error).message });
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
