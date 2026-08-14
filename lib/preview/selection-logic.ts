export interface SelectionModifiers {
  shift?: boolean;
  meta?: boolean; // cmd (mac) or ctrl
}

/**
 * Pure next-selection given a clicked id, the current ordered selection, and
 * keyboard modifiers. Plain click = replace. meta/ctrl = toggle. shift = add.
 * Order is preserved (insertion order); the clicked id appends when added.
 */
export function resolveSelection(
  clickedId: string,
  current: string[],
  mods: SelectionModifiers,
): string[] {
  if (mods.meta) {
    return current.includes(clickedId)
      ? current.filter((id) => id !== clickedId)
      : [...current, clickedId];
  }
  if (mods.shift) {
    return current.includes(clickedId) ? current : [...current, clickedId];
  }
  return [clickedId];
}
