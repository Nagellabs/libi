import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { getJobManager } from "@/lib/jobs/manager";
import { isTemplateInstallError, type TemplateInstallResult } from "@/lib/jobs/runners/template-install";
import { isCancelledError } from "@/lib/jobs/types";
import { navigationEmitter } from "@/lib/navigation-events";
import { activeCatalogSource } from "@/lib/templates/cloud/catalog-setting";
import { CLOUD_ID_PATTERN } from "@/lib/templates/cloud/constants";
import type { InstallErrorCode } from "@/lib/templates/cloud/install";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  cloudId: z.string().regex(CLOUD_ID_PATTERN),
  version: z.number().int().positive().optional(),
  force: z.boolean().optional(),
});

/**
 * libi's own words for an install that failed, by its code — never the job's
 * message, which is the agent's and can carry the site's words.
 */
const INSTALL_ERROR_COPY: Partial<Record<InstallErrorCode, string>> = {
  not_found: "This template is no longer in the catalog.",
  unreachable: "Can't reach the catalog right now. Check your connection and try again.",
  download_failed: "The template's files couldn't be downloaded. Check your connection and try again.",
  rate_limited: "The catalog is busy. Try again in a minute.",
  catalog_error: "The catalog couldn't send this template right now. Try again later.",
  version_changed: "This template changed since the list was loaded. Refresh the catalog and try again.",
  older_version: "A newer version of this template is already installed.",
  code_blocked: "Templates that run code can't be installed yet.",
  rejected: "This template didn't pass libi's checks, so it wasn't installed.",
  catalog_changed: "The templates catalog changed before this install started. Try again.",
  stopped: "The install was stopped.",
};
const INSTALL_FAILED = "Couldn't install the template.";

function installFailure(err: unknown): { error: string; code?: InstallErrorCode } {
  if (isCancelledError(err)) return { error: INSTALL_ERROR_COPY.stopped!, code: "stopped" };
  if (isTemplateInstallError(err)) return { error: INSTALL_ERROR_COPY[err.code] ?? INSTALL_FAILED, code: err.code };
  return { error: INSTALL_FAILED };
}

/**
 * Run the `template_install` job to its end. `forceNew` always: an install is
 * never answered from an earlier run's cached row, and while one is in flight
 * the job's `exclusiveResource` attaches this call to it instead. `force` (a
 * re-download) is `discardOutput`, never a param, so it shares that one run's
 * key; a forced call that found a run in flight waits for it, then runs its own.
 */
async function runInstall(params: { cloudId: string; version?: number; source: string }, force: boolean, retried = false): Promise<TemplateInstallResult> {
  const jm = getJobManager();
  const enq = await jm.enqueue("template_install", params, { forceNew: true, discardOutput: force });
  if (enq.status === "matching_completed") throw new Error("the install could not be started");
  let result: TemplateInstallResult;
  try {
    result = await jm.runToCompletion<TemplateInstallResult>(enq.jobId);
  } catch (err) {
    // This call attached to an install another caller (the agent) stopped:
    // that cancel was theirs, so the page's install runs on its own, once.
    if (isCancelledError(err) && enq.status === "attached_running" && !retried) return runInstall(params, force, true);
    throw err;
  }
  if (force && enq.status === "attached_running") {
    const again = await jm.enqueue("template_install", params, { forceNew: true, discardOutput: true });
    if (again.status === "matching_completed") throw new Error("the install could not be started");
    return jm.runToCompletion<TemplateInstallResult>(again.jobId);
  }
  return result;
}

/**
 * POST /api/templates/cloud/install { cloudId, version?, force? } — install
 * (or update) a public template locally, through the same `template_install`
 * job `libi.apply_template({ cloudId })` uses: `{ ok: true, templateId,
 * version, reinstalled }`. Every failure is `400 { ok: false, error, code? }`:
 * libi's own copy chosen by the install's code (`error` is never the job's
 * message) — offline and a refused template are normal answers, never a 5xx.
 */
export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ ok: false, error: "cloudId is required" }, { status: 400 });
  const { cloudId, version, force } = parsed.data;
  try {
    // The catalog the page is on now: the job installs from it even if the user switches before it starts.
    const r = await runInstall({ cloudId, ...(version !== undefined ? { version } : {}), source: activeCatalogSource({ fresh: true }) }, force === true);
    navigationEmitter.emit("refresh_query", { queryKey: "templates" });
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    return NextResponse.json({ ok: false, ...installFailure(err) }, { status: 400 });
  }
}
