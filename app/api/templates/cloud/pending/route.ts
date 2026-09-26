import fsp from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { templates } from "@/lib/db/schema/sqlite";
import { getTemplatesAuthor } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import { navigationEmitter } from "@/lib/navigation-events";
import { catalogSource, describeCatalog, isProductionLink, otherCatalogOf, whereProductionIsUsed } from "@/lib/templates/cloud/catalog-source";
import { mineShowsLive } from "@/lib/templates/cloud/client";
import type { PendingPublish } from "@/lib/templates/types";
import {
  allUploaded,
  getPublishPending,
  getTemplate,
  getTemplateRecord,
  listPublishPendingTemplates,
  publishWorkDir,
  publishingTemplateIds,
  unansweredCommitMayRun,
  type PublishPending,
} from "@/lib/templates/store";

export const dynamic = "force-dynamic";

/**
 * The Templates page's "Discard the pending publish" list, under "Publishing as".
 *
 *   GET → { pending: PendingPublish[] }
 *   DELETE { templateId } → forget that template's pending publish and its
 *        `<LIBI_HOME>/template-publish/<id>` folder: `{ ok: true }`; 404 when
 *        there is none; 409 `{ error, code }` when discarding could let the
 *        next publish make a second public copy.
 *
 * Discarding gives up the catalog id libi was keeping for that template, so a
 * first publish's next attempt starts fresh under a new id. That is safe only
 * when the discarded publish can't be live, so DELETE refuses:
 *   - while a publish of the template is queued, running or stopping;
 *   - an `unfinished` record, unless (a) not every upload finished, so no
 *     commit was ever sent; or (b) the template already has a catalog id, so
 *     the next publish reuses it; or (c) the record was prepared under the
 *     current creator key (its `authorId` — a record naming none counts as
 *     another key's, whose templates this key's list can't see), that key's
 *     own list, read fail-closed, shows the id not live at that version, and
 *     no commit that got no answer may still be running on the site.
 * A `reserved` (abandoned), `needs-attention` or unreadable record may always
 * be discarded: the publish job's own errors send the creator here for them.
 *
 * A record started against ANOTHER catalog (test mode and a normal boot share
 * LIBI_HOME) is listed as `other-catalog`, never judged by this one's list: a
 * throwaway catalog's (the fixture's, a staging site's) is discarded at once;
 * the production catalog's is refused (`other_catalog`) — only a libi reading
 * that catalog can tell whether it went live.
 *
 * The job check and the clear run in one IMMEDIATE transaction that clears
 * only the exact record judged, so neither a publish starting nor the runner
 * rewriting the record while the site answers can slip between them.
 */
const TAG = "templates-cloud";

/** Why a production-catalog record is not discarded from another catalog. */
function otherCatalogRefusal(): string {
  return `This publish was started against the public catalog, and this libi is using ${describeCatalog(catalogSource())}. Finish or discard it ${whereProductionIsUsed()}.`;
}

function describe(t: { id: string; name: string }, publishing: Set<string>): PendingPublish {
  const base = { templateId: t.id, name: t.name, cloudId: null, version: null, detail: null };
  const record = getTemplateRecord(t.id);
  const other = record ? otherCatalogOf(record) : null;
  if (other !== null && !publishing.has(t.id)) {
    const detail = isProductionLink(other)
      ? otherCatalogRefusal()
      : `Started against ${describeCatalog(other)}. The next publish of this template starts a new one here; discarding it forgets that one.`;
    return { ...base, state: "other-catalog", detail };
  }
  let pending;
  try {
    pending = getPublishPending(t.id);
  } catch {
    return { ...base, state: publishing.has(t.id) ? "publishing" : "unreadable" };
  }
  if (!pending) return { ...base, state: "unreadable" };
  const known = { ...base, cloudId: pending.cloudId, version: pending.version };
  if (publishing.has(t.id)) return { ...known, state: "publishing" };
  if (pending.needsAttention) return { ...known, state: "needs-attention", detail: pending.needsAttention };
  if (pending.abandoned) return { ...known, state: "reserved" };
  return { ...known, state: "unfinished" };
}

export async function GET(): Promise<Response> {
  const publishing = publishingTemplateIds();
  const pending = listPublishPendingTemplates().map((t) => describe(t, publishing));
  return NextResponse.json({ pending });
}

const PUBLISHING = "This template is publishing right now. Stop that publish first, then discard it.";

type Refusal = { code: "still_publishing" | "cannot_check" | "live" | "other_catalog"; error: string };

/**
 * Why discarding this `unfinished` record could let the next publish make a
 * second public copy — or null when it can't (the rules above).
 */
