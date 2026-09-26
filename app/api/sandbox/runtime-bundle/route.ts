import { NextResponse } from "next/server";
import { getOverlayRuntimeBundle, getOverlayWorkerBundle } from "@/lib/sandbox/runtime-bundle";
import { serverLogger as logger } from "@/lib/logger";

/**
 * The overlay runtime as one JS script (spec §4.1 + A1): the supervisor with
 * the worker embedded. Content-hashed: the page names it `?v=<hash>`, so it is
 * immutable per hash and the ETag is the hash. `?part=worker` serves the worker
 * alone — the dev-only in-origin mode spawns it as a same-origin blob worker
 * (lib/sandbox/in-origin-transport.ts).
 */
export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const part = params.get("part");
  let bundle;
  try {
    bundle = part === "worker" ? await getOverlayWorkerBundle() : await getOverlayRuntimeBundle();
  } catch (err) {
    logger.error(
      { tag: "overlay-sandbox", op: "runtime_bundle_build_failed", part, err },
      "overlay-sandbox: runtime bundle build failed",
    );
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
  const etag = `"${bundle.hash}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  // `immutable` is only ever correct for a URL that NAMES this content — the
  // page's own `?v=<hash>`. A bare GET and `?part=worker` are stable URLs whose
  // body changes with the code, so a year-long immutable entry on one of those
  // is a copy an upgrade could never dislodge; they revalidate on the ETag.
  const immutable = process.env.NODE_ENV === "production" && params.get("v") === bundle.hash;
  return new Response(bundle.code, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      etag,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}
