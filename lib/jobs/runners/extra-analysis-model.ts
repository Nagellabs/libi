import { z } from "zod/v3";
import path from "node:path";
import { eq } from "drizzle-orm";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";
import { scriptAnalysisLogger } from "@/lib/logger";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getLibiStorageDir } from "@/lib/libi-home";
import { saveScript, saveCaptionSpec } from "@/lib/analysis/manager";
import { parseAndValidateScript } from "@/lib/analysis/script-validator";
import { buildTestModePlaceholderScriptText } from "@/lib/analysis/test-mode-script";
import { isTestMode } from "@/lib/test-mode";
import { buildScriptPrompt, buildRetryPrompt, pickAnalysisPrompt } from "@/lib/analysis/script-providers/prompt-builder";
import { getScriptProvider } from "@/lib/analysis/script-providers/registry";
import { registerBuiltinScriptProviders } from "@/lib/analysis/script-providers/register";
import type { JobContext, JobRunner } from "@/lib/jobs/types";
import type { Script } from "@/lib/analysis/types";

const extraAnalysisModelParamsSchema = z.object({
  fileId: z.string().min(1),
  pieceId: z.string().min(1).nullable().optional(),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  forceFresh: z.boolean().optional(),
  focus: z.enum(["script", "captions"]).optional(),
});

export type ExtraAnalysisModelParams = z.infer<
  typeof extraAnalysisModelParamsSchema
>;

export interface ExtraAnalysisModelResult {
  script?: Script;
  captionSpec?: string;
}

const log = scriptAnalysisLogger.child({ runner: "extra_analysis_model" });

function resolveSourcePath(file: typeof files.$inferSelect): string {
  const bucket = file.pieceId ?? "_global";
  return path.join(getLibiStorageDir(), bucket, file.filename);
}

export const extraAnalysisModelRunner: JobRunner<
  ExtraAnalysisModelParams,
  ExtraAnalysisModelResult
