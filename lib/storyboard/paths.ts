import type { SketchSlot } from "./types";
import { isUnsafeStorageName, isWindowsHazard } from "@/lib/storage/safe-name";
import { serverLogger as logger } from "@/lib/logger";

export const STORYBOARD_DIR = "storyboard";
export const STORYBOARD_MANIFEST = `${STORYBOARD_DIR}/manifest.json`;

export function cardDir(cardId: string): string { return `${STORYBOARD_DIR}/cards/${cardId}`; }
export function cardJsonPath(cardId: string): string { return `${cardDir(cardId)}/card.json`; }
export function cardRenderPath(cardId: string, file: string): string { return `${cardDir(cardId)}/${file}`; }
export function cardSketchesDir(cardId: string): string {
  return `${cardDir(cardId)}/sketches`;
}
export function slotSketchPath(cardId: string, slotId: string): string {
  return `${cardSketchesDir(cardId)}/${slotId}.png`;
}

/** A card-relative path whose every "/"-separated segment is a safe stored name
 *  (`isUnsafeStorageName`: no empty, ".", ".." or backslash segment, no NUL)
 *  and no Windows hazard, since it is agent-written text, not a name read back
 *  from disk: no `:` (an NTFS alternate data stream, `unit.jsx:x`, or a drive
 *  `C:`) and no trailing `.` or space, which Windows strips. Exported so both
 *  the write-side check (repo.ts, before a `render.file` is ever saved to
 *  card.json) and the read-side check below (`slotUnitPath`, for a card.json
 *  that predates the write-side check, or was hand-edited) share one rule. */
export function isSafeCardRelativePath(file: string): boolean {
  if (typeof file !== "string" || file.length === 0) return false;
  return file.split("/").every((segment) => !isUnsafeStorageName(segment) && !isWindowsHazard(segment));
}

function defaultUnitFile(slotId: string): string {
  return `sketches/${slotId}/unit.jsx`;
}

/** Card-relative unit path for a sketch slot's render file. `slot.render.file`
 *  is agent-written text read back from `card.json`, not re-validated on the
 *  write side every time it's read — so an unsafe value (path traversal, a
 *  Windows-hazard segment) is refused HERE too, falling back to the same
 *  default unit path used when the slot has no render file at all, rather
 *  than being joined into a filesystem path unchecked. A refusal is warned
 *  (never for a slot with no render.file at all, which is the common case):
 *  a card.json carrying an unsafe file is either hand-edited or predates the
 *  write-side check, and silently substituting the default otherwise leaves
 *  no trace of why a slot's render doesn't match what card.json says. Warned
 *  once per card, slot and file per process. */
/** Refusals already warned in this process, keyed by card, slot and file. The
 *  storyboard watcher re-renders EVERY card's sketches on any storyboard change,
 *  so an undeduped warn repeats for one stale card.json on every unrelated edit.
 *  On globalThis because the production bundle loads this module more than once. */
const warnedRefusals = ((globalThis as Record<symbol, unknown>)[Symbol.for("libi.storyboard.warnedRefusals")] ??=
  new Set<string>()) as Set<string>;

export function slotUnitPath(cardId: string, slot: SketchSlot): string {
  const file = slot.render?.file;
  const safe = file !== undefined && isSafeCardRelativePath(file);
  const refusalKey = `${cardId}\0${slot.id}\0${file}`;
  if (file !== undefined && !safe && !warnedRefusals.has(refusalKey)) {
    warnedRefusals.add(refusalKey);
    logger.warn(
      { tag: "storyboard", op: "render_file_refused", cardId, slotId: slot.id, file: file.slice(0, 120) },
      "slot.render.file failed the safe-path check; falling back to the default unit path",
    );
  }
  const safeFile = safe ? file! : defaultUnitFile(slot.id);
  return `${cardDir(cardId)}/${safeFile}`;
}
