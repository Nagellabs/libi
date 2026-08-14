import { describe, it, expect, vi } from "vitest";
// server.ts → tools.ts → placeholders.ts → file-tools (DB) at import; stub them.
vi.mock("@/mcp/tools/file-tools", () => ({ storeFile: vi.fn() }));
vi.mock("@/lib/ffmpeg/exec", () => ({ runFfmpeg: vi.fn(), resolveFfmpegPath: () => "ffmpeg" }));
vi.mock("node:child_process", () => ({ spawnSync: () => ({ stdout: "drawtext" }) }));
import { createFakeFalMcpServer } from "@/mcp/dev/fake-fal/server";
import { registeredToolNames } from "@/__tests__/helpers/mcp-tools";

describe("createFakeFalMcpServer", () => {
  it("registers the mirrored fal tool names", async () => {
    const server = createFakeFalMcpServer();
    const names = registeredToolNames(server);
    for (const t of ["recommend_model", "get_model_schema", "get_pricing", "run_model", "submit_job", "check_job", "get_job_result", "search_docs"]) {
      expect(names).toContain(t);
    }
  });
});
