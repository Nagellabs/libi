/**
 * Which announcements THIS install has already displayed.
 *
 * "Seen" is recorded at display time, not at dismiss time — an announcement
 * the user never X-ed still must not reappear at the next launch (the update
 * toast's per-launch sessionStorage dismissal is a different, deliberate
 * choice; do not unify them). Rows outlive announcements (3-day window) by a
 * wide margin and are pruned on every write, so the table cannot grow.
 */

import { lt } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { seenAnnouncements } from "@/lib/db/schema/sqlite";

/** Seen rows older than this are pruned on the next write. */
export const SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function listSeenIds(): string[] {
  return getDb()
    .select({ id: seenAnnouncements.announcementId })
    .from(seenAnnouncements)
    .all()
    .map((row) => row.id);
}

export function markSeen(ids: string[], now: Date = new Date()): void {
  const db = getDb();
  if (ids.length > 0) {
    db.insert(seenAnnouncements)
      .values(ids.map((id) => ({ announcementId: id, seenAt: now })))
      .onConflictDoNothing()
      .run();
  }
  db.delete(seenAnnouncements)
    .where(lt(seenAnnouncements.seenAt, new Date(now.getTime() - SEEN_RETENTION_MS)))
    .run();
}
