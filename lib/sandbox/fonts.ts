/**
 * Fonts a body may name inside the runtime, as ArrayBuffers (spec §4.8): every
 * bundled face (they are what the manual tells bodies to use) plus each
 * uploaded font a text overlay references. The family names are exactly the
 * host's — `Inter`, `JetBrains Mono`, `libifont-<fileId>` — so `drawTextBlock`
 * and bodies are unchanged. Fetched once per URL for the life of the page.
 *
 * `data` must be a real `ArrayBuffer`: the protocol's guard is
 * `instanceof ArrayBuffer`, and a `Uint8Array` would null the whole `load` —
 * which the 5 s watchdog then reads as a hang and restarts in a loop.
 */
import type { Overlay } from "@/lib/engine/types";
import { BUNDLED_FONTS, bundledFontUrl } from "@/lib/fonts/bundled";
import { cssFamilyForFontFile } from "@/lib/fonts/family";
import type { FontPayload } from "./protocol";

const cache = new Map<string, Promise<ArrayBuffer | null>>();

async function defaultFetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`font fetch failed: ${res.status} ${url}`);
  return res.arrayBuffer();
}

function cached(url: string, fetchBuffer: (url: string) => Promise<ArrayBuffer>): Promise<ArrayBuffer | null> {
  let p = cache.get(url);
  if (!p) {
    p = fetchBuffer(url).catch(() => {
      // Not cached: a font uploaded a moment ago may 404 once, and must not
      // stay missing for the life of the page.
      cache.delete(url);
      return null;
    });
    cache.set(url, p);
  }
  return p;
}

export function fontFileIdsOf(overlays: readonly Overlay[]): string[] {
  const ids = new Set<string>();
  for (const o of overlays) if (o.kind === "text" && o.fontFileId) ids.add(o.fontFileId);
  return Array.from(ids);
}

export async function collectSandboxFonts(
  overlays: readonly Overlay[],
  fetchBuffer: (url: string) => Promise<ArrayBuffer> = defaultFetchBuffer,
): Promise<FontPayload[]> {
  const wanted: Array<{ family: string; weight: number; url: string }> = [
    ...BUNDLED_FONTS.map((f) => ({ family: f.family, weight: f.weight, url: bundledFontUrl(f.file) })),
    // Weight 400: an uploaded face registers with FontFace's default weight in
    // the host (`lib/fonts/registry-client.ts`), and the runtime must match.
    ...fontFileIdsOf(overlays).map((id) => ({ family: cssFamilyForFontFile(id), weight: 400, url: `/api/files/by-id/${id}/content` })),
  ];
  const buffers = await Promise.all(wanted.map((w) => cached(w.url, fetchBuffer)));
  const out: FontPayload[] = [];
  wanted.forEach((w, i) => {
    const data = buffers[i];
    if (data) out.push({ family: w.family, weight: w.weight, data });
  });
  return out;
}

/** Test seam. */
export function resetSandboxFontCacheForTests(): void {
  cache.clear();
}
