// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { PermissionOption, ToolCallUpdate } from "@agentclientprotocol/sdk";
import { PermissionRequestCard } from "@/components/chat/permission-request-card";

afterEach(cleanup);

const options: PermissionOption[] = [
  { optionId: "once", name: "Allow", kind: "allow_once" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
];

const card = (title: string, rawInput: unknown, status: "pending" | "resolved" = "pending") =>
  render(
    <PermissionRequestCard
      sessionId="s1"
      pendingId="p1"
      toolCall={{ toolCallId: "t1", title, rawInput } as unknown as ToolCallUpdate}
      options={options}
      reason="acp"
      status={status}
      outcome={status === "resolved" ? { kind: "selected", optionId: "once" } : undefined}
    />,
  );

describe("PermissionRequestCard title", () => {
  it("names the action of a merged libi tool", () => {
    card("mcp__libi__libi_snapshot", { action: "discard", pieceId: "p" });
    expect(screen.getByText("Libi Snapshot · discard")).toBeInTheDocument();
  });

  it("names the target of libi.show and the kind of libi.social_link", () => {
    card("mcp__libi__libi_show", { target: "templates" });
    expect(screen.getByText("Libi Show · templates")).toBeInTheDocument();
    cleanup();
    card("mcp__libi__libi_social_link", { kind: "post" });
    expect(screen.getByText("Libi Social link · post")).toBeInTheDocument();
  });

  it("names the action on the resolved line too", () => {
    card("mcp__libi__libi_piece_folder", { action: "delete" }, "resolved");
    expect(screen.getByText("Libi Piece folder · delete")).toBeInTheDocument();
  });

  it("leaves a tool that is not merged, and a merged call with no action, as before", () => {
    card("mcp__libi__libi_list_pieces", { action: "delete" });
    expect(screen.getByText("Libi List pieces")).toBeInTheDocument();
    cleanup();
    card("mcp__libi__libi_snapshot", { name: "mcp__libi__libi_snapshot" });
    expect(screen.getByText("Libi Snapshot")).toBeInTheDocument();
  });
});

// A Codex request is nameless; the server names it from the call's cached tool_call (title + rawInput with the
// { server, tool, arguments } envelope), so the card reads like Claude's.
describe("PermissionRequestCard title for a Codex call", () => {
  const codexInput = (args: unknown) => ({ server: "libi", tool: "libi.snapshot", arguments: args });

  it("names the action of a merged libi tool", () => {
    card("mcp.libi.libi.snapshot", codexInput({ action: "discard", pieceId: "p", confirm: true }));
    expect(screen.getByText("Libi Snapshot · discard")).toBeInTheDocument();
  });

  it("names an unmerged tool, and the resolved line too", () => {
    card("mcp.libi.libi.get_piece_state", { server: "libi", tool: "libi.get_piece_state", arguments: { pieceId: "p" } });
    expect(screen.getByText("Libi Get piece state")).toBeInTheDocument();
    cleanup();
    card("mcp.libi.libi.snapshot", codexInput({ action: "compare" }), "resolved");
    expect(screen.getByText("Libi Snapshot · compare")).toBeInTheDocument();
  });

  it("still says 'Permission required' when the request could not be named", () => {
    render(
      <PermissionRequestCard
        sessionId="s1"
        pendingId="p1"
        toolCall={{ toolCallId: "t1", kind: "execute" } as unknown as ToolCallUpdate}
        options={options}
        reason="acp"
        status="pending"
      />,
    );
    expect(screen.getByText("Permission required")).toBeInTheDocument();
  });
});
