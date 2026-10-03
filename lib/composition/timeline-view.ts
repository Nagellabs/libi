/**
 * The compact timeline view of a piece — `libi.get_composition({ view: "timeline" })`.
 *
 * One line per layer instead of the full manifest (~11 KB for a mid-sized piece): what an agent
 * needs to answer "what is where, how loud, and is it the same in the other five pieces?" without
 * reading `composition.json` or SQLite itself (Dreams session, pattern P7). Pure: callers load
 * the manifest and the file names; nothing here touches the database or the disk.
 *
 * Several pieces render as groups. The first piece is printed in full; every later piece prints
 * `<id> =` for a layer identical to the layer at the same place in the first piece, and the full
 * line plus `≠field,field` for one that differs — ids are never compared, they are different in
 * every piece (a link or a sidechain is compared by the position of what it points at).
 *
 * A video overlay and an audio clip also print `src <file length>s, <footage left after the trim end>s left`,
 * so an agent can size an `insert_time` / `extendTarget` without listing the files first.
 */
import type { CompositionManifest } from "./persistence";
import { pieceDurationSec } from "./duration";
import { sourceRoom } from "./ripple-insert";

/** What the formatter needs to know about a file a layer plays or shows. */
export interface TimelineFile {
  name: string;
  /** Audio rights class and track title, when the file carries audio rights. */
  rights?: { class: string; track?: string } | null;
  /** The file's own length in seconds (`files.mediaDuration`), when probed. */
  duration?: number | null;
}

export interface TimelinePieceInput {
  pieceId: string;
  name: string;
  manifest: CompositionManifest;
  hasDraft: boolean;
  /** Keyed by file id; a missing entry prints the id's tail instead of a name. */
  files: ReadonlyMap<string, TimelineFile>;
}

/** One printed layer. `fields` are in print order; `cmp` is the same value without ids, for the diff. */
interface Line {
  id: string;
  fields: { key: string; shown: string; cmp: string }[];
}

const NAME_MAX = 30;

/** Seconds with at most 2 decimals and no trailing zeros: `0`, `1.5`, `12.34`. */
export function sec(n: number): string {
  const v = Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
  return Object.is(v, -0) ? "0" : String(v);
}

function clean(text: string, max = NAME_MAX): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

type AnyOverlay = NonNullable<CompositionManifest["overlays"]>[number] & {
  displayName?: string;
  content?: string;
  fileId?: string;
  hidden?: boolean;
  effects?: { in?: { effectId?: string }; out?: { effectId?: string }; loop?: { effectId?: string } };
  keyframes?: Record<string, { keyframes?: unknown[] } | undefined>;
  caption?: unknown;
};

type AnyClip = NonNullable<CompositionManifest["audioClips"]>[number] & {
  effects?: AnyOverlay["effects"];
  enabled?: boolean;
};

function overlayName(o: AnyOverlay, files: TimelinePieceInput["files"]): string {
  if (o.displayName?.trim()) return clean(o.displayName);
  if (o.kind === "text" && o.content) return clean(o.content);
  if (o.fileId) return clean(files.get(o.fileId)?.name ?? `file …${o.fileId.slice(-6)}`);
  return "";
}

function effectsText(fx: AnyOverlay["effects"]): string {
  if (!fx) return "";
  const parts = (["in", "out", "loop"] as const).flatMap((slot) => {
    const id = fx[slot]?.effectId;
    return id ? [`${slot}=${id}`] : [];
  });
  return parts.length > 0 ? `fx:${parts.join(",")}` : "";
}

/**
 * `src 12s, 4s left`: the file's length and the footage after the layer's window (trim start + duration),
 * the same room `insert_time`'s `extendTarget` checks. Empty when the file's length is unknown.
 */
function sourceText(file: TimelineFile | undefined, trimStart: number, duration: number): string {
  const room = sourceRoom(file?.duration, trimStart, duration);
  return room === null ? "" : `src ${sec(file!.duration!)}s, ${sec(Math.max(0, room))}s left`;
}

/** Top layer first, like the editor's timeline; id breaks every remaining tie so the order is stable. */
function sortedOverlays(m: CompositionManifest): AnyOverlay[] {
  return [...(m.overlays ?? [])].map((o) => o as AnyOverlay).sort(
    (a, b) => b.z - a.z || a.startTime - b.startTime || a.id.localeCompare(b.id),
  );
}

function sortedClips(m: CompositionManifest): AnyClip[] {
  return [...((m.audioClips ?? []) as AnyClip[])].sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
}

