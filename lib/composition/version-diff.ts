import type {
  CompositionManifest,
  PersistedScene,
  PersistedOverlay,
  PersistedAudioClip,
} from "./persistence";

export type ChangeKind = "added" | "removed" | "changed" | "unchanged";

export interface SceneRef {
  id: string;
  name: string;
  type: "canvas" | "video";
  duration: number;
  /** Source file for video scenes; null for canvas scenes. */
  fileId: string | null;
}

export interface ChangedSceneRef extends SceneRef {
  /** Cheap, human reasons: "renamed", "duration changed", "trim changed", "draw changed". */
  reasons: string[];
}

export interface EntityRef {
  id: string;
  kind: string;
  /** Text snippet for text overlays, clip label/kind otherwise. */
  label: string;
}

export interface StripTile {
  id: string;
  name: string;
  type: "canvas" | "video";
  duration: number;
  fileId: string | null;
  changeKind: ChangeKind;
}

export interface EnrichedDiff {
  scenes: { added: SceneRef[]; removed: SceneRef[]; changed: ChangedSceneRef[] };
  overlays: { added: EntityRef[]; removed: EntityRef[]; changed: EntityRef[] };
  audioClips: { added: EntityRef[]; removed: EntityRef[]; changed: EntityRef[] };
  /** Ordered scenes of `newer` (with per-tile changeKind), then removed scenes as ghost tiles. */
  sceneStrip: StripTile[];
  totalChanges: number;
}

function sceneRef(s: PersistedScene): SceneRef {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    duration: s.duration,
    // Canvas scenes reference no file (video scenes, which did, were retired).
    fileId: null,
  };
}

function sceneReasons(a: PersistedScene, b: PersistedScene): string[] {
  const reasons: string[] = [];
  if (a.name !== b.name) reasons.push("renamed");
  if (a.duration !== b.duration) reasons.push("duration changed");
  if (a.drawFunction !== b.drawFunction) reasons.push("draw changed");
  return reasons;
}

function overlayLabel(o: PersistedOverlay): string {
  if (o.kind === "text") return o.content.slice(0, 40) || "text";
  if (o.kind === "image" || o.kind === "video") return o.kind;
  if (o.kind === "code") return "code";
  if (o.kind === "three") return "3d";
  // Tracked overlays carry their payload in `content`; surface the text so the
  // changelog shows what's tracked, not just the bare "tracked" kind.
  if (o.content.kind === "text") return `tracked: ${o.content.content.slice(0, 40)}`;
  return "tracked";
}

function clipLabel(c: PersistedAudioClip): string {
  return c.label ?? c.kind;
}

function entityDiff<T extends { id: string }>(
  older: T[],
  newer: T[],
  toRef: (t: T) => EntityRef,
): { added: EntityRef[]; removed: EntityRef[]; changed: EntityRef[] } {
  const ma = new Map(older.map((x) => [x.id, x]));
  const mb = new Map(newer.map((x) => [x.id, x]));
  const added = newer.filter((x) => !ma.has(x.id)).map(toRef);
  const removed = older.filter((x) => !mb.has(x.id)).map(toRef);
  const changed = newer
    .filter((x) => ma.has(x.id) && JSON.stringify(ma.get(x.id)) !== JSON.stringify(x))
    .map(toRef);
  return { added, removed, changed };
}

export function diffManifests(older: CompositionManifest, newer: CompositionManifest): EnrichedDiff {
  const oScenes = older.scenes ?? [];
  const nScenes = newer.scenes ?? [];
  const oById = new Map(oScenes.map((s) => [s.id, s]));
  const nById = new Map(nScenes.map((s) => [s.id, s]));

  const added = nScenes.filter((s) => !oById.has(s.id)).map(sceneRef);
  const removed = oScenes.filter((s) => !nById.has(s.id)).map(sceneRef);
  const changed: ChangedSceneRef[] = nScenes
    .filter((s) => oById.has(s.id))
    .map((s) => ({ scene: s, reasons: sceneReasons(oById.get(s.id)!, s) }))
    .filter((x) => x.reasons.length > 0)
    .map((x) => ({ ...sceneRef(x.scene), reasons: x.reasons }));

  const changedIds = new Set(changed.map((c) => c.id));
  const addedIds = new Set(added.map((a) => a.id));

  const sceneStrip: StripTile[] = nScenes.map((s) => ({
    ...sceneRef(s),
    changeKind: addedIds.has(s.id) ? "added" : changedIds.has(s.id) ? "changed" : "unchanged",
  }));
  for (const r of removed) sceneStrip.push({ ...r, changeKind: "removed" });

  const overlays = entityDiff(older.overlays ?? [], newer.overlays ?? [], (o) => ({
    id: o.id,
    kind: o.kind,
    label: overlayLabel(o),
  }));
  const audioClips = entityDiff(older.audioClips ?? [], newer.audioClips ?? [], (c) => ({
    id: c.id,
    kind: c.kind,
    label: clipLabel(c),
  }));

  const totalChanges =
    added.length + removed.length + changed.length +
    overlays.added.length + overlays.removed.length + overlays.changed.length +
    audioClips.added.length + audioClips.removed.length + audioClips.changed.length;

  return { scenes: { added, removed, changed }, overlays, audioClips, sceneStrip, totalChanges };
}
