import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";

const routes = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/security/test-routes", () => ({ testRoutesEnabled: () => routes.enabled }));

import { DELETE } from "@/app/api/e2e/agents/[agentId]/sign-in-confirmation/route";
import { getSignInConfirmedAt, setSignInConfirmed } from "@/lib/agents/sign-in-confirmation";

const del = (agentId: string) =>
  DELETE(new Request(`http://x/api/e2e/agents/${agentId}/sign-in-confirmation`, { method: "DELETE" }), {
    params: Promise.resolve({ agentId }),
  });

/**
 * The e2e-only undo of POST /api/agents/<id>/sign-in-confirmation: a spec that
 * stores a confirmation in the scratch DB takes it back out with this.
 */
describe("DELETE /api/e2e/agents/[agentId]/sign-in-confirmation", () => {
  beforeEach(() => {
    createTestDb();
    routes.enabled = true;
  });

  it("forgets the confirmation for that agent only", async () => {
    setSignInConfirmed("claude-code");
    setSignInConfirmed("codex");
    const res = await del("claude-code");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ confirmedAt: null });
    expect(getSignInConfirmedAt("claude-code")).toBeNull();
    expect(getSignInConfirmedAt("codex")).not.toBeNull();
  });

  it("is refused, and changes nothing, unless test routes are enabled", async () => {
    routes.enabled = false;
    setSignInConfirmed("claude-code");
    const res = await del("claude-code");
    expect(res.status).toBe(403);
    expect(getSignInConfirmedAt("claude-code")).not.toBeNull();
  });

  it("rejects an unknown agent", async () => {
    const res = await del("gemini");
    expect(res.status).toBe(400);
  });
});