function overlayLines(m: CompositionManifest, files: TimelinePieceInput["files"]): Line[] {
  const sorted = sortedOverlays(m);
  const clips = sortedClips(m);
  const positionOfClip = (id: string) => clips.findIndex((c) => c.id === id);
  return sorted.map((o) => {
    const clip = clips.find((c) => c.linkedOverlayId === o.id);
    const flags = [
      o.hidden ? "hidden" : "",
      effectsText(o.effects),
      Object.entries(o.keyframes ?? {}).some(([, v]) => (v?.keyframes?.length ?? 0) > 0)
        ? `kf:${Object.entries(o.keyframes ?? {}).filter(([, v]) => (v?.keyframes?.length ?? 0) > 0).map(([k]) => k).join(",")}`
        : "",
      o.caption ? "caption" : "",
    ].filter(Boolean).join(" ");
    const src = o.kind === "video" && o.fileId
      ? sourceText(files.get(o.fileId), (o as { trim?: { start: number } }).trim?.start ?? 0, o.duration)
      : "";
    return {
      id: o.id,
      fields: [
        { key: "kind", shown: o.kind, cmp: o.kind },
        { key: "time", shown: `${sec(o.startTime)}–${sec(o.startTime + o.duration)}`, cmp: `${sec(o.startTime)}–${sec(o.startTime + o.duration)}` },
        { key: "z", shown: `z${o.z}`, cmp: `z${o.z}` },
        { key: "name", shown: overlayName(o, files), cmp: overlayName(o, files) },
        { key: "src", shown: src, cmp: src },
        { key: "flags", shown: flags, cmp: flags },
        {
          key: "audio",
          shown: clip ? `audio:${clip.id}` : "",
          cmp: clip ? `audio:#${positionOfClip(clip.id)}` : "",
        },
      ],
    };
  });
}

function audioLines(m: CompositionManifest, files: TimelinePieceInput["files"]): Line[] {
  const sorted = sortedClips(m);
  const overlays = sortedOverlays(m);
  const positionOfClip = (id: string) => sorted.findIndex((c) => c.id === id);
  const positionOfOverlay = (id: string) => overlays.findIndex((o) => o.id === id);
  return sorted.map((c) => {
    const file = files.get(c.fileId);
    const name = clean(file?.name ?? `file …${c.fileId.slice(-6)}`);
    const sidechains = c.duck ? (c.duck.sidechainClipIds ?? (c.duck.sidechainClipId ? [c.duck.sidechainClipId] : [])) : [];
    const duckShown = c.duck ? `duck(${sidechains.join(",")} ${sec(c.duck.reductionDb)}dB)` : "";
    const duckCmp = c.duck ? `duck(${sidechains.map((s) => `#${positionOfClip(s)}`).join(",")} ${sec(c.duck.reductionDb)}dB)` : "";
    const fades = effectsText(c.effects).replace(/^fx:/, "fade:");
    const link = c.linkedOverlayId ? `${c.kind === "inline" ? "link" : "detached"}:${c.linkedOverlayId}` : "";
    const linkCmp = c.linkedOverlayId ? `${c.kind === "inline" ? "link" : "detached"}:#${positionOfOverlay(c.linkedOverlayId)}` : "";
    const rights = file?.rights ? `${file.rights.class}${file.rights.track ? `(${clean(file.rights.track, 24)})` : ""}` : "";
    const gain = typeof c.gainDb === "number" && c.gainDb !== 0 ? `gain${c.gainDb > 0 ? "+" : ""}${sec(c.gainDb)}dB` : "";
    // The volume envelope: clip-local seconds, dB offsets; past six keys the rest is counted, not listed.
    const keys = c.volumeKeyframes?.keyframes ?? [];
    const env = keys.length
      ? `env[${keys.slice(0, 6).map((k) => `${sec(k.t)}s:${sec(k.value)}`).join(" ")}${keys.length > 6 ? ` +${keys.length - 6}` : ""}]dB`
      : "";
    const xfade = typeof c.crossfadeMs === "number" && c.crossfadeMs > 0 ? `xfade${sec(c.crossfadeMs)}ms` : "";
    const src = sourceText(file, c.trimStart, c.duration);
    return {
      id: c.id,
      fields: [
        { key: "file", shown: name, cmp: name },
        { key: "time", shown: `${sec(c.startTime)}–${sec(c.startTime + c.duration)}`, cmp: `${sec(c.startTime)}–${sec(c.startTime + c.duration)}` },
        { key: "src", shown: src, cmp: src },
        { key: "vol", shown: `vol${sec(c.volume)}${c.enabled === false ? " off" : ""}`, cmp: `vol${sec(c.volume)}${c.enabled === false ? " off" : ""}` },
        { key: "gain", shown: gain, cmp: gain },
        { key: "env", shown: env, cmp: env },
        { key: "xfade", shown: xfade, cmp: xfade },
        { key: "duck", shown: duckShown, cmp: duckCmp },
        { key: "fades", shown: fades, cmp: fades },
        { key: "link", shown: link, cmp: linkCmp },
        { key: "rights", shown: rights, cmp: rights },
      ],
    };
  });
}

