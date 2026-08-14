import { describe, it, expect } from "vitest";
import { mcpMissingKeyError } from "@/lib/mcp/missing-key";

it("builds the structured error shape", () => {
  expect(mcpMissingKeyError("fal-ai", "FAL_KEY")).toEqual({
    error: "mcp_missing_key",
    data: {
      mcpId: "fal-ai",
      envVar: "FAL_KEY",
      hint:
        'The fal-ai MCP needs FAL_KEY. Call libi.show_api_config({ mcpId: "fal-ai" }) and ask the user to enter it.',
    },
  });
});
