import { NextResponse } from "next/server";
import {
  TemplatesAuthorChangedError,
  TemplatesAuthorWriteError,
  getOrCreateTemplatesAuthor,
  getTemplatesAuthor,
  importTemplatesAuthorKey,
  setTemplatesAuthorNickname,
  type TemplatesAuthorSetting,
} from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal, crossSiteSubresourceRefusal } from "@/lib/security/request-guard";
import { CREATOR_KEY_PATTERN, NOT_A_CREATOR_KEY, maskCreatorKey, parseNickname } from "@/lib/templates/cloud/author-rules";
import { fetchMine } from "@/lib/templates/cloud/client";
import { creatorKeyInUse, publishedHere } from "@/lib/templates/cloud/key-usage";

export const dynamic = "force-dynamic";

/**
 * The Settings → General creator-key card. The key is the one secret settings
 * holds, and none of these answers carry it — only its mask. The key itself
 * comes from `POST ./reveal` alone, on the user's explicit Reveal or Copy: a
 * POST, because the proxy's origin gate covers only unsafe methods: a
 * loopback GET passes whatever its origin (lib/security/request-guard.ts —
 * the DNS-rebinding Host check alone covers every method). Never in a URL (the import travels in a PUT body),
 * never logged, never cached (`no-store`).
 *
 *   GET  → { hasKey, masked, authorId, nickname, publishedHere } — creating
 *        the identity, with its default nickname, on the first view: every
 *        user has a nickname to see and edit from the start. A write, so a
 *        cross-site or same-site subresource request is refused first (403
 *        `cross_site_read`, `crossSiteSubresourceRefusal`). `publishedHere`:
 *        this machine holds a publish under this catalog (key-usage.ts) — the
 *        card warns before an import only then, or when the site lists any.
 *   POST → the same (kept for older pages).
 *   PUT  { key, replace? } → import a key from another machine, then (best
 *        effort) learn the nickname it already publishes under from the site.
 *        Replacing a DIFFERENT stored key that has been USED — anything
 *        published under it, here or on the site (entries libi can't read
 *        included), a nickname the site holds for it, or the site can't say
 *        (lib/templates/cloud/key-usage.ts) — takes `replace: true`; without
 *        it the answer is 409 `replace_required` and nothing changes. An
 *        unused key (the one made on first view) is replaced silently. This route
 *        compares the whole key — the card only ever sees the mask, which a
 *        different key can share. Takes the browser-only checks
 *        (`browserOnlyRefusal`), like a publish confirm and the reveal: a key
 *        the agent chose would put the user's next reviewed publish under an
 *        identity the agent already holds. 403 `browser_only` otherwise. Not
 *        authentication: see the LIMITATIONS in lib/approval/extensions.ts.
 */
const NO_STORE = { "Cache-Control": "no-store" } as const;
const CHANGED = "The creator key changed while it was being saved. Reload and try again.";
// Never the driver's error: a failed write's message carries its parameters, the key among them.
const NOT_SAVED = (e: TemplatesAuthorWriteError) => `The creator key couldn't be saved on this machine (${e.sqliteCode ?? "database error"}). Try again.`;
const REPLACE_REQUIRED = "This install already has a different creator key. Confirm that you want to replace it.";

function shape(a: TemplatesAuthorSetting | null) {
  return { hasKey: a !== null, masked: a ? maskCreatorKey(a.key) : null, authorId: a?.authorId ?? null, nickname: a?.nickname ?? null, publishedHere: a ? publishedHere() : false };
}

function answer(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET(req: Request): Promise<Response> {
  const refused = crossSiteSubresourceRefusal(req);
  if (refused) {
    logger.warn({ tag: "templates-cloud", op: "key_status_refused", reason: refused }, "refused a cross-site request for the creator key status");
    return answer({ error: "The creator key is shown only on libi's own page.", code: "cross_site_read" }, 403);
  }
  return POST();
}

export async function POST(): Promise<Response> {
  try {
    return answer(shape(getOrCreateTemplatesAuthor()));
  } catch (err) {
    if (err instanceof TemplatesAuthorChangedError) return answer({ error: CHANGED }, 409);
    if (err instanceof TemplatesAuthorWriteError) return answer({ error: NOT_SAVED(err) }, 500);
    throw err;
  }
}

export async function PUT(req: Request): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "templates-cloud", op: "key_import_refused", reason: refused }, "creator key import refused: not from libi's own page");
    return answer({ error: "A creator key is imported only on libi's own Settings page.", code: "browser_only" }, 403);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return answer({ error: "invalid JSON body" }, 400);
  }
  const { key: raw, replace } = typeof body === "object" && body !== null ? (body as { key?: unknown; replace?: unknown }) : {};
  if (typeof raw !== "string") return answer({ error: "key is required" }, 400);
  if (!CREATOR_KEY_PATTERN.test(raw.trim())) return answer({ error: NOT_A_CREATOR_KEY }, 400);
  // The key already in use: nothing to replace, and its nickname stays.
  const current = getTemplatesAuthor();
  if (current && current.key === raw.trim()) return answer(shape(current));
  // Ask only before replacing a key something was published under; the one made on first view goes silently.
  if (current && replace !== true && (await creatorKeyInUse(current.key))) return answer({ error: REPLACE_REQUIRED, code: "replace_required" }, 409);
  // The key checked is the key replaced: another import may have landed while the site answered, or a
  // publish started under it (a Publish in another tab) — then it is used after all.
  if (current && replace !== true && getTemplatesAuthor()?.key !== current.key) return answer({ error: CHANGED }, 409);
  if (current && replace !== true && publishedHere()) return answer({ error: REPLACE_REQUIRED, code: "replace_required" }, 409);
  let author: TemplatesAuthorSetting;
  try {
    author = importTemplatesAuthorKey(raw);
  } catch (err) {
    if (err instanceof TemplatesAuthorWriteError) return answer({ error: NOT_SAVED(err) }, 500);
    return answer({ error: NOT_A_CREATOR_KEY }, 400);
  }
  // Best effort: the nickname this key already publishes under, held to the
  // site's own rule. Written only while the key is still the one just imported
  // (another import may have landed while the site answered) and its nickname
  // still the default the import stored (the user may have set one meanwhile).
  // A key the site has no nickname for keeps that default.
  const mine = await fetchMine(author.key);
  const parsed = mine.ok && mine.nickname ? parseNickname(mine.nickname) : null;
  if (parsed?.ok) {
    let wrote: boolean;
    try {
      wrote = setTemplatesAuthorNickname(author.key, parsed.nickname, { expectedNickname: author.nickname });
    } catch (err) {
      // The key itself is saved; only the cached nickname is not. "Your templates" re-reads it from the site.
      if (err instanceof TemplatesAuthorWriteError) return answer(shape(author));
      throw err;
    }
    if (!wrote) {
      const now = getTemplatesAuthor();
      // Same key, nickname set meanwhile: theirs stands. Any other change: the key moved.
      if (now?.key !== author.key) return answer({ error: CHANGED }, 409);
      return answer(shape(now));
    }
    author = { ...author, nickname: parsed.nickname };
  }
  return answer(shape(author));
}
