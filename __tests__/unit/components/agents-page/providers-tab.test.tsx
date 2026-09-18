// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentStatus } from "@/lib/agents/agent-status";
import {
  commandCarriesNoKeyMaterial,
  providerAddCommand,
  providerRemoveCommand,
  providerReplaceCommand,
  providerSignInCommand,
  type SetupCli,
} from "@/lib/agents/setup/commands";
import { findProvider } from "@/lib/providers/catalog";

/**
 * The Providers tab: one row per third-party provider, one chip per agent, and
 * every action typed into the tab's ONE setup terminal, shown inside the row
 * that opened it. libi never writes an agent's config and never takes a key —
 * each action types a short call to one of libi's setup scripts, and a keyed
 * add's script reads the key at a hidden prompt inside that shell.
 * Every data hook is mocked; the setup terminal host is the real one over a
 * stubbed fetch, so the command a button opens is observable in the POST body.
 */

type ProvidersOpts = { enabled?: boolean; refetchInterval?: number | false };
const providersOpts: ProvidersOpts[] = [];
let connected: unknown[] = [];
let providersError: string | undefined;
let providersCodex: "stale" | "unread" | undefined;
let providersLoading = false;
let legacy: unknown[] = [];
let status: Record<string, AgentStatus> | undefined;
let statusLoading = false;
let flavor: "posix" | "powershell" | undefined;
let scriptsDir: string | undefined;
let scriptsDirError = false;
let scriptsDirErrorValue: Error | undefined;
let visible = true;
let activeProviderId: string | null = "claude-code";
const refetchProviders = vi.fn();
const refreshProviders = vi.fn();
const refetchStatus = vi.fn();
const refetchScriptsDir = vi.fn();
// Counted by a real query under the providers key, so an invalidation (which
// never goes through the mocked `refetch`) is observable as a re-read.
const providersFetches = vi.fn();
const ackLegacy = vi.fn<(rowId: string) => Promise<void>>(async () => undefined);
const toastError = vi.fn();
const trackEvent = vi.fn();

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
}));
vi.mock("@/lib/analytics/client", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));
vi.mock("@/lib/queries/providers", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    providerKeys: { all: ["providers"], legacy: ["providers", "legacy"] },
    useProviders: (o: ProvidersOpts) => {
      providersOpts.push(o);
      useQuery({ queryKey: ["providers"], queryFn: () => (providersFetches(), null), staleTime: Infinity });
      return {
        data: providersLoading ? undefined : { connected, error: providersError, codex: providersCodex },
        isLoading: providersLoading,
        refetch: refetchProviders,
      };
    },
    useRefreshProviders: () => ({ mutate: refreshProviders, isPending: false }),
    useLegacyKeyNotices: () => ({ data: { notices: legacy } }),
    useAcknowledgeLegacyKey: () => ({ mutateAsync: ackLegacy, isPending: false }),
  };
});
vi.mock("@/lib/queries/agent-status", () => ({
  agentStatusKeys: { all: ["agent-status"] },
  useAllAgentStatus: () => ({ data: status, refetch: refetchStatus, isLoading: statusLoading }),
}));
vi.mock("@/hooks/terminal/use-shell-flavor", () => ({
  useShellFlavor: () => ({ data: flavor }),
}));
vi.mock("@/lib/queries/setup-scripts", () => {
  class SetupScriptsUnreachableError extends Error {}
  return {
    SetupScriptsUnreachableError,
    useSetupScriptsDir: () => ({
      data: scriptsDir,
      isError: scriptsDirError,
      error: scriptsDirErrorValue,
      refetch: refetchScriptsDir,
    }),
  };
});
vi.mock("@/hooks/use-document-visible", () => ({ useDocumentVisible: () => visible }));
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ activeProviderId }),
}));
import { followSearch, freshAgentsUrl } from "../../../helpers/agents-page-url";

const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => {
    followSearch(search);
    return { push: vi.fn(), replace, prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() };
  },
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(search),
}));
// Rendered only while the host holds a terminal for the surface, like the real
// one, so "the terminal is shown in THAT row" means something.
vi.mock("@/components/terminal/setup-terminal", async () => {
  const { useSetupTerminalHost } = await import("@/components/agents-page/setup-terminal-host");
  return {
    SetupTerminal: ({ surface }: { surface: "providers" }) => {
      const host = useSetupTerminalHost();
      const entry = host.terminals[surface];
      if (!entry) return null;
      return (
        <div
          data-testid={`setup-terminal-${surface}`}
          data-command={entry.command}
          data-scripts={(entry.scripts ?? []).map((script) => `${script.name}=${script.url}`).join(" ")}
          data-explanation={entry.explanation}
        >
          <button className="cursor-pointer" onClick={() => void host.close(surface)}>
            Close
          </button>
          <button className="cursor-pointer" onClick={() => host.markExited(surface, entry.id, 0)}>
            simulate-exit
          </button>
          <button className="cursor-pointer" onClick={() => host.markGone(surface, entry.id)}>
            simulate-gone
          </button>
        </div>
      );
    },
  };
});

import { AgentChip } from "@/components/agents-page/providers-tab/agent-chip";
import { ProvidersTab } from "@/components/agents-page/providers-tab/providers-tab";
import { SetupTerminalHost } from "@/components/agents-page/setup-terminal-host";
import { providerSetupSteps } from "@/lib/providers/setup-steps";

/** The line under one action that adds Higgsfield and signs in. */
const COMBINED_CAPTION = "One command does both steps: it adds Higgsfield, then opens your browser to sign in, and waits until you finish.";
/** What a step says while its command is live in the tab's terminal. */
const ADD_RUNNING = "Press Enter in the terminal below to run it.";
const SIGN_IN_RUNNING = "Finish signing in in your browser. If it didn't open, or you stopped it, sign in again:";
/** For building a RegExp that matches one of the constants above literally. */
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const fetchMock = vi.fn<typeof fetch>();
let nextId = 1;
let refusePosts = false;
let qc: QueryClient;

function ready(path: string, realPath = path): AgentStatus {
  return {
    agentId: "claude-code",
    cli: { path, realPath, version: "9.9.9", meetsMinimum: true },
    adapter: "ready",
    signIn: { confirmedAt: null, needsAuth: false },
    libiTools: { state: "not-connected" },
    ready: true,
  };
}

function notInstalled(): AgentStatus {
  return {
    agentId: "codex",
    cli: null,
    adapter: "missing",
    signIn: { confirmedAt: null, needsAuth: false },
    libiTools: { state: "not-connected" },
    ready: false,
  };
}

function tabUi(props: { provider: string | null } = { provider: null }) {
  return (
    <QueryClientProvider client={qc}>
      <SetupTerminalHost>
        <ProvidersTab {...props} />
      </SetupTerminalHost>
    </QueryClientProvider>
  );
}

function renderTab(props: { provider: string | null } = { provider: null }) {
  return render(tabUi(props));
}

const AGENT_IDS = ["claude-code", "codex"] as const;

/** Shows one agent's chips the way the user does: its option in the switch at the top of the tab. */
function showAgent(agentId: (typeof AGENT_IDS)[number]) {
  fireEvent.click(screen.getByTestId(`providers-agent-option-${agentId}`));
}

function bothReady() {
  status = { "claude-code": ready("/u/bin/claude"), codex: ready("/u/bin/codex") };
}

function posts() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
}

function lastPostedCommand(): string {
  return (JSON.parse(String(posts().at(-1)![1]!.body)) as { initialInput: string }).initialInput;
}

async function click(row: string, name: RegExp) {
  await act(async () => {
    fireEvent.click(within(screen.getByTestId(`provider-row-${row}`)).getByRole("button", { name }));
  });
}

const CLAUDE_CLI: SetupCli = { agentId: "claude-code", realPath: "/u/bin/claude" };
const CODEX_CLI: SetupCli = { agentId: "codex", realPath: "/u/bin/codex" };
const SCRIPTS = "/opt/libi/lib/agents/setup/scripts";
const linked = (...names: string[]) => names.map((name) => `${name}=/api/agents/setup-scripts/${name}`).join(" ");

