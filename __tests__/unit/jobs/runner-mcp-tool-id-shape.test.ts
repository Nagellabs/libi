import { describe, it, expect } from "vitest";
import { z } from "zod/v3";
import type { JobRunner } from "@/lib/jobs/types";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

describe("JobRunner.mcpToolId shape", () => {
  it("accepts a single McpToolId", () => {
    const r: JobRunner<{ x: number }, void> = {
      kind: "ex_single",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({ x: z.number() }),
      mcpToolId: makeMcpToolId("libi", "libi.foo"),
      async run() {},
    };
    expect(r.mcpToolId).toBe("libi:libi.foo");
  });
  it("accepts an array of McpToolIds", () => {
    const r: JobRunner<{ x: number }, void> = {
      kind: "ex_multi",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({ x: z.number() }),
      mcpToolId: [
        makeMcpToolId("libi", "libi.bar"),
        makeMcpToolId("libi-tracking", "libi.bar"),
      ],
      async run() {},
    };
    expect(Array.isArray(r.mcpToolId)).toBe(true);
  });
  it("permits omitting the field (server-internal runners)", () => {
    const r: JobRunner<{ x: number }, void> = {
      kind: "ex_internal",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({ x: z.number() }),
      async run() {},
    };
    expect(r.mcpToolId).toBeUndefined();
  });
});
