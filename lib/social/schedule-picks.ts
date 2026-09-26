import { toDatetimeLocal } from "@/lib/social/format";

/**
 * Scheduling arithmetic, done entirely in WALL-CLOCK terms.
 *
 * The wire shape is a bare `YYYY-MM-DDTHH:mm` plus a `timezone`, which the
 * provider converts itself (`.superpowers/sdd/zernio-live-shapes.md`). So
 * "tomorrow 9am" means 09:00 on the next calendar day IN THE POST'S ZONE — not
 * an instant offset from now, and never the browser's idea of tomorrow. A user
 * in Europe scheduling for Asia/Bangkok must get Bangkok's tomorrow.
 *
 * Every function here therefore takes zoned wall-clock parts and does plain
 * calendar arithmetic on them. `Date.UTC` appears only as a calendar: it is
 * read back with UTC getters exclusively, so no offset ever enters the result.
 */
export interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DDTHH:mm` — the exact shape the wire takes and the field holds. */
export function formatWall(w: WallClock): string {
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

export function parseWall(v: string): WallClock | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
}

/** What the clock reads in `tz` right now. */
export function nowWall(tz: string, now: Date = new Date()): WallClock {
  return parseWall(toDatetimeLocal(now.toISOString(), tz)) ?? { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate(), h: now.getHours(), mi: now.getMinutes() };
}

/** 0 = Sunday … 6 = Saturday, for a wall-clock DATE. */
export function weekdayOf(w: Pick<WallClock, "y" | "mo" | "d">): number {
  return new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
}

/** `w` moved by whole days, staying a calendar date (month and year roll). */
export function addDays(w: WallClock, days: number): WallClock {
  const d = new Date(Date.UTC(w.y, w.mo - 1, w.d + days));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: w.h, mi: w.mi };
}

/** Days in a wall-clock month — the calendar grid's row count depends on it. */
export function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** True when `a` is strictly later than `b` on the same clock. */
export function isAfter(a: WallClock, b: WallClock): boolean {
  return formatWall(a) > formatWall(b);
}

export interface QuickPick {
  id: string;
  label: string;
  /** `YYYY-MM-DDTHH:mm` in the post's own zone. */
  value: string;
}

/** Next occurrence of `weekday` at `h:00`, never today. */
function nextWeekday(from: WallClock, weekday: number, h: number): WallClock {
  const delta = ((weekday - weekdayOf(from) + 7) % 7) || 7;
  return { ...addDays(from, delta), h, mi: 0 };
}

/**
 * The times people actually pick, in the post's zone.
 *
 * "Tonight" is dropped once it has passed rather than silently rolling to
 * tomorrow — a chip that says tonight and schedules for tomorrow is worse than
 * no chip. Everything else is always in the future by construction.
 */
export function quickPicks(tz: string, now: Date = new Date()): QuickPick[] {
  const n = nowWall(tz, now);
  const out: QuickPick[] = [];

  const tonight: WallClock = { ...n, h: 19, mi: 0 };
  if (isAfter(tonight, n)) out.push({ id: "tonight", label: "Tonight 7pm", value: formatWall(tonight) });

  out.push({ id: "tomorrow", label: "Tomorrow 9am", value: formatWall({ ...addDays(n, 1), h: 9, mi: 0 }) });
  out.push({ id: "saturday", label: "Saturday 11am", value: formatWall(nextWeekday(n, 6, 11)) });
  out.push({ id: "monday", label: "Next Monday 9am", value: formatWall(nextWeekday(n, 1, 9)) });
  return out;
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Mon 22 Sep, 09:00" — the chosen slot, read back in plain words. */
export function describeWall(v: string): string {
  const w = parseWall(v);
  if (!w) return "";
  return `${DAY[weekdayOf(w)]} ${w.d} ${MONTH[w.mo - 1].slice(0, 3)}, ${pad(w.h)}:${pad(w.mi)}`;
}

export function monthTitle(y: number, mo: number): string {
  return `${MONTH[mo - 1]} ${y}`;
}

export const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];
