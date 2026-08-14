import { z } from "zod/v3";

export const RecommendModelSchema = z.object({ task: z.string().min(1) });
export const GetSchemaSchema = z.object({ endpoint_id: z.string().min(1) });
export const GetPricingSchema = z.object({ endpoint_id: z.string().min(1) });
export const RunModelSchema = z.object({
  endpoint_id: z.string().min(1),
  input: z.record(z.unknown()),
  pieceId: z.string().nullable().optional(),
});
export const SubmitJobSchema = RunModelSchema;
export const CheckJobSchema = z.object({ request_id: z.string().min(1) });
export const GetJobResultSchema = z.object({ request_id: z.string().min(1) });
export const SearchDocsSchema = z.object({ query: z.string().min(1) });
