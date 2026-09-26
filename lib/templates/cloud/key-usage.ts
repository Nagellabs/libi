/**
 * Has this install's creator key been USED — has anything been published (or
 * started publishing) under it? The key import asks before it replaces a key,
 * because replacing a used key strands the templates published under it; an
 * identity libi made on its own the first time the user opened Templates or
 * Settings, and never used, is replaced silently.
 *
 * Used means any of:
 *   - locally, a template linked to this catalog (a `cloudId` or a pending
 *     publish), or a publish request that is publishing right now;
 *   - on the site, `/mine` lists any template for the key — entries libi
 *     can't read (dropped by its schema) included: they are still the key's —
 *     or holds a nickname for it (the user renamed it, or a publish set one:
 *     either way someone chose that name under this key);
 *   - the site could not be asked (unreachable, refused): unknown counts as
 *     used, so a doubt always asks.
 * Local evidence is not tied to the key (a template's row does not say which
 * key published it), which also errs towards asking.
 */
import { and, eq, isNotNull, or } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { templatePublishRequests, templates } from "@/lib/db/schema/sqlite";
import { catalogSource } from "@/lib/templates/cloud/catalog-source";
import { fetchMine } from "@/lib/templates/cloud/client";
import { linkedToThisCatalog } from "@/lib/templates/store";

/** Anything on this machine that a publish under the current catalog left behind. No network. */
export function publishedHere(): boolean {
  const db = getDb();
  const linked = db
    .select({ id: templates.id })
    .from(templates)
    .where(and(or(isNotNull(templates.cloudId), isNotNull(templates.publishPending)), linkedToThisCatalog()))
    .limit(1)
    .get();
  if (linked) return true;
  const publishing = db
    .select({ id: templatePublishRequests.id })
    .from(templatePublishRequests)
    .where(and(eq(templatePublishRequests.status, "publishing"), eq(templatePublishRequests.source, catalogSource())))
    .limit(1)
    .get();
  return Boolean(publishing);
}

/** Whether replacing `key` needs the user's confirmation. One site read when nothing local decides it. */
export async function creatorKeyInUse(key: string): Promise<boolean> {
  if (publishedHere()) return true;
  const mine = await fetchMine(key);
  if (!mine.ok) return true;
  return mine.templates.length > 0 || (mine.dropped ?? 0) > 0 || mine.nickname !== null;
}
