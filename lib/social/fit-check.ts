/**
 * Local export fit check — reads an export with ffprobe and judges it
 * against each target platform's limits, before any provider call. This is
 * offline and free: the composer runs it before uploading or sending
 * anything, so a mismatch (too long, wrong aspect, too large) is caught up
 * front and named per platform.
 */
import fs from "node:fs";
import path from "node:path";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { resolveExportFolder } from "@/lib/db/settings";
import { getLibiStorageDir } from "@/lib/libi-home";
import { findSocialProvider, type SocialPlatform, type SocialProviderId } from "@/lib/social/catalog";
import { SocialError } from "@/lib/social/errors";

export interface FitTarget {
  platform: SocialPlatform;
  /** "reel" | "feed" | "story" | "video" — a provider platform's post type. */
  postType: string;
}

export interface FitProbe {
  durationSeconds: number;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface FitVerdict extends FitTarget {
  ok: boolean;
  problems: string[];
  probe: FitProbe;
}

const LABEL: Record<SocialPlatform, string> = { instagram: "Instagram", tiktok: "TikTok" };
const TYPE_LABEL: Record<string, string> = { reel: "Reel", feed: "Feed", story: "Story", video: "video" };

function mmss(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

/** MEBIbytes (1024²), the unit the catalog's own `maxBytes` are written in
 *  (`catalog.ts`'s `MB = 1024 * 1024`). Dividing by 1e6 here against a MiB
 *  limit made the two halves of one sentence disagree — a 300 MiB file read
 *  as "314.6 MB is over Instagram's 300 MB limit". */
function mb(b: number): string {
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function ratioOf(a: string): number {
  const [w, h] = a.split(":").map(Number);
  return w / h;
}

/** 2% tolerance, matching the composer's own aspect check. */
const ASPECT_TOLERANCE = 0.02;

function aspectLabel(w: number, h: number): string {
  const r = w / h;
  for (const a of ["9:16", "16:9", "4:5", "1:1", "1.91:1", "4:3", "3:4"]) {
    if (Math.abs(r - ratioOf(a)) / ratioOf(a) <= ASPECT_TOLERANCE) return a;
  }
  return `${w}×${h}`;
}

/**
 * Judge one probed export against one platform target's limits. Pure and
 * synchronous — no I/O, so the composer can re-check every target the moment
 * either the export or the target list changes.
 */
export function checkFit(probe: FitProbe, target: FitTarget, providerId: SocialProviderId = "zernio"): FitVerdict {
  const def = findSocialProvider(providerId).platforms[target.platform];
  const lim = def.limits[target.postType];
  const name = `${LABEL[target.platform]} ${TYPE_LABEL[target.postType] ?? target.postType}`;
  const problems: string[] = [];
  if (!lim) {
    problems.push(`${name} is not a post type this provider supports`);
  } else {
    if (probe.durationSeconds > lim.maxSeconds) {
      problems.push(`${mmss(probe.durationSeconds)} is longer than ${name}'s ${mmss(lim.maxSeconds)} maximum`);
    }
    const r = probe.width / probe.height;
    if (!lim.aspects.some((a) => Math.abs(r - ratioOf(a)) / ratioOf(a) <= ASPECT_TOLERANCE)) {
      problems.push(`${aspectLabel(probe.width, probe.height)} is not an accepted aspect for ${name} (${lim.aspects.join(", ")})`);
    }
    if (probe.sizeBytes > lim.maxBytes) {
      problems.push(`${mb(probe.sizeBytes)} is over ${name}'s ${Math.round(lim.maxBytes / 1024 / 1024)} MB limit`);
    }
  }
  return { ...target, ok: problems.length === 0, problems, probe };
}

/**
 * An export path libi may read: inside the export folder or libi's storage,
 * after realpath (no traversal, no symlink escape). Export/media code must
 * only ever read from these two roots — never an arbitrary path handed up
 * from a client.
 */
export function isAllowedExportPath(p: string): boolean {
  try {
    const real = fs.realpathSync(p);
    return [resolveExportFolder(), getLibiStorageDir()].some((root) => {
      const r = fs.existsSync(root) ? fs.realpathSync(root) : root;
      return real === r || real.startsWith(r + path.sep);
    });
  } catch {
    return false;
  }
}

/** Probe an export for the fit check. Reads the ORIGINAL file (never a
 *  proxy) — the same file the provider would upload. Throws a `validation`
 *  `SocialError` for anything unreadable, so a missing/corrupt export never
 *  reaches a provider call and never crashes the route. */
export async function probeExport(p: string): Promise<FitProbe> {
  if (!isAllowedExportPath(p)) throw new SocialError("validation", "that file is not one of your exports");
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw new SocialError("validation", "that export file could not be found");
  }
  const m = await probeMedia(p);
  if (!m.duration || !m.width || !m.height) {
    throw new SocialError("validation", "could not read the export's duration or size (ffprobe)");
  }
  return { durationSeconds: m.duration, width: m.width, height: m.height, sizeBytes: st.size };
}
