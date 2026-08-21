/**
 * HTTP+SSE client for invoking JobManager jobs from the MCP stdio child.
 *
 * The MCP child must not import `lib/jobs/manager` or `lib/jobs/runners/*` —
 * doing so would pull the full runner registry (Playwright, ffmpeg, etc.)
 * into the MCP process. Instead, MCP-side tool code uses this module to
 * enqueue + watch jobs via HTTP+SSE against the Next.js server.
 *
 * Two entry points:
 *   - `enqueueJobOnServer(kind, params, opts)` — fire-and-forget (proxy_gen).
 *   - `runJobViaServer<R>(kind, params, opts)` — await result + forward
 *      progress to the MCP client via `notifications/progress`.
 *
 * Progress payload shape MUST byte-match `lib/jobs/progress-forwarder.ts`
 * so `claude-agent-acp` keeps surfacing `tool_call_update` events on the
 * same `toolCallId`.
 */
import { getCurrentPort } from "@/lib/libi-home";
import { getCurrentToolCall } from "@/mcp/tool-call-context";
import { CancelledError } from "@/lib/jobs/types";
import { mcpLogger as logger } from "@/lib/logger";
import type { JobStatusSnapshot, EnqueueResult } from "@/lib/jobs/types";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types";

function resolveToolHint(opts: EnqueueOpts) {
  if (opts.toolHint) return opts.toolHint;
  const ctx = getCurrentToolCall();
  return ctx ? { toolName: ctx.toolName, toolArgs: ctx.args } : undefined;
}

/** Thrown when the libi server isn't reachable. Callers can branch on the
 *  class to surface a "start libi first" message to the agent. */
export class LibiServerUnavailableError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "LibiServerUnavailableError";
    this.hint = hint;
  }
}

/**
 * Shared catch handler for fire-and-forget `enqueueJobOnServer("proxy_gen", ...)`
 * calls from MCP-side tools (`file-tools.ts`, `proxy-tools.ts`). `LibiServerUnavailableError`
 * is logged at warn level because the startup sweep will recover the missing
 * proxy on next launch — proxy gen is best-effort. Other errors are also warn
 * (never thrown to the tool's caller) since proxy gen is non-essential to the
 * upload / regenerate flow's success.
 */
export function logProxyGenEnqueueFailure(fileId: string, err: unknown): void {
  if (err instanceof LibiServerUnavailableError) {
    logger.warn(
      {
        tag: "mcp-jobs-client",
        op: "proxy_gen_enqueue_skipped",
        fileId,
        reason: "server-unavailable",
      },
      "Skipped proxy_gen enqueue — libi server not running",
    );
    return;
  }
  logger.warn(
    {
      tag: "mcp-jobs-client",
      op: "proxy_gen_enqueue_failed",
      fileId,
      err: err instanceof Error ? err.message : String(err),
    },
    "Failed to enqueue proxy_gen job from MCP",
  );
}

interface EnqueueOpts {
  pieceId?: string | null;
  fileId?: string | null;
  resume?: boolean;
  /** Tool identity + args hint for job↔chat-row correlation. Defaults to
   *  the ambient tool-call context (set by the registerTool wrapper);
   *  callers may override to append e.g. a progressLabel. */
  toolHint?: {
    toolName: string;
    toolArgs: unknown;
    /** Optional display prefix for progress lines (e.g. "segment 2/7"). */
    progressLabel?: string;
  };
  /** Stable caller-supplied identifier echoed back in the response. */
  clientKey?: string;
  /** Skip the paramsHash match check; always create a new job. Mutually
   *  exclusive in semantics with `resume: true` — when both are supplied,
   *  the server treats `forceNew: true` as the winner. */
  forceNew?: boolean;
  /** Explicit "throw away what's on disk and start over". Distinct from
   *  `forceNew` on purpose: the failed-row auto-escape below sets `forceNew`,
   *  so a runner keyed on it would wipe its output on every retry. */
  discardOutput?: boolean;
}

