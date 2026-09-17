import { describe, it, expect, vi } from "vitest";

// Hermetic by construction. `verifyInstall` resolves the server port via
// getCurrentPort(), which FALLS BACK to LIBI_PORT ?? "3456" when the port
// file is absent (always, under the isolated test LIBI_HOME). On a dev
// machine the real app runs on 3456, so without this mock the test made a
// real, slow network call to the live /api/tracking/verify selftest and
// timed out non-deterministically. We instead simulate the documented
// "server down in unit ctx" condition directly: getCurrentPort throws,
// so verifyInstall must return its structured libi_server_unavailable
// failure with zero network and never throw.
vi.mock("@/lib/libi-home", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/libi-home")>();
  return {
    ...actual,
    getCurrentPort: () => {
      throw new Error("port file missing (test: no libi server)");
    },
  };
});

import { VerifyInstallSchema } from "@/mcp/tools/schemas";
import { verifyInstall } from "@/mcp/tools/tracking-tools";

describe("verify_install", () => {
  it("schema accepts an empty object", () => {
    expect(VerifyInstallSchema.parse({})).toBeTruthy();
  });

  it("returns a structured libi_server_unavailable failure without throwing when no server", async () => {
    const r = await verifyInstall({});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toBe("libi_server_unavailable");
      const data = r.data as { hint?: string } | undefined;
      expect(typeof data?.hint).toBe("string");
      expect(data?.hint).toMatch(/libi server not running/i);
    }
  });
});

/**
 * `libi.verify_install({ mcpId: "local-music" })` reported
 * `missing: ["tracking-pyenv"]`. The music extension's wiring in
 * `mcp/registry/bundled.ts` is fine — it declares `uv` plus the virtual
 * `ace-step-model` dep and nothing tracking-related. The fault was that
 * `VerifyInstallSchema` was `z.object({})`, so zod stripped the id and the
 * tool answered the caller's music-shaped question with the TRACKING engine's
 * status. An agent then tells the user music needs a Python tracking sidecar.
 *
 * The mock above makes the tracking path unreachable (getCurrentPort throws),
 * so a refusal here can only be the new guard and never an accidental pass.
 */
describe("verify_install is the TRACKING engine's check and says so", () => {
  it("refuses another extension's id instead of answering with tracking's deps", async () => {
    for (const params of [{ mcpId: "local-music" }, { extensionId: "whisper" }]) {
      const r = await verifyInstall(params);
      expect(r.success).toBe(false);
      if (r.success) throw new Error("expected refusal");
      expect(r.error).toBe("not_the_tracking_engine");
      const hint = (r.data as { hint?: string } | undefined)?.hint ?? "";
      // The failure mode was a *plausible* wrong answer, so the refusal has to
      // point at what does verify that extension.
      expect(hint).toContain("libi-tracking");
      expect(hint).toMatch(/needs_install/);
      expect(hint).toMatch(/get_install_plan/);
      // It must never leak the tracking engine's own dependency names as if
      // they were the caller's.
      expect(hint).not.toMatch(/missing.*tracking-pyenv/);
    }
  });

  it("still answers for the tracking engine when given its own id, or none", async () => {
    for (const params of [{}, { mcpId: "libi-tracking" }, { extensionId: "libi-tracking" }]) {
      const r = await verifyInstall(params);
      expect(r.success).toBe(false);
      if (r.success) throw new Error("expected the server-unavailable path");
      // Reached the real code path (and only failed because the mock kills the
      // port lookup) rather than being turned away by the guard.
      expect(r.error).toBe("libi_server_unavailable");
    }
  });

  it("declares both keys, so the SDK advertises them instead of silently stripping one", () => {
    const shape = VerifyInstallSchema.shape;
    expect(Object.keys(shape).sort()).toEqual(["extensionId", "mcpId"]);
    expect(VerifyInstallSchema.parse({})).toEqual({});
    expect(VerifyInstallSchema.parse({ mcpId: "libi-tracking" })).toEqual({
      mcpId: "libi-tracking",
    });
  });
});
