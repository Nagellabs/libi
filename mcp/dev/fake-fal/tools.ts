import { createHash } from "node:crypto";
import { recommendModel, getSchema, getPricing, kindFor, resolveEndpoint } from "./kb";
import type { ScenarioConfig } from "./kb";
import { loadScenarioConfig } from "./config";
import { recordCall } from "./recorder";
import { makePlaceholder } from "./placeholders";
import type {
  RecommendModelSchema, GetSchemaSchema, GetPricingSchema,
  RunModelSchema, SubmitJobSchema, CheckJobSchema, GetJobResultSchema, SearchDocsSchema,
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