beforeEach(() => {
  qc = new QueryClient();
  providersOpts.length = 0;
  connected = [];
  providersError = undefined;
  providersCodex = undefined;
  providersLoading = false;
  legacy = [];
  status = { "claude-code": ready("/u/bin/claude"), codex: notInstalled() };
  statusLoading = false;
  flavor = "posix";
  scriptsDir = SCRIPTS;
  scriptsDirError = false;
  scriptsDirErrorValue = undefined;
  refetchScriptsDir.mockReset();
  visible = true;
  activeProviderId = "claude-code";
  refetchProviders.mockReset();
  refreshProviders.mockReset();
  refetchStatus.mockReset();
  providersFetches.mockReset();
  ackLegacy.mockClear();
  toastError.mockReset();
  trackEvent.mockReset();
  replace.mockReset();
  search = "";
  freshAgentsUrl();
  nextId = 1;
  refusePosts = false;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    if (init?.method === "POST") {
      if (refusePosts) return new Response(JSON.stringify({ error: "too many terminals" }), { status: 429 });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ id: `term-${nextId++}`, purpose: "setup", surface: body.surface, title: "Setup", cliId: "shell", createdAt: 1, status: "running" }),
        { status: 201 },
      );
    }
    if (init?.method === "DELETE") return new Response(JSON.stringify({ success: true }), { status: 200 });
    throw new Error(`unexpected fetch ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("Providers tab — rows and chips", () => {
  it("lists fal.ai, Higgsfield and ElevenLabs only — on-device extensions live on the libi MCP tab", () => {
    renderTab();
    expect(screen.getAllByTestId(/^provider-row-/).map((e) => e.getAttribute("data-testid"))).toEqual([
      "provider-row-fal",
      "provider-row-higgsfield",
      "provider-row-elevenlabs",
    ]);
    expect(screen.queryByTestId("provider-row-ace-step")).not.toBeInTheDocument();
  });

  it("shows one chip per READY agent; a not-ready agent says Set up <Agent> first and links to the Agents tab", () => {
    connected = [{ agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected", scope: "user" }];
    renderTab();
    expect(within(screen.getByTestId("provider-row-fal")).getByTestId("chip-fal-claude-code")).toHaveTextContent("Connected");
    showAgent("codex");
    const fal = screen.getByTestId("provider-row-fal");
    expect(within(fal).getByRole("link", { name: /set up codex first/i })).toHaveAttribute(
      "href",
      "/agents?tab=agents&agent=codex",
    );
  });

  it("says Needs key for a provider whose key is missing, and Not added when nothing is detected", () => {
    bothReady();
    connected = [{ agent: "claude", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "needs-key", scope: "user" }];
    renderTab();
    expect(screen.getByTestId("chip-elevenlabs-claude-code")).toHaveTextContent("Needs key");
    expect(screen.getByTestId("chip-fal-claude-code")).toHaveTextContent("Not added");
    showAgent("codex");
    expect(screen.getByTestId("chip-elevenlabs-codex")).toHaveTextContent("Not added");
  });

  it("a detected MCP libi does not recognise is not listed as a provider", () => {
    bothReady();
    connected = [{ agent: "codex", name: "my-thing", providerId: null, transport: "stdio", status: "connected" }];
    renderTab();
    expect(screen.queryByText("my-thing")).toBeNull();
    expect(screen.getAllByTestId(/^provider-row-/)).toHaveLength(3);
    showAgent("codex");
    expect(screen.queryByText("my-thing")).toBeNull();
    expect(screen.getByTestId("chip-fal-codex")).toHaveTextContent("Not added");
  });

  it("a connected provider offers Remove instead of Add", () => {
    bothReady();
    connected = [{ agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected", scope: "user" }];
    renderTab();
    const chip = screen.getByTestId("chip-fal-claude-code");
    expect(within(chip).queryByRole("button", { name: /add to/i })).toBeNull();
    expect(within(chip).getByRole("button", { name: /remove from claude code/i })).toBeInTheDocument();
  });

  it("a connected provider that takes a key says how to change it — remove, then add again — and nothing else does", () => {
    bothReady();
    connected = [
      { agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected", scope: "user" },
      { agent: "codex", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "connected" },
      { agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected", signIn: "signed-in" },
    ];
    renderTab();
    expect(screen.getByTestId("chip-fal-claude-code-change-key")).toHaveTextContent(
      "Need a new key, or this one stopped working? Remove it from Claude Code, then add it again — Add asks for your key.",
    );
    // Not added yet: there is no key to change.
    expect(screen.queryByTestId("chip-elevenlabs-claude-code-change-key")).toBeNull();
    showAgent("codex");
    expect(screen.getByTestId("chip-elevenlabs-codex-change-key")).toHaveTextContent("Remove it from Codex, then add it again");
    // A provider you sign in to with your account has no key.
    expect(screen.getByTestId("chip-higgsfield-codex")).not.toHaveTextContent(/new key/);
    expect(screen.queryByTestId("chip-higgsfield-codex-change-key")).toBeNull();
  });

  it("a Needs key chip offers Replace and no remove-and-add line", () => {
    bothReady();
    connected = [{ agent: "claude", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "needs-key", scope: "user" }];
    renderTab();
    expect(within(screen.getByTestId("chip-elevenlabs-claude-code")).getByRole("button", { name: "Replace on Claude Code" })).toBeInTheDocument();
    expect(screen.queryByTestId("chip-elevenlabs-claude-code-change-key")).toBeNull();
  });

  it("a Codex entry that is disabled says so, with no action — codex mcp add cannot enable it", () => {
    bothReady();
    connected = [{ agent: "codex", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "disabled" }];
    renderTab();
    showAgent("codex");
    const chip = screen.getByTestId("chip-elevenlabs-codex");
    expect(chip).toHaveTextContent("Disabled");
    expect(chip).toHaveTextContent("Enable it in your Codex config");
    expect(within(chip).queryByRole("button")).toBeNull();
  });

  it("Higgsfield links its MCP docs, says there is no key, and offers Add on both agents", () => {
    bothReady();
    renderTab();
    const row = screen.getByTestId("provider-row-higgsfield");
    expect(within(row).getByRole("link", { name: /docs/i })).toHaveAttribute("href", "https://higgsfield.ai/mcp");
    expect(row).toHaveTextContent(
      "No key: you sign in with your Higgsfield account in your browser, and generations use your Higgsfield credits.",
    );
    expect(row).not.toHaveTextContent(/No MCP server published/);
    expect(within(row).getByRole("button", { name: /add to claude code/i })).toBeInTheDocument();
    showAgent("codex");
    const codexRow = screen.getByTestId("provider-row-higgsfield");
    expect(within(codexRow).getByRole("button", { name: /add to codex/i })).toBeInTheDocument();
    expect(screen.getByTestId("chip-higgsfield-codex")).toHaveTextContent(COMBINED_CAPTION);
    expect(within(codexRow).queryByTestId("setup-terminal-providers")).toBeNull();
  });

  it("shows the Codex note where it describes Codex, and never a desktop-app limitation", () => {
    bothReady();
    renderTab();
    expect(document.body.textContent).not.toMatch(/desktop app/i);
    showAgent("codex");
    expect(screen.getByTestId("provider-row-fal")).toHaveTextContent(
      "Add asks for your key and saves it as FAL_KEY in your shell profile, where Codex reads it. Restart libi and Codex afterwards.",
    );
    expect(screen.getByTestId("provider-row-elevenlabs")).toHaveTextContent(/Needs uv/);
    expect(document.body.textContent).not.toMatch(/desktop app/i);
  });

  it("?provider=elevenlabs shows only that row, highlighted, with Show all providers", () => {
    renderTab({ provider: "elevenlabs" });
    expect(screen.getAllByTestId(/^provider-row-/)).toHaveLength(1);
    expect(screen.getByTestId("provider-row-elevenlabs").className).toMatch(/ring-2/);
    fireEvent.click(screen.getByRole("button", { name: /show all providers/i }));
    expect(screen.getAllByTestId(/^provider-row-/)).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /show all providers/i })).toBeNull();
  });

  it("a ?provider= that names no third-party provider shows every row, unhighlighted", () => {
    renderTab({ provider: "ace-step" });
    expect(screen.getAllByTestId(/^provider-row-/)).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /show all providers/i })).toBeNull();
    for (const row of screen.getAllByTestId(/^provider-row-/)) expect(row.className).not.toMatch(/ring-2/);
  });

  it("shows skeletons while the agent status loads — never 'Loading' text and no rows", () => {
    statusLoading = true;
    const { container } = renderTab();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId(/^provider-row-/)).toHaveLength(0);
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it("shows skeletons while detection has not answered yet", () => {
    providersLoading = true;
    const { container } = renderTab();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId(/^provider-row-/)).toHaveLength(0);
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it("never renders an input that could take a key; every control has cursor-pointer", () => {
    bothReady();
    legacy = [{ rowId: "r1", providerId: "fal", providerName: "fal.ai", command: "c", commands: { claude: "c", codex: "d" } }];
    renderTab({ provider: "fal" });
    for (const agentId of AGENT_IDS) {
      showAgent(agentId);
      expect(document.querySelectorAll("input, textarea")).toHaveLength(0);
      for (const el of [...screen.getAllByRole("button"), ...screen.getAllByRole("link"), ...screen.getAllByRole("tab")]) {
        expect(el.className, `${agentId}: ${el.textContent}`).toContain("cursor-pointer");
      }
    }
  });
});

describe("Providers tab — agent switch", () => {
  const option = (agentId: (typeof AGENT_IDS)[number]) => screen.getByTestId(`providers-agent-option-${agentId}`);
  const chipIdsIn = (row: HTMLElement) =>
    within(row)
      .queryAllByTestId(/^chip-[a-z]+-(claude-code|codex)$/)
      .map((chip) => chip.getAttribute("data-testid"));

  it("is a tablist labelled Set up providers for, with Claude Code and Codex, under the legacy key notice and above the rows, which are its panel", () => {
    legacy = [{ rowId: "r1", providerId: "fal", providerName: "fal.ai", command: "c", commands: { claude: "c", codex: "d" } }];
    renderTab();
    const tablist = screen.getByRole("tablist", { name: "Set up providers for" });
    expect(tablist).toBe(screen.getByTestId("providers-agent-switch"));
    expect(within(tablist).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Claude Code", "Codex"]);
    expect(screen.getByTestId("legacy-key-notices").compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const panel = screen.getByRole("tabpanel");
    expect(panel).toContainElement(screen.getByTestId("provider-row-fal"));
    expect(tablist.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(option("claude-code")).toHaveAttribute("aria-controls", panel.id);
    for (const agentId of AGENT_IDS) expect(option(agentId)).toHaveClass("cursor-pointer");
  });

  it.each([
    ["claude-code", "claude-code"],
    ["codex", "codex"],
    [null, "claude-code"],
  ] as const)("with no setupAgent in the URL, the sidebar's agent (%s) picks the agent shown (%s)", (sidebar, shown) => {
    bothReady();
    activeProviderId = sidebar;
    renderTab();
    expect(option(shown)).toHaveAttribute("aria-selected", "true");
    expect(option(shown === "codex" ? "claude-code" : "codex")).toHaveAttribute("aria-selected", "false");
    for (const id of ["fal", "higgsfield", "elevenlabs"]) {
      expect(chipIdsIn(screen.getByTestId(`provider-row-${id}`))).toEqual([`chip-${id}-${shown}`]);
    }
    // Nothing was picked, so nothing is written.
    expect(replace).not.toHaveBeenCalled();
  });

  it("switching shows only that agent's chip, full width, in every row and writes setupAgent to the URL", () => {
    bothReady();
    renderTab();
    showAgent("codex");
    expect(option("codex")).toHaveAttribute("aria-selected", "true");
    expect(option("claude-code")).toHaveAttribute("aria-selected", "false");
    expect(replace).toHaveBeenCalledWith("/agents?setupAgent=codex", { scroll: false });
    for (const id of ["fal", "higgsfield", "elevenlabs"]) {
      const row = screen.getByTestId(`provider-row-${id}`);
      expect(chipIdsIn(row)).toEqual([`chip-${id}-codex`]);
      // One chip at the row's full width, not a two-column grid.
      expect(row.querySelector('[class*="grid-cols-2"]')).toBeNull();
    }
    showAgent("claude-code");
    expect(replace).toHaveBeenLastCalledWith("/agents?setupAgent=claude-code", { scroll: false });
    expect(chipIdsIn(screen.getByTestId("provider-row-fal"))).toEqual(["chip-fal-claude-code"]);
  });

  it("a deep-linked setupAgent wins over the sidebar's agent, together with ?provider=, and a new one while the tab is open is followed", () => {
    bothReady();
    activeProviderId = "claude-code";
    search = "tab=providers&provider=higgsfield&setupAgent=codex";
    const { rerender } = renderTab({ provider: "higgsfield" });
    expect(option("codex")).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByTestId(/^provider-row-/)).toHaveLength(1);
    expect(chipIdsIn(screen.getByTestId("provider-row-higgsfield"))).toEqual(["chip-higgsfield-codex"]);
    // The user picks Claude Code, the URL follows, then back/forward returns to the link naming Codex.
    showAgent("claude-code");
    expect(replace).toHaveBeenCalledWith("/agents?tab=providers&provider=higgsfield&setupAgent=claude-code", { scroll: false });
    search = "tab=providers&provider=higgsfield&setupAgent=claude-code";
    rerender(tabUi({ provider: "higgsfield" }));
    expect(option("claude-code")).toHaveAttribute("aria-selected", "true");
    search = "tab=providers&provider=higgsfield&setupAgent=codex";
    rerender(tabUi({ provider: "higgsfield" }));
    expect(option("codex")).toHaveAttribute("aria-selected", "true");
    expect(chipIdsIn(screen.getByTestId("provider-row-higgsfield"))).toEqual(["chip-higgsfield-codex"]);
  });

  it("each option counts the providers connected on that agent, and says nothing when none are or detection can't say", () => {
    bothReady();
    connected = [
      { agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected", scope: "user" },
      { agent: "claude", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "connected", scope: "user" },
      // Added, but libi can't see the sign-in: not connected.
      { agent: "claude", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected", signIn: "unknown", scope: "user" },
      { agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected" },
      { agent: "codex", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "needs-key" },
    ];
    const { rerender } = renderTab();
    expect(option("claude-code").textContent).toBe("Claude Code 2 connected");
    expect(option("codex").textContent).toBe("Codex 1 connected");
    // The name and the count are read out apart.
    expect(screen.getByRole("tab", { name: "Codex 1 connected" })).toBe(option("codex"));
    // Codex gave no list: its count is unknown, not zero.
    providersCodex = "unread";
    rerender(tabUi());
    expect(option("codex").textContent).toBe("Codex");
    expect(option("claude-code").textContent).toBe("Claude Code 2 connected");
    // Detection failed: neither can say.
    providersCodex = undefined;
    providersError = "detection failed";
    rerender(tabUi());
    expect(option("claude-code").textContent).toBe("Claude Code");
    expect(option("codex").textContent).toBe("Codex");
    // Nothing connected anywhere.
    providersError = undefined;
    connected = [];
    rerender(tabUi());
    expect(option("claude-code").textContent).toBe("Claude Code");
    expect(option("codex").textContent).toBe("Codex");
  });

  it("a terminal open for the other agent leaves one line where the rows start, and Show <Agent> switches back to it in its row", async () => {
    bothReady();
    renderTab();
    await click("fal", /add to claude code/i);
    expect(within(screen.getByTestId("provider-row-fal")).getByTestId("setup-terminal-providers")).toBeInTheDocument();
    expect(screen.queryByTestId("providers-other-agent-terminal")).toBeNull();

    showAgent("codex");
    expect(screen.queryByTestId("setup-terminal-providers")).toBeNull();
    const line = screen.getByTestId("providers-other-agent-terminal");
    expect(line).toHaveTextContent("Claude Code has a setup command open.");
    expect(screen.getByRole("tabpanel")).toContainElement(line);
    expect(line.compareDocumentPosition(screen.getByTestId("provider-row-fal")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Switching hides the terminal; it never closes it.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    replace.mockClear();
    const show = within(line).getByRole("button", { name: "Show Claude Code" });
    expect(show).toHaveClass("cursor-pointer");
    fireEvent.click(show);
    expect(option("claude-code")).toHaveAttribute("aria-selected", "true");
    expect(replace).toHaveBeenCalledWith("/agents?setupAgent=claude-code", { scroll: false });
    expect(screen.queryByTestId("providers-other-agent-terminal")).toBeNull();
    expect(within(screen.getByTestId("provider-row-fal")).getByTestId("setup-terminal-providers")).toBeInTheDocument();

    // The same the other way round.
    showAgent("codex");
    await click("elevenlabs", /add to codex/i);
    showAgent("claude-code");
    expect(screen.getByTestId("providers-other-agent-terminal")).toHaveTextContent("Codex has a setup command open.");
    fireEvent.click(screen.getByRole("button", { name: "Show Codex" }));
    expect(within(screen.getByTestId("provider-row-elevenlabs")).getByTestId("setup-terminal-providers")).toBeInTheDocument();
  });

  it.each([
    ["simulate-exit", "Claude Code's setup command finished."],
    ["simulate-gone", "Claude Code's setup terminal was closed."],
  ] as const)("once the other agent's terminal ends (%s) its line says %j, and still leads back to its Close", async (ending, text) => {
    bothReady();
    renderTab();
    await click("fal", /add to claude code/i);
    fireEvent.click(screen.getByRole("button", { name: ending }));

    showAgent("codex");
    const line = screen.getByTestId("providers-other-agent-terminal");
    expect(line).toHaveTextContent(text);
    expect(line).not.toHaveTextContent("has a setup command open");
    fireEvent.click(within(line).getByRole("button", { name: "Show Claude Code" }));
    expect(option("claude-code")).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByTestId("provider-row-fal")).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("a chip starts with its state: the agent's name is in the switch above, not repeated in the chip", () => {
    bothReady();
    connected = [{ agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected", scope: "user" }];
    renderTab();
    for (const agentId of AGENT_IDS) {
      showAgent(agentId);
      const name = agentId === "codex" ? "Codex" : "Claude Code";
      for (const id of ["fal", "higgsfield", "elevenlabs"]) {
        const chip = screen.getByTestId(`chip-${id}-${agentId}`);
        expect(within(chip).queryByText(name, { exact: true }), `${id} / ${agentId}`).toBeNull();
      }
    }
    expect(screen.getByTestId("chip-fal-codex").textContent).toMatch(/^Not added/);
    showAgent("claude-code");
    expect(screen.getByTestId("chip-fal-claude-code").textContent).toMatch(/^Connected· user scope/);
    // Its buttons still name the agent they act on.
    expect(within(screen.getByTestId("chip-fal-claude-code")).getByRole("button", { name: "Remove from Claude Code" })).toBeInTheDocument();
  });

  it("a row notice shows only while the agent its command ran for is shown", async () => {
    bothReady();
    const { rerender } = renderTab();
    await click("fal", /add to claude code/i);
    connected = [{ agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected", scope: "user" }];
    rerender(tabUi());
    expect(within(screen.getByTestId("provider-row-fal")).getByTestId("provider-notice-fal")).toHaveTextContent(/start a new chat to use it/i);
    showAgent("codex");
    expect(screen.queryByTestId("provider-notice-fal")).toBeNull();
    expect(screen.getByTestId("chip-fal-codex")).toHaveTextContent("Not added");
    showAgent("claude-code");
    expect(screen.getByTestId("provider-notice-fal")).toHaveTextContent(/start a new chat to use it/i);
  });

  it.each(["unread", "stale"] as const)("Codex's %s listing banner shows only while Codex is shown", (listing) => {
    bothReady();
    providersCodex = listing;
    renderTab();
    expect(screen.queryByTestId(`providers-codex-${listing}`)).toBeNull();
    showAgent("codex");
    expect(screen.getByTestId(`providers-codex-${listing}`)).toBeInTheDocument();
    showAgent("claude-code");
    expect(screen.queryByTestId(`providers-codex-${listing}`)).toBeNull();
  });

  it("the status, detection and scripts errors show whichever agent is shown", () => {
    status = undefined;
    providersError = "detection failed";
    scriptsDir = undefined;
    scriptsDirError = true;
    scriptsDirErrorValue = new Error("libi's provider setup scripts are missing from this install.");
    renderTab();
    for (const agentId of AGENT_IDS) {
      showAgent(agentId);
      for (const testId of ["providers-status-error", "providers-detect-error", "providers-scripts-error"]) {
        expect(screen.getByTestId(testId), `${agentId}: ${testId}`).toBeInTheDocument();
      }
    }
  });

  it("arrow keys move between the options and switch the agent", async () => {
    bothReady();
    renderTab();
    act(() => option("claude-code").focus());
    fireEvent.keyDown(option("claude-code"), { key: "ArrowRight" });
    await waitFor(() => expect(option("codex")).toHaveAttribute("aria-selected", "true"));
    expect(document.activeElement).toBe(option("codex"));
    expect(chipIdsIn(screen.getByTestId("provider-row-fal"))).toEqual(["chip-fal-codex"]);
    expect(replace).toHaveBeenCalledWith("/agents?setupAgent=codex", { scroll: false });
    fireEvent.keyDown(option("codex"), { key: "ArrowLeft" });
    await waitFor(() => expect(option("claude-code")).toHaveAttribute("aria-selected", "true"));
    expect(chipIdsIn(screen.getByTestId("provider-row-fal"))).toEqual(["chip-fal-claude-code"]);
  });
});

describe("Providers tab — reading state that failed", () => {
  it("an agent status that could not be read is not 'Set up <Agent> first': the tab says so and Retry re-reads the status", () => {
    status = undefined;
    renderTab();
    expect(screen.getByTestId("providers-status-error")).toHaveTextContent(/couldn.t read your agents. status/i);
    expect(screen.queryByRole("link", { name: /set up .* first/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add to/i })).toBeNull();
    expect(screen.getByTestId("chip-fal-claude-code")).not.toHaveTextContent("Not added");
    showAgent("codex");
    expect(screen.getByTestId("providers-status-error")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /set up .* first/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add to/i })).toBeNull();
    expect(screen.getByTestId("chip-fal-codex")).not.toHaveTextContent("Not added");
    fireEvent.click(within(screen.getByTestId("providers-status-error")).getByRole("button", { name: /retry/i }));
    expect(refetchStatus).toHaveBeenCalledTimes(1);
    expect(refetchProviders).not.toHaveBeenCalled();
    expect(refreshProviders).not.toHaveBeenCalled();
  });

  it("a detection error is not 'Not added': the tab says so and Retry asks for a fresh detection", () => {
    bothReady();
    providersError = "detection failed";
    renderTab();
    expect(screen.getByTestId("providers-detect-error")).toHaveTextContent(/couldn.t read/i);
    expect(screen.getByTestId("chip-fal-claude-code")).not.toHaveTextContent("Not added");
    expect(screen.queryByRole("button", { name: /add to/i })).toBeNull();
    showAgent("codex");
    expect(screen.getByTestId("providers-detect-error")).toBeInTheDocument();
    expect(screen.getByTestId("chip-fal-codex")).not.toHaveTextContent("Not added");
    expect(screen.queryByRole("button", { name: /add to/i })).toBeNull();
    fireEvent.click(within(screen.getByTestId("providers-detect-error")).getByRole("button", { name: /retry/i }));
    // A fresh read, not a refetch the server could answer from a failure it memoised a moment ago.
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(refetchProviders).not.toHaveBeenCalled();
  });

  it("a Codex listing codex gave no answer to is not 'Not added': Codex's chips say Unknown with no action, the tab says so, Claude's chips are untouched, and Retry asks for a fresh detection", () => {
    bothReady();
    providersCodex = "unread";
    connected = [{ agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected", scope: "user" }];
    renderTab();
    expect(screen.getByTestId("chip-fal-claude-code")).toHaveTextContent("Connected");
    expect(within(screen.getByTestId("chip-elevenlabs-claude-code")).getByRole("button", { name: /add to claude code/i })).toBeEnabled();
    showAgent("codex");
    const notice = screen.getByTestId("providers-codex-unread");
    expect(notice).toHaveTextContent("Couldn't read which MCP servers Codex has: it gave libi no list.");
    expect(screen.queryByTestId("providers-detect-error")).toBeNull();
    for (const id of ["fal", "higgsfield", "elevenlabs"]) {
      const chip = screen.getByTestId(`chip-${id}-codex`);
      expect(chip).toHaveTextContent("Unknown");
      expect(chip).not.toHaveTextContent("Not added");
      expect(chip).not.toHaveTextContent("Connected");
      expect(within(chip).queryByRole("button")).toBeNull();
    }
    fireEvent.click(within(notice).getByRole("button", { name: /retry/i }));
    // A fresh read, not a refetch the server could answer from a failure it memoised a moment ago.
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(refetchProviders).not.toHaveBeenCalled();
  });

  it("Codex rows from codex's last good listing keep that state marked last known, the tab says so, the actions stay, and no row notice rests on them", async () => {
    bothReady();
    providersCodex = "stale";
    connected = [
      { agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "needs-sign-in", stale: true },
      { agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected", scope: "user" },
    ];
    const { rerender } = renderTab();
    // Claude Code's chips are never marked last known.
    expect(screen.getByTestId("chip-fal-claude-code")).toBeInTheDocument();
    expect(screen.queryByTestId("chip-fal-claude-code-stale")).toBeNull();
    showAgent("codex");
    const notice = screen.getByTestId("providers-codex-stale");
    expect(notice).toHaveTextContent("Couldn't re-read Codex's MCP servers just now, so Codex shows the list it gave earlier.");
    const codexChip = screen.getByTestId("chip-higgsfield-codex");
    expect(codexChip).toHaveTextContent("Sign in needed");
    expect(screen.getByTestId("chip-higgsfield-codex-stale")).toHaveTextContent("· last known");
    expect(screen.getByTestId("chip-fal-codex")).toHaveTextContent("Not added");
    expect(screen.getByTestId("chip-fal-codex-stale")).toBeInTheDocument();
    // A last known state keeps its actions: the provider that makes codex slow may be the one to remove.
    expect(within(codexChip).getByRole("button", { name: /remove from codex/i })).toBeEnabled();
    fireEvent.click(within(notice).getByRole("button", { name: /retry/i }));
    // A fresh read, not a refetch the server could answer from a failure it memoised a moment ago.
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(refetchProviders).not.toHaveBeenCalled();

    // What a command just did is never read off a last known state.
    await click("higgsfield", /sign in on codex/i);
    connected = [{ agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected", stale: true }];
    rerender(tabUi());
    expect(screen.queryByTestId("provider-notice-higgsfield")).toBeNull();
    providersCodex = undefined;
    connected = [{ agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected" }];
    rerender(tabUi());
    expect(screen.queryByTestId("providers-codex-stale")).toBeNull();
    expect(within(screen.getByTestId("provider-row-higgsfield")).getByTestId("provider-notice-higgsfield")).toHaveTextContent(
      "Higgsfield is connected. Start a new chat to use it",
    );
  });

  it("a Claude entry detected without its scope offers no Remove or Replace, says the scope couldn't be read, and Retry asks for a fresh detection", () => {
    bothReady();
    connected = [
      { agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected" },
      { agent: "claude", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "needs-key" },
    ];
    renderTab();
    const fal = screen.getByTestId("chip-fal-claude-code");
    expect(fal).toHaveTextContent("Connected");
    expect(fal).toHaveTextContent(/couldn.t read its scope/i);
    expect(within(fal).queryByRole("button", { name: /remove/i })).toBeNull();
    const eleven = screen.getByTestId("chip-elevenlabs-claude-code");
    expect(eleven).toHaveTextContent("Needs key");
    expect(within(eleven).queryByRole("button", { name: /replace/i })).toBeNull();
    fireEvent.click(within(fal).getByRole("button", { name: /retry/i }));
    // A fresh read, not a refetch the server could answer from a failure it memoised a moment ago.
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(refetchProviders).not.toHaveBeenCalled();
  });

  it("disables every action button until the scripts folder is known", () => {
    bothReady();
    scriptsDir = undefined;
    connected = [{ agent: "codex", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "connected" }];
    renderTab();
    for (const agentId of AGENT_IDS) {
      showAgent(agentId);
      const actions = screen.getAllByRole("button", { name: /add to|replace on|remove from/i });
      expect(actions.length, agentId).toBeGreaterThan(0);
      for (const b of actions) expect(b).toBeDisabled();
    }
    // Still being read is not a failure.
    expect(screen.queryByTestId("providers-scripts-error")).toBeNull();
  });

  it("a missing-scripts install says so in one line, the actions stay disabled, and Retry re-reads it", () => {
    bothReady();
    scriptsDir = undefined;
    scriptsDirError = true;
    scriptsDirErrorValue = new Error("libi's provider setup scripts are missing from this install.");
    renderTab();
    for (const agentId of AGENT_IDS) {
      showAgent(agentId);
      expect(screen.getByTestId("providers-scripts-error")).toHaveTextContent(
        "Couldn't find libi's setup scripts. Restart libi; if it keeps happening, reinstall it.",
      );
      const actions = screen.getAllByRole("button", { name: /add to|replace on|remove from/i });
      expect(actions.length, agentId).toBeGreaterThan(0);
      for (const b of actions) expect(b).toBeDisabled();
    }
    fireEvent.click(within(screen.getByTestId("providers-scripts-error")).getByRole("button", { name: /retry/i }));
    expect(refetchScriptsDir).toHaveBeenCalledTimes(1);
    expect(refetchProviders).not.toHaveBeenCalled();
    expect(refetchStatus).not.toHaveBeenCalled();
  });

  it("any other scripts-folder failure (network error, unreachable route) reads differently from a missing install", async () => {
    const { SetupScriptsUnreachableError } = await import("@/lib/queries/setup-scripts");
    bothReady();
    scriptsDir = undefined;
    scriptsDirError = true;
    scriptsDirErrorValue = new SetupScriptsUnreachableError("setup scripts folder fetch failed (503)");
    renderTab();
    for (const agentId of AGENT_IDS) {
      showAgent(agentId);
      expect(screen.getByTestId("providers-scripts-error")).toHaveTextContent(
        "Couldn't reach libi's setup scripts. Try again; if it keeps happening, restart libi.",
      );
      const actions = screen.getAllByRole("button", { name: /add to|replace on|remove from/i });
      expect(actions.length, agentId).toBeGreaterThan(0);
      for (const b of actions) expect(b).toBeDisabled();
    }
    fireEvent.click(within(screen.getByTestId("providers-scripts-error")).getByRole("button", { name: /retry/i }));
    expect(refetchScriptsDir).toHaveBeenCalledTimes(1);
  });

  it("disables every action button until the shell flavor is known", () => {
    bothReady();
    flavor = undefined;
    connected = [{ agent: "codex", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "connected" }];
    renderTab();
    for (const agentId of AGENT_IDS) {
      showAgent(agentId);
      const actions = screen.getAllByRole("button", { name: /add to|replace on|remove from/i });
      expect(actions.length, agentId).toBeGreaterThan(0);
      for (const b of actions) expect(b).toBeDisabled();
    }
  });
});

describe("Providers tab — typed commands", () => {
  it("Add types a short call to add-provider.sh into the tab's terminal, shown inside THAT row, with a link to read the script", async () => {
    bothReady();
    renderTab();
    await click("fal", /add to claude code/i);
    const body = JSON.parse(String(posts().at(-1)![1]!.body)) as { surface: string; purpose: string; initialInput: string };
    expect(body.surface).toBe("providers");
    expect(body.purpose).toBe("setup");
    expect(body.initialInput).toBe(`sh ${SCRIPTS}/add-provider.sh fal claude /u/bin/claude`);
    const terminal = within(screen.getByTestId("provider-row-fal")).getByTestId("setup-terminal-providers");
    expect(terminal).toHaveAttribute("data-scripts", linked("add-provider.sh"));
  });

  it("Add to Codex for fal asks for the key and saves FAL_KEY before the add", async () => {
    bothReady();
    renderTab();
    showAgent("codex");
    await click("fal", /add to codex/i);
    expect(lastPostedCommand()).toBe(providerAddCommand(CODEX_CLI, "posix", findProvider("fal"), SCRIPTS));
    // The script saves the key in a login profile, so the shell's own ZDOTDIR goes with it.
    expect(lastPostedCommand()).toBe(`ZDOTDIR="\${ZDOTDIR-}" sh ${SCRIPTS}/add-provider.sh fal codex /u/bin/codex`);
  });

  it("no typed add carries key material or the <your key> placeholder", async () => {
    bothReady();
    renderTab();
    for (const [agentId, name] of [["claude-code", /add to claude code/i], ["codex", /add to codex/i]] as const) {
      showAgent(agentId);
      for (const row of ["fal", "higgsfield", "elevenlabs"]) {
        await click(row, name);
        expect(lastPostedCommand()).not.toContain("<your key>");
        expect(commandCarriesNoKeyMaterial(lastPostedCommand())).toBe(true);
      }
    }
  });

  it("types the CLI's REAL path, not the path it was found at", async () => {
    status = { "claude-code": ready("/u/bin/claude"), codex: ready("/u/bin/codex", "/opt/codex/1.0/codex") };
    renderTab();
    showAgent("codex");
    await click("elevenlabs", /add to codex/i);
    expect(lastPostedCommand()).toBe(`sh ${SCRIPTS}/add-provider.sh elevenlabs codex /opt/codex/1.0/codex`);
  });

  it("an action on another row moves the ONE terminal to that row", async () => {
    bothReady();
    renderTab();
    showAgent("codex");
    await click("fal", /add to codex/i);
    await click("elevenlabs", /add to codex/i);
    expect(screen.getAllByTestId("setup-terminal-providers")).toHaveLength(1);
    expect(within(screen.getByTestId("provider-row-elevenlabs")).getByTestId("setup-terminal-providers")).toBeInTheDocument();
    expect(within(screen.getByTestId("provider-row-fal")).queryByTestId("setup-terminal-providers")).toBeNull();
  });

  it("Needs key offers Replace (remove, then the keyed add, linking both scripts); Connected offers Remove with the detected scope", async () => {
    bothReady();
    connected = [
      { agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "needs-key", scope: "local" },
      { agent: "codex", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "connected" },
    ];
    renderTab();
    await click("fal", /replace on claude code/i);
    expect(lastPostedCommand()).toBe(
      providerReplaceCommand(CLAUDE_CLI, "posix", findProvider("fal"), { agentId: "claude-code", name: "fal-ai", scope: "local" }, SCRIPTS),
    );
    expect(lastPostedCommand()).toBe(`sh ${SCRIPTS}/replace-provider.sh fal claude /u/bin/claude fal-ai local`);
    expect(screen.getByTestId("setup-terminal-providers")).toHaveAttribute("data-scripts", linked("replace-provider.sh", "add-provider.sh"));
    showAgent("codex");
    await click("elevenlabs", /remove from codex/i);
    expect(lastPostedCommand()).toBe(`sh ${SCRIPTS}/remove-provider.sh elevenlabs codex /u/bin/codex elevenlabs`);
    expect(screen.getByTestId("setup-terminal-providers")).toHaveAttribute("data-scripts", linked("remove-provider.sh"));
    // Removing a connected entry is not a row that flipped to Connected.
    expect(screen.queryByText(/start a new chat to use it/i)).toBeNull();
  });

  it("Remove on a Codex fal entry runs remove-provider.sh, which also clears the saved key line", async () => {
    bothReady();
    connected = [{ agent: "codex", name: "fal-ai", providerId: "fal", transport: "http", status: "connected" }];
    renderTab();
    showAgent("codex");
    await click("fal", /remove from codex/i);
    expect(lastPostedCommand()).toBe(
      providerRemoveCommand(CODEX_CLI, "posix", { agentId: "codex", name: "fal-ai" }, findProvider("fal"), SCRIPTS),
    );
    expect(lastPostedCommand()).toBe(`ZDOTDIR="\${ZDOTDIR-}" sh ${SCRIPTS}/remove-provider.sh fal codex /u/bin/codex fal-ai`);
  });

  it("on PowerShell the same actions run the .ps1 scripts' text in a child powershell, and link those", async () => {
    bothReady();
    flavor = "powershell";
    scriptsDir = "C:\\libi\\lib\\agents\\setup\\scripts";
    connected = [{ agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "needs-key", scope: "user" }];
    renderTab();
    await click("fal", /replace on claude code/i);
    expect(lastPostedCommand()).toBe(
      "powershell -NoProfile -Command \"& ([scriptblock]::Create([IO.File]::ReadAllText('C:\\libi\\lib\\agents\\setup\\scripts\\replace-provider.ps1'))) 'fal' 'claude' '/u/bin/claude' 'fal-ai' 'user' -ScriptsDir 'C:\\libi\\lib\\agents\\setup\\scripts'\"",
    );
    expect(screen.getByTestId("setup-terminal-providers")).toHaveAttribute("data-scripts", linked("replace-provider.ps1", "add-provider.ps1"));
  });

  it("a detected name the command builder refuses toasts instead of opening a terminal", async () => {
    bothReady();
    connected = [{ agent: "codex", name: "fal\u0007ai", providerId: "fal", transport: "http", status: "connected" }];
    renderTab();
    showAgent("codex");
    await click("fal", /remove from codex/i);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(0);
    expect(screen.queryByTestId("setup-terminal-providers")).toBeNull();
  });

  it("reports provider_command_opened with bounded params once the terminal exists, and not for a refused spawn", async () => {
    bothReady();
    renderTab();
    showAgent("codex");
    await click("elevenlabs", /add to codex/i);
    expect(trackEvent).toHaveBeenCalledWith("provider_command_opened", { provider: "elevenlabs", agent: "codex", surface: "providers" });
    trackEvent.mockReset();
    refusePosts = true;
    showAgent("claude-code");
    await click("fal", /add to claude code/i);
    expect(trackEvent).not.toHaveBeenCalledWith("provider_command_opened", expect.anything());
  });

  it("Add Higgsfield types add-provider.sh with no ZDOTDIR — there is no key to save — and says what the sign-in does", async () => {
    bothReady();
    renderTab();
    showAgent("codex");
    await click("higgsfield", /add to codex/i);
    expect(lastPostedCommand()).toBe(`sh ${SCRIPTS}/add-provider.sh higgsfield codex /u/bin/codex`);
    const terminal = within(screen.getByTestId("provider-row-higgsfield")).getByTestId("setup-terminal-providers");
    expect(terminal).toHaveAttribute("data-scripts", linked("add-provider.sh"));
    expect(terminal.getAttribute("data-explanation")).toContain("opens your browser to sign in with your Higgsfield account");
    showAgent("claude-code");
    await click("higgsfield", /add to claude code/i);
    expect(lastPostedCommand()).toBe(`sh ${SCRIPTS}/add-provider.sh higgsfield claude /u/bin/claude`);
  });

  it("a Codex Higgsfield entry codex says is not signed in reads Sign in needed, and Sign in types signin-provider.sh with a link to it", async () => {
    bothReady();
    connected = [{ agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "needs-sign-in" }];
    renderTab();
    showAgent("codex");
    const chip = screen.getByTestId("chip-higgsfield-codex");
    expect(chip).toHaveTextContent("Sign in needed");
    expect(chip).not.toHaveTextContent(/needs key/i);
    expect(within(chip).queryByRole("button", { name: /replace/i })).toBeNull();
    await click("higgsfield", /sign in on codex/i);
    expect(lastPostedCommand()).toBe(
      providerSignInCommand(CODEX_CLI, "posix", { agentId: "codex", name: "higgsfield" }, findProvider("higgsfield"), SCRIPTS),
    );
    expect(lastPostedCommand()).toBe(`sh ${SCRIPTS}/signin-provider.sh higgsfield codex /u/bin/codex higgsfield`);
    const terminal = screen.getByTestId("setup-terminal-providers");
    expect(terminal).toHaveAttribute("data-scripts", linked("signin-provider.sh"));
    expect(terminal).toHaveAttribute(
      "data-explanation",
      "Runs Codex's own MCP sign-in for Higgsfield: your browser opens to sign in with your Higgsfield account, and the command waits until you finish. Codex keeps the sign-in, and libi never sees it. Generations use your Higgsfield credits.",
    );
    expect(commandCarriesNoKeyMaterial(lastPostedCommand())).toBe(true);
  });

  it("a Claude Higgsfield entry reads Added · sign in to use — never Connected, since libi can't see Claude Code's sign-in — and offers Sign in and Remove", async () => {
    bothReady();
    connected = [
      { agent: "claude", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected", signIn: "unknown", scope: "local" },
    ];
    renderTab();
    const chip = screen.getByTestId("chip-higgsfield-claude-code");
    expect(chip).toHaveTextContent("Added · sign in to use");
    expect(chip).not.toHaveTextContent("Connected");
    expect(chip).toHaveTextContent("libi can't see whether Claude Code has signed in to Higgsfield. If you already have, it's ready to use.");
    // The add is done (kept, disabled), Sign in is the step to take, and Remove sits under the steps.
    expect(within(chip).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Added to Claude Code",
      "Sign in on Claude Code",
      "Remove from Claude Code",
    ]);
    expect(within(chip).getByRole("button", { name: "Added to Claude Code" })).toBeDisabled();
    expect(within(chip).getByTestId("setup-step-higgsfield-claude-code-add")).toHaveAttribute("data-status", "done");
    expect(within(chip).getByTestId("setup-step-higgsfield-claude-code-sign-in")).toHaveAttribute("data-status", "current");
    expect(within(chip).getByTestId("setup-step-higgsfield-claude-code-sign-in")).toHaveAttribute("aria-current", "step");
    expect(within(chip).getByTestId("setup-step-higgsfield-claude-code-sign-in")).toHaveTextContent("Then start a new chat.");
    await click("higgsfield", /sign in on claude code/i);
    expect(lastPostedCommand()).toBe(`sh ${SCRIPTS}/signin-provider.sh higgsfield claude /u/bin/claude higgsfield`);
    await click("higgsfield", /remove from claude code/i);
    expect(lastPostedCommand()).toBe(`sh ${SCRIPTS}/remove-provider.sh higgsfield claude /u/bin/claude higgsfield local`);
    expect(screen.getByTestId("setup-terminal-providers")).toHaveAttribute(
      "data-explanation",
      "Signs Claude Code out of Higgsfield first, so the sign-in it stored isn't left behind, then removes the Higgsfield MCP server from Claude Code's local-scope settings, so Claude Code stops using Higgsfield.",
    );
  });

  it("an unfinished Codex sign-in is not a dead end: Sign in needed offers Remove beside Sign in, both keyboard-reachable buttons, and Remove signs out first", async () => {
    bothReady();
    connected = [{ agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "needs-sign-in" }];
    renderTab();
    showAgent("codex");
    const chip = screen.getByTestId("chip-higgsfield-codex");
    const buttons = within(chip).getAllByRole("button");
    // The same design as Claude Code's added state: the add done and kept disabled, then Sign in and Remove.
    expect(buttons.map((b) => b.textContent)).toEqual(["Added to Codex", "Sign in on Codex", "Remove from Codex"]);
    expect(buttons[0]).toBeDisabled();
    for (const button of buttons.slice(1)) {
      expect(button.tagName).toBe("BUTTON");
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute("tabindex", "-1");
      expect(button).toHaveClass("cursor-pointer");
      button.focus();
      expect(document.activeElement).toBe(button);
    }
    await click("higgsfield", /remove from codex/i);
    expect(lastPostedCommand()).toBe(
      providerRemoveCommand(CODEX_CLI, "posix", { agentId: "codex", name: "higgsfield" }, findProvider("higgsfield"), SCRIPTS),
    );
    expect(lastPostedCommand()).toBe(`sh ${SCRIPTS}/remove-provider.sh higgsfield codex /u/bin/codex higgsfield`);
    const terminal = screen.getByTestId("setup-terminal-providers");
    expect(terminal).toHaveAttribute("data-scripts", linked("remove-provider.sh"));
    expect(terminal).toHaveAttribute(
      "data-explanation",
      "Signs Codex out of Higgsfield first, so the sign-in it stored isn't left behind, then removes the Higgsfield MCP server from Codex's config (~/.codex/config.toml), so Codex stops using Higgsfield.",
    );
  });

  it("after an add, a Higgsfield row that still needs a sign-in says so in the chip's sign-in step — no notice under the row, and never that it is connected or ready", async () => {
    bothReady();
    const { rerender } = renderTab();
    await click("higgsfield", /add to claude code/i);
    // Claude Code's add writes the entry at once; libi can't see a sign-in, so detection reads it as unknown.
    connected = [
      { agent: "claude", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected", signIn: "unknown", scope: "user" },
    ];
    rerender(tabUi());
    const row = screen.getByTestId("provider-row-higgsfield");
    expect(within(row).queryByTestId("provider-notice-higgsfield")).toBeNull();
    expect(row).not.toHaveTextContent(/is connected|start a new chat to use it/i);
    // The add's terminal is still open, but the add is done: step 2 is the one to take now.
    const claudeSignIn = screen.getByTestId("setup-step-higgsfield-claude-code-sign-in");
    expect(screen.getByTestId("setup-step-higgsfield-claude-code-add")).toHaveAttribute("data-status", "done");
    expect(claudeSignIn).toHaveAttribute("data-status", "current");
    expect(within(claudeSignIn).getByRole("button", { name: "Sign in on Claude Code" })).toBeEnabled();

    // Codex writes its entry before the browser sign-in finishes; until it does, its add is still finishing the sign-in.
    showAgent("codex");
    await click("higgsfield", /add to codex/i);
    connected = [...connected, { agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "needs-sign-in" }];
    rerender(tabUi());
    expect(within(screen.getByTestId("provider-row-higgsfield")).queryByTestId("provider-notice-higgsfield")).toBeNull();
    expect(screen.getByTestId("setup-step-higgsfield-codex-add")).toHaveAttribute("data-status", "done");
    const codexSignIn = screen.getByTestId("setup-step-higgsfield-codex-sign-in");
    expect(codexSignIn).toHaveAttribute("data-status", "running");
    expect(codexSignIn).toHaveTextContent(SIGN_IN_RUNNING);
    // An interrupted or abandoned browser sign-in is not a dead end: Sign in stays under the line.
    expect(within(codexSignIn).getByRole("button", { name: "Sign in on Codex" })).toBeEnabled();

    // Once Codex reports the sign-in, the same row says it is ready.
    connected = [connected[0], { agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected" }];
    rerender(tabUi());
    expect(within(screen.getByTestId("provider-row-higgsfield")).getByTestId("provider-notice-higgsfield")).toHaveTextContent(
      "Higgsfield is connected. Start a new chat to use it",
    );
  });

  it("a signed-in Codex Higgsfield entry offers Remove and no Sign in; a Sign in stays disabled until the scripts folder is known", async () => {
    bothReady();
    connected = [
      { agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected" },
      { agent: "claude", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected", signIn: "unknown", scope: "user" },
    ];
    scriptsDir = undefined;
    renderTab();
    showAgent("codex");
    const codexChip = screen.getByTestId("chip-higgsfield-codex");
    expect(within(codexChip).queryByRole("button", { name: /sign in/i })).toBeNull();
    expect(within(codexChip).getByRole("button", { name: /remove from codex/i })).toBeDisabled();
    showAgent("claude-code");
    const claudeChip = screen.getByTestId("chip-higgsfield-claude-code");
    expect(within(claudeChip).getByRole("button", { name: /sign in on claude code/i })).toBeDisabled();
    expect(within(claudeChip).getByRole("button", { name: /remove from claude code/i })).toBeDisabled();
  });

  it("on PowerShell, Sign in runs signin-provider.ps1's text in a child powershell, and links it", async () => {
    bothReady();
    flavor = "powershell";
    scriptsDir = "C:\\libi\\lib\\agents\\setup\\scripts";
    connected = [{ agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "needs-sign-in" }];
    renderTab();
    showAgent("codex");
    await click("higgsfield", /sign in on codex/i);
    expect(lastPostedCommand()).toBe(
      "powershell -NoProfile -Command \"& ([scriptblock]::Create([IO.File]::ReadAllText('C:\\libi\\lib\\agents\\setup\\scripts\\signin-provider.ps1'))) 'higgsfield' 'codex' '/u/bin/codex' 'higgsfield'\"",
    );
    expect(screen.getByTestId("setup-terminal-providers")).toHaveAttribute("data-scripts", linked("signin-provider.ps1"));
  });

  it("a Codex entry whose sign-in flips it to Connected while its terminal is open says Start a new chat to use it", async () => {
    bothReady();
    connected = [{ agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "needs-sign-in" }];
    const { rerender } = renderTab();
    showAgent("codex");
    await click("higgsfield", /sign in on codex/i);
    expect(screen.queryByText(/start a new chat to use it/i)).not.toBeInTheDocument();
    connected = [{ agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected" }];
    rerender(tabUi());
    expect(within(screen.getByTestId("provider-row-higgsfield")).getByText(/start a new chat to use it/i)).toBeInTheDocument();
  });

  it("a row that flips to Connected while its terminal is open says Start a new chat to use it", async () => {
    bothReady();
    const { rerender } = renderTab();
    await click("fal", /add to claude code/i);
    expect(screen.queryByText(/start a new chat to use it/i)).not.toBeInTheDocument();
    connected = [{ agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected", scope: "user" }];
    rerender(tabUi());
    expect(within(screen.getByTestId("provider-row-fal")).getByText(/start a new chat to use it/i)).toBeInTheDocument();
  });
});

describe("Providers tab — setup steps", () => {
  const step = (agentId: "claude-code" | "codex", stepId: "add" | "sign-in") =>
    screen.getByTestId(`setup-step-higgsfield-${agentId}-${stepId}`);
  const buttonTexts = (testId: string) => within(screen.getByTestId(testId)).getAllByRole("button").map((b) => b.textContent);

  it("Claude Code not added: step 1 Add is current, step 2 Sign in is shown disabled until step 1 is done, and there is no Remove", async () => {
    bothReady();
    renderTab();
    const add = step("claude-code", "add");
    expect(add).toHaveAttribute("data-status", "current");
    expect(add).toHaveAttribute("aria-current", "step");
    expect(add).toHaveTextContent("Add Higgsfield to Claude Code");
    expect(within(add).getByRole("button", { name: "Add to Claude Code" })).toBeEnabled();
    const signIn = step("claude-code", "sign-in");
    expect(signIn).toHaveAttribute("data-status", "locked");
    expect(signIn).not.toHaveAttribute("aria-current");
    expect(signIn).toHaveTextContent("Sign in with your Higgsfield account");
    const locked = within(signIn).getByRole("button", { name: "Sign in on Claude Code" });
    expect(locked).toBeDisabled();
    expect(locked).toHaveAccessibleDescription("After step 1");
    // A disabled button takes no pointer events, so it never lights up on hover; its wrapper shows the not-allowed cursor.
    expect(locked).not.toHaveClass("disabled:pointer-events-auto");
    expect(locked.parentElement).toHaveClass("cursor-not-allowed");
    expect(within(add).getByRole("button", { name: "Add to Claude Code" }).parentElement).not.toHaveClass("cursor-not-allowed");
    expect(buttonTexts("chip-higgsfield-claude-code")).toEqual(["Add to Claude Code", "Sign in on Claude Code"]);
    // Only steps one action performs together are drawn as one block.
    expect(add).not.toHaveClass("bg-muted/20");
    // The steps are an ordered list, in order.
    expect(add.closest("ol")).toBe(signIn.closest("ol"));
    expect(add.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await click("higgsfield", /^add to claude code$/i);
    expect(lastPostedCommand()).toBe(`sh ${SCRIPTS}/add-provider.sh higgsfield claude /u/bin/claude`);
  });

  it("Codex not added: both steps and ONE action that does both sit in one block, captioned once with what it does, posting the add", async () => {
    bothReady();
    renderTab();
    // A chip whose steps are separate actions draws its connector in the border color.
    expect(step("claude-code", "add").querySelector('[aria-hidden].w-px')).toHaveClass("bg-border");
    expect(step("claude-code", "add").querySelector('[aria-hidden].w-px')).not.toHaveClass("bg-primary");
    showAgent("codex");
    expect(step("codex", "add")).toHaveAttribute("data-status", "current");
    expect(step("codex", "sign-in")).toHaveAttribute("data-status", "current");
    expect(buttonTexts("chip-higgsfield-codex")).toEqual(["Add to Codex and sign in"]);
    const chip = screen.getByTestId("chip-higgsfield-codex");
    expect(within(chip).getAllByText(COMBINED_CAPTION)).toHaveLength(1);
    // One sentence: the catalog's note about Codex's add says the same thing, so it is not shown as well.
    expect(chip).not.toHaveTextContent("Add opens your browser");
    const action = within(chip).getByRole("button", { name: "Add to Codex and sign in" });
    expect(action).toHaveAccessibleDescription(COMBINED_CAPTION);
    // Both steps it performs are drawn as one block, and the action sits at the bottom of it, after both.
    for (const id of ["add", "sign-in"] as const) expect(step("codex", id)).toHaveClass("bg-muted/20");
    // The connector between the block's steps is drawn in the current color; a non-combined chip's is not.
    expect(step("codex", "add").querySelector('[aria-hidden]')).toHaveClass("bg-primary");
    expect(step("codex", "add").closest("ol")).toBe(step("codex", "sign-in").closest("ol"));
    expect(step("codex", "sign-in")).toContainElement(action);
    expect(step("codex", "add").compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(step("codex", "sign-in")).getByText("Sign in with your Higgsfield account").compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await click("higgsfield", /add to codex and sign in/i);
    expect(lastPostedCommand()).toBe(providerAddCommand(CODEX_CLI, "posix", findProvider("higgsfield"), SCRIPTS));
    expect(lastPostedCommand()).toBe(`sh ${SCRIPTS}/add-provider.sh higgsfield codex /u/bin/codex`);
  });

  it("signed in: both steps done with their actions kept disabled, and Remove — for Codex, and for a Claude Code entry that carries its own Authorization header", async () => {
    bothReady();
    connected = [
      { agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected" },
      { agent: "claude", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected", scope: "user" },
    ];
    renderTab();
    for (const [agentId, name] of [["claude-code", "Claude Code"], ["codex", "Codex"]] as const) {
      showAgent(agentId);
      expect(step(agentId, "add")).toHaveAttribute("data-status", "done");
      expect(step(agentId, "sign-in")).toHaveAttribute("data-status", "done");
      const chip = screen.getByTestId(`chip-higgsfield-${agentId}`);
      expect(buttonTexts(`chip-higgsfield-${agentId}`)).toEqual([`Added to ${name}`, `Signed in on ${name}`, `Remove from ${name}`]);
      expect(within(chip).getByRole("button", { name: `Added to ${name}` })).toBeDisabled();
      expect(within(chip).getByRole("button", { name: `Signed in on ${name}` })).toBeDisabled();
      expect(within(chip).getByRole("button", { name: `Remove from ${name}` })).toBeEnabled();
    }
    await click("higgsfield", /remove from codex/i);
    expect(lastPostedCommand()).toBe(`sh ${SCRIPTS}/remove-provider.sh higgsfield codex /u/bin/codex higgsfield`);
  });

  it("a Codex entry switched off in its config: step 1 done, step 2 blocked rather than current and says to enable it, with no sign-in action and no Remove", () => {
    bothReady();
    connected = [{ agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "disabled" }];
    renderTab();
    showAgent("codex");
    expect(screen.getByTestId("chip-higgsfield-codex")).toHaveTextContent("Disabled");
    expect(step("codex", "add")).toHaveAttribute("data-status", "done");
    expect(step("codex", "sign-in")).toHaveAttribute("data-status", "blocked");
    expect(step("codex", "sign-in")).not.toHaveAttribute("aria-current");
    expect(step("codex", "sign-in")).toHaveTextContent("Enable it in your Codex config.");
    expect(within(step("codex", "sign-in")).queryByRole("button")).toBeNull();
    expect(buttonTexts("chip-higgsfield-codex")).toEqual(["Added to Codex"]);
  });

  it("while a chip's command is live in the terminal, the steps it performs say what is left and keep their actions, so a click types the command again", async () => {
    bothReady();
    renderTab();
    await click("higgsfield", /^add to claude code$/i);
    expect(step("claude-code", "add")).toHaveAttribute("data-status", "running");
    expect(step("claude-code", "add")).toHaveTextContent(ADD_RUNNING);
    const claudeAdd = within(step("claude-code", "add")).getByRole("button", { name: "Add to Claude Code" });
    expect(claudeAdd).toBeEnabled();
    expect(claudeAdd).toHaveAccessibleDescription(ADD_RUNNING);
    expect(step("claude-code", "sign-in")).toHaveAttribute("data-status", "locked");
    // Only the chip the terminal is for.
    showAgent("codex");
    expect(step("codex", "add")).toHaveAttribute("data-status", "current");
    expect(screen.getByTestId("chip-higgsfield-codex")).not.toHaveTextContent(ADD_RUNNING);

    await click("higgsfield", /add to codex and sign in/i);
    showAgent("claude-code");
    expect(step("claude-code", "add")).toHaveAttribute("data-status", "current");
    showAgent("codex");
    expect(step("codex", "add")).toHaveAttribute("data-status", "running");
    expect(step("codex", "sign-in")).toHaveAttribute("data-status", "running");
    // Each step says what is left of it; the one action stays under both, to start over if the sign-in didn't open or was stopped.
    expect(step("codex", "add")).toHaveTextContent(ADD_RUNNING);
    expect(step("codex", "sign-in")).toHaveTextContent(SIGN_IN_RUNNING);
    expect(buttonTexts("chip-higgsfield-codex")).toEqual(["Add to Codex and sign in"]);
    const codexAction = within(screen.getByTestId("chip-higgsfield-codex")).getByRole("button", { name: "Add to Codex and sign in" });
    expect(codexAction).toBeEnabled();
    expect(within(step("codex", "sign-in")).getByText(SIGN_IN_RUNNING).compareDocumentPosition(codexAction) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // While its command is live, the running lines of the steps it covers are announced too, not just the caption.
    expect(codexAction).toHaveAccessibleDescription(new RegExp(escapeRegExp(SIGN_IN_RUNNING)));
    expect(codexAction).toHaveAccessibleDescription(new RegExp(escapeRegExp(COMBINED_CAPTION)));
    const before = posts().length;
    await click("higgsfield", /add to codex and sign in/i);
    expect(posts()).toHaveLength(before + 1);
    expect(lastPostedCommand()).toBe(`sh ${SCRIPTS}/add-provider.sh higgsfield codex /u/bin/codex`);

    fireEvent.click(screen.getByRole("button", { name: "simulate-exit" }));
    expect(step("codex", "add")).toHaveAttribute("data-status", "current");
    expect(step("codex", "sign-in")).not.toHaveTextContent(SIGN_IN_RUNNING);
    expect(buttonTexts("chip-higgsfield-codex")).toEqual(["Add to Codex and sign in"]);
  });

  it("an add that failed leaves its terminal open and nothing added: the step still says to run it, and Add stays clickable and types the add again", async () => {
    bothReady();
    const { rerender } = renderTab();
    await click("higgsfield", /^add to claude code$/i);
    const addCommand = `sh ${SCRIPTS}/add-provider.sh higgsfield claude /u/bin/claude`;
    expect(lastPostedCommand()).toBe(addCommand);
    // The script exited with an error: the shell is still live, and detection still finds no entry.
    connected = [];
    rerender(tabUi());
    expect(within(screen.getByTestId("provider-row-higgsfield")).getByTestId("setup-terminal-providers")).toBeInTheDocument();
    expect(screen.getByTestId("chip-higgsfield-claude-code")).toHaveTextContent("Not added");
    expect(step("claude-code", "add")).toHaveAttribute("data-status", "running");
    expect(step("claude-code", "sign-in")).toHaveAttribute("data-status", "locked");
    const add = within(step("claude-code", "add")).getByRole("button", { name: "Add to Claude Code" });
    expect(add).toBeEnabled();
    await click("higgsfield", /^add to claude code$/i);
    expect(posts()).toHaveLength(2);
    expect(posts().map(([, init]) => (JSON.parse(String(init!.body)) as { initialInput: string }).initialInput)).toEqual([addCommand, addCommand]);
    expect(step("claude-code", "add")).toHaveAttribute("data-status", "running");
  });

  it("a Sign in live in the terminal runs step 2, which says to finish in the browser and keeps Sign in to try again; Remove stays reachable", async () => {
    bothReady();
    connected = [
      { agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "needs-sign-in" },
      { agent: "claude", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected", signIn: "unknown", scope: "user" },
    ];
    renderTab();
    showAgent("codex");
    await click("higgsfield", /sign in on codex/i);
    expect(step("codex", "add")).toHaveAttribute("data-status", "done");
    expect(step("codex", "sign-in")).toHaveAttribute("data-status", "running");
    expect(step("codex", "sign-in")).toHaveTextContent(SIGN_IN_RUNNING);
    expect(buttonTexts("chip-higgsfield-codex")).toEqual(["Added to Codex", "Sign in on Codex", "Remove from Codex"]);
    const codexSignIn = within(step("codex", "sign-in")).getByRole("button", { name: "Sign in on Codex" });
    expect(codexSignIn).toBeEnabled();
    expect(codexSignIn).toHaveAccessibleDescription(SIGN_IN_RUNNING);

    // Claude Code's sign-in is one libi never sees finish, so its step keeps Sign in the whole time its terminal is open.
    showAgent("claude-code");
    await click("higgsfield", /sign in on claude code/i);
    const signInCommand = `sh ${SCRIPTS}/signin-provider.sh higgsfield claude /u/bin/claude higgsfield`;
    expect(lastPostedCommand()).toBe(signInCommand);
    expect(step("claude-code", "sign-in")).toHaveAttribute("data-status", "running");
    showAgent("codex");
    expect(step("codex", "sign-in")).toHaveAttribute("data-status", "current");
    showAgent("claude-code");
    expect(step("claude-code", "sign-in")).toHaveTextContent(SIGN_IN_RUNNING);
    await click("higgsfield", /sign in on claude code/i);
    expect(lastPostedCommand()).toBe(signInCommand);
    expect(buttonTexts("chip-higgsfield-claude-code")).toEqual(["Added to Claude Code", "Sign in on Claude Code", "Remove from Claude Code"]);
  });

  it("an add that also signs in for Claude Code is drawn the same way, labelled and captioned from the steps it performs", () => {
    const def = { ...findProvider("higgsfield"), addSignsIn: ["claude"] as const };
    const onAdd = vi.fn();
    const chip = (liveAction: "provider-add" | null) => (
      <AgentChip
        providerId="higgsfield"
        providerName="Higgsfield"
        agentId="claude-code"
        agentName="Claude Code"
        state="not-added"
        actionsEnabled
        steps={providerSetupSteps({ def, agentId: "claude-code", state: "not-added", liveAction })!}
        onAdd={onAdd}
      />
    );
    const { rerender } = render(chip(null));
    const action = screen.getByRole("button", { name: "Add to Claude Code and sign in" });
    expect(screen.getAllByRole("button")).toEqual([action]);
    expect(screen.getAllByText(COMBINED_CAPTION)).toHaveLength(1);
    expect(action).toHaveAccessibleDescription(COMBINED_CAPTION);
    for (const id of ["add", "sign-in"] as const) {
      expect(step("claude-code", id)).toHaveAttribute("data-status", "current");
      expect(step("claude-code", id)).toHaveClass("bg-muted/20");
    }
    fireEvent.click(action);
    expect(onAdd).toHaveBeenCalledTimes(1);

    rerender(chip("provider-add"));
    expect(step("claude-code", "add")).toHaveTextContent(ADD_RUNNING);
    expect(step("claude-code", "sign-in")).toHaveTextContent(SIGN_IN_RUNNING);
    expect(screen.getByRole("button", { name: "Add to Claude Code and sign in" })).toBeEnabled();
  });

  it("a stale Codex chip lists its steps from the last known state and keeps · last known", () => {
    bothReady();
    providersCodex = "stale";
    connected = [{ agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected", stale: true }];
    renderTab();
    showAgent("codex");
    expect(step("codex", "add")).toHaveAttribute("data-status", "done");
    expect(step("codex", "sign-in")).toHaveAttribute("data-status", "done");
    expect(screen.getByTestId("chip-higgsfield-codex-stale")).toHaveTextContent("· last known");
    expect(within(screen.getByTestId("chip-higgsfield-codex")).getByRole("button", { name: "Remove from Codex" })).toBeEnabled();
  });

  it("a chip that claims nothing lists no steps: Set up <Agent> first, and a Claude Code entry whose scope couldn't be read", () => {
    connected = [{ agent: "claude", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected", signIn: "unknown" }];
    renderTab();
    expect(screen.queryAllByTestId(/^setup-step-higgsfield-/)).toHaveLength(0);
    expect(buttonTexts("chip-higgsfield-claude-code")).toEqual(["Retry"]);
    showAgent("codex");
    expect(screen.queryAllByTestId(/^setup-step-higgsfield-/)).toHaveLength(0);
    expect(within(screen.getByTestId("chip-higgsfield-codex")).getByRole("link", { name: /set up codex first/i })).toBeInTheDocument();
  });

  it("an Unknown chip lists no steps", () => {
    bothReady();
    providersCodex = "unread";
    renderTab();
    expect(step("claude-code", "add")).toHaveAttribute("data-status", "current");
    showAgent("codex");
    expect(screen.getByTestId("chip-higgsfield-codex")).toHaveTextContent("Unknown");
    expect(screen.queryAllByTestId(/^setup-step-higgsfield-codex-/)).toHaveLength(0);
  });

  it("single-step providers keep their one action beside the agent's name, with no steps", () => {
    bothReady();
    connected = [{ agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected", scope: "user" }];
    renderTab();
    for (const agentId of AGENT_IDS) {
      showAgent(agentId);
      expect(screen.queryAllByTestId(/^setup-step-(fal|elevenlabs)-/), agentId).toHaveLength(0);
      expect(document.querySelectorAll('[data-testid^="chip-fal-"] ol, [data-testid^="chip-elevenlabs-"] ol'), agentId).toHaveLength(0);
    }
    showAgent("claude-code");
    expect(buttonTexts("chip-fal-claude-code")).toEqual(["Remove from Claude Code"]);
    showAgent("codex");
    expect(buttonTexts("chip-fal-codex")).toEqual(["Add to Codex"]);
    expect(buttonTexts("chip-elevenlabs-codex")).toEqual(["Add to Codex"]);
  });
});

describe("Providers tab — detection polling and refresh", () => {
  it("polls detection every 3 s only while the setup terminal is open, and only while the page is visible", async () => {
    bothReady();
    renderTab();
    expect(providersOpts.at(-1)).toMatchObject({ enabled: true, refetchInterval: false });
    await click("fal", /add to claude code/i);
    expect(providersOpts.at(-1)).toMatchObject({ refetchInterval: 3000 });
  });

  it("stops reading detection while nobody can see the window", () => {
    visible = false;
    renderTab();
    expect(providersOpts.length).toBeGreaterThan(0);
    for (const o of providersOpts) expect(o.enabled).toBe(false);
  });

  it("closing the setup terminal re-reads detection once, after the DELETE", async () => {
    bothReady();
    renderTab();
    await waitFor(() => expect(providersFetches).toHaveBeenCalledTimes(1));
    await click("fal", /add to claude code/i);
    providersFetches.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    });
    expect(screen.queryByTestId("setup-terminal-providers")).not.toBeInTheDocument();
    await waitFor(() => expect(providersFetches).toHaveBeenCalledTimes(1));
    const deleteIndex = fetchMock.mock.calls.findIndex(([, init]) => init?.method === "DELETE");
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(fetchMock.mock.invocationCallOrder[deleteIndex]).toBeLessThan(providersFetches.mock.invocationCallOrder[0]);

    // Once, not a poll, and not a second read from the component.
    await new Promise((r) => setTimeout(r, 50));
    expect(providersFetches).toHaveBeenCalledTimes(1);
    expect(refetchProviders).not.toHaveBeenCalled();
    expect(providersOpts.at(-1)).toMatchObject({ refetchInterval: false });
  });

  it.each(["simulate-exit", "simulate-gone"])(
    "a terminal that ends on its own (%s) re-reads detection once and stops the poll",
    async (ending) => {
      bothReady();
      renderTab();
      await click("fal", /add to claude code/i);
      expect(refetchProviders).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: ending }));
      expect(refetchProviders).toHaveBeenCalledTimes(1);
      expect(providersOpts.at(-1)).toMatchObject({ refetchInterval: false });

      // A second report about the same terminal is not a second ending.
      fireEvent.click(screen.getByRole("button", { name: /simulate-exit/ }));
      fireEvent.click(screen.getByRole("button", { name: /simulate-gone/ }));
      expect(refetchProviders).toHaveBeenCalledTimes(1);
    },
  );
});

describe("Providers tab — legacy key notices", () => {
  const FAL_LEGACY = {
    rowId: "r1",
    providerId: "fal",
    providerName: "fal.ai",
    command: "claude mcp add … sk-test",
    commands: { claude: "claude mcp add … sk-test", codex: "codex mcp add …" },
  };

  it("renders nothing when there is no rescued key", () => {
    renderTab();
    expect(screen.queryByTestId("legacy-key-notices")).toBeNull();
  });

  it("renders legacy key notices at the top, above the rows, with the active agent's command", () => {
    legacy = [FAL_LEGACY];
    renderTab();
    expect(
      screen.getByTestId("legacy-key-notices").compareDocumentPosition(screen.getByTestId("provider-row-fal")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId("command-legacy-r1")).toHaveTextContent("claude mcp add … sk-test");
  });

  it("shows the Codex command for a Codex user", () => {
    activeProviderId = "codex";
    legacy = [FAL_LEGACY];
    renderTab();
    expect(screen.getByTestId("command-legacy-r1")).toHaveTextContent("codex mcp add …");
  });

  it("the notice's command follows the agent picked in the switch", () => {
    legacy = [FAL_LEGACY];
    renderTab();
    expect(screen.getByTestId("command-legacy-r1")).toHaveTextContent("claude mcp add … sk-test");
    showAgent("codex");
    expect(screen.getByTestId("command-legacy-r1")).toHaveTextContent("codex mcp add …");
  });

  it("\"I've copied it\" acknowledges by row id", () => {
    legacy = [FAL_LEGACY];
    renderTab();
    fireEvent.click(within(screen.getByTestId("legacy-key-r1")).getByRole("button", { name: /copied it/i }));
    expect(ackLegacy).toHaveBeenCalledWith("r1");
  });
});

describe("Providers tab — provider_connected is the OBSERVED success, never the click", () => {
  const falOnClaude = { agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected", scope: "user" };

  it("Add, then detection reads the provider connected on that agent → provider_connected once, with the same enums as the opened command", async () => {
    bothReady();
    const { rerender } = renderTab();
    await click("fal", /add to claude code/i);
    // The click itself: the host's own terminal event plus the command event — and no connect yet.
    expect(trackEvent.mock.calls.filter(([name]) => name !== "setup_terminal_opened")).toEqual([
      ["provider_command_opened", { provider: "fal", agent: "claude", surface: "providers" }],
    ]);
    connected = [falOnClaude];
    rerender(tabUi());
    expect(trackEvent).toHaveBeenCalledWith("provider_connected", { provider: "fal", agent: "claude", surface: "providers" });
    // Forgotten once counted: a re-render with the same detection adds nothing.
    rerender(tabUi());
    expect(trackEvent.mock.calls.filter(([name]) => name === "provider_connected")).toHaveLength(1);
  });

  it("the row a libi.suggest_provider link narrowed the tab to reports surface suggestion, on the command and on the connect", async () => {
    bothReady();
    const { rerender } = renderTab({ provider: "fal" });
    await click("fal", /add to claude code/i);
    expect(trackEvent).toHaveBeenCalledWith("provider_command_opened", { provider: "fal", agent: "claude", surface: "suggestion" });
    connected = [falOnClaude];
    rerender(tabUi({ provider: "fal" }));
    expect(trackEvent).toHaveBeenCalledWith("provider_connected", { provider: "fal", agent: "claude", surface: "suggestion" });
  });

  it("a Remove is never waited on: the provider still reading connected afterwards counts nothing", async () => {
    bothReady();
    connected = [falOnClaude];
    const { rerender } = renderTab();
    await click("fal", /remove/i);
    expect(trackEvent).toHaveBeenCalledWith("provider_command_opened", { provider: "fal", agent: "claude", surface: "providers" });
    rerender(tabUi());
    expect(trackEvent).not.toHaveBeenCalledWith("provider_connected", expect.anything());
  });

  it("a Codex last-known (stale) listing that says connected is not the command's doing", async () => {
    bothReady();
    const { rerender } = renderTab();
    showAgent("codex");
    await click("fal", /add to codex/i);
    connected = [{ ...falOnClaude, agent: "codex", scope: undefined }];
    providersCodex = "stale";
    rerender(tabUi());
    expect(trackEvent).not.toHaveBeenCalledWith("provider_connected", expect.anything());
    providersCodex = undefined;
    rerender(tabUi());
    expect(trackEvent).toHaveBeenCalledWith("provider_connected", { provider: "fal", agent: "codex", surface: "providers" });
  });
});
