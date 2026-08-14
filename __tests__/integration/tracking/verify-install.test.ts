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
