import type {
  CompositionManifest,
  PersistedOverlay,
  PersistedAudioClip,
} from "./persistence";

export type ChangeKind = "added" | "removed" | "changed" | "unchanged";

export interface EntityRef {
  id: string;
  kind: string;
  /** Text snippet for text overlays, clip label/kind otherwise. */
  label: string;
}

export interface EnrichedDiff {
  overlays: { added: EntityRef[]; removed: EntityRef[]; changed: EntityRef[] };
  audioClips: { added: EntityRef[]; removed: EntityRef[]; changed: EntityRef[] };
  /** Ordered scenes of `newer` (with per-tile changeKind), then removed scenes as ghost tiles. */
  totalChanges: number;
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
    overlays.added.length + overlays.removed.length + overlays.changed.length +
    audioClips.added.length + audioClips.removed.length + audioClips.changed.length;

  return { overlays, audioClips, totalChanges };
}
