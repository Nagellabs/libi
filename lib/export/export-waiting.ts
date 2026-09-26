/**
 * The progress an export reports while it waits its turn in the export lane
 * (lib/export/export-lane.ts) behind another export — a user's, or a publish
 * preparation's (final review F7). Before the lane an export waited in its
 * job slot and read "queued"; now its job is running while it waits, so it
 * says so instead of sitting at "0 %". Client-safe: the chat, the jobs list
 * and the export dialog all read it.
 */
export const EXPORT_WAITING_UNIT = "waiting";
export const EXPORT_WAITING_MESSAGE = "Waiting for another export to finish";

/** Whether a progress tick is the lane wait rather than the export's own progress. */
export function isExportWaiting(p: { unit?: string | null } | null | undefined): boolean {
  return p?.unit === EXPORT_WAITING_UNIT;
}
