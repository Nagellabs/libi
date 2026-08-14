import { describe, it, expect } from "vitest";
import { RunModelSchema, RecommendModelSchema, SubmitJobSchema, GetSchemaSchema } from "@/mcp/dev/fake-fal/schemas";

describe("fake-fal tool schemas", () => {
  it("run_model requires endpoint_id + input", () => {
    expect(RunModelSchema.safeParse({ endpoint_id: "openai/gpt-image-2", input: { prompt: "x" } }).success).toBe(true);
    expect(RunModelSchema.safeParse({ input: { prompt: "x" } }).success).toBe(false);
  });
  it("recommend_model requires a task string", () => {
    expect(RecommendModelSchema.safeParse({ task: "make an image" }).success).toBe(true);
  });
  it("submit_job + get_model_schema parse", () => {
    expect(SubmitJobSchema.safeParse({ endpoint_id: "x", input: {} }).success).toBe(true);
    expect(GetSchemaSchema.safeParse({ endpoint_id: "x" }).success).toBe(true);
  });
});
