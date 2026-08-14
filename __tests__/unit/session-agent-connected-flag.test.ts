import { it, expect, vi } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn() }));

it("markAgentConnected flips the flag + fires agent_connected exactly once", async () => {
  testDb = createTestDb();
  const { markAgentConnected } = await import("@/lib/sessions/session-manager");
  const { getSettings } = await import("@/lib/db/settings");
  const { trackServerEvent } = await import("@/lib/analytics/server");
  expect(getSettings().agentEverConnected).toBe(false);

  markAgentConnected();
  expect(getSettings().agentEverConnected).toBe(true);
  expect(trackServerEvent).toHaveBeenCalledTimes(1);
  expect(trackServerEvent).toHaveBeenCalledWith("agent_connected");

  // Already connected → no flag change and no duplicate event.
  markAgentConnected();
  expect(trackServerEvent).toHaveBeenCalledTimes(1);
});
