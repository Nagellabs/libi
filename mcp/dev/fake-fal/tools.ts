import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { recommendModel, getSchema, getPricing, kindFor, resolveEndpoint } from "./kb";
import type { ScenarioConfig } from "./kb";
import { loadScenarioConfig } from "./config";
import { recordCall } from "./recorder";
import { makePlaceholder } from "./placeholders";
import type {
  RecommendModelSchema, GetSchemaSchema, GetPricingSchema,
  RunModelSchema, SubmitJobSchema, CheckJobSchema, GetJobResultSchema, SearchDocsSchema,
  UploadFileSchema,
} from "./schemas";
import type { z } from "zod/v3";

type ToolResult = { content: { type: "text"; text: string }[]; error?: string };
const ok = (p: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(p) }] });

/** The endpoint-fidelity fields to attach to a recorded call line. */
export function buildCallRecord(
  endpointId: string,
  cfg: ScenarioConfig | null,
): { canonical_endpoint_id?: string; unknown_endpoint?: true } {
  const { canonical } = resolveEndpoint(endpointId, cfg);
  if (canonical === null) return { unknown_endpoint: true };
  if (canonical !== endpointId) return { canonical_endpoint_id: canonical };
  return {};
}

/** True when strict mode is on AND the endpoint is unknown to the KB. */
export function strictReject(endpointId: string, cfg: ScenarioConfig | null): boolean {
  return cfg?.strict === true && resolveEndpoint(endpointId, cfg).canonical === null;
}

/** fal-style 404 result for a rejected unknown endpoint in strict mode. */
function unknownEndpointError(endpointId: string): ToolResult {
  const payload = {
    success: false,
    error: "unknown_endpoint",
    status: 404,
    message: `fake-fal (strict): endpoint_id '${endpointId}' is not a known fal endpoint.`,
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], error: "unknown_endpoint" };
}

/**
 * Inputs fal fetches over the network. `image_url`, `video_urls`, `uri`, … —
 * the keys whose values a REMOTE model server has to be able to reach.
 */
const URL_KEY = /(^|_)(url|uri)s?$/i;

/** Hosts nothing outside this machine can reach. */
function unreachableHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h.endsWith(".local")) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  return /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

/** True when fal's servers could actually fetch this value. */
function fetchableByFal(value: string): boolean {
  if (value.startsWith("data:")) return true; // fal accepts data URIs
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false; // a bare path is not a URL at all
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  return !unreachableHost(u.hostname);
}

/**
 * The first input value a REAL fal would refuse, or null.
 *
 * The fake used to accept anything, so a scenario that handed fal a local
 * storage path or a `http://127.0.0.1:<port>/api/files/...` URL "passed" while
 * doing the one thing a hosted provider cannot do — which is exactly the open
 * local-file design gap, papered over by the harness. Checked in the tool
 * rather than in the zod schema deliberately: a schema rejection surfaces as
 * an MCP validation error, is never recorded in `fal-calls.jsonl`, and so
 * cannot be asserted on; production receives the call and answers with an
 * error, and so does this.
 */
export function unreachableInput(
  input: Record<string, unknown>,
): { key: string; value: string } | null {
  for (const [key, raw] of Object.entries(input)) {
    const values = (Array.isArray(raw) ? raw : [raw]).filter(
      (v): v is string => typeof v === "string",
    );
    for (const value of values) {
      if (URL_KEY.test(key) ? !fetchableByFal(value) : value.startsWith("file://")) {
        return { key, value };
      }
    }
  }
  return null;
}

/** fal-style 422 for an input fal could not fetch. */
function unreachableInputError(bad: { key: string; value: string }): ToolResult {
  const shown = bad.value.length > 120 ? bad.value.slice(0, 117) + "..." : bad.value;
  const payload = {
    success: false,
    error: "invalid_input",
    status: 422,
    message:
      `fake-fal: \`${bad.key}\` must be a URL fal's servers can fetch (https, or a data: URI); got "${shown}". ` +
      "A remote model server cannot read a local path or a URL on your machine — upload the file first " +
      "(`upload_file`) and pass the URL it returns.",
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], error: "invalid_input" };
}

/**
 * Mirror of fal's own upload tool: a local path in, a CDN URL out. The URL is
 * derived from the resolved path, so the same file always uploads to the same
 * URL and a scenario's trace is stable.
 */
export function upload_file(args: z.infer<typeof UploadFileSchema>): ToolResult {
  const path = resolvePath(args.path);
  recordCall({ tool: "upload_file", input: { path: args.path } });
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
  } catch {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "file_not_found",
            message: `fake-fal: no readable file at ${args.path}`,
          }),
        },
      ],
      error: "file_not_found",
    };
  }
  const hash = createHash("sha1").update(path).digest("hex").slice(0, 12);
  return ok({
    success: true,
    url: `https://v3.fal.media/files/fake/${hash}/${basename(path)}`,
  });
}