async function unfinishedRefusal(templateId: string, pending: PublishPending): Promise<Refusal | null> {
  if (!allUploaded(pending)) return null; // (a) no commit was ever sent
  if (getTemplate(templateId)?.cloudId) return null; // (b) the next publish keeps the id
  if (unansweredCommitMayRun(pending)) {
    return { code: "still_publishing", error: "This template is still publishing — try again in a minute. Its last send may still be landing on the catalog." };
  }
  const author = getTemplatesAuthor();
  if (!author) {
    return { code: "cannot_check", error: "libi can't check whether this publish went live: this install has no creator key. Import the key it was published under, then check your published templates." };
  }
  if (pending.authorId !== author.authorId) {
    // Only the key it was prepared under can list it: this key's "not live" would prove nothing.
    return {
      code: "cannot_check",
      error: "This publish was started under another creator key, so libi can't check whether it went live. To finish or discard it, import the key it was published under.",
    };
  }
  const mine = await mineShowsLive(author.key, pending.cloudId, pending.version);
  if (!mine.ok) {
    return { code: "cannot_check", error: `libi couldn't check your published templates (${mine.error}), so it won't risk a second public copy. Try again in a minute.` };
  }
  if (mine.live) {
    return { code: "live", error: "This publish did reach the catalog. The next publish of this template finishes it — libi completes this same publish, not a second one." };
  }
  return null; // (c)
}

export async function DELETE(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const templateId = typeof body === "object" && body !== null ? (body as { templateId?: unknown }).templateId : undefined;
  if (typeof templateId !== "string" || templateId.length === 0) return NextResponse.json({ error: "templateId is required" }, { status: 400 });
  // The exact record judged below, whichever catalog it belongs to: only it is cleared.
  const record = getTemplateRecord(templateId);
  const judged = record?.publishPending ?? null;
  if (!record || !judged) return NextResponse.json({ error: "That template has no pending publish." }, { status: 404 });
  const other = otherCatalogOf(record);
  if (other !== null && isProductionLink(other)) {
    logger.info({ tag: TAG, op: "pending_discard_refused", templateId, code: "other_catalog" }, "pending publish kept: it belongs to the production catalog");
    return NextResponse.json({ code: "other_catalog", error: otherCatalogRefusal() } satisfies Refusal, { status: 409 });
  }
  if (publishingTemplateIds().has(templateId)) return NextResponse.json({ error: PUBLISHING, code: "publishing" }, { status: 409 });
  let work: string;
  try {
    work = publishWorkDir(templateId);
  } catch {
    return NextResponse.json({ error: "not a template id" }, { status: 400 });
  }
  // Another (throwaway) catalog's record reads as none here: nothing of this catalog's to judge.
  let pending: PublishPending | null = null;
  try {
    pending = getPublishPending(templateId);
  } catch {
    // Unreadable: libi won't guess at it — the creator decides.
  }
  if (pending && !pending.abandoned && !pending.needsAttention) {
    const refusal = await unfinishedRefusal(templateId, pending);
    if (refusal) {
      logger.info({ tag: TAG, op: "pending_discard_refused", templateId, code: refusal.code }, "pending publish kept: discarding it could make a second public copy");
      return NextResponse.json(refusal, { status: 409 });
    }
  }
  // After the await: one transaction checks for a live publish and clears
  // only the record judged, so nothing can start or rewrite it in between.
  const outcome = getDb().transaction(
    (tx) => {
      if (publishingTemplateIds(tx).has(templateId)) return "publishing" as const;
      const cleared = tx
        .update(templates)
        .set({ publishPending: null })
        .where(and(eq(templates.id, templateId), eq(templates.publishPending, judged)))
        .run();
      return cleared.changes === 1 ? ("cleared" as const) : ("changed" as const);
    },
    { behavior: "immediate" },
  );
  if (outcome === "publishing") return NextResponse.json({ error: PUBLISHING, code: "publishing" }, { status: 409 });
  if (outcome === "changed") {
    return NextResponse.json({ error: "This publish changed while libi was checking it. Look again, then decide.", code: "changed" }, { status: 409 });
  }
  await fsp.rm(work, { recursive: true, force: true }).catch((err: unknown) => {
    // The record is gone, so nothing will reuse the folder; a leftover is only disk.
    logger.warn({ tag: TAG, op: "pending_discard_rm_failed", templateId, error: err instanceof Error ? err.message : String(err) }, "could not remove the publish work folder");
  });
  logger.info({ tag: TAG, op: "pending_discarded", templateId }, "pending publish discarded by the creator");
  navigationEmitter.emit("refresh_query", { queryKey: "templates" });
  return NextResponse.json({ ok: true });
}
