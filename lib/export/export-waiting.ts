/**
 * The progress an export reports while the export scheduler
 * (lib/export/scheduler.ts) has not admitted it yet. The unit is the contract
 * the chat, the jobs list and the export UI read; the WHY (memory, CPU,
 * encoder, cap, queue) is on the export's record (`waiting`), and
 * `EXPORT_WAITING_MESSAGE` is the fallback line when the record can't be read.
 * Client-safe: the chat, the jobs list and the export dialog all read it.
 */
export const EXPORT_WAITING_UNIT = "waiting";
export const EXPORT_WAITING_MESSAGE = "Waiting for another export to finish";

/** Whether a progress tick is the scheduler wait rather than the export's own progress. */
export function isExportWaiting(p: { unit?: string | null } | null | undefined): boolean {
  return p?.unit === EXPORT_WAITING_UNIT;
}
