import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v3";
import { getDb } from "@/lib/db/client";
import { analysisSteps } from "@/lib/db/schema";
import { scriptSchema, type Script } from "@/lib/analysis/schemas";
import { getScriptProvider } from "@/lib/analysis/script-providers/registry";
import { registerBuiltinScriptProviders } from "@/lib/analysis/script-providers/register";
import { navigationEmitter } from "@/lib/navigation-events";
import { scriptAnalysisLogger } from "@/lib/logger";

const log = scriptAnalysisLogger.child({ route: "refresh-cost" });

const bodySchema = z.object({
  kind: z.string().regex(/^script:/, "kind must start with 'script:'"),
});

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

/** Re-fetch the real billed cost for a previously-generated script.
 *
 *  Single-attempt: the endpoint asks the provider once. The frontend is
 *  responsible for retry cadence (3× with 10s delay per the spec) — keeps
 *  each HTTP roundtrip short and lets the UI surface "attempt X/3" progress.
 *
 *  Idempotent; safe to call repeatedly. On a successful fetch the row is
 *  updated in place (provider.costUsd, costEstimated, costLastCheckedAt). On
 *  still-pending only costLastCheckedAt is updated. The pieceId is read
 *  for the refresh_query event so the editor's analysis query invalidates.
 */
export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const { fileId } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { kind } = parsed.data;

  registerBuiltinScriptProviders();

  const db = getDb();
  const [row] = db
    .select()
    .from(analysisSteps)
    .where(and(eq(analysisSteps.fileId, fileId), eq(analysisSteps.kind, kind)))
    .limit(1)
    .all();

  if (!row || row.content === null) {
    return NextResponse.json({ error: "step_not_found" }, { status: 404 });
  }

  let script: Script;
  try {
    const parsedScript = JSON.parse(row.content);
    script = scriptSchema.parse(parsedScript);
  } catch (err) {
    log.warn(
      { op: "parse_failed", fileId, kind, err: (err as Error).message },
      "refresh-cost: stored script content failed to parse",
    );
    return NextResponse.json({ error: "invalid_stored_script" }, { status: 500 });
  }

  const requestId = script.provider.requestId;
  if (!requestId) {
    // Older rows generated before requestId persistence. Nothing to do.
    return NextResponse.json(
      { status: "no_request_id", provider: script.provider },
      { status: 200 },
    );
  }

  // Provider id is the part between the two colons of the kind: "script:{providerId}:{modelId}".
  const providerId = kind.split(":")[1] ?? script.provider.name;
  const provider = (() => {
    try {
      return getScriptProvider(providerId);
    } catch {
      return null;
    }
  })();
  if (!provider) {
    return NextResponse.json({ error: "provider_not_found" }, { status: 500 });
  }
  if (!provider.fetchRealCostUsd) {
    return NextResponse.json(
      { status: "no_provider_fetch_support", provider: script.provider },
      { status: 200 },
    );
  }

  // Single attempt. Frontend orchestrates retries. `generatedAt` bounds the
  // provider's billing query window (fal's `start` defaults to 24h ago —
  // without it an older script's request returns no events forever).
  const generatedAt = row.createdAt
    ? new Date(row.createdAt).toISOString()
    : undefined;
  let outcome: Awaited<ReturnType<NonNullable<typeof provider.fetchRealCostUsd>>>;
  try {
    outcome = await provider.fetchRealCostUsd({ requestId, generatedAt });
  } catch (err) {
    log.warn(
      { op: "fetch_failed", fileId, kind, requestId, err: (err as Error).message },
      "refresh-cost: provider fetch threw",
    );
    return NextResponse.json({ error: "provider_fetch_failed" }, { status: 502 });
  }

  // Permanent credential problem (fal: key not ADMIN-scoped / missing).
  // Retrying with the same key cannot succeed — tell the user what to fix.
  if (outcome.kind === "forbidden") {
    log.warn(
      { op: "permission_denied", fileId, kind, requestId, hint: outcome.message },
      "refresh-cost: provider billing API refused the configured key",
    );
    return NextResponse.json({
      status: "provider_permission_denied",
      hint: outcome.message,
      provider: script.provider,
    });
  }

  if (outcome.kind === "error") {
    log.warn(
      { op: "fetch_failed", fileId, kind, requestId, status: outcome.status, err: outcome.message },
      "refresh-cost: provider billing API errored",
    );
    return NextResponse.json({ error: "provider_fetch_failed" }, { status: 502 });
  }

  const realCost = outcome.kind === "resolved" ? outcome.amountUsd : null;

  const checkedAt = new Date().toISOString();
  const updatedProvider = {
    ...script.provider,
    costLastCheckedAt: checkedAt,
    ...(realCost !== null && realCost > 0
      ? { costUsd: realCost, costEstimated: false }
      : {}),
  };
  const updatedScript: Script = { ...script, provider: updatedProvider };

  // Stale-write guard: only update if the row's content's requestId still
  // matches what we read. If the user regenerated the script while our call
  // was in flight, the requestId will differ and we skip the write.
  const [currentRow] = db
    .select()
    .from(analysisSteps)
    .where(and(eq(analysisSteps.fileId, fileId), eq(analysisSteps.kind, kind)))
    .limit(1)
    .all();
  if (currentRow?.content) {
    try {
      const currentParsed = JSON.parse(currentRow.content) as Script;
      if (currentParsed.provider.requestId !== requestId) {
        log.info(
          { op: "stale_skipped", fileId, kind, expectedRequestId: requestId },
          "refresh-cost: row's requestId changed since read; skipping write",
        );
        return NextResponse.json(
          { status: "stale", provider: currentParsed.provider },
          { status: 200 },
        );
      }
    } catch {
      // If we can't parse the current row, fall through and overwrite — the
      // user's row is already broken.
    }
  }

  db.update(analysisSteps)
    .set({ content: JSON.stringify(updatedScript), updatedAt: new Date() })
    .where(eq(analysisSteps.id, row.id))
    .run();

  log.info(
    {
      op: realCost !== null && realCost > 0 ? "resolved" : "still_pending",
      fileId,
      kind,
      requestId,
      realCost,
    },
    realCost !== null && realCost > 0
      ? "refresh-cost: resolved real cost"
      : "refresh-cost: still pending",
  );

  // Drive the editor's analysis query invalidation so the UI re-renders.
  navigationEmitter.emit("refresh_query", { queryKey: "analysis", fileId });

  return NextResponse.json({
    status: realCost !== null && realCost > 0 ? "resolved" : "still_pending",
    provider: updatedProvider,
  });
}
