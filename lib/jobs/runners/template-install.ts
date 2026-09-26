/**
 * `template_install` — install (or update) a public catalog template: the
 * download and every check in `lib/templates/cloud/install.ts`, run as a job so
 * it reports progress, can be cancelled, and has ONE owner per template
 * whichever surface asked. Behind `libi.apply_template({ cloudId })` (the MCP
 * child reaches it over HTTP, never directly) and the Templates page's
 * `POST /api/templates/cloud/install`.
 *
 * Params are `{ cloudId, version? }` and nothing else, so two installs of the
 * same template — the agent's and the page's, or an agent's retry after its
 * client timed out — share one `(kind, paramsHash)`. Every caller enqueues
 * with `forceNew`: an install must never be answered from an earlier run's
 * cached row (the template may have been deleted since, or have a newer
 * version), and `exclusiveResource` turns `forceNew` into "attach" while a run
 * is in flight. A re-download of the installed version is `discardOutput`, a
 * caller's explicit choice about the bytes on disk — never a param.
 */
import { z } from "zod/v3";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";
import { CancelledError, type JobRunner } from "@/lib/jobs/types";
import { CLOUD_ID_PATTERN } from "@/lib/templates/cloud/constants";
import { installTemplate, type InstallErrorCode } from "@/lib/templates/cloud/install";
import { catalogSource, withCatalogSource } from "@/lib/templates/cloud/catalog-source";

const CANCEL_POLL_MS = 500;

const paramsSchema = z
  .object({
    cloudId: z.string().regex(CLOUD_ID_PATTERN, "not a catalog template id"),
    /** The version the caller's listing showed; omitted, the catalog's current one. */
    version: z.number().int().positive().optional(),
  })
  .strict();
export type TemplateInstallParams = z.infer<typeof paramsSchema>;

export interface TemplateInstallResult {
  templateId: string;
  version: number;
  reinstalled: boolean;
}

/**
 * A failed install, as the job throws it: the message is the agent's (it reads
 * the job's error), `code` is what the Templates page's route maps to libi's
 * own copy — never showing the message, which can carry the site's words.
 */
export class TemplateInstallError extends Error {
  constructor(
    message: string,
    readonly code: InstallErrorCode,
  ) {
    super(message);
    this.name = "TemplateInstallError";
  }
}

/**
 * Whether `err` is a `TemplateInstallError`, judged by its name (and a string `code`). Not
 * `instanceof`: this runner is registered with the globalThis JobManager by whichever route bundle
 * built it first, and each Next route bundle has its own copy of this module.
 */
export function isTemplateInstallError(err: unknown): err is TemplateInstallError {
  return err instanceof Error && err.name === "TemplateInstallError" && typeof (err as { code?: unknown }).code === "string";
}

export const templateInstallRunner: JobRunner<TemplateInstallParams, TemplateInstallResult> = {
  kind: "template_install",
  // Network-bound and small (≤ 24 MB each); installs of different templates may overlap.
  maxConcurrent: 2,
  paramsSchema: paramsSchema as unknown as z.ZodSchema<TemplateInstallParams>,
  // A restart starts the download over; the checkpoints are progress records.
  resumable: false,
  // One install of a template at a time: a second caller attaches to the run in flight.
  exclusiveResource: true,
  // Progress ticks per file; one file may take up to its 60 s download timeout.
  noProgressTimeoutMs: 120_000,
  mcpToolId: makeMcpToolId("libi", "libi.apply_template"),
  async run(ctx) {
    const ac = new AbortController();
    const poll = setInterval(() => {
      if (ctx.shouldCancel()) ac.abort();
    }, CANCEL_POLL_MS);
    try {
      ctx.reportProgress(0, 100, "%");
      // Pinned to the catalog it started under: a switch in Settings meanwhile (a dev build) never splits one install across two.
      const r = await withCatalogSource(catalogSource(), () =>
        installTemplate(ctx.params.cloudId, {
          version: ctx.params.version,
          force: ctx.discardOutput === true,
          signal: ac.signal,
          onFile: async (p) => {
            ctx.reportProgress(p.totalBytes > 0 ? Math.round((100 * p.doneBytes) / p.totalBytes) : 100, 100, "%");
            await ctx.checkpoint({ step: "downloaded", file: p.name, files: p.index, of: p.count });
          },
        }),
      );
      if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
      if (!r.ok) throw new TemplateInstallError(r.error, r.code);
      ctx.reportProgress(100, 100, "%");
      return { templateId: r.templateId, version: r.version, reinstalled: r.reinstalled };
    } finally {
      clearInterval(poll);
    }
  },
};
