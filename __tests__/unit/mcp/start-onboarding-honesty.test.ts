import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `libi.start_onboarding` used to claim the screen off a fire-and-forget
 * notify — the same over-claim fixed for `libi.suggest_provider`. `notify`
 * no-ops silently when there is no studio to POST to (a CLI surface, a stopped
 * server), so the agent was told something was on screen and narrated a page
 * the user could not see.
 *
 * It now sends the user to the Agents page, and says so only when
 * the POST landed. The mock RESOLVES a boolean rather than returning undefined:
 * that is what the real `notify.navigateAgents` does, and a mock that resolved
 * nothing would make the "navigated" case pass for the wrong reason.
 */
const { navigateAgents } = vi.hoisted(() => ({
  navigateAgents: vi.fn<(event: unknown) => Promise<boolean>>(async () => true),
}));
vi.mock("@/mcp/notify", () => ({ notify: { navigateAgents } }));

import { startOnboarding } from "@/mcp/tools/onboarding-tools";

beforeEach(() => {
  navigateAgents.mockClear();
  navigateAgents.mockResolvedValue(true);
});

describe("libi.start_onboarding — reports whether the Agents page actually opened", () => {
  it("navigates to the Agents tab and says so only when the POST landed", async () => {
    const res = await startOnboarding({});
    expect(navigateAgents).toHaveBeenCalledWith({ tab: "agents" });
    expect(res).toEqual({
      success: true,
      data: { status: "navigated", opened: "agents" },
    });
  });

  it("degrades honestly when the notify did not land", async () => {
    navigateAgents.mockResolvedValue(false);
    const res = await startOnboarding({});
    const data = res.data as { status: string; opened: null; note: string };
    expect(res.success).toBe(true);
    expect(data.status).toBe("unavailable");
    // The load-bearing assertion: nothing in the payload lets the agent say a
    // page is up.
    expect(data.opened).toBeNull();
    expect(data.note).toMatch(/could not/i);
  });

  it("awaits the notify rather than firing and forgetting it", async () => {
    // A fire-and-forget call would resolve the tool before the POST settled,
    // so a false could never influence the answer.
    let release!: (v: boolean) => void;
    navigateAgents.mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );
    let settled = false;
    const p = startOnboarding({}).then((r) => {
      settled = true;
      return r;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release(false);
    const res = await p;
    expect((res.data as { status: string }).status).toBe("unavailable");
  });
});
