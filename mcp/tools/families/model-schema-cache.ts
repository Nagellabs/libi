import {
  getModelSchemaCacheTool,
  saveModelSchemaCacheTool,
  invalidateModelSchemaCacheTool,
} from "@/mcp/tools/model-schema-tools";
import {
  getModelSchemaCacheSchema,
  saveModelSchemaCacheSchema,
  invalidateModelSchemaCacheSchema,
} from "@/mcp/tools/schemas";
import { z } from "zod/v3";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";

const ctx = { pieceId: "" };

export const modelSchemaCacheTool: ActionToolDef = {
  name: "libi.model_schema_cache",
  description:
    "The cache of generation-endpoint parameter schemas that gates `libi.set_storyboard_generation` (keyed by apiUrl + model): read an endpoint's cached schema, save a freshly fetched one, or drop a wrong one. Actions: get, save, invalidate.",
  // `fields` is advertised loosely (the GenFieldDef shape is in its text); `save` still validates every field def.
  widen: { fields: z.array(z.record(z.unknown())) },
  props: {
    apiUrl: "Full endpoint URL / fal endpoint id (the cache key, with `model`).",
    model: "Model id (the cache key, with `apiUrl`).",
  },
  actions: {
    get: action({
      describe:
        "read an endpoint's cached parameter schema { exists, stale, fetchedAt, schema }; call it BEFORE generating, and if missing or stale fetch the endpoint's API schema and `save` it",
      schema: getModelSchemaCacheSchema,
      run: (params) => getModelSchemaCacheTool(params, ctx),
    }),
    save: action({
      describe:
        "cache an endpoint's normalized parameter schema (`fields`), upserting by apiUrl+model; populate it before libi.set_storyboard_generation",
      schema: saveModelSchemaCacheSchema,
      run: (params) => saveModelSchemaCacheTool(params, ctx),
    }),
    invalidate: action({
      describe: "drop a cached schema when a generation failed because it was wrong, then re-fetch and `save`",
      schema: invalidateModelSchemaCacheSchema,
      run: (params) => invalidateModelSchemaCacheTool(params, ctx),
    }),
  },
};
