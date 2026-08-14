import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import {
  parseAiGenerationMeta,
  serializeAiGenerationMeta,
  type AiGenerationMeta,
} from "@/lib/ai-generation/types";
import {
  getCostFetcher,
  registerBuiltinAiGenerationCostFetchers,
} from "@/lib/ai-generation/cost-fetchers";
import { navigationEmitter } from "@/lib/navigation-events";
import { serverLogger } from "@/lib/logger";

const log = serverLogger.child({ tag: "ai-generation", route: "refresh-cost" });

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

/**
 * Re-fetch the real billed cost for an AI-generated file.
 *
 * Mirrors `/api/files/by-id/[fileId]/analysis/refresh-cost` (script analysis)
 * pattern: single-attempt; the frontend orchestrates retries.
 *
 * 1. Read file row.
 * 2. Parse `aiGeneration` JSON; bail with `no_meta` if missing.
 * 3. Look up cost fetcher for `aiGeneration.provider`.
 * 4. Call fetcher with `aiGeneration.providerJobId`.
 * 5. On success, write back `aiGeneration.costActual = { amount, currency, tier?, source: "tool" }`.
 * 6. Emit refresh_query so the panel re-renders.
 * 7. Return { status, aiGeneration }.
 *
 * Status values:
 * - "resolved"             — actual cost present (real number written).
 * - "still_pending"        — provider hasn't published the charge yet (retry later is meaningful).
 * - "provider_permission_denied" — PERMANENT: credentials can't read billing
 *                            data (fal: key not ADMIN-scoped, or no key).
 *                            Response carries a user-facing `hint`. Retrying
 *                            with the same key will never succeed.
 * - "free"                 — costEstimate.tier === "test-mode" (provider-agnostic; fake-fal files qualify).
 * - "no_provider_fetch_support" — provider has no registered fetcher.
 * - "no_meta"              — file has no aiGeneration metadata.
 * - "no_request_id"        — aiGeneration is present but providerJobId is missing.
 * - "already_resolved"     — costActual already set; nothing to do.
 */