interface RunOpts<R = unknown> extends EnqueueOpts {
  /** MCP `extra` from the tool handler. Used to read `_meta.progressToken`
   *  and call `sendNotification` for live progress. */
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>;
  /** Caller-controlled abort. Aborting closes the SSE reader and rejects
   *  the outer promise. */
  signal?: AbortSignal;
  /** Unused at runtime; carried only so TypeScript can infer the result
   *  generic from a typed caller. */
  __r?: R;
}

/**
 * Discriminated-union result of {@link runJobViaServer}. Mirrors the four
 * shapes the server returns from `POST /api/jobs` (see `lib/jobs/types.ts`
 * `EnqueueResult`), but with `result` populated for all shapes — either
 * from the SSE terminal event (new / attached_running / forced) or from
 * the cached row's stored result (matching_completed).
 *
 * The `matching_completed` shape may carry a `failed`/`cancelled` status:
 * callers that need to surface those terminal errors should branch on
 * `existingJob.status` before consuming `existingJob.result`.
 */
export type RunJobResult<R> =
  | { status: "new"; jobId: string; clientKey: string; result: R }
  | {
      status: "attached_running";
      jobId: string;
      clientKey: string;
      existingJob: {
        jobId: string;
        pieceId: string | null;
        startedAt: string;
      };
      result: R;
    }
  | {
      status: "matching_completed";
      existingJob: {
        jobId: string;
        pieceId: string | null;
        completedAt: string;
        status: "completed" | "failed" | "cancelled";
        result?: R;
        error?: string | null;
      };
    }
  | {
      status: "new";
      jobId: string;
      clientKey: string;
      forced: true;
      result: R;
    };

interface ProgressEventPayload {
  jobId: string;
  kind?: string;
  done: number;
  total: number;
  unit: string;
  etaMs?: number | null;
  msPerUnit?: number | null;
}

function resolveBaseUrl(): string {
  let port: number;
  try {
    port = getCurrentPort();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LibiServerUnavailableError(
      `libi server port not resolvable: ${msg}`,
      "libi server not running. Start it with `npx @nagellabs/libi` or `npx @nagellabs/libi --connect-agent`.",
    );
  }
  return `http://127.0.0.1:${port}`;
}

function isConnectionRefused(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { cause?: { code?: string }; message?: string };
  if (e.cause && typeof e.cause === "object" && e.cause.code === "ECONNREFUSED") {
    return true;
  }
  const msg = e.message ?? "";
  return /econnrefused|connection refused|fetch failed/i.test(msg);
}

/**
 * POST /api/jobs — enqueue (or attach to) a job. Fire-and-forget from the
 * MCP child's point of view: the server keeps running the job in the
 * background and persists results to `~/.libi/libi.sqlite`.
 *
 * Returns the full discriminated `EnqueueResult` union as produced by the
 * server. Callers branching on `status` get four shapes:
 *   - `new`               — fresh row was inserted; runner is now executing.
 *   - `attached_running`  — an in-flight match exists; caller observes that.
 *   - `matching_completed`— terminal cached row exists; no new work was scheduled.
 *   - `new` + `forced:true` — `forceNew` requested; prior row discarded.
 */
