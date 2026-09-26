/**
 * The Public tab's view of this install's OWN templates while the cached
 * catalog copy lags behind a change made here — a publish, a hide, a show
 * again (lib/templates/cloud/catalog-cache.ts#noteOwnCatalogChange; in
 * production the site's index is edge-cached for up to five minutes).
 *
 *   - `justListed`: a template published or shown again here that the copy
 *     doesn't list yet. The tab shows it from `/mine` (the site's own word on
 *     the creator's templates) with a note that the catalog may take a few
 *     minutes — never "No public templates yet".
 *   - `hiddenIds`: cards to leave out although the copy still lists them — a
 *     hide made here, or one `/mine` reports (the owner's list is current,
 *     the copy is not).
 *
 * A change made here decides for its own template over `/mine`, which may
 * still be the read from before it (the server forgets the change once the
 * copy shows it, or after 15 minutes); `/mine` decides for the rest. Pure,
 * for the renderer: types only.
 */
import type { MineTemplate } from "@/lib/templates/cloud/client";
import type { OwnCatalogChangeDto, TemplateSummary } from "@/lib/templates/types";

export interface JustListedTemplate {
  cloudId: string;
  kind: "published" | "shown";
  /** `/mine`'s name, else the local copy's. */
  name: string;
  /** The local template it was published from, when this machine still has it. */
  local: TemplateSummary | null;
}

export interface OwnCatalogView {
  justListed: JustListedTemplate[];
  hiddenIds: Set<string>;
}

export function ownCatalogView(opts: {
  changes: OwnCatalogChangeDto[] | undefined;
  /** The catalog ids the Public tab's unfiltered list already shows. */
  listedIds: ReadonlySet<string>;
  mine: { templates: MineTemplate[]; error?: string } | undefined;
  local: TemplateSummary[] | undefined;
}): OwnCatalogView {
  const changes = opts.changes ?? [];
  const changed = new Map(changes.map((c) => [c.cloudId, c]));
  // An unreadable `/mine` is empty with `error`: it says nothing about anything.
  const mine = opts.mine && !opts.mine.error ? new Map(opts.mine.templates.map((m) => [m.id, m])) : new Map<string, MineTemplate>();
  const hiddenIds = new Set<string>();
  for (const m of mine.values()) {
    if ((m.hidden || m.moderated) && !changed.has(m.id)) hiddenIds.add(m.id);
  }
  const justListed: JustListedTemplate[] = [];
  for (const c of changes) {
    if (c.kind === "hidden") {
      hiddenIds.add(c.cloudId);
      continue;
    }
    if (opts.listedIds.has(c.cloudId)) continue;
    const m = mine.get(c.cloudId);
    const local = opts.local?.find((t) => t.cloudId === c.cloudId && t.origin === "local") ?? null;
    const name = m?.name ?? local?.name;
    if (!name) continue;
    justListed.push({ cloudId: c.cloudId, kind: c.kind, name, local });
  }
  return { justListed, hiddenIds };
}
