import { NextResponse } from "next/server";
import { listTemplates, searchTemplates } from "@/lib/templates/store";
import type { TemplateOrder, TemplateScope } from "@/lib/templates/types";

export const dynamic = "force-dynamic";

const ORDERS: readonly TemplateOrder[] = ["trending", "most-used", "newest"];
const SCOPES: readonly TemplateScope[] = ["local", "public", "all"];
/** The page renders the whole local library; `searchTemplates` caps at 200. */
const LIMIT = 200;

/** GET /api/templates?q=&tags=a,b&order=&scope= — search when `q` has 2+ chars
 *  or a tag filter is set, else list. A one-character `q` is deliberately NOT
 *  a search: FTS on a single token matches nearly everything, so the list is
 *  the honest answer while the user is still typing. */
export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const q = sp.get("q") ?? "";
  const tags = (sp.get("tags") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const orderRaw = sp.get("order");
  const scopeRaw = sp.get("scope");
  const order = ORDERS.includes(orderRaw as TemplateOrder) ? (orderRaw as TemplateOrder) : "trending";
  const scope = SCOPES.includes(scopeRaw as TemplateScope) ? (scopeRaw as TemplateScope) : "local";
  const templates =
    q.trim().length >= 2 || tags.length > 0
      ? await searchTemplates({ query: q, tags, order, scope, limit: LIMIT })
      : await listTemplates({ order, scope });
  return NextResponse.json({ templates });
}