export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const { fileId } = await ctx.params;
  registerBuiltinAiGenerationCostFetchers();

  const db = getDb();
  const [row] = db
    .select({
      id: files.id,
      pieceId: files.pieceId,
      aiGeneration: files.aiGeneration,
    })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1)
    .all();

  if (!row) {
    return NextResponse.json({ error: "file_not_found" }, { status: 404 });
  }

  const meta = parseAiGenerationMeta(row.aiGeneration);
  if (!meta) {
    return NextResponse.json(
      { status: "no_meta", aiGeneration: null },
      { status: 200 },
    );
  }

  if (meta.costActual) {
    return NextResponse.json(
      { status: "already_resolved", aiGeneration: meta },
      { status: 200 },
    );
  }

  if (!meta.providerJobId) {
    return NextResponse.json(
      { status: "no_request_id", aiGeneration: meta },
      { status: 200 },
    );
  }

  // Provider-agnostic test-mode shortcut: any generation whose costEstimate
  // carries tier === "test-mode" (e.g. fake-fal files, which use provider
  // "fal-ai") is free by definition — mark it resolved without a network call.
  if (meta.costEstimate?.tier === "test-mode") {
    const freeMeta: AiGenerationMeta = {
      ...meta,
      costActual: {
        amount: 0,
        currency: meta.costEstimate?.currency ?? "USD",
        tier: meta.costEstimate?.tier,
        source: "tool",
      },
    };
    db.update(files)
      .set({ aiGeneration: serializeAiGenerationMeta(freeMeta) })
      .where(eq(files.id, fileId))
      .run();
    log.info(
      { op: "free", fileId, provider: meta.provider },
      "refresh-cost: free (test-mode tier)",
    );
    if (row.pieceId) {
      navigationEmitter.emit("refresh_query", {
        queryKey: "piece",
        pieceId: row.pieceId,
      });
    } else {
      navigationEmitter.emit("refresh_query", { queryKey: "files" });
    }
    return NextResponse.json({ status: "free", aiGeneration: freeMeta });
  }

  const fetcher = getCostFetcher(meta.provider);
  if (!fetcher) {
    return NextResponse.json(
      { status: "no_provider_fetch_support", aiGeneration: meta },
      { status: 200 },
    );
  }

  let outcome: Awaited<ReturnType<typeof fetcher>>;
  try {
    outcome = await fetcher({
      providerJobId: meta.providerJobId,
      generatedAt: meta.completedAt ?? meta.startedAt,
    });
  } catch (err) {
    log.warn(
      {
        op: "fetch_failed",
        fileId,
        provider: meta.provider,
        providerJobId: meta.providerJobId,
        err: (err as Error).message,
      },
      "refresh-cost: fetcher threw",
    );
    return NextResponse.json({ error: "provider_fetch_failed" }, { status: 502 });
  }

  // Permanent credential problem — retrying with the same key cannot succeed.
  // Surface the provider's own explanation so the UI can show it verbatim.
  if (outcome.kind === "forbidden") {
    log.warn(
      {
        op: "permission_denied",
        fileId,
        provider: meta.provider,
        providerJobId: meta.providerJobId,
        hint: outcome.message,
      },
      "refresh-cost: provider billing API refused the configured key",
    );
    return NextResponse.json({
      status: "provider_permission_denied",
      hint: outcome.message,
      aiGeneration: meta,
    });
  }

  if (outcome.kind === "error") {
    log.warn(
      {
        op: "fetch_failed",
        fileId,
        provider: meta.provider,
        providerJobId: meta.providerJobId,
        status: outcome.status,
        err: outcome.message,
      },
      "refresh-cost: provider billing API errored",
    );
    return NextResponse.json({ error: "provider_fetch_failed" }, { status: 502 });
  }

  // Stale-write guard: re-read the row before writing and bail if the
  // providerJobId changed (file got re-generated). Otherwise we'd write a
  // cost belonging to the old job onto the new one.
  const [currentRow] = db
    .select({ aiGeneration: files.aiGeneration })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1)
    .all();
  const currentMeta = parseAiGenerationMeta(currentRow?.aiGeneration);
  if (!currentMeta || currentMeta.providerJobId !== meta.providerJobId) {
    log.info(
      {
        op: "stale_skipped",
        fileId,
        expectedJobId: meta.providerJobId,
        currentJobId: currentMeta?.providerJobId ?? null,
      },
      "refresh-cost: providerJobId changed since read; skipping write",
    );
    return NextResponse.json(
      { status: "stale", aiGeneration: currentMeta },
      { status: 200 },
    );
  }

  // Note: test-mode (tier === "test-mode") files are resolved before we reach
  // the fetcher — a `pending` outcome here means a real provider genuinely
  // hasn't published the charge yet (fal returns no event, or a 0-cost
  // placeholder event, until billing propagates).
  let updatedMeta: AiGenerationMeta = currentMeta;
  let status: string;
  if (outcome.kind === "pending") {
    status = "still_pending";
  } else {
    updatedMeta = {
      ...currentMeta,
      costActual: {
        amount: outcome.amountUsd,
        currency: currentMeta.costEstimate?.currency ?? "USD",
        tier: currentMeta.costEstimate?.tier,
        source: "tool",
      },
    };
    status = "resolved";
  }

  if (status === "resolved" || status === "free") {
    db.update(files)
      .set({ aiGeneration: serializeAiGenerationMeta(updatedMeta) })
      .where(eq(files.id, fileId))
      .run();
  }

  log.info(
    {
      op: status,
      fileId,
      provider: meta.provider,
      providerJobId: meta.providerJobId,
      real: outcome.kind === "resolved" ? outcome.amountUsd : null,
    },
    `refresh-cost: ${status}`,
  );

  // Push refresh so the editor's file query invalidates and the Generation tab
  // re-renders. Same payload shape as the notes route.
  if (row.pieceId) {
    navigationEmitter.emit("refresh_query", {
      queryKey: "piece",
      pieceId: row.pieceId,
    });
  } else {
    navigationEmitter.emit("refresh_query", { queryKey: "files" });
  }

  return NextResponse.json({ status, aiGeneration: updatedMeta });
}
