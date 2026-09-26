/**
 * An applied template's media slot that nobody has filled yet.
 *
 * `applyScaffold` (materialize.ts) still creates the image / video layer, so the
 * user sees where the media goes, but it has no file: its `fileId` is the
 * reserved `unfilled-<slot key>` and its `displayName` is `<slot label> (fill me)`.
 * No real file id can take that shape (ids are UUIDs), so the prefix alone
 * marks the state.
 *
 * Pure and dependency-free on purpose: the preview (engine, hooks, timeline)
 * and the export classifier both import it, and neither may pull in the
 * server-only template store.
 */

const PREFIX = "unfilled-";
const FILL_ME_SUFFIX = " (fill me)";

/** The placeholder `fileId` for the slot `key`. */
export function unfilledSlotFileId(key: string): string {
  return `${PREFIX}${key}`;
}

/** The placeholder `displayName` for a slot labelled `label`. */
export function unfilledSlotDisplayName(label: string): string {
  return `${label}${FILL_ME_SUFFIX}`;
}

/** True for a placeholder `fileId`: there is no file behind it, so nothing may fetch it. */
export function isUnfilledSlotFileId(fileId: string | null | undefined): boolean {
  return typeof fileId === "string" && fileId.startsWith(PREFIX) && fileId.length > PREFIX.length;
}

/**
 * What to call the empty slot on screen: the slot's label (the layer's name
 * without the " (fill me)" tail), or its key when the layer has been renamed
 * to nothing.
 */
export function unfilledSlotLabel(overlay: { fileId: string; displayName?: string }): string {
  const name = overlay.displayName?.trim();
  if (name) return name.endsWith(FILL_ME_SUFFIX) ? name.slice(0, -FILL_ME_SUFFIX.length) : name;
  return overlay.fileId.slice(PREFIX.length);
}
