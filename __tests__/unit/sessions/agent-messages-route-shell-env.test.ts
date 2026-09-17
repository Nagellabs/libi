/** GET /api/agent/messages carries the session's shell-environment flag, read AFTER activation. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const entry: { shellEnvLoaded?: boolean } = {};
const sm = {
  getSession: vi.fn((): unknown => entry),
  activateSession: vi.fn(async () => [] as unknown[]),
};
vi.mock("@/lib/sessions/session-manager", () => ({ getSessionManager: () => sm }));

import { GET } from "@/app/api/agent/messages/route";

const req = (id: string) => new Request(`http://127.0.0.1/api/agent/messages?sessionId=${id}`);

beforeEach(() => {
  vi.clearAllMocks();
  delete entry.shellEnvLoaded;
  sm.getSession.mockImplementation(() => entry);
  sm.activateSession.mockImplementation(async () => []);
});

describe("GET /api/agent/messages — shellEnvLoaded", () => {
  it("false for a session whose agent started before the environment loaded (known only after activation)", async () => {
    sm.activateSession.mockImplementation(async () => {
      entry.shellEnvLoaded = false;
      return [];
    });
    expect(await (await GET(req("s-1"))).json()).toEqual({ messages: [], shellEnvLoaded: false });
  });
  it("true when loaded, or not recorded", async () => {
    expect(await (await GET(req("s-1"))).json()).toEqual({ messages: [], shellEnvLoaded: true });
    entry.shellEnvLoaded = true;
    expect(await (await GET(req("s-1"))).json()).toEqual({ messages: [], shellEnvLoaded: true });
  });
  it("an unknown session has nothing to warn about", async () => {
    sm.getSession.mockImplementation(() => undefined);
    expect(await (await GET(req("nope"))).json()).toEqual({ messages: [], shellEnvLoaded: true });
  });
});
