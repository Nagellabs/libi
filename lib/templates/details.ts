/**
 * What a template's own page shows, derived from its scaffold and its usage —
 * pure, and client-safe (no fs, no db, no node globals), so the local page
 * and the public page read the same rows.
 *
 * Everything here that came from a scaffold (labels, keys, file names) is the
 * template author's text. For an installed or public template that author is
 * a stranger: the page renders it as plain text only.
 */
import type { TemplateAsset } from "@/lib/templates/scaffold-schema";

/** The overlay fields the page reads — both scaffold types (the schema's and the app's) have them. */
interface OverlayLike {
  key: string;
  kind: "text" | "image" | "video" | "code" | "three";
  startTime: number;
  duration: number;
  z: number;
  displayName?: string;
  source?: { slot: string } | { assetRef: string };
  text?: { slot: string } | { fixed: string };
}

/** The scaffold fields the page reads. */
export interface ScaffoldForDetails {
  overlays: ReadonlyArray<OverlayLike>;
  assets: ReadonlyArray<TemplateAsset>;
}

export interface OverlayRow {
  key: string;
  label: string;
  kind: OverlayLike["kind"];
  start: number;
  end: number;
  slot: string | null;
  z: number;
}

const slotOf = (o: OverlayLike): string | null => {
  if (o.source && "slot" in o.source) return o.source.slot;
  if (o.text && "slot" in o.text) return o.text.slot;
  return null;
};

/** Top-most first (z descending), ties by start time then key. `label` = displayName ?? key. `slot` = source.slot ?? text.slot ?? null. */
export function overlayRows(s: ScaffoldForDetails): OverlayRow[] {
  return s.overlays
    .map((o) => ({ key: o.key, label: o.displayName || o.key, kind: o.kind, start: o.startTime, end: o.startTime + o.duration, slot: slotOf(o), z: o.z }))
    .sort((a, b) => b.z - a.z || a.start - b.start || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * How a resource is reached: a servable `file` URL; a `link` to the author's
 * host — with `stream`, libi's own URL that plays it inline when it is
 * audio or video on a public template's page (lib/templates/cloud/asset-stream.ts);
 * or `unavailable`.
 */
export type ResourceSource = { kind: "file"; url: string } | { kind: "link"; url: string; host: string; stream?: string } | { kind: "unavailable" };

export interface ResourceRow {
  ref: string;
  kind: "image" | "video" | "audio" | "font";
  name: string;
  bytes: number | null;
  source: ResourceSource;
}

const basename = (p: string): string => p.split("/").pop() || p;

/** A link asset's host and name, or null when the url is not an https URL (the scaffold schema allows only those). */
function parsedLink(raw: string): { url: string; host: string; name: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.host) return null;
  let name = basename(u.pathname);
  try {
    name = decodeURIComponent(name);
  } catch {
    // A malformed escape: keep the raw segment.
  }
  return { url: u.href, host: u.host, name: name || u.host };
}

/**
 * One row per asset, in the scaffold's order. `fileUrl(file)` maps an asset's
 * `file` to a servable URL, or null to mark it unavailable; `streamUrl(url)`,
 * when given, is how a link-only audio or video asset plays inline.
 */
export function resourceRows(s: ScaffoldForDetails, fileUrl: (file: string) => string | null, streamUrl?: (url: string) => string): ResourceRow[] {
  return s.assets.map((a) => {
    const bytes = typeof a.bytes === "number" ? a.bytes : null;
    if (a.file !== undefined) {
      const url = fileUrl(a.file);
      return { ref: a.ref, kind: a.kind, name: basename(a.file), bytes, source: url ? { kind: "file", url } : { kind: "unavailable" } };
    }
    const link = a.url !== undefined ? parsedLink(a.url) : null;
    return {
      ref: a.ref,
      kind: a.kind,
      name: link?.name ?? a.ref,
      bytes,
      source: link
        ? { kind: "link", url: link.url, host: link.host, ...(streamUrl && (a.kind === "audio" || a.kind === "video") && a.url !== undefined ? { stream: streamUrl(a.url) } : {}) }
        : { kind: "unavailable" },
    };
  });
}

const DAY_MS = 86_400_000;

/**
 * A day key as `YYYY-MM-DD`, from either the `YYYYMMDD` or `YYYY-MM-DD` the
 * catalog uses; null for anything else. The one normaliser for catalog day
 * keys (the details page and "Your templates"' sparkline both read it).
 */
export function catalogDayKey(key: string): string | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(key);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
const normalDay = catalogDayKey;

/** The UTC day of `ms`, `YYYY-MM-DD` — the day the catalog counts a use under. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A UTC calendar day as libi shows it: "26 Sep 2026 (UTC)" — day, English
 * month, year, never a numeric order a reader could flip, and labelled UTC,
 * because it is the catalog's day, not the reader's. Accepts a `Date`, an
 * ISO timestamp or a catalog day key; null for anything it can't read.
 */
export function utcDateLabel(when: Date | string): string | null {
  let d: Date;
  if (when instanceof Date) d = when;
  else {
    const day = catalogDayKey(when);
    d = new Date(day ? `${day}T00:00:00.000Z` : /^\d{4}-\d{2}-\d{2}T/.test(when) ? when : NaN);
  }
  if (!Number.isFinite(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} (UTC)`;
}

/** Uses today and the `days - 1` UTC days before it, from the catalog's per-day counts (keys "YYYYMMDD" or "YYYY-MM-DD"). */
export function usesInLastDays(byDay: Record<string, number>, days: number, now: number = Date.now()): number {
  const last = utcDay(now);
  const first = utcDay(now - (days - 1) * DAY_MS);
  let sum = 0;
  for (const [key, n] of Object.entries(byDay)) {
    const day = normalDay(key);
    if (day !== null && day >= first && day <= last && Number.isFinite(n)) sum += n;
  }
  return sum;
}

/** The latest day with a count > 0, as YYYY-MM-DD; null when there is none. */
export function lastUsedDayOf(byDay: Record<string, number>): string | null {
  let latest: string | null = null;
  for (const [key, n] of Object.entries(byDay)) {
    const day = normalDay(key);
    if (day !== null && n > 0 && (latest === null || day > latest)) latest = day;
  }
  return latest;
}

/** `m:ss`, with tenths only when there are any ("0:03", "0:03.5", "1:15.3"). */
export function formatDuration(sec: number): string {
  const tenths = Math.round(Math.max(0, sec) * 10);
  const m = Math.floor(tenths / 600);
  const rest = tenths - m * 600;
  const s = Math.floor(rest / 10);
  const t = rest % 10;
  return `${m}:${String(s).padStart(2, "0")}${t ? `.${t}` : ""}`;
}

/**
 * libi's own URL for a public template's link-only audio or video: the page
 * plays it through `/api/templates/cloud/asset-stream`, never from the
 * author's host directly (the app CSP admits no stranger's media host).
 * `url` is the scaffold's value verbatim — the route looks it up there.
 */
export function assetStreamUrl(cloudId: string, url: string): string {
  return `/api/templates/cloud/asset-stream?${new URLSearchParams({ cloudId, url })}`;
}
