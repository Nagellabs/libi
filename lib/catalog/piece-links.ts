/** Pure, client-safe: given the per-piece grouped payload (file → entities),
 *  return the distinct file names a given catalog entity is linked to. */
export interface PieceLinkGroup {
  file: { id: string; name: string; type: string };
  entities: { id: string; name: string }[];
}

export function linkedAssetNames(groups: PieceLinkGroup[], entityId: string): string[] {
  const names: string[] = [];
  for (const g of groups) {
    if (g.entities.some((e) => e.id === entityId) && !names.includes(g.file.name)) {
      names.push(g.file.name);
    }
  }
  return names;
}
