// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/lib/queries/mcp-servers", () => ({
  useCreateMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AddMcpDialog } from "@/components/settings/add-mcp-dialog";
import type { McpServerUI } from "@/lib/queries/mcp-servers";

/**
 * The form re-seeds whenever the dialog opens or the edited server changes —
 * now a render-time previous-state adjustment instead of an effect. These
 * tests pin the seeding in edit mode and the reset back to create mode.
 */

const editServer = {
  id: "srv1",
  name: "my-server",
  type: "stdio",
  command: "npx",
  args: JSON.stringify(["-y", "some-mcp"]),
  url: null,
  requireApproval: false,
} as unknown as McpServerUI;

describe("AddMcpDialog", () => {
  it("seeds the form from the edited server", () => {
    render(<AddMcpDialog open onOpenChange={() => {}} editServer={editServer} />);
    expect(screen.getByDisplayValue("my-server")).toBeInTheDocument();
    expect(screen.getByDisplayValue("npx")).toBeInTheDocument();
    expect(screen.getByDisplayValue("-y some-mcp")).toBeInTheDocument();
  });

  it("re-seeds when reopened for a different mode (edit → create)", () => {
    const { rerender } = render(
      <AddMcpDialog open onOpenChange={() => {}} editServer={editServer} />,
    );
    expect(screen.getByDisplayValue("my-server")).toBeInTheDocument();

    rerender(<AddMcpDialog open={false} onOpenChange={() => {}} editServer={null} />);
    rerender(<AddMcpDialog open onOpenChange={() => {}} editServer={null} />);
    expect(screen.queryByDisplayValue("my-server")).not.toBeInTheDocument();
  });
});
