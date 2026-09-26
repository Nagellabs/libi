/**
 * Test mode only (LIBI_TEST_MODE=1): `DELETE /api/test-mode/catalog-cache`
 * makes libi forget its cached copy of the public catalog, as if it had never
 * fetched one (lib/templates/cloud/catalog-cache.ts#forgetCatalogCopy). The
 * e2e spec for the Public tab needs a first open, and an earlier spec in the
 * same run may already have opened the Templates page.
 *
 * Outside test mode every method answers a bare 404, before a byte of the body
 * is read — the same gate as the fixture catalog beside it
 * (app/api/test-mode/templates-catalog). Every method Next routes is exported
 * for that reason: one left out would get Next's automatic answer (an OPTIONS
 * 204 with `Allow`, a 405), which says the route exists.
 */
import { isTestMode } from "@/lib/test-mode";
import { forgetCatalogCopy } from "@/lib/templates/cloud/catalog-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request): Promise<Response> {
  if (!isTestMode()) return new Response(null, { status: 404 });
  if (req.method !== "DELETE") return new Response(null, { status: 405, headers: { Allow: "DELETE" } });
  forgetCatalogCopy();
  return Response.json({ ok: true });
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
