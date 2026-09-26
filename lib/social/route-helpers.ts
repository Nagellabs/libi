import { NextResponse } from "next/server";
import { isSocialError, socialErrorToResponse, errShape } from "@/lib/social/errors";
import { serverLogger as logger } from "@/lib/logger";

/**
 * Every social route body goes through this: a `SocialError` maps to its own
 * status via `socialErrorToResponse` (never a raw provider payload, never a
 * token); anything else is logged by NAME/CODE only (`errShape` — see
 * `errors.ts` for why `.message` is never safe to log for this feature) and
 * answered as a bare 500, never the original error text.
 */
export async function socialRoute(op: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (isSocialError(err)) {
      const { status, body } = socialErrorToResponse(err);
      // `err.message` is safe HERE and only here: a SocialError's message has already
      // been through redactSecrets() in mcp-client.ts before the error was built. Raw
      // Error#message is never logged — the catch-all below uses errShape(), because the
      // MCP SDK embeds whole response bodies (and therefore secrets) in its messages.
      logger.warn({ tag: "social", op, kind: err.kind, status }, err.message);
      return NextResponse.json(body, { status });
    }
    logger.error({ tag: "social", op, ...errShape(err) }, "social route failed");
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

interface ZodLikeSchema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: unknown } };
}

/** Parse + validate a JSON request body against a zod (v3) schema. Never
 *  throws — a malformed body or a schema mismatch comes back as a `Response`
 *  the caller returns as-is. */
export async function jsonBody<T>(
  req: Request,
  schema: ZodLikeSchema<T>,
): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, res: NextResponse.json({ error: "invalid JSON body" }, { status: 400 }) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, res: NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 }) };
  }
  return { ok: true, data: parsed.data };
}