export async function enqueueJobOnServer(
  kind: string,
  params: unknown,
  opts: EnqueueOpts = {},
): Promise<EnqueueResult> {
  const base = resolveBaseUrl();
  const body = {
    kind,
    params,
    pieceId: opts.pieceId ?? null,
    fileId: opts.fileId ?? null,
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
    ...(resolveToolHint(opts) ? { toolHint: resolveToolHint(opts) } : {}),
    ...(opts.clientKey !== undefined ? { clientKey: opts.clientKey } : {}),
    ...(opts.forceNew !== undefined ? { forceNew: opts.forceNew } : {}),
    ...(opts.discardOutput !== undefined
      ? { discardOutput: opts.discardOutput }
      : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${base}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (isConnectionRefused(err)) {
      const port = base.split(":").pop();
      throw new LibiServerUnavailableError(
        `failed to reach libi server at ${base}`,
        `libi server not running on port ${port}. Start it with \`npx @nagellabs/libi\` or \`npx @nagellabs/libi --connect-agent\`.`,
      );
    }
    throw err;
  }

  if (res.status === 200) {
    const json = (await res.json()) as EnqueueResult;
    return json;
  }

  if (res.status === 400) {
    let parsed: { error?: string; issues?: unknown } = {};
    try {
      parsed = (await res.json()) as { error?: string; issues?: unknown };
    } catch {
      /* fallthrough — parsed stays empty */
    }
    let message = parsed.error ?? "bad request";
    if (Array.isArray(parsed.issues) && parsed.issues.length > 0) {
      const summary = parsed.issues
        .map((i) => {
          const issue = i as { path?: unknown; message?: string };
          const pathArr = Array.isArray(issue.path) ? issue.path : [];
          const pathStr = pathArr.join(".") || "(root)";
          return `${pathStr}: ${issue.message ?? "invalid"}`;
        })
        .join("; ");
      message = `${message} (${summary})`;
    }
    throw new Error(message);
  }

  if (res.status >= 500) {
    throw new Error("internal server error");
  }

  throw new Error(`unexpected status ${res.status} from /api/jobs`);
}

interface ParsedFrame {
  event: string;
  data: unknown;
}

/**
 * Pull SSE frames out of a growing buffer. Mutates `state` so callers can
 * accumulate partial chunks across `read()` boundaries. Returns the frames
 * that completed in this call.
 */
function consumeFrames(state: { buffer: string }): ParsedFrame[] {
  const out: ParsedFrame[] = [];
  let idx: number;
  while ((idx = state.buffer.indexOf("\n\n")) !== -1) {
    const frame = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + 2);
    const eventMatch = frame.match(/^event: (.+)$/m);
    const dataMatch = frame.match(/^data: (.+)$/m);
    if (!eventMatch || !dataMatch) continue;
    try {
      out.push({ event: eventMatch[1], data: JSON.parse(dataMatch[1]) });
    } catch {
      // Malformed JSON frame; skip rather than crash the SSE loop.
    }
  }
  return out;
}

function buildAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("aborted", "AbortError");
  }
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Enqueue a job and wait for the terminal event over SSE. Forwards each
 * `progress` tick to the MCP client as a `notifications/progress`
 * notification IF the client supplied a `progressToken` in `_meta`.
 *
 * Resolves with a {@link RunJobResult} union — branch on `status` to read
 * `jobId` (absent on `matching_completed`) and `result`. For `matching_completed`,
 * the cached prior result lives at `existingJob.result`; no SSE round-trip
 * is performed.
 *
 * Rejects with:
 *   - `Error(data.error)` on `failed`
 *   - `CancelledError(jobId)` on `cancelled`
 *   - `AbortError` if `opts.signal` aborts
 *   - `LibiServerUnavailableError` if the server can't be reached
 */
