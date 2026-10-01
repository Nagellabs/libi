import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { MEDIA_RESPONSE_CSP } from "@/lib/http/media-types";
import { serverLogger as logger } from "@/lib/logger";
import { crossSiteSubresourceRefusal } from "@/lib/security/request-guard";
import { AssetStreamRefusal, hostOf, openAssetStream, type AssetStreamRefusalCode } from "@/lib/templates/cloud/asset-stream";
import { previewHostAllowed } from "@/lib/social/music-preview";

export const dynamic = "force-dynamic";

const MAX_URL_CHARS = 2048;
const REFUSED: Record<AssetStreamRefusalCode, number> = {
  invalid_url: 403, private_address: 403, too_many_redirects: 502, dns_failed: 502, unreachable: 502, upstream_status: 502, timeout: 504, wrong_type: 415, too_large: 413,
};

/**
 * GET /api/social/music/preview?url=<preview>[&kind=artwork] — a catalog
 * track's preview, streamed from libi's own origin. Allow-listed platform
 * CDNs only (`lib/social/music-preview.ts`) on every hop, redirects
 * included; every hop DNS-checked and pinned (`openAssetStream`),
 * audio/video, or (kind=artwork) a raster image, only, capped. A read with
 * an outside effect, so another site's request is refused. Logged by host
 * only.
 */
export async function GET(req: Request): Promise<Response> {
  const refused = crossSiteSubresourceRefusal(req);
  if (refused) return NextResponse.json({ error: "A preview plays only on libi's own page.", code: "cross_site_read" }, { status: 403 });
  const url = new URL(req.url).searchParams.get("url") ?? "";
  if (url.length === 0 || url.length > MAX_URL_CHARS || !previewHostAllowed(url)) {
    logger.warn({ tag: "social-music", op: "preview_refused", host: hostOf(url) }, "music preview host not allowed");
    return NextResponse.json({ error: "Not a platform's music preview.", code: "host_not_allowed" }, { status: 403 });
  }
  const artwork = new URL(req.url).searchParams.get("kind") === "artwork";
  try {
    // The allow-list holds on every hop: a CDN that redirects elsewhere is refused at the redirect.
    const s = await openAssetStream(url, {
      range: artwork ? null : req.headers.get("range"),
      signal: req.signal,
      allowUrl: (u) => previewHostAllowed(u.href),
      ...(artwork ? { kinds: ["image"] as const } : {}),
    });
    return new Response(Readable.toWeb(s.body) as ReadableStream, {
      status: s.status,
      headers: { ...s.headers, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": MEDIA_RESPONSE_CSP },
    });
  } catch (err) {
    if (err instanceof AssetStreamRefusal) {
      logger.warn({ tag: "social-music", op: "preview_refused", reason: err.code, host: hostOf(url) }, "music preview not streamed");
      return NextResponse.json({ error: err.message, code: err.code }, { status: REFUSED[err.code] });
    }
    if (req.signal.aborted) return new Response(null, { status: 499 });
    logger.error({ tag: "social-music", op: "preview_failed", host: hostOf(url), err: err instanceof Error ? err.name : "unknown" }, "music preview failed");
    return NextResponse.json({ error: "Couldn't play this preview.", code: "internal" }, { status: 500 });
  }
}
