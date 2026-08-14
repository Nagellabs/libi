/** Minimal folder shape the tree helpers need — any folder-like table works. */
export interface TreeNode {
  id: string;
  parentFolderId: string | null;
}

/** Ancestor folder ids of `id`, nearest-parent first. Empty for a root folder. */
export function getAncestorIds(id: string, all: TreeNode[]): string[] {
  const byId = new Map(all.map((f) => [f.id, f]));
  const out: string[] = [];
  let current = byId.get(id)?.parentFolderId ?? null;
  const seen = new Set<string>([id]);
  while (current && !seen.has(current)) {
    out.push(current);
    seen.add(current);
    current = byId.get(current)?.parentFolderId ?? null;
  }
  return out;
}

/** All descendant folder ids of `id` (not including `id` itself). */
export function getDescendantIds(id: string, all: TreeNode[]): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const f of all) {
    if (!f.parentFolderId) continue;
    const list = childrenByParent.get(f.parentFolderId) ?? [];
    list.push(f.id);
    childrenByParent.set(f.parentFolderId, list);
  }
  const out: string[] = [];
  const stack = [...(childrenByParent.get(id) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    out.push(next);
    stack.push(...(childrenByParent.get(next) ?? []));
  }
  return out;
}

/**
 * True if making `folderId` a child of `newParentId` would create a cycle:
 * either `newParentId` IS the folder, or it is a descendant of it.
 */
export function wouldCreateCycle(
  folderId: string,
  newParentId: string | null,
  all: TreeNode[],
): boolean {
  if (newParentId === null) return false;
  if (newParentId === folderId) return true;
  return getDescendantIds(folderId, all).includes(newParentId);
}