export async function runJobViaServer<R = unknown>(
  kind: string,
  params: unknown,
  opts: RunOpts<R> = {},
): Promise<RunJobResult<R>> {
  // Fail fast if the caller has already aborted before we did any work.
  if (opts.signal?.aborted) {
    throw buildAbortError();
  }

  const progressToken = opts.extra?._meta?.progressToken as
    | string
    | number
    | undefined;
  const sendNotification = opts.extra?.sendNotification;

  const enqueueArgs = {
    pieceId: opts.pieceId,
    fileId: opts.fileId,
    resume: opts.resume,
    clientKey: opts.clientKey,
    forceNew: opts.forceNew,
    toolHint: opts.toolHint,
  };
  let enqueueResp = await enqueueJobOnServer(kind, params, enqueueArgs);

  // A FAILED (or cancelled) cached row must never become this call's answer.
  //
  // `(kind, paramsHash)` dedup is only sound for work whose result is worth
  // reusing; a failure is not a result, it is the absence of one — and the
  // reason it failed is routinely OUTSIDE the params (a missing binary, a
  // dependency not installed yet, a server that was down). Replaying it makes
  // the identical call fail forever no matter what the user fixes in between.
  //
  // Observed end to end on a clean install: `libi.ground_target` failed once
  // with `tracking_engine_not_installed`, the user then installed the tracking
  // engine and `libi.verify_install` returned `ok:true` — and the retry STILL
  // reported "not installed", because it attached to that failed row and never
  // re-ran. Only one `tracking` job row was ever created. The escape hatch was
  // to perturb a parameter (a different timestamp) to change the hash.
  //
  // CLAUDE.md's own long-running-tool-dedup policy already prescribes the
  // behaviour for this case — "`existingJob.status` is `failed` or
  // `cancelled` → Re-run silently with `forceNew: true`" — so do exactly that,
  // once, here, rather than requiring every call site to remember it. A caller
  // that ALREADY asked for `forceNew` is left alone (nothing stale to escape),
  // and a genuine repeat failure surfaces from the fresh run, so this cannot
  // loop.
  if (
    enqueueResp.status === "matching_completed" &&
    (enqueueResp.existingJob.status === "failed" ||
      enqueueResp.existingJob.status === "cancelled") &&
    !opts.forceNew
  ) {
    // NOTE: `forceNew` only — deliberately NOT `discardOutput`. This is a
    // retry of work that failed, not a user asking to discard its output; for
    // a model download the partial bytes on disk are exactly what makes the
    // retry cheap.
    enqueueResp = await enqueueJobOnServer(kind, params, {
      ...enqueueArgs,
      forceNew: true,
    });
  }

  // `matching_completed`: the server attached us to a terminal cached row
  // and is NOT scheduling another runner pass. There is no SSE stream to
  // follow — return the cached payload directly. Cast the `unknown` result
  // to R; callers branching on existingJob.status get the failed/cancelled
  // signal cleanly.
  if (enqueueResp.status === "matching_completed") {
    return {
      status: "matching_completed",
      existingJob: {
        ...enqueueResp.existingJob,
        result: enqueueResp.existingJob.result as R | undefined,
      },
    };
  }

  const { jobId } = enqueueResp;

  const base = resolveBaseUrl();
  const ac = new AbortController();
  const onCallerAbort = () => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) {
      ac.abort();
    } else {
      opts.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  const forwardProgress = (p: ProgressEventPayload) => {
    if (progressToken === undefined || !sendNotification) return;
    const message = `${p.done}/${p.total} ${p.unit}`;
    // Mirror lib/jobs/progress-forwarder.ts exactly.
    void sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: p.done,
        total: Math.max(p.total, 1),
        message,
      },
    }).catch((err) => {
      logger.warn(
        {
          tag: "mcp-jobs-client",
          op: "progress_notify_failed",
          jobId,
          err: err instanceof Error ? err.message : String(err),
        },
        "mcp-jobs-client.progress_notify_failed",
      );
    });
  };

  let res: Response;
  try {
    res = await fetch(`${base}/api/jobs/${jobId}/events`, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: ac.signal,
    });
  } catch (err) {
    if (opts.signal) opts.signal.removeEventListener("abort", onCallerAbort);
    if (ac.signal.aborted) throw buildAbortError();
    if (isConnectionRefused(err)) {
      const port = base.split(":").pop();
      throw new LibiServerUnavailableError(
        `failed to reach libi server at ${base}`,
        `libi server not running on port ${port}. Start it with \`npx @nagellabs/libi\` or \`npx @nagellabs/libi --connect-agent\`.`,
      );
    }
    throw err;
  }

  if (!res.ok || !res.body) {
    if (opts.signal) opts.signal.removeEventListener("abort", onCallerAbort);
    throw new Error(
      `SSE subscribe failed: status ${res.status}${res.body ? "" : " (no body)"}`,
    );
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const state = { buffer: "" };

  const closeReader = async () => {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  };

  // Sentinel to race `reader.read()` against the abort signal — needed when
  // the underlying stream is in-memory (tests, future SSE polyfills) and
  // doesn't honor the fetch AbortController.
  const ABORTED = Symbol("aborted");
  const waitForAbort = (): Promise<typeof ABORTED> =>
    new Promise((resolve) => {
      if (ac.signal.aborted) {
        resolve(ABORTED);
        return;
      }
      ac.signal.addEventListener("abort", () => resolve(ABORTED), {
        once: true,
      });
    });

  try {
    while (true) {
      let r: ReadableStreamReadResult<string> | typeof ABORTED;
      try {
        r = await Promise.race([reader.read(), waitForAbort()]);
      } catch (err) {
        if (ac.signal.aborted) {
          throw buildAbortError();
        }
        throw err;
      }
      if (r === ABORTED) {
        throw buildAbortError();
      }
      if (r.done) {
        throw new Error("SSE closed before terminal event");
      }
      state.buffer += r.value ?? "";
      const frames = consumeFrames(state);
      for (const f of frames) {
        if (f.event === "progress") {
          forwardProgress(f.data as ProgressEventPayload);
          continue;
        }
        if (f.event === "snapshot") {
          // Snapshot is informational; the server will follow with a terminal
          // event if the job is already done.
          continue;
        }
        if (f.event === "completed") {
          const data = f.data as { jobId: string; result?: R };
          const result = data.result as R;
          // Reconstruct the discriminated union shape from the enqueue
          // response (status/clientKey/forced/existingJob) plus the SSE
          // terminal payload (result). For `new`/`new+forced`/`attached_running`
          // we always have `jobId` + `clientKey`.
          if (enqueueResp.status === "attached_running") {
            return {
              status: "attached_running",
              jobId: enqueueResp.jobId,
              clientKey: enqueueResp.clientKey,
              existingJob: enqueueResp.existingJob,
              result,
            };
          }
          if (
            enqueueResp.status === "new" &&
            "forced" in enqueueResp &&
            enqueueResp.forced === true
          ) {
            return {
              status: "new",
              jobId: enqueueResp.jobId,
              clientKey: enqueueResp.clientKey,
              forced: true,
              result,
            };
          }
          return {
            status: "new",
            jobId: enqueueResp.jobId,
            clientKey: enqueueResp.clientKey,
            result,
          };
        }
        if (f.event === "failed") {
          const data = f.data as { jobId: string; error?: string };
          throw new Error(data.error ?? "job failed");
        }
        if (f.event === "cancelled") {
          throw new CancelledError(jobId);
        }
        // Unknown event: log and keep reading.
        logger.warn(
          {
            tag: "mcp-jobs-client",
            op: "unknown_sse_event",
            jobId,
            event: f.event,
          },
          "mcp-jobs-client.unknown_sse_event",
        );
      }
    }
  } finally {
    if (opts.signal) opts.signal.removeEventListener("abort", onCallerAbort);
    await closeReader();
  }
}

