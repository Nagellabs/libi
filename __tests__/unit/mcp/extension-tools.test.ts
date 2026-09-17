import { describe, it, expect, vi, beforeEach } from "vitest";
const navigateAgents = vi.fn<(event: unknown) => Promise<boolean>>(async () => true);
vi.mock("@/mcp/notify", () => ({ notify: { navigateAgents: (e: unknown) => navigateAgents(e) } }));
import * as extensionTools from "@/mcp/tools/extension-tools";
import { showExtension } from "@/mcp/tools/extension-tools";

describe("libi.show_extension", () => {
  beforeEach(() => navigateAgents.mockClear());
  it("navigates to the libi MCP tab focused on the extension, and reports whether the studio accepted it", async () => {
    expect(await showExtension({ extensionId: "libi-tracking" })).toEqual({ success: true, data: { ok: true, navigated: true } });
    expect(navigateAgents).toHaveBeenCalledWith({ tab: "libi-mcp", extensionId: "libi-tracking" });
  });
  it("still honours the deprecated mcpId alias", async () => {
    await showExtension({ mcpId: "whisper" });
    expect(navigateAgents).toHaveBeenCalledWith({ tab: "libi-mcp", extensionId: "whisper" });
  });
  it("says navigated:false when the POST did not land", async () => {
    navigateAgents.mockResolvedValueOnce(false);
    expect((await showExtension({})).data).toEqual({ ok: true, navigated: false });
    // No extension named → the tab alone, with no `extensionId` key at all.
    expect(navigateAgents.mock.calls[0][0]).toStrictEqual({ tab: "libi-mcp" });
  });
});

// Guards that outlived the tool they sat next to: libi registers no third-party
// MCPs (so there is nothing to list), and holds no provider key (so there is no
// key-config panel to open).
describe("extension-tools after providers", () => {
  it("no longer exports listBundledMcps", () => {
    expect("listBundledMcps" in extensionTools).toBe(false);
  });
});

describe("onboarding-tools after providers", () => {
  it("no longer exports showApiConfig", async () => {
    const mod = await import("@/mcp/tools/onboarding-tools");
    expect("showApiConfig" in mod).toBe(false);
  });
});
