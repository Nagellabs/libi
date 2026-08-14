import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createTempStorageDir,
  cleanupTempDir,
} from "@/__tests__/helpers/test-storage";

vi.mock("@/mcp/workspace", () => ({
  regenerateAndRestart: vi.fn(async () => ({ sessionsTerminated: 2 })),
  prepareAgentDir: vi.fn(),
}));

import { GET, PUT } from "@/app/api/settings/memories/route";
import { readMemories, writeMemories } from "@/lib/instructions/memories";
import { regenerateAndRestart } from "@/mcp/workspace";

beforeEach(() => {
  createTempStorageDir();
  vi.mocked(regenerateAndRestart).mockClear();
});

afterEach(() => {
  cleanupTempDir();
});

describe("GET /api/settings/memories", () => {
  it("returns empty content when the file does not exist", async () => {
    const body = await (await GET()).json();
    expect(body.content).toBe("");
  });

  it("returns the file content", async () => {
    writeMemories("## Style\n\ncinematic\n");
    const body = await (await GET()).json();
    expect(body.content).toBe("## Style\n\ncinematic\n");
  });
});

describe("PUT /api/settings/memories", () => {
  const put = (payload: unknown) =>
    PUT(new Request("http://x/", { method: "PUT", body: JSON.stringify(payload) }));

  it("persists content and triggers regenerate-and-restart", async () => {
    const res = await put({ content: "## A\n\nremember this\n" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, sessionsTerminated: 2 });
    expect(readMemories()).toBe("## A\n\nremember this\n");
    expect(regenerateAndRestart).toHaveBeenCalledTimes(1);
  });

  it("rejects > 8000 chars without writing", async () => {
    const res = await put({ content: "x".repeat(8001) });
    expect(res.status).toBe(400);
    expect(readMemories()).toBe("");
    expect(regenerateAndRestart).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON", async () => {
    const res = await PUT(new Request("http://x/", { method: "PUT", body: "not json" }));
    expect(res.status).toBe(400);
  });

  it("accepts empty string (clears memories)", async () => {
    writeMemories("old");
    const res = await put({ content: "" });
    expect(res.status).toBe(200);
    expect(readMemories()).toBe("");
  });
});