/**
 * Flatten a {@link RunJobResult} into the legacy `{ jobId, resumed, result }`
 * triple. Re-throws cached `failed`/`cancelled` terminal states the same way
 * the SSE path would (Error / CancelledError), so callers get identical
 * behavior whether the work just ran or was returned from the
 * `matching_completed` cache hit.
 *
 * Provided as a transitional helper for callers that don't yet need to
 * surface the richer `status` discriminator to their consumers; T16/T17
 * migrate the per-tool result shapes.
 *
 * For T14 transition convenience this function ALSO accepts the legacy
 * `{ jobId, resumed, result }` shape itself — many tests pre-T14 mock
 * `runJobViaServer` with the old triple, and forcing every test to adopt
 * the union immediately would balloon the diff. The legacy passthrough
 * is the obvious "no status field" branch and disappears once callers
 * adopt the union return type directly.
 */
export function legacyTripleFromRunJobResult<R>(
  resp:
    | RunJobResult<R>
    | { jobId: string; resumed: boolean; result: R },
): { jobId: string; resumed: boolean; result: R } {
  // Legacy triple passthrough (no `status` discriminator).
  if (!("status" in resp)) {
    return { jobId: resp.jobId, resumed: resp.resumed, result: resp.result };
  }
  if (resp.status === "matching_completed") {
    const { existingJob } = resp;
    if (existingJob.status === "failed") {
      throw new Error(existingJob.error ?? "job failed");
    }
    if (existingJob.status === "cancelled") {
      throw new CancelledError(existingJob.jobId);
    }
    return {
      jobId: existingJob.jobId,
      resumed: true,
      result: existingJob.result as R,
    };
  }
  if (resp.status === "attached_running") {
    return { jobId: resp.jobId, resumed: true, result: resp.result };
  }
  // status: "new" (with or without forced)
  return { jobId: resp.jobId, resumed: false, result: resp.result };
}

