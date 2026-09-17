/**
 * The reactive safety net under the deliberate `libi` entry-name collision.
 *
 * The collision is the mechanism that makes an in-app session mount libi ONCE
 * (`lib/mcp/agent-surface.ts#LIBI_MCP_ENTRY_NAME`). On Codex it is resolved by a
 * FIELD-BY-FIELD merge of libi's session override into the user's own
 * `[mcp_servers.libi]`, which has two failure shapes — both measured on
 * codex-cli 0.153.4 + codex-acp 1.10.0, 2026-09-09:
 *
 *  1. a hand-written STDIO entry merges into a table holding both `command`
 *     and `url`; codex rejects the whole config and the chat cannot start.
 *     Reachable without hand-editing: older libi versions wrote stdio entries.
 *  2. `enabled = false` survives the merge; the chat starts with NO libi tools
 *     and nothing says why.
 *
 * (1) is caught and retried under a non-colliding name. These tests pin the
 * discrimination, because the cost of getting it wrong is silently retrying —
 * and thereby re-duplicating the tool surface on — failures that are nothing to
 * do with libi.
 */
import { describe, it, expect, vi } from "vitest";
import {
  isLibiMcpEntryConfigError,
  LIBI_MCP_ENTRY_NAME,
  LIBI_MCP_FALLBACK_ENTRY_NAME,
} from "@/lib/mcp/agent-surface";
import { fromAnyToolName } from "@/lib/agents/mcp-tool-id";

vi.mock("@/lib/libi-home", async () => {
  const actual = await vi.importActual<typeof import("@/lib/libi-home")>("@/lib/libi-home");
  return { ...actual, getCurrentMcpPort: () => 3999 };
});

/**
 * The literal `session/new` rejection, captured from the real adapter: the
 * discriminating text is in `data`, and `message` is the generic wrapper
 * codex-acp's `handleError` puts on anything mentioning "load config".
 */
function stdioCollisionError() {
  return {
    code: -32603,
    message: "Internal error",
    data:
      "failed to load configuration: url is not supported for stdio\n" +
      "in `mcp_servers.libi`\n\n\n" +
      "Check /tmp/codex-home and project .codex directories, especially their " +
      "config.toml files, or any CODEX_CONFIG override.",
  };
}

describe("isLibiMcpEntryConfigError", () => {
  it("matches the merged-override rejection that names libi's own entry", () => {
    expect(isLibiMcpEntryConfigError(stdioCollisionError())).toBe(true);
  });

  /**
   * Every one of these is a REAL rejection captured the same day from the same
   * adapter. They share the `-32603` code and the "Internal error" message with
   * the case above, which is exactly why neither can be the discriminator.
   *
   * None of them is fixed by renaming libi's entry — they are the user's config
   * being wrong on its own terms — so a retry would only mask the real cause
   * and re-duplicate the tool surface. The tell is that a config error codex
   * finds by PARSING carries a `file:line:col` locator and no table frame.
   */
  it.each([
    [
      "the user's own unrelated broken server",
      "failed to load configuration: /tmp/h/config.toml:1:1: url is not supported for stdio\n\nCheck /tmp/h …",
    ],
    [
      "malformed TOML",
      "failed to load configuration: /tmp/h/config.toml:1:18: unclosed table, expected `]`\n\nCheck /tmp/h …",
    ],
    [
      "a bad field type on libi's own entry",
      'failed to load configuration: /tmp/h/config.toml:3:23: invalid type: string "x", expected f64\n\nCheck /tmp/h …',
    ],
  ])("does not match %s", (_label, data) => {
    expect(isLibiMcpEntryConfigError({ code: -32603, message: "Internal error", data })).toBe(
      false,
    );
  });

  it("does not match an auth rejection, a crash, or a non-error", () => {
    expect(isLibiMcpEntryConfigError({ code: -32000, message: "Authentication required" })).toBe(
      false,
    );
    expect(isLibiMcpEntryConfigError(new Error("Connection closed"))).toBe(false);
    expect(isLibiMcpEntryConfigError(new Error("spawn ENOENT"))).toBe(false);
    expect(isLibiMcpEntryConfigError(null)).toBe(false);
    expect(isLibiMcpEntryConfigError("failed to load configuration")).toBe(false);
  });

  /** Both halves are required — neither alone is specific enough. */
  it("requires the config-load wording AND the frame naming libi's entry", () => {
    expect(isLibiMcpEntryConfigError({ data: "in `mcp_servers.libi` is odd" })).toBe(false);
    expect(isLibiMcpEntryConfigError({ data: "failed to load configuration: nope" })).toBe(false);
  });

  /** A future adapter that stops re-wrapping would put the text in `message`. */
  it("reads the message too, not only data", () => {
    expect(
      isLibiMcpEntryConfigError(
        new Error("failed to load configuration: url is not supported for stdio\nin `mcp_servers.libi`"),
      ),
    ).toBe(true);
  });
});

describe("the fallback entry list", () => {
  it("renames ONLY libi's own entry, keeping its url and surface header", async () => {
    const { getMcpServersForAcp, getMcpServersForAcpFallback, invalidateMcpConfig } =
      await import("@/lib/mcp-config");
    invalidateMcpConfig({ reason: "fallback-test" });

    const normal = getMcpServersForAcp("codex");
    const fallback = getMcpServersForAcpFallback("codex");

    expect(normal.map((e) => e.name)).toContain(LIBI_MCP_ENTRY_NAME);
    expect(fallback.map((e) => e.name)).toContain(LIBI_MCP_FALLBACK_ENTRY_NAME);
    expect(fallback.map((e) => e.name)).not.toContain(LIBI_MCP_ENTRY_NAME);
    expect(fallback).toHaveLength(normal.length);
    // Everything but the name is untouched.
    expect({ ...fallback[0], name: LIBI_MCP_ENTRY_NAME }).toEqual(normal[0]);
    // …and the cached canonical list was not mutated in the process.
    expect(getMcpServersForAcp("codex")[0].name).toBe(LIBI_MCP_ENTRY_NAME);

    invalidateMcpConfig({ reason: "fallback-test-cleanup" });
  });

  /**
   * The whole reason the fallback reuses `libi-app` rather than a fresh string:
   * every tool call in a fallback session arrives with that wire segment, and a
   * null `toolId` there silently blinds the jobs progress bridge, the extension
   * approval gate and the chat's tool labels.
   */
  it("still canonicalizes to libi on the wire", () => {
    expect(fromAnyToolName(`mcp__${LIBI_MCP_FALLBACK_ENTRY_NAME}__libi.list_pieces`)).toBe(
      "libi:libi.list_pieces",
    );
    // Claude Code flattens `-` to `_` in the wire segment.
    expect(
      fromAnyToolName(
        `mcp__${LIBI_MCP_FALLBACK_ENTRY_NAME.replace(/-/g, "_")}__libi_list_pieces`,
      ),
    ).toBe("libi:libi.list_pieces");
  });
});
