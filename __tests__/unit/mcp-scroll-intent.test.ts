import { describe, it, expect, beforeEach } from "vitest";
import {
  MCP_SCROLL_EVENT,
  setPendingMcpScroll,
  takePendingMcpScroll,
} from "@/lib/mcp-scroll-intent";

/**
 * The parking lot that makes `libi.show_extension` work from the Skills
 * tab. `McpServersView` is unmounted whenever the Skills tab is showing
 * (base-ui `Tabs.Panel` keepMounted:false), so the CustomEvent alone reaches
 * nobody — the id has to survive until the view mounts and claims it.
 */
describe("mcp scroll intent", () => {
  beforeEach(() => setPendingMcpScroll(undefined));

  it("hands a parked id to the first claimer", () => {
    setPendingMcpScroll("local-music");
    expect(takePendingMcpScroll()).toBe("local-music");
  });

  it("is one-shot — a remount does not replay an old jump", () => {
    setPendingMcpScroll("whisper");
    expect(takePendingMcpScroll()).toBe("whisper");
    expect(takePendingMcpScroll()).toBeNull();
  });

  it("claims nothing when no intent was parked", () => {
    expect(takePendingMcpScroll()).toBeNull();
  });

  it("drops an intent older than the TTL", () => {
    setPendingMcpScroll("local-tts", 1_000);
    expect(takePendingMcpScroll(1_000 + 30_000)).toBe("local-tts");
    setPendingMcpScroll("local-tts", 1_000);
    expect(takePendingMcpScroll(1_000 + 30_001)).toBeNull();
  });

  it("an extensionId-less navigate_agents parks nothing", () => {
    setPendingMcpScroll("whisper");
    setPendingMcpScroll(undefined);
    expect(takePendingMcpScroll()).toBeNull();
  });

  it("keeps the event name both sides agree on", () => {
    expect(MCP_SCROLL_EVENT).toBe("libi:mcp-scroll-to");
  });
});
