import { NextResponse } from "next/server";
import fs from "node:fs";
import { isSafePieceId } from "@/lib/security/pieceId";
import { isUnsafeUrlParamName } from "@/lib/storage/safe-name";
import { getTemplate, readTemplateFile } from "@/lib/templates/store";
import { serveFileWithRange } from "@/lib/http/range";
import { MEDIA_RESPONSE_CSP, SVG_TYPE, anyMediaTypeFor } from "@/lib/http/media-types";

export const dynamic = "force-dynamic";

/** The only two files served from the template's own root. Everything else
 *  must be an asset, and is looked for under `assets/` — so `template.json`,
 *  `index.md` and a code file are not reachable through this route. */
const TOP_LEVEL = new Set(["poster.jpg", "example.mp4"]);

/**
 * Extension ALLOWLIST: the shared media table (`lib/http/media-types.ts`),
 * which is also the content-type table — the allowlist and the type cannot
 * disagree, and `lib/http/mime.ts` answers `application/octet-stream` for half
 * of these, which opaque-response blocking would then refuse under `nosniff`.
 *
 * Nothing outside it is served AT ALL. An asset's basename is whatever the
 * extracting agent named the source file, so `evil.js` / `evil.html` under
 * `assets/` is a reachable name — and libi's CSP allows inline scripts, so
 * serving one from libi's own origin would run it as libi.
 *
 * An SVG is a document: navigated to directly it can carry script, and
 * `image/svg+xml` is not something `nosniff` alone defuses. It gets
 * `MEDIA_RESPONSE_CSP` (`default-src 'none'; sandbox`). NOTE: proxy.ts sets the
 * response CSP for every path and Next keeps the PROXY's header over a route's,
 * so it is proxy.ts that sets the same policy on this path — the header here is
 * the route's own statement, and what a direct handler call (the tests) sees.
 */
/** GET /api/templates/[id]/media/[name] — poster.jpg, example.mp4, or an
 *  asset's basename under assets/ (`?as=asset` asks for the asset even when
 *  its name is poster.jpg or example.mp4). Basename-only by construction (a route
 *  segment holds no slash; the shared segment guard `isUnsafeUrlParamName`
 *  and a leading-dot check refuse the rest),
 *  then an extension allowlist, then realpath containment inside the template
 *  dir (`readTemplateFile`), so a planted symlink cannot leak a file from
 *  outside. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; name: string }> },
): Promise<Response> {
  const { id, name } = await ctx.params;
  const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!isSafePieceId(id) || !getTemplate(id)) return notFound();
  // The shared per-SEGMENT guard (`...` inside a name is ordinary; `..`, separators, encoded
  // traversal and the Windows hazards are not), plus no hidden (leading-dot) files.
  if (isUnsafeUrlParamName(name) || name.startsWith(".")) return notFound();
  const contentType = anyMediaTypeFor(name);
  if (!contentType) return notFound();
  // `?as=asset`: the asset of that name, even when it is called poster.jpg or example.mp4 (an
  // extracted asset is named after its source file) — never the template's own (D5–D6 M6).
  const asAsset = new URL(req.url).searchParams.get("as") === "asset";
  const rel = TOP_LEVEL.has(name) && !asAsset ? name : `assets/${name}`;
  let real: string;
  try {
    real = await readTemplateFile(id, rel);
  } catch {
    // Missing, or it resolved outside the template folder.
    return notFound();
  }
  let stat: fs.Stats;
  try {
    // `real` is already realpath'd, so this can never be a symlink — it is the
    // existence + EISDIR guard `serveFileWithRange`'s read stream needs.
    stat = fs.lstatSync(real);
  } catch {
    return notFound();
  }
  if (!stat.isFile()) return notFound();
  return serveFileWithRange({
    filePath: real,
    contentType,
    cacheControl: "private, max-age=60",
    request: req,
    extraHeaders: {
      "X-Content-Type-Options": "nosniff",
      ...(contentType === SVG_TYPE ? { "Content-Security-Policy": MEDIA_RESPONSE_CSP } : {}),
    },
  });
}