const printLine = (l: Line) => [l.id, ...l.fields.map((f) => f.shown).filter(Boolean)].join(" ");

/** The fields of `line` that differ from `ref` (all of them when there is no reference line). */
function differing(line: Line, ref: Line | undefined): string[] {
  if (!ref) return ["new"];
  const refByKey = new Map(ref.fields.map((f) => [f.key, f.cmp]));
  return line.fields.filter((f) => (refByKey.get(f.key) ?? "") !== f.cmp).map((f) => f.key);
}

interface PieceBlock {
  header: string;
  /** Header facts compared across pieces (duration, size, draft). */
  facts: string;
  overlays: Line[];
  audio: Line[];
}

function block(p: TimelinePieceInput): PieceBlock {
  const m = p.manifest;
  const facts = `${sec(pieceDurationSec(m))}s ${m.width}x${m.height} ${m.fps}fps ${p.hasDraft ? "draft" : "no draft"}`;
  return {
    header: `${p.name || "(unnamed)"} [${p.pieceId}] ${facts}, ${(m.overlays ?? []).length} overlays, ${(m.audioClips ?? []).length} audio`,
    facts,
    overlays: overlayLines(m, p.files),
    audio: audioLines(m, p.files),
  };
}

function section(label: string, lines: Line[], refLines: Line[] | null): string[] {
  if (lines.length === 0 && (!refLines || refLines.length === 0)) return [];
  const out = [`${label}:`];
  lines.forEach((l, i) => {
    if (!refLines) {
      out.push(`  ${printLine(l)}`);
      return;
    }
    const diff = differing(l, refLines[i]);
    out.push(diff.length === 0 ? `  ${l.id} =` : `  ${printLine(l)} ≠${diff.join(",")}`);
  });
  if (refLines && refLines.length > lines.length) out.push(`  (the first piece has ${refLines.length - lines.length} more)`);
  return out;
}

/**
 * The text view of one or several pieces. A single piece is printed in full; with several, the first
 * is the reference and the others are marked against it. The first line of a multi-piece view says
 * which pieces match the first one outright.
 */
export function renderTimeline(pieces: TimelinePieceInput[]): string {
  const blocks = pieces.map(block);
  const out: string[] = [];
  if (blocks.length === 0) return "";
  if (blocks.length === 1) {
    out.push(`piece ${blocks[0].header}`);
    out.push(...section("overlays (top layer first)", blocks[0].overlays, null));
    out.push(...section("audio", blocks[0].audio, null));
    return out.join("\n");
  }
  const first = blocks[0];
  const body: string[] = [];
  const same: string[] = [];
  const differs: string[] = [];
  blocks.forEach((b, i) => {
    const name = pieces[i].name || pieces[i].pieceId;
    if (i === 0) {
      body.push(`piece 1 (reference) ${b.header}`);
      body.push(...section("overlays (top layer first)", b.overlays, null));
      body.push(...section("audio", b.audio, null));
      return;
    }
    const sectionOverlays = section("overlays", b.overlays, first.overlays);
    const sectionAudio = section("audio", b.audio, first.audio);
    const marks = [...sectionOverlays, ...sectionAudio].filter((l) => l.includes(" ≠") || l.startsWith("  (the first")).length;
    const headerSame = b.facts === first.facts;
    if (marks === 0 && headerSame) same.push(name);
    else differs.push(`${name}${marks > 0 ? ` (${marks} line${marks === 1 ? "" : "s"})` : ""}${headerSame ? "" : " (header)"}`);
    body.push(`piece ${i + 1} ${b.header}${headerSame ? "" : "  ≠header"}`);
    body.push(...sectionOverlays);
    body.push(...sectionAudio);
  });
  out.push(
    `${blocks.length} pieces. ` +
      (differs.length === 0
        ? "All match the first piece (ids aside)."
        : `Match the first: ${same.length > 0 ? same.join(", ") : "none"}. Differ: ${differs.join(", ")}.`) +
      " `=` means the same as the first piece's line, `≠field` names what differs.",
  );
  out.push(...body);
  return out.join("\n");
}
