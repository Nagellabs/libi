// mcp/tools/model-schema-tools.ts
import type { ToolContext, ToolResult } from "./types";
import {
  getModelSchemaCache,
  saveModelSchemaCache,
  invalidateModelSchemaCache,
} from "@/lib/storyboard/model-schema-cache";
import { validateFieldDefs } from "@/lib/storyboard/gen-schema";
import type { ModelSchema } from "@/lib/storyboard/gen-schema";

export async function getModelSchemaCacheTool(
  params: { apiUrl: string; model: string },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const r = await getModelSchemaCache(params.apiUrl, params.model);
  return { success: true, data: r as Record<string, unknown> };
}

export async function saveModelSchemaCacheTool(
  params: { apiUrl: string; model: string; fields: unknown; source?: string },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const check = validateFieldDefs(params.fields);
  if (!check.ok) return { success: false, error: `invalid schema: ${check.error}` };
  const schema: ModelSchema = {
    apiUrl: params.apiUrl,
    model: params.model,
    fields: params.fields as ModelSchema["fields"],
  };
  await saveModelSchemaCache(params.apiUrl, params.model, schema, params.source);
  return { success: true, data: { saved: true, fieldCount: schema.fields.length } };
}

export async function invalidateModelSchemaCacheTool(
  params: { apiUrl: string; model: string },
  _ctx: ToolContext,
): Promise<ToolResult> {
  await invalidateModelSchemaCache(params.apiUrl, params.model);
  return { success: true, data: { invalidated: true } };
}
