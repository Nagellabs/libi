/**
 * libi.verify_install passes the self-test's failure REASON through. It used
 * to return only ok/installed/missing/versions, so a self-test that timed out
 * (or whose uv could not download its Python offline) reached the agent as a
 * bare `ok: false` with nothing to tell the user.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/libi-home", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/libi-home")>()),
  getCurrentPort: () => 65000,
}));

import { verifyInstall } from "@/mcp/tools/tracking-tools";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(body: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as never;
}

describe("verify_install surfaces the self-test's error", () => {
  it("carries `error` when the endpoint reports one", async () => {
    answer({
      ok: false,
      installed: true,
      missing: [],
      versions: {},
      error: "engine selftest timed out after 170000ms",
    });
    const r = await verifyInstall({});
    expect(r).toEqual({
      success: true,
      data: {
        ok: false,
        installed: true,
        missing: [],
        versions: {},
        error: "engine selftest timed out after 170000ms",
      },
    });
  });

  it("adds no error key when there is none", async () => {
    answer({ ok: true, installed: true, missing: [], versions: { torch: "2.12.0" } });
    const r = await verifyInstall({});
    expect(r).toEqual({
      success: true,
      data: { ok: true, installed: true, missing: [], versions: { torch: "2.12.0" } },
    });
  });
});
