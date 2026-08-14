import { NextResponse } from "next/server";
import { fetchLiveAnnouncements } from "@/lib/announcements/site-client";
import { listSeenIds } from "@/lib/announcements/seen-store";

/**
 * GET /api/announcements — the one announcement the banner should show.
 *
 * `announcement` is the NEWEST live announcement this install has not seen
 * (older unseen ones are deliberately dropped — the client marks every id in
 * `liveIds` seen when it displays the banner, so they never surface later).
 * Null whenever there is nothing new: offline, site down, or all seen.
 */
export async function GET() {
  const live = await fetchLiveAnnouncements();
  if (live.length === 0) {
    return NextResponse.json({ announcement: null, liveIds: [] });
  }
  const seen = new Set(listSeenIds());
  const announcement = live.find((a) => !seen.has(a.id)) ?? null;
  return NextResponse.json({ announcement, liveIds: live.map((a) => a.id) });
}
