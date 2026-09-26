import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { MEDIA_RESPONSE_CSP } from "@/lib/http/media-types";
import { serverLogger as logger } from "@/lib/logger";
import { crossSiteSubresourceRefusal } from "@/lib/security/request-guard";
import { AssetStreamRefusal, hostOf, openAssetStream, type AssetStreamRefusalCode } from "@/lib/templates/cloud/asset-stream";
import { confirmStreamableAsset } from "@/lib/templates/cloud/catalog-detail";
import { CLOUD_ID_PATTERN } from "@/lib/templates/cloud/constants";

export const dynamic = "force-dynamic";

const TAG = "templates-cloud";
const MAX_URL_CHARS = 2048;

/** The answer for each refusal: its status and libi's words (never the upstream's). */
const REFUSED: Record<AssetStreamRefusalCode, number> = {
  invalid_url: 403,
  private_address: 403,
  too_many_redirects: 502,
  dns_failed: 502,
  unreachable: 502,
  upstream_status: 502,
  timeout: 504,
  wrong_type: 415,
  too_large: 413,
};

/**
 * GET /api/templates/cloud/asset-stream?cloudId=<id>&url=<asset url> — plays
 * a public template's link-only audio or video inline on its page, from
 * libi's own origin, so the app CSP's `media-src` needs no stranger's host.
 *
 * Only an asset its page already showed: `url` must be a link-only audio or
 * video asset of `cloudId` in a scaffold this process read and checked for
 * that page (the install's asset check has passed), of a template the
 * catalog still lists — re-asked on demand when its last word is older than
 * 15 minutes (`confirmStreamableAsset`): 404 `not_found` once it is gone,
 * 429 while the catalog's limit holds.
 * The fetch itself is `openAssetStream` (lib/templates/cloud/asset-stream.ts):
 * https only, the install's public-host rule and a DNS check against private,
 * loopback, link-local and metadata ranges on EVERY redirect hop (at most 3),
 * the connection pinned to the checked address, audio/* or video/* only, a
 * byte cap and timeouts. The page's `Range` is forwarded, so seeking works.
 * The page mounts the player only when the user presses play — nothing is
 * fetched on page load.
 *
 * A read with an outside effect (it calls a third party), so another page's
 * request is refused first (403 `cross_site_read`). The bytes are a
 * stranger's: served with `nosniff`, no caching, and the media CSP
 * (proxy.ts, lib/security/media-paths.ts). Logged by host only — never the
 * URL, whose query may carry a signature.
 */
export async function GET(req: Request): Promise<Response> {
  const refused = crossSiteSubresourceRefusal(req);
  if (refused) {
    logger.warn({ tag: TAG, op: "asset_stream_refused", reason: refused }, "refused a cross-site request for a template's media");
    return NextResponse.json({ error: "A template's media plays only on libi's own page.", code: "cross_site_read" }, { status: 403 });
  }
  const q = new URL(req.url).searchParams;
  const cloudId = q.get("cloudId") ?? "";
  const url = q.get("url") ?? "";
  if (!CLOUD_ID_PATTERN.test(cloudId) || url.length === 0 || url.length > MAX_URL_CHARS) {
    return NextResponse.json({ error: "Not a template's media.", code: "invalid" }, { status: 400 });
  }
  const gate = await confirmStreamableAsset(cloudId, url);
  if (!gate.ok) {
    logger.warn({ tag: TAG, op: "asset_stream_refused", reason: gate.code, cloudId, host: hostOf(url) }, "a template's media was not streamed");
    switch (gate.code) {
      case "not_an_asset":
        return NextResponse.json({ error: "Open the template's page again, then play it.", code: gate.code }, { status: 404 });
      case "not_found":
        return NextResponse.json({ error: "This template is no longer in the catalog.", code: gate.code }, { status: 404 });
      case "rate_limited":
        return NextResponse.json(
          { error: "The catalog asked libi to slow down. Try again in a minute.", code: gate.code, retryAfterSec: gate.retryAfterSec },
          { status: 429, headers: { "Retry-After": String(gate.retryAfterSec) } },
        );
      default:
        return NextResponse.json({ error: "Couldn't check the catalog. Try again.", code: gate.code }, { status: 502 });
    }
  }
  try {
    const s = await openAssetStream(url, { range: req.headers.get("range"), signal: req.signal });
    logger.info({ tag: TAG, op: "asset_stream_started", cloudId, host: s.host, status: s.status }, "streaming a template's media");
    return new Response(Readable.toWeb(s.body) as ReadableStream, {
      status: s.status,
      headers: {
        ...s.headers,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": MEDIA_RESPONSE_CSP,
      },
    });
  } catch (err) {
    if (err instanceof AssetStreamRefusal) {
      logger.warn(
        { tag: TAG, op: "asset_stream_refused", reason: err.code, cloudId, host: hostOf(url), ...(err.upstreamStatus ? { upstreamStatus: err.upstreamStatus } : {}) },
        "a template's media was not streamed",
      );
      return NextResponse.json({ error: err.message, code: err.code }, { status: REFUSED[err.code] });
    }
    if (req.signal.aborted) return new Response(null, { status: 499 });
    logger.error({ tag: TAG, op: "asset_stream_failed", cloudId, host: hostOf(url), err: err instanceof Error ? err.name : "unknown" }, "streaming a template's media failed");
    return NextResponse.json({ error: "Couldn't play this media.", code: "internal" }, { status: 500 });
  }
}
