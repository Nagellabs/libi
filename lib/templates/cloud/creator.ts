/**
 * Creator approval, libi's side. Publishing to the public catalog is
 * invite-only (libi-site lib/templates/creators.ts): a creator applies from the
 * Templates page, the owner approves in the Firebase console, and only an
 * approved creator key publishes. The site is the gate; this file answers
 * "may this install publish?" early — for the Templates page and for
 * libi.publish_template, which refuses before preparing anything.
 *
 * The applicant's email is sent to the site and nowhere else: never logged.
 */
import { z } from "zod/v3";
import { getOrCreateTemplatesAuthor, getTemplatesAuthor } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import { creatorStatus } from "@/lib/templates/cloud/client";
import { CREATOR_NOTE_MAX } from "@/lib/templates/cloud/constants";
import { multiLineTextProblem } from "@/lib/templates/cloud/text-rules";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** RFC 5321's path limit; the site refuses longer. */
const EMAIL_MAX = 254;
const inputSchema = z.object({ email: z.string(), note: z.string().optional() }).strict();

/** The Templates page's application form, held to the site's rules before anything is sent. */
export function parseCreatorApplicationInput(body: unknown): { ok: true; email: string; note: string } | { ok: false; error: string } {
  const r = inputSchema.safeParse(body);
  if (!r.success) return { ok: false, error: "Send an email address, and optionally a note." };
  const email = r.data.email.trim().toLowerCase();
  if (email.length > EMAIL_MAX || !EMAIL.test(email)) return { ok: false, error: "That doesn't look like a valid email." };
  const note = (r.data.note ?? "").trim();
  if (note.length > CREATOR_NOTE_MAX) return { ok: false, error: `Keep the note under ${CREATOR_NOTE_MAX} characters.` };
  if (note && multiLineTextProblem(note) !== null) return { ok: false, error: "The note has characters the catalog doesn't accept." };
  return { ok: true, email, note };
}

/** What libi.publish_template tells the agent when this install may not publish — libi's words, never the site's. */
export const CREATOR_GATE_MESSAGES = {
  none: "Publishing is invite-only; apply on the Templates page (\"Apply to publish\"). Nothing was prepared — the template stays private on this machine.",
  pending:
    "Publishing is invite-only; apply on the Templates page — this user already has, and the application is waiting for review. Nothing was prepared; they can publish once approved.",
  rejected: "Publishing is invite-only, and this creator key wasn't approved. Nothing was prepared — the template stays private on this machine.",
  unknown: "Couldn't check whether this user may publish — the catalog didn't answer. Nothing was prepared; try again in a minute.",
} as const;

/**
 * `status`: why the gate refused — the site's word for the key, or `unknown`
 * when the site didn't answer (nothing is known about the key then).
 */
export type CreatorGate = { ok: true } | { ok: false; status: "none" | "pending" | "rejected" | "unknown"; error: string };

function refuse(status: "none" | "pending" | "rejected" | "unknown"): CreatorGate {
  return { ok: false, status, error: CREATOR_GATE_MESSAGES[status] };
}

/**
 * May this install publish? Asks the site for the creator key's status.
 *
 * With no identity yet, one is created HERE — in the MCP child, on every
 * libi.publish_template call, before any local check (even for a template
 * that doesn't exist). That is earlier than anything else does it: preparing
 * creates the identity only inside the server's prepare job, after preflight
 * has passed (recordPublishRequest, lib/templates/cloud/publish-requests.ts),
 * and the Templates page creates it on first view. The new key then goes, as
 * a bearer, only to the site's GET /creators/me — the origin every publish
 * already talks to; the site writes nothing on that read. On the real site a
 * fresh key is always `none`, so in production this buys nothing but the
 * refusal; it exists because the test-mode catalog answers
 * `LIBI_TEST_CATALOG_CREATOR` for every key, which lets the skill-eval
 * publish scenarios on a fresh LIBI_HOME reach the catalog.
 *
 * An identity that can't be created falls back to the stored one; with none
 * at all the answer is `none` and the site is not asked (both logged). A site
 * that doesn't answer → `unknown`: fail closed, the publish is not prepared.
 * Never throws.
 */
export async function checkCreatorApproved(): Promise<CreatorGate> {
  let key: string | null = null;
  try {
    key = getOrCreateTemplatesAuthor().key;
  } catch (err) {
    // Never the error's message: a failed write's carries its parameters, the key among them.
    logger.warn(
      { tag: "templates-cloud", op: "creator_identity_unavailable", error: err instanceof Error ? err.name : typeof err },
      "creator identity couldn't be created; checking the stored one",
    );
    try {
      key = getTemplatesAuthor()?.key ?? null;
    } catch (readErr) {
      logger.warn(
        { tag: "templates-cloud", op: "creator_identity_unreadable", error: readErr instanceof Error ? readErr.name : typeof readErr },
        "stored creator identity couldn't be read; publish not prepared",
      );
      key = null;
    }
  }
  if (!key) return refuse("none");
  const r = await creatorStatus(key);
  if (!r.ok) {
    logger.info({ tag: "templates-cloud", op: "creator_status_unknown", status: r.status ?? null, code: r.code ?? null }, "creator status unknown; publish not prepared");
    return refuse("unknown");
  }
  if (r.status === "approved") return { ok: true };
  // The one trace an invite-only refusal leaves (the MCP tool returns it to the agent and
  // logs nothing else): the site's word only, never the key.
  logger.info({ tag: "templates-cloud", op: "creator_not_approved", status: r.status }, "creator not approved; publish not prepared");
  return refuse(r.status);
}
