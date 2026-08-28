/**
 * GET /api/sessions/[sessionId]/model distinguishes "not known yet" (pending —
 * the activation replay hasn't filled configOptions, or the session isn't
 * registered yet after a restart) from "the agent offers no model select"
 * (genuinely unsupported). The old single {supported:false} collapsed both,
 * and with nothing invalidating sessionModelKeys the picker rendered null for
 * as long as a restored session stayed open.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionModelSnapshot } from "@/lib/sessions/model-option";

const sm = {
  getSessionModelSnapshot: vi.fn(
    (_id: string): SessionModelSnapshot | null => null,
  ),
  setSessionModel: vi.fn(),
};
vi.mock("@/lib/sessions/session-manager", () => ({ getSessionManager: () => sm }));

import { GET } from "@/app/api/sessions/[sessionId]/model/route";

function params(sessionId: string) {
  return { params: Promise.resolve({ sessionId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  sm.getSessionModelSnapshot.mockReturnValue(null);
});

describe("GET /api/sessions/[sessionId]/model", () => {
  it("reports pending (not unsupported) while configOptions are uncaptured", async () => {
    sm.getSessionModelSnapshot.mockReturnValue({ supported: false, pending: true });
    const body = await (await GET(new Request("http://libi.test"), params("s1"))).json();
    expect(body).toEqual({ supported: false, pending: true });
  });

  it("reports genuinely unsupported when options exist but hold no model select", async () => {
    sm.getSessionModelSnapshot.mockReturnValue({ supported: false, pending: false });
    const body = await (await GET(new Request("http://libi.test"), params("s1"))).json();
    expect(body).toEqual({ supported: false, pending: false });
  });

  it("treats an unknown session as pending — after a restart the GET can land before loadInitialSessions registers the entry", async () => {
    const body = await (await GET(new Request("http://libi.test"), params("gone"))).json();
    expect(body).toEqual({ supported: false, pending: true });
  });

  it("returns the full model state when a model select exists", async () => {
    sm.getSessionModelSnapshot.mockReturnValue({
      supported: true,
      currentModelId: "default",
      availableModels: [{ id: "default", name: "Default (recommended)" }],
    });
    const body = await (await GET(new Request("http://libi.test"), params("s1"))).json();
    expect(body).toEqual({
      supported: true,
      currentModelId: "default",
      availableModels: [{ id: "default", name: "Default (recommended)" }],
    });
  });
});
