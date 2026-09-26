/**
 * Test mode only (LIBI_TEST_MODE=1): libi-site's catalog API and the catalog
 * bucket, served by the studio itself (lib/templates/cloud/test-fixture.ts),
 * so lib/templates/cloud/client.ts walks the identical path it would against
 * the site — offline, at zero cost.
 *
 * Outside test mode every method on every path answers a bare 404, before a
 * byte of the body is read. Every method Next routes is exported here for
 * that reason: one left out would get Next's automatic answer (an OPTIONS 204
 * with `Allow`, a 405), which says the route exists.
 */
import { isTestMode } from "@/lib/test-mode";
import { handleFixtureRequest } from "@/lib/templates/cloud/test-fixture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  if (!isTestMode()) return new Response(null, { status: 404 });
  const { path } = await ctx.params;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const body = Buffer.from(await req.arrayBuffer());
  const r = await handleFixtureRequest(req.method, path.join("/"), body, headers);
  return new Response(r.body.byteLength && req.method !== "HEAD" ? new Uint8Array(r.body) : null, { status: r.status, headers: r.headers });
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
