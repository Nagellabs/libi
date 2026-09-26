// PATCH /api/settings must not be a second, unguarded way to switch approval
// cards off: the approval mode is written only by the browser-only-checked
// PATCH /api/sessions/permission-modes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getApprovalMode, setApprovalMode } from "@/lib/approval/settings";
import { getSettings } from "@/lib/db/settings";
import { PATCH } from "@/app/api/settings/route";

beforeEach(() => {
  createTestDb();
});
afterEach(() => {
  resetTestDb();
});

function patch(body: unknown): Promise<Response> {
  return PATCH(new Request("http://127.0.0.1:3461/api/settings", { method: "PATCH", body: JSON.stringify(body) }));
}

describe("PATCH /api/settings and the approval mode", () => {
  it("ignores agentApprovalModes, so a header-less caller cannot switch cards off", async () => {
    setApprovalMode("claude", "ask");
    const res = await patch({ agentApprovalModes: JSON.stringify({ claude: "auto-with-generations" }) });
    expect(res.status).toBe(200);
    expect(getApprovalMode("claude")).toBe("ask");
  });

  it("still applies the other fields in the same body", async () => {
    setApprovalMode("claude", "ask");
    await patch({ panelChatSize: 41, agentApprovalModes: JSON.stringify({ claude: "auto-with-generations" }) });
    expect(getSettings().panelChatSize).toBe(41);
    expect(getApprovalMode("claude")).toBe("ask");
  });
});