> = {
  kind: "extra_analysis_model",
  // fal.ai video-understanding script/caption gen — spends money on an
  // external provider API.
  paid: true,
  maxConcurrent: 4,
  resumable: false,
  mcpToolId: makeMcpToolId("libi", "libi.extra_analysis_model"),
  paramsSchema: extraAnalysisModelParamsSchema,

  async run(
    ctx: JobContext<ExtraAnalysisModelParams>,
  ): Promise<ExtraAnalysisModelResult> {
    registerBuiltinScriptProviders();

    const { fileId, providerId, modelId } = ctx.params;
    const focus = ctx.params.focus;
    ctx.reportProgress(0, 4, "step");

    const db = getDb();
    const [file] = db
      .select()
      .from(files)
      .where(eq(files.id, fileId))
      .limit(1)
      .all();
    if (!file) throw new Error(`file not found: ${fileId}`);

    const localPath = resolveSourcePath(file);

    // F6 guard: the script-analysis providers call fal's HTTP API DIRECTLY
    // (`lib/analysis/script-providers/fal-video-understanding.ts`) — they do NOT
    // go through the `fal-ai` MCP that test mode swaps for fake-fal. So in test
    // mode we MUST short-circuit before invoking the provider, or it spends REAL
    // fal credits while the user/agent believe `LIBI_TEST_MODE=1` means $0. The
    // pipeline + persistence still run end-to-end against a deterministic
    // placeholder Script. See docs-local/testing/2026-06-05-ugc-mimic-stitch-dogfood.md (F6).
    if (isTestMode()) {
      log.info(
        { op: "test_mode_placeholder", fileId, providerId, modelId },
        "LIBI_TEST_MODE=1 — returning placeholder script (no provider call, no spend)",
      );
      if (focus === "captions") {
        const placeholderText =
          "**Caption 1**\n1. text: PLACEHOLDER\n2. appear_sec: 0.0 / exit_sec: 1.0\n3. anchor: screen\n4. keyframes:\n0.0 | 0.5,0.4 | 0.10\n0.5 | 0.5,0.4 | 0.10\n1.0 | 0.5,0.4 | 0.08\n5. reveal: all-at-once\n6. orientation: billboard, 0deg\n7. color #ffffff, glow small, bold\n\n(test-mode placeholder caption spec)";
        await saveCaptionSpec({ fileId, providerId, modelId, text: placeholderText });
        ctx.reportProgress(4, 4, "step");
        log.info({ op: "done", fileId, providerId, modelId, testMode: true, focus }, "placeholder caption spec saved");
        return { captionSpec: placeholderText };
      }
      const placeholder = parseAndValidateScript(
        buildTestModePlaceholderScriptText(file.mediaDuration ?? 0),
        {
          providerName: providerId,
          modelId,
          generatedAt: new Date().toISOString(),
          costUsd: 0,
          costEstimated: true,
        },
      );
      if (!placeholder.ok) {
        throw new Error(
          `test-mode placeholder script failed validation: ${placeholder.error}`,
        );
      }
      await saveScript({ fileId, providerId, modelId, script: placeholder.script });
      ctx.reportProgress(4, 4, "step");
      log.info(
        { op: "done", fileId, providerId, modelId, testMode: true },
        "placeholder script saved",
      );
      return { script: placeholder.script };
    }

    const provider = getScriptProvider(providerId);

    log.info(
      { op: "start", fileId, providerId, modelId, localPath, focus },
      "starting script generation",
    );

    if (focus === "captions") {
      const captionPrompt = pickAnalysisPrompt("captions");
      await ctx.checkpoint({ stage: "submitted" });
      ctx.reportProgress(1, 4, "step");
      const ac = new AbortController();
      const watcher = setInterval(() => {
        if (ctx.shouldCancel() && !ac.signal.aborted) ac.abort();
      }, 1000);
      let text: string;
      try {
        const res = await provider.generate({
          localPath,
          durationSeconds: file.mediaDuration ?? 0,
          promptInstructions: captionPrompt,
          onProgress: (_n) => ctx.reportProgress(2, 4, "step"),
          signal: ac.signal,
        });
        text = res.text;
      } finally {
        clearInterval(watcher);
      }
      if (ctx.shouldCancel()) throw new Error("cancelled");
      await ctx.checkpoint({ stage: "received" });
      ctx.reportProgress(3, 4, "step");
      await saveCaptionSpec({ fileId, providerId, modelId, text });
      ctx.reportProgress(4, 4, "step");
      log.info({ op: "done", fileId, providerId, modelId, focus }, "caption spec saved");
      return { captionSpec: text };
    }

    const basePrompt = buildScriptPrompt();
    const generatedAt = new Date().toISOString();

    await ctx.checkpoint({ stage: "submitted" });
    ctx.reportProgress(1, 4, "step");

    // Wire an AbortController so the 1s cancel watcher can abort the
    // in-flight provider poll (e.g. fal's 5s-poll loop) instead of waiting
    // for the provider to return naturally. Mirrors the pattern in proxy-gen.ts.
    const ac = new AbortController();
    const watcher = setInterval(() => {
      if (ctx.shouldCancel() && !ac.signal.aborted) {
        ac.abort();
      }
    }, 1000);

    let validatedScript: Script;

    /** Always-estimate-at-generation cost: don't block the runner on the
     *  provider's billing API (fal's billing can take hours-to-days to
     *  populate). Persist the estimate now; the user can click "refresh"
     *  in the UI later to fetch the real cost. */
    const estimateCost = (): number | null => {
      if (!provider.estimateCostUsd) return null;
      return provider.estimateCostUsd({
        durationSeconds: file.mediaDuration ?? 0,
      });
    };

    try {
      // First attempt
      const first = await provider.generate({
        localPath,
        durationSeconds: file.mediaDuration ?? 0,
        promptInstructions: basePrompt,
        onProgress: (_note) => ctx.reportProgress(2, 4, "step"),
        signal: ac.signal,
      });

      await ctx.checkpoint({ stage: "received_first" });
      ctx.reportProgress(2, 4, "step");

      const firstResult = parseAndValidateScript(first.text, {
        providerName: first.providerName,
        modelId: first.modelId ?? modelId,
        generatedAt,
        costUsd: estimateCost(),
        costEstimated: true,
        requestId: first.requestId,
      });

      if (firstResult.ok) {
        validatedScript = firstResult.script;
      } else {
        log.warn(
          { op: "validation_failed_first", error: firstResult.error },
          "first attempt failed validation; retrying once",
        );

        // Build an amended prompt that includes the validation error, bounded
        // to the provider's prompt-length cap. The error can embed the model's
        // (long/truncated) first output; appending it verbatim previously blew
        // past fal's 5000-char field limit → HTTP 422 before billing.
        const retryPrompt = buildRetryPrompt(
          basePrompt,
          firstResult.error,
          provider.maxPromptChars,
        );

        const second = await provider.generate({
          localPath,
          durationSeconds: file.mediaDuration ?? 0,
          promptInstructions: retryPrompt,
          onProgress: (_note) => ctx.reportProgress(2, 4, "step"),
          signal: ac.signal,
        });

        const secondResult = parseAndValidateScript(second.text, {
          providerName: second.providerName,
          modelId: second.modelId ?? modelId,
          generatedAt,
          // For the retry path, double the estimate since both calls were
          // billed to the user. The refresh-cost flow will replace this with
          // the real combined amount when fal billing publishes.
          costUsd: estimateCost() === null ? null : (estimateCost() as number) * 2,
          costEstimated: true,
          // Keep the SECOND requestId — that's the one that produced the
          // saved script content. The first request's billing will still
          // show up in fal's dashboard but we can't attach it to this row.
          requestId: second.requestId,
        });

        if (!secondResult.ok) {
          throw new Error(
            `Script provider ${providerId} returned invalid output on both attempts. Last error: ${secondResult.error}`,
          );
        }

        validatedScript = secondResult.script;
      }
    } finally {
      clearInterval(watcher);
    }

    if (ctx.shouldCancel()) {
      throw new Error("cancelled");
    }

    await ctx.checkpoint({ stage: "validated" });
    ctx.reportProgress(3, 4, "step");

    await saveScript({
      fileId,
      providerId,
      modelId,
      script: validatedScript,
    });

    ctx.reportProgress(4, 4, "step");
    log.info({ op: "done", fileId, providerId, modelId }, "script saved");

    return { script: validatedScript };
  },
};
