import { NextResponse } from "next/server";
import { TemplatesAuthorChangedError, TemplatesAuthorWriteError, getOrCreateTemplatesAuthor, setTemplatesAuthorNickname } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal, crossSiteSubresourceRefusal } from "@/lib/security/request-guard";
import { parseNickname } from "@/lib/templates/cloud/author-rules";
import { catalogSource, withCatalogSource } from "@/lib/templates/cloud/catalog-source";
import { setNickname } from "@/lib/templates/cloud/client";
import { CREATOR_NOT_APPROVED_RENAME_MESSAGE, CREATOR_STATUS_REFRESH_KEY } from "@/lib/templates/cloud/constants";
import { navigationEmitter } from "@/lib/navigation-events";

export const dynamic = "force-dynamic";

/**
 * "Publishing as" on the Templates page. Never the key — only the name the
 * catalog shows on this install's templates, and the author id.
 *
 *   GET → { nickname, authorId }, creating the identity on the first view
 *        (`getOrCreateTemplatesAuthor`) so every user has a nickname from the
 *        start — a random default ("Brave Otter 4821",
 *        lib/templates/cloud/default-nickname.ts) until they rename it; an
 *        older identity without one is given its default here. A write, so a
 *        cross-site or same-site subresource request is refused first (403
 *        `cross_site_read`); 409 / 500 when the identity can't be saved.
 *   PUT { nickname } → held to the site's rule here first, then set on the
 *        site (which creates the author), then stored: `{ nickname, authorId }`,
 *        or `{ error, code? }` — 400 the value is refused, 409 the creator key
 *        changed meanwhile, 429 too many changes, 403 `creator_not_approved`
 *        (not an approved creator, and owns a template in the catalog, hidden
 *        or not: the nickname is on each of them), 403 the site refused the creator key,
 *        502 the site could not be reached, failed, or refused the change for
 *        another reason; 403 `browser_only` when the request didn't come from
 *        libi's own page.
 *
 * PUT takes the browser-only checks (`browserOnlyRefusal`), like a publish
 * confirm: the nickname is public — it renames every template this install
 * has published, and it is what a reviewed publish without its own nickname
 * goes out under. Not authentication: see the LIMITATIONS in
 * lib/approval/extensions.ts.
 */
const CHANGED = "The creator key changed while the nickname was being saved. Try again.";
// Never the driver's error: a failed write's message carries its parameters, the key among them.
const notSaved = (e: TemplatesAuthorWriteError) => `The creator identity couldn't be saved on this machine (${e.sqliteCode ?? "database error"}). Try again.`;

export async function GET(req: Request): Promise<Response> {
  const refused = crossSiteSubresourceRefusal(req);
  if (refused) {
    logger.warn({ tag: "templates-cloud", op: "author_refused", reason: refused }, "refused a cross-site request for the author");
    return NextResponse.json({ error: "Your nickname is shown only on libi's own page.", code: "cross_site_read" }, { status: 403 });
  }
  try {
    // The nickname of the catalog this page is on: each keeps its own (review M4).
    const a = getOrCreateTemplatesAuthor(catalogSource());
    return NextResponse.json({ nickname: a.nickname, authorId: a.authorId });
  } catch (err) {
    if (err instanceof TemplatesAuthorChangedError) return NextResponse.json({ error: CHANGED }, { status: 409 });
    if (err instanceof TemplatesAuthorWriteError) return NextResponse.json({ error: notSaved(err) }, { status: 500 });
    throw err;
  }
}

export async function PUT(req: Request): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "templates-cloud", op: "nickname_refused", reason: refused }, "nickname change refused: not from libi's own page");
    return NextResponse.json({ error: "Your public nickname is set only on libi's Templates page.", code: "browser_only" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const raw = typeof body === "object" && body !== null ? (body as { nickname?: unknown }).nickname : undefined;
  if (typeof raw !== "string") return NextResponse.json({ error: "nickname is required" }, { status: 400 });
  const parsed = parseNickname(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // The catalog renamed on, held across the await: only its own nickname changes (review M4).
  const source = catalogSource();
  let author;
  try {
    author = getOrCreateTemplatesAuthor(source);
  } catch (err) {
    if (err instanceof TemplatesAuthorChangedError) return NextResponse.json({ error: CHANGED }, { status: 409 });
    if (err instanceof TemplatesAuthorWriteError) return NextResponse.json({ error: notSaved(err) }, { status: 500 });
    throw err;
  }
  const key = author.key;
  const r = await withCatalogSource(source, () => setNickname(key, parsed.nickname));
  if (!r.ok) {
    // By the site's code and status, never its words: those are only shown.
    if (r.code === "rate_limited") return NextResponse.json({ error: "Too many nickname changes. Try again in a minute.", code: r.code }, { status: 429 });
    if (r.status === 400) return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, { status: 400 });
    // Invite-only reaches the nickname too: it is on every template the author
    // published, so an author who owns any template (hidden or not) must be an
    // approved creator to change it (libi-site creators.ts#mayRename). A
    // rename's own words — not the publish refusal's "Nothing was published."
    // — and the approval is re-read, since it may have been withdrawn.
    if (r.status === 403 && r.code === "creator_not_approved") {
      navigationEmitter.emit("refresh_query", { queryKey: CREATOR_STATUS_REFRESH_KEY });
      return NextResponse.json({ error: CREATOR_NOT_APPROVED_RENAME_MESSAGE, code: r.code }, { status: 403 });
    }
    const code = r.code ? { code: r.code } : {};
    if (r.status === 401 || r.status === 403) {
      return NextResponse.json({ error: `The catalog didn't accept this install's creator key (${r.error}).`, ...code }, { status: 403 });
    }
    if (r.status === undefined || r.status >= 500) {
      return NextResponse.json({ error: `Couldn't reach the catalog to set the nickname (${r.error}).`, ...code }, { status: 502 });
    }
    return NextResponse.json({ error: `The catalog didn't take the nickname (${r.error}).`, ...code }, { status: 502 });
  }
  // After the await: only while the key is still the one the site just named.
  let wrote: boolean;
  try {
    wrote = setTemplatesAuthorNickname(author.key, r.nickname, { source });
  } catch (err) {
    if (err instanceof TemplatesAuthorWriteError) return NextResponse.json({ error: notSaved(err) }, { status: 500 });
    throw err;
  }
  if (!wrote) return NextResponse.json({ error: CHANGED }, { status: 409 });
  return NextResponse.json({ nickname: r.nickname, authorId: author.authorId });
}
