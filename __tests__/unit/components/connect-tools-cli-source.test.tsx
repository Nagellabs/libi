// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CodexConnectState } from "@/lib/queries/codex-connect";

/**
 * The Codex row used to collapse three different situations into one grey
 * "Not installed" chip, and offered Install whenever a `which codex` probe run
 * in the SERVER's environment said yes — which, under `npm run dev`, it does
 * for the `codex` shim npm puts in `<repo>/node_modules/.bin`. So a user with
 * no codex of their own clicked Install, was told it succeeded, and got libi's
 * MCP config written into a binary they can never invoke.
 *
 * Install is now gated on `cliSource === "user"` and nothing else.
 */

let state: CodexConnectState;
let setConnectError: Error | null = null;
const setConnectMutate = vi.fn();
const createTerminalMutate = vi.fn();

vi.mock("@/lib/queries/codex-connect", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/codex-connect")>()),
  useCodexConnect: () => ({ data: state, isLoading: false }),
  useSetCodexConnect: () => ({
    mutate: setConnectMutate,
    isPending: false,
    error: setConnectError,
  }),
}));

vi.mock("@/lib/queries/terminals", () => ({
  useCreateTerminal: () => ({ mutateAsync: createTerminalMutate, isPending: false }),
}));

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ selectAgent: vi.fn(), setActiveTerminalId: vi.fn() }),
}));

// `usePathname` is needed because the remedy action now goes through the
// shared `useRunRemedyInTerminal` hook rather than a copy local to this
// component (hooks/agents/use-run-remedy-in-terminal.ts).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/mcps-skills",
}));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/shell/client", () => ({ revealFile: vi.fn() }));
vi.mock("@/lib/analytics/client", () => ({ trackEvent: vi.fn() }));

vi.mock("@/components/ui/tooltip", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Tooltip: Pass,
    TooltipProvider: Pass,
    TooltipContent: () => null,
    TooltipTrigger: ({
      children,
      render,
    }: {
      children?: React.ReactNode;
      render?: React.ReactNode;
    }) => <div>{render ?? children}</div>,
  };
});

const { ConnectToolsSection } = await import(
  "@/components/mcps-skills/connect-tools-section"
);

const INSTALL_REMEDY = {
  label: "Install the Codex CLI",
  command: "npm i -g @openai/codex",
  detail: "Installs Codex on your PATH.",
};

function base(overrides: Partial<CodexConnectState>): CodexConnectState {
  return {
    available: false,
    installed: false,
    status: "idle",
    cliSource: "none",
    remedy: null,
    libiEntriesPresent: false,
    codexHome: "/home/u/.codex",
    configPath: "/home/u/.codex/config.toml",
    configExists: false,
    ...overrides,
  };
}

describe("ConnectToolsSection — the three codex CLI states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConnectError = null;
  });

  it("no codex anywhere: says so, and offers the install remedy — not Install", () => {
    state = base({ cliSource: "none", remedy: INSTALL_REMEDY });
    render(<ConnectToolsSection />);

    expect(screen.getByText("Codex not installed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Install the Codex CLI/ }),
    ).toBeInTheDocument();
  });

  it("only libi's bundled codex reads the same as none, and still never offers Install", () => {
    state = base({
      cliSource: "libi-internal",
      remedy: INSTALL_REMEDY,
      // The old probe reported `available: true` for exactly this case — a
      // codex that exists only inside libi's own node_modules.
      available: true,
    });
    render(<ConnectToolsSection />);

    // `libi-internal` vs `none` matters to the PROBE (it is why we refuse to
    // write config) but not to the person: either way they have no codex of
    // their own. One chip, one short line.
    expect(screen.getByText("Codex not installed")).toBeInTheDocument();
    // THE regression this test exists for.
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("keeps the explanation to one short line", () => {
    // Long copy does not get read. The state this used to narrate at length —
    // "an earlier build of libi registered tools against its own bundled
    // codex" — cannot happen any more, because Install is refused unless the
    // user has a codex of their own.
    state = base({ cliSource: "libi-internal", remedy: INSTALL_REMEDY });
    render(<ConnectToolsSection />);

    expect(document.body.textContent).toContain(
      "Install the Codex CLI to use libi's tools in your own terminal.",
    );
    expect(document.body.textContent).not.toContain("an earlier version of libi");
    expect(document.body.textContent).not.toContain("Entries left behind");
  });

  it("the user's own codex, libi not registered: offers Install", () => {
    state = base({ cliSource: "user", available: true, installed: false });
    render(<ConnectToolsSection />);

    expect(screen.getByText("Not registered")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install" })).toBeEnabled();
  });

  it("the user's own codex, libi registered: offers Uninstall", () => {
    state = base({ cliSource: "user", available: true, installed: true });
    render(<ConnectToolsSection />);

    expect(screen.getByText("Registered")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeEnabled();
  });

  it("falls back to the pre-cliSource response shape without claiming 'none'", () => {
    state = base({ cliSource: undefined, available: true, installed: false });
    render(<ConnectToolsSection />);
    expect(screen.getByText("Not registered")).toBeInTheDocument();
  });
});

/**
 * A refusal from the server still has to be readable. There is no longer any
 * "entries left behind" UI — that was migration surface for a bug that can no
 * longer occur, since Install is refused unless the user has their own codex —
 * but if the server ever declines a request, the reason must reach the screen
 * rather than vanish into a toast.
 */
describe("ConnectToolsSection — server refusals stay visible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConnectError = null;
  });

  it("renders the refusal text instead of a fake success", () => {
    state = base({ cliSource: "none", remedy: INSTALL_REMEDY });
    setConnectError = new Error(
      "libi can't remove its entries automatically — there is no codex CLI on this machine to run `codex mcp remove` with. Delete the [mcp_servers.libi] block from /home/u/.codex/config.toml by hand.",
    );
    render(<ConnectToolsSection />);

    expect(document.body.textContent).toContain("/home/u/.codex/config.toml");
    expect(document.body.textContent).toContain("[mcp_servers.libi]");
  });
});
