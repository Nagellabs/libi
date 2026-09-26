import { NextResponse } from "next/server";
import { getTemplatesAuthor } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal } from "@/lib/security/request-guard";

export const dynamic = "force-dynamic";

/**
 * POST → { key }: the creator key itself, for the Settings card's explicit
 * Reveal or Copy — the one answer that carries it. A POST on purpose: the
 * proxy's origin gate covers every unsafe method but lets a loopback GET
 * through whatever its origin (its DNS-rebinding Host check covers both), so
 * the key never rides on a request any page may send. It also takes the same browser-only checks as a publish confirm
 * (`browserOnlyRefusal`): the key speaks the catalog's publish protocol, so an
 * agent's tool call or shell must not be handed it by asking. 404 when there
 * is no identity; revealing never creates one.
 */
export async function POST(req: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "templates-cloud", op: "key_reveal_refused", reason: refused }, "creator key reveal refused: not from libi's own page");
    return NextResponse.json({ error: "The creator key is revealed only on libi's own Settings page.", code: "browser_only" }, { status: 403, headers });
  }
  const author = getTemplatesAuthor();
  if (!author) return NextResponse.json({ error: "This install has no creator key yet." }, { status: 404, headers });
  return NextResponse.json({ key: author.key }, { headers });
}
