/**
 * Which libi extensions offer a Remove control — the list, and nothing else.
 *
 * Split out of `mcp/registry/extension-uninstall.ts` (which owns the actual
 * deletion) so the Settings row can ask the question without dragging `node:fs`
 * and the server logger into the browser bundle. The uninstaller imports this,
 * not the other way round, so the two can never disagree.
 *
 * `libi-export` and `youtube-download` are absent on purpose: everything they
 * install is SHARED (chromium with the tracking engine, `uv` and its cache with
 * three other extensions), so a per-extension Remove would break a neighbour
 * the user did not ask to remove. See the uninstaller's header.
 */
export const REMOVABLE_EXTENSION_IDS = [
  "local-tts",
  "whisper",
  "local-music",
  "libi-tracking",
] as const;

export type RemovableExtensionId = (typeof REMOVABLE_EXTENSION_IDS)[number];

/** Does this extension have files of its own that Remove can delete? */
export function isRemovableExtension(id: string): id is RemovableExtensionId {
  return (REMOVABLE_EXTENSION_IDS as readonly string[]).includes(id);
}