export function recommend_model(args: z.infer<typeof RecommendModelSchema>): ToolResult {
  const cfg = loadScenarioConfig();
  recordCall({ tool: "recommend_model", input: args });
  return ok(recommendModel(args.task, cfg));
}

export function get_model_schema(args: z.infer<typeof GetSchemaSchema>): ToolResult {
  const cfg = loadScenarioConfig();
  recordCall({ tool: "get_model_schema", endpoint_id: args.endpoint_id });
  return ok(getSchema(args.endpoint_id, cfg));
}

export function get_pricing(args: z.infer<typeof GetPricingSchema>): ToolResult {
  const cfg = loadScenarioConfig();
  recordCall({ tool: "get_pricing", endpoint_id: args.endpoint_id });
  return ok(getPricing(args.endpoint_id, cfg));
}

export function search_docs(args: z.infer<typeof SearchDocsSchema>): ToolResult {
  recordCall({ tool: "search_docs", input: args });
  return ok({ snippets: [`[FAKE FAL docs] No live docs in test mode. Query: ${args.query}`] });
}
interface PendingJob { endpoint_id: string; input: Record<string, unknown>; pieceId?: string | null }
// Test-mode, process-lifetime store — acceptable to leave unbounded for a short-lived fake server.
const JOBS = new Map<string, PendingJob>();
let JOB_SEQ = 0;

function requestIdFor(endpoint_id: string, input: unknown): string {
  return "fake-" + createHash("sha1").update(endpoint_id + JSON.stringify(input)).digest("hex").slice(0, 12) + "-" + (++JOB_SEQ);
}

function durationFromInput(input: Record<string, unknown>): number | undefined {
  const d = input.duration ?? input.durationSeconds;
  const n = typeof d === "string" ? parseFloat(d) : typeof d === "number" ? d : NaN;
  return Number.isFinite(n) ? n : undefined;
}

async function materialize(endpoint_id: string, input: Record<string, unknown>, pieceId?: string | null) {
  const file = await makePlaceholder(kindFor(endpoint_id), {
    prompt: String(input.prompt ?? ""),
    pieceId: pieceId ?? null,
    durationSeconds: durationFromInput(input),
    endpointId: endpoint_id,
  });
  return file;
}

export async function run_model(args: z.infer<typeof RunModelSchema>): Promise<ToolResult> {
  const cfg = loadScenarioConfig();
  recordCall({
    tool: "run_model",
    endpoint_id: args.endpoint_id,
    ...buildCallRecord(args.endpoint_id, cfg),
    input: args.input,
    pieceId: args.pieceId ?? null,
  });
  if (strictReject(args.endpoint_id, cfg)) return unknownEndpointError(args.endpoint_id);
  const bad = unreachableInput(args.input);
  if (bad) return unreachableInputError(bad);
  const file = await materialize(args.endpoint_id, args.input, args.pieceId);
  return ok({ success: true, file });
}

export async function submit_job(args: z.infer<typeof SubmitJobSchema>): Promise<ToolResult> {
  const cfg = loadScenarioConfig();
  if (strictReject(args.endpoint_id, cfg)) {
    recordCall({
      tool: "submit_job",
      endpoint_id: args.endpoint_id,
      ...buildCallRecord(args.endpoint_id, cfg),
      input: args.input,
      pieceId: args.pieceId ?? null,
    });
    return unknownEndpointError(args.endpoint_id);
  }
  const bad = unreachableInput(args.input);
  if (bad) {
    recordCall({
      tool: "submit_job",
      endpoint_id: args.endpoint_id,
      ...buildCallRecord(args.endpoint_id, cfg),
      input: args.input,
      pieceId: args.pieceId ?? null,
    });
    return unreachableInputError(bad);
  }
  const request_id = requestIdFor(args.endpoint_id, args.input);
  JOBS.set(request_id, { endpoint_id: args.endpoint_id, input: args.input, pieceId: args.pieceId ?? null });
  recordCall({
    tool: "submit_job",
    endpoint_id: args.endpoint_id,
    ...buildCallRecord(args.endpoint_id, cfg),
    input: args.input,
    pieceId: args.pieceId ?? null,
    request_id,
  });
  return ok({ request_id, status: "submitted" });
}

export function check_job(args: z.infer<typeof CheckJobSchema>): ToolResult {
  recordCall({ tool: "check_job", request_id: args.request_id });
  return ok({ request_id: args.request_id, status: "completed" });
}

export async function get_job_result(args: z.infer<typeof GetJobResultSchema>): Promise<ToolResult> {
  recordCall({ tool: "get_job_result", request_id: args.request_id });
  const job = JOBS.get(args.request_id);
  if (!job) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "unknown request_id" }) }], error: "unknown request_id" };
  const file = await materialize(job.endpoint_id, job.input, job.pieceId);
  return ok({ success: true, file });
}
