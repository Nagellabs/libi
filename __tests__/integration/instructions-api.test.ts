import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createTempStorageDir,
  cleanupTempDir,
} from "@/__tests__/helpers/test-storage";

vi.mock("@/mcp/workspace", () => ({
  regenerateAndRestart: vi.fn(async () => ({ sessionsTerminated: 1 })),
  prepareAgentDir: vi.fn(),
}));

import { GET } from "@/app/api/instructions/route";
import { POST, DELETE } from "@/app/api/instructions/override/route";
import { loadBundledTemplate } from "@/lib/instructions/bundled-template";
import { renderDialect } from "@/lib/instructions/dialect";
import { hasInstructionsOverride } from "@/lib/instructions/override";
import { regenerateAndRestart } from "@/mcp/workspace";

beforeEach(() => {
  createTempStorageDir();
  vi.mocked(regenerateAndRestart).mockClear();
});

afterEach(() => {
  cleanupTempDir();
});

describe("GET /api/instructions", () => {
  it("returns the bundled template when no override exists", async () => {
    const body = await (await GET()).json();
    expect(body.source).toBe("bundled");
    expect(body.bundledUpdatedSinceFork).toBe(false);
    // The page renders the CLAUDE (default) dialect — dialect blocks resolved.
    expect(body.content).toBe(renderDialect(loadBundledTemplate(), "claude"));
  });
});

describe("POST /api/instructions/override", () => {
  it("creates the override and restarts sessions", async () => {
    const res = await POST(
      new Request("http://x/", { method: "POST", body: JSON.stringify({ content: "# Mine" }) }),
    );
    expect(res.status).toBe(200);
    expect(hasInstructionsOverride()).toBe(true);
    expect(regenerateAndRestart).toHaveBeenCalledTimes(1);

    const body = await (await GET()).json();
    expect(body.source).toBe("override");
    expect(body.content).toBe("# Mine");
  });

  it("rejects empty content", async () => {
    const res = await POST(
      new Request("http://x/", { method: "POST", body: JSON.stringify({ content: "  " }) }),
    );
    expect(res.status).toBe(400);
    expect(regenerateAndRestart).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/instructions/override", () => {
  it("reverts to bundled and restarts sessions", async () => {
    await POST(
      new Request("http://x/", { method: "POST", body: JSON.stringify({ content: "# Mine" }) }),
    );
    vi.mocked(regenerateAndRestart).mockClear();

    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(hasInstructionsOverride()).toBe(false);
    expect(regenerateAndRestart).toHaveBeenCalledTimes(1);
  });
});