/**
 * GET /api/jobs/${jobId} — fetch a single job's full status snapshot.
 *
 * Used by `libi.get_job_status`. The MCP child does NOT call JobManager
 * directly — it goes over HTTP to keep the runner registry out of this
 * process.
 *
 * Throws:
 *   - `Error("job not found: <id>")` on 404
 *   - `LibiServerUnavailableError` if the server can't be reached
 *   - `Error(...)` for other non-2xx responses
 */
export async function getJobStatusFromServer(
  jobId: string,
): Promise<JobStatusSnapshot> {
  const base = resolveBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/api/jobs/${jobId}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    if (isConnectionRefused(err)) {
      const port = base.split(":").pop();
      throw new LibiServerUnavailableError(
        `failed to reach libi server at ${base}`,
        `libi server not running on port ${port}. Start it with \`npx @nagellabs/libi\` or \`npx @nagellabs/libi --connect-agent\`.`,
      );
    }
    throw err;
  }

  if (res.status === 404) {
    throw new Error(`job not found: ${jobId}`);
  }
  if (!res.ok) {
    throw new Error(`unexpected status ${res.status} from /api/jobs/${jobId}`);
  }
  const json = (await res.json()) as JobStatusSnapshot;
  return json;
}

/**
 * List jobs, newest first, optionally filtered by status and kind.
 *
 * The counterpart to `getJobStatusFromServer` for the case where the caller has
 * NO jobId — which is the common case after something goes wrong, and was a dead
 * end until now. A blocking job tool hands its jobId back in its return value,
 * so an agent whose tool call was interrupted, declined, or killed with the
 * session never learns the id of the work it started. The work itself survives
 * (aborting only closes the SSE reader; nothing cancels the job), so the agent
 * was left unable to see a running download it had itself kicked off — and
 * reported "nothing has been downloaded" while 6 GB streamed in the background
 * (session 9c3ce4d0, 2026-08-17).
 */
export async function listJobsFromServer(opts: {
  status?: string;
  kind?: string;
  limit?: number;
}): Promise<JobStatusSnapshot[]> {
  const base = resolveBaseUrl();
  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.kind) qs.set("kind", opts.kind);
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  let res: Response;
  try {
    res = await fetch(`${base}/api/jobs${suffix}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    if (isConnectionRefused(err)) {
      const port = base.split(":").pop();
      throw new LibiServerUnavailableError(
        `failed to reach libi server at ${base}`,
        `libi server not running on port ${port}. Start it with \`npx @nagellabs/libi\` or \`npx @nagellabs/libi --connect-agent\`.`,
      );
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`unexpected status ${res.status} from /api/jobs`);
  }
  const json = (await res.json()) as { jobs?: JobStatusSnapshot[] };
  return json.jobs ?? [];
}

/**
 * DELETE /api/jobs/${jobId} — request cooperative cancellation.
 *
 * Used by `libi.cancel_job`. Returns once the server accepts the cancel
 * request; the actual termination is driven by the runner's `shouldCancel()`
 * poll.
 *
 * Throws:
 *   - `Error("job not found: <id>")` on 404
 *   - `LibiServerUnavailableError` if the server can't be reached
 *   - `Error(...)` for other non-2xx responses
 */
export async function cancelJobOnServer(jobId: string): Promise<void> {
  const base = resolveBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/api/jobs/${jobId}`, {
      method: "DELETE",
    });
  } catch (err) {
    if (isConnectionRefused(err)) {
      const port = base.split(":").pop();
      throw new LibiServerUnavailableError(
        `failed to reach libi server at ${base}`,
        `libi server not running on port ${port}. Start it with \`npx @nagellabs/libi\` or \`npx @nagellabs/libi --connect-agent\`.`,
      );
    }
    throw err;
  }

  if (res.status === 404) {
    throw new Error(`job not found: ${jobId}`);
  }
  if (!res.ok) {
    throw new Error(`unexpected status ${res.status} from /api/jobs/${jobId}`);
  }
}
