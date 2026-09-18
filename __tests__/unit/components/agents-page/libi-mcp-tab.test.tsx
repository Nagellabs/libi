// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentStatus } from "@/lib/agents/agent-status";
import type { McpHealth } from "@/lib/queries/mcp-health";

/**
 * The Libi MCP tab (endpoint card, active sessions, extensions) and the Global
 * setup tab (a Claude Code | Codex switch over one list for the selected agent
 * — every action types a command into the tab's setup terminal, libi never
 * writes an agent's config — and the small print),
 * rendered side by side so the shared data mocks drive both.
 * Every data hook is mocked; the setup terminal host is the real one, over a
 * stubbed fetch, so the command a button opens is observable in the POST body.
 */

import type { SkillInstallView, SkillInstallsResponse } from "@/lib/agents/skill-installs-types";

let health: McpHealth | undefined;
let healthLoading = false;
let registration: Record<string, { state: string; scope?: "user" | "local"; url?: string; stale?: true }> | undefined;
let registrationLoading = false;
let status: Record<string, AgentStatus> | undefined;
let statusLoading = false;
let flavor: "posix" | "powershell" | undefined;
const restartMutate = vi.fn();
const refetchRegistration = vi.fn();
const refreshRegistration = vi.fn();
const refetchStatus = vi.fn();
const registrationOpts = vi.fn();
// Counted by a real query under each hook's real key, so an invalidation (which
// never goes through the mocked `refetch`) is observable as a re-read.
const registrationFetches = vi.fn();
const statusFetches = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
let installs: SkillInstallsResponse | undefined;
let installsLoading = false;
let installsFetching = false;
const refetchInstalls = vi.fn();
let addPending = false;
let removePending = false;
const addInstall = vi.fn<(v: unknown) => Promise<SkillInstallView>>();
const removeInstall = vi.fn<(id: string) => Promise<{ removed: number }>>();
const installsQueryOpts = vi.fn();
vi.mock("@/lib/queries/skill-installs", async (orig) => {
  const actual = await orig<typeof import("@/lib/queries/skill-installs")>();
  return {
    ...actual,
    useSkillInstalls: (opts: unknown) => {
      installsQueryOpts(opts);
      return { data: installs, isLoading: installsLoading, isFetching: installsFetching, refetch: refetchInstalls };
    },
    useAddSkillInstall: () => ({ mutateAsync: addInstall, isPending: addPending }),
    useRemoveSkillInstall: () => ({ mutateAsync: removeInstall, isPending: removePending }),
  };
});
type PickResult = { status: "picked"; path: string } | { status: "cancelled" } | { status: "unavailable"; reason: string } | { status: "busy" };
let pickResult: PickResult = { status: "cancelled" };
// Overridden by tests that need to control exactly when the dialog "resolves"
// (e.g. a pick that comes back after the user has already cancelled).
let pickFolderImpl: (() => Promise<PickResult>) | null = null;
vi.mock("@/lib/shell/client", () => ({ pickFolder: async () => (pickFolderImpl ? pickFolderImpl() : pickResult) }));

function install(over: Partial<SkillInstallView>): SkillInstallView {
  return { id: "i1", agentId: "claude-code", scope: "folder", path: "/p/.claude/skills", folderPath: "/p", source: "ui", status: "up-to-date", error: null, skippedNames: [], installedCount: 3, lastSyncedAt: null, ...over };
}

vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));
vi.mock("@/lib/analytics/client", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/queries/mcp-health", () => ({
  mcpHealthKeys: { all: ["mcp-health"] },
  useMcpHealth: () => ({ data: health, isLoading: healthLoading }),
  useMcpSessions: () => ({ data: health, isLoading: healthLoading }),
}));
vi.mock("@/lib/queries/mcp-restart", () => ({
  useRestartMcpEndpoint: () => ({ mutate: restartMutate, isPending: false }),
}));
vi.mock("@/lib/queries/libi-registration", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    libiRegistrationKeys: { all: ["libi-registration"] },
    useLibiRegistration: (opts: unknown) => {
      registrationOpts(opts);
      useQuery({ queryKey: ["libi-registration"], queryFn: () => (registrationFetches(), null), staleTime: Infinity });
      return { data: registration, refetch: refetchRegistration, isLoading: registrationLoading };
    },
    useRefreshLibiRegistration: () => ({ mutate: refreshRegistration, isPending: false }),
  };
});
vi.mock("@/lib/queries/agent-status", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    agentStatusKeys: { all: ["agent-status"] },
    useAllAgentStatus: () => {
      useQuery({ queryKey: ["agent-status"], queryFn: () => (statusFetches(), null), staleTime: Infinity });
      return { data: status, refetch: refetchStatus, isLoading: statusLoading };
    },
  };
});
vi.mock("@/hooks/terminal/use-shell-flavor", () => ({
  useShellFlavor: () => ({ data: flavor }),
}));
vi.mock("@/components/agents-page/mcp-servers-view", () => ({
  McpServersView: () => <div data-testid="extensions" />,
}));
// Rendered only while the host holds a terminal for the surface, like the real
// one, with its Close button and the two ways a live view reports an ending.
vi.mock("@/components/terminal/setup-terminal", async () => {
  const { useSetupTerminalHost } = await import("@/components/agents-page/setup-terminal-host");
  return {
    SetupTerminal: ({ surface }: { surface: "global-setup" }) => {
      const host = useSetupTerminalHost();
      const entry = host.terminals[surface];
      if (!entry) return null;
      return (
        <div data-testid={`setup-terminal-${surface}`} data-command={entry.command}>
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
vi.mock("@/hooks/use-document-visible", () => ({ useDocumentVisible: () => true }));
// The agent the setup tabs show defaults to the sidebar's, and a pick is written to the URL.
let activeProviderId: string | null = "claude-code";
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
// Just enough for the Providers tab to render, to show the two setup tabs share one selection.
vi.mock("@/lib/queries/providers", () => ({
  providerKeys: { all: ["providers"], legacy: ["providers", "legacy"] },
  useProviders: () => ({ data: { connected: [] }, isLoading: false, refetch: vi.fn() }),
  useRefreshProviders: () => ({ mutate: vi.fn(), isPending: false }),
  useLegacyKeyNotices: () => ({ data: { notices: [] } }),
  useAcknowledgeLegacyKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/setup-scripts", () => ({
  SetupScriptsUnreachableError: class extends Error {},
  useSetupScriptsDir: () => ({ data: "/scripts", isError: false, error: undefined, refetch: vi.fn() }),
}));
const setPendingMcpScroll = vi.fn();
vi.mock("@/lib/mcp-scroll-intent", async (orig) => ({
  ...(await orig<typeof import("@/lib/mcp-scroll-intent")>()),
  setPendingMcpScroll: (...a: unknown[]) => setPendingMcpScroll(...a),
}));

import { LibiMcpTab } from "@/components/agents-page/libi-mcp-tab/libi-mcp-tab";
import { trackEvent } from "@/lib/analytics/client";
import { GlobalSetupTab } from "@/components/agents-page/global-setup-tab/global-setup-tab";
import { ProvidersTab } from "@/components/agents-page/providers-tab/providers-tab";
import { SetupTerminalHost, useSetupTerminalHost } from "@/components/agents-page/setup-terminal-host";
import { MCP_SCROLL_EVENT } from "@/lib/mcp-scroll-intent";

const AGENT_IDS = ["claude-code", "codex"] as const;

/** Shows one agent's list the way the user does: its option in the switch at the top of the tab. */
function showAgent(agentId: (typeof AGENT_IDS)[number]) {
  fireEvent.click(screen.getByTestId(`global-setup-agent-option-${agentId}`));
}

const option = (agentId: (typeof AGENT_IDS)[number]) => screen.getByTestId(`global-setup-agent-option-${agentId}`);

const fetchMock = vi.fn<typeof fetch>();
let nextId = 1;
let scrollEvents: string[] = [];
const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>(async () => undefined) };

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

function renderTab({ extension = null }: { extension?: string | null } = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SetupTerminalHost>
        <LibiMcpTab extension={extension} />
        <GlobalSetupTab />
      </SetupTerminalHost>
    </QueryClientProvider>,
  );
}

const onScroll = (e: Event) => scrollEvents.push((e as CustomEvent<{ mcpId: string }>).detail.mcpId);

beforeEach(() => {
  health = { ok: true, url: "http://127.0.0.1:3457/mcp", childStatus: "running", version: "1.2.3", port: 3457, sessions: 0 };
  healthLoading = false;
  registration = { "claude-code": { state: "not-connected" }, codex: { state: "not-connected" } };
  registrationLoading = false;
  status = { "claude-code": ready("/u/bin/claude"), codex: notInstalled() };
  statusLoading = false;
  flavor = "posix";
  activeProviderId = "claude-code";
  search = "";
  freshAgentsUrl();
  replace.mockReset();
  restartMutate.mockReset();
  refetchRegistration.mockReset();
  refreshRegistration.mockReset();
  refetchStatus.mockReset();
  registrationOpts.mockReset();
  registrationFetches.mockReset();
  statusFetches.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  setPendingMcpScroll.mockReset();
  clipboard.writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  scrollEvents = [];
  window.removeEventListener(MCP_SCROLL_EVENT, onScroll);
  window.addEventListener(MCP_SCROLL_EVENT, onScroll);
  nextId = 1;
  installs = { installs: [], userSkillsDirs: { "claude-code": "~/.claude/skills", codex: "~/.agents/skills" } };
  installsLoading = false;
  installsFetching = false;
  refetchInstalls.mockReset();
  addPending = false;
  removePending = false;
  addInstall.mockReset();
  addInstall.mockResolvedValue(install({ id: "new" }));
  removeInstall.mockReset();
  removeInstall.mockResolvedValue({ removed: 3 });
  installsQueryOpts.mockReset();
  pickResult = { status: "cancelled" };
  pickFolderImpl = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    if (init?.method === "POST") {
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

function lastPostedCommand(): string {
  const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
  return (JSON.parse(String(posts.at(-1)![1]!.body)) as { initialInput: string }).initialInput;
}

describe("libi MCP tab — endpoint card", () => {
  it("shows the URL, the version and the status WORD next to the dot", () => {
    renderTab();
    expect(screen.getByText("http://127.0.0.1:3457/mcp")).toBeInTheDocument();
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    expect(screen.getByTestId("endpoint-status")).toHaveTextContent("Running");
  });

  it.each([
    ["restarting", "Restarting"],
    ["stopped", "Stopped"],
    ["gave-up", "Gave up"],
  ] as const)("says %s as %s", (s, word) => {
    health = { ok: s === "restarting", url: "u", childStatus: s, port: 3457 };
    renderTab();
    expect(screen.getByTestId("endpoint-status")).toHaveTextContent(word);
  });

  it("says Unreachable when the child runs but the endpoint does not answer", () => {
    health = { ok: false, url: "u", childStatus: "running", error: "ECONNREFUSED" };
    renderTab();
    expect(screen.getByTestId("endpoint-status")).toHaveTextContent("Unreachable");
  });

  it("Restart asks first, with the measured copy about open chats, then calls the mutation", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /^restart$/i }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Open chats keep working — their next libi tool call reconnects on its own.");
    // Both agents behave the same, so the sentence is not prefixed per agent.
    expect(dialog).not.toHaveTextContent(/Claude Code:|Codex:/);
    expect(restartMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /restart now/i }));
    expect(restartMutate).toHaveBeenCalledTimes(1);
  });

  it("disables Restart while the endpoint is already restarting", () => {
    health = { ok: true, url: "u", childStatus: "restarting", port: 3457 };
    renderTab();
    expect(screen.getByRole("button", { name: /^restart$/i })).toBeDisabled();
  });

  it("toasts the route's error when a restart fails", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /^restart$/i }));
    fireEvent.click(screen.getByRole("button", { name: /restart now/i }));
    const [, options] = restartMutate.mock.calls[0] as [unknown, { onError?: (err: Error) => void }];
    options.onError?.(new Error("the endpoint is already restarting"));
    expect(toastError).toHaveBeenCalledWith("the endpoint is already restarting");
  });
});

describe("libi MCP tab — connected agents", () => {
  it("renders one row per agent with its state and the right action", () => {
    registration = {
      "claude-code": { state: "connected", scope: "local" },
      codex: { state: "stale-port", url: "http://127.0.0.1:3400/mcp?agent=codex" },
    };
    status = { "claude-code": ready("/u/bin/claude"), codex: ready("/u/bin/codex") };
    renderTab();
    const claude = screen.getByTestId("libi-agent-row-claude-code");
    expect(claude).toHaveTextContent("Connected");
    expect(within(claude).getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
    showAgent("codex");
    const codex = screen.getByTestId("libi-agent-row-codex");
    expect(codex).toHaveTextContent("Connected to an old port");
    expect(within(codex).getByRole("button", { name: /reconnect/i })).toBeInTheDocument();
  });

  it("Not connected → Connect types the connect command into the tab's setup terminal", async () => {
    renderTab();
    expect(screen.queryByTestId("setup-terminal-global-setup")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("libi-agent-row-claude-code")).getByRole("button", { name: /^connect$/i }));
    });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({
      purpose: "setup",
      surface: "global-setup",
      initialInput: "/u/bin/claude mcp add --scope user --transport http libi http://127.0.0.1:3457/mcp",
    });
    expect(screen.getByTestId("setup-terminal-global-setup")).toBeInTheDocument();
  });

  it("opens the setup terminal under the Tools section of the agent whose button was pressed", async () => {
    registration = {
      "claude-code": { state: "connected", scope: "local" },
      codex: { state: "stale-port", url: "http://127.0.0.1:3400/mcp?agent=codex" },
    };
    status = { "claude-code": ready("/u/bin/claude"), codex: ready("/u/bin/codex") };
    renderTab();
    const claudeTools = () => within(screen.getByRole("region", { name: "Claude Code tools" }));
    const codexTools = () => within(screen.getByRole("region", { name: "Codex tools" }));
    expect(claudeTools().getByTestId("libi-agent-row-claude-code")).toHaveTextContent("Libi MCP");
    expect(within(screen.getByRole("region", { name: "Claude Code skills" })).getByTestId("skills-user-row-claude-code")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(screen.getByTestId("libi-agent-row-claude-code")).getByRole("button", { name: /disconnect/i }));
    });
    expect(claudeTools().getByTestId("setup-terminal-global-setup")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Claude Code skills" })).queryByTestId("setup-terminal-global-setup")).toBeNull();

    showAgent("codex");
    expect(codexTools().getByTestId("libi-agent-row-codex")).toHaveTextContent("Libi MCP");
    expect(within(screen.getByRole("region", { name: "Codex skills" })).getByTestId("skills-user-row-codex")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-terminal-global-setup")).toBeNull();
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("libi-agent-row-codex")).getByRole("button", { name: /reconnect/i }));
    });
    expect(codexTools().getByTestId("setup-terminal-global-setup")).toBeInTheDocument();
    expect(screen.getAllByTestId("setup-terminal-global-setup")).toHaveLength(1);

    showAgent("claude-code");
    expect(claudeTools().queryByTestId("setup-terminal-global-setup")).toBeNull();
    expect(screen.getByTestId("global-setup-other-agent-terminal")).toHaveTextContent("Codex has a setup command open.");
  });

  it("Disconnect on Claude names the DETECTED scope; Reconnect chains remove and add against the CURRENT endpoint", async () => {
    registration = {
      "claude-code": { state: "connected", scope: "local" },
      codex: { state: "stale-port", url: "http://127.0.0.1:3400/mcp?agent=codex" },
    };
    status = { "claude-code": ready("/u/bin/claude"), codex: ready("/u/bin/codex") };
    renderTab();
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("libi-agent-row-claude-code")).getByRole("button", { name: /disconnect/i }));
    });
    expect(lastPostedCommand()).toBe("/u/bin/claude mcp remove --scope local libi");
    showAgent("codex");
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("libi-agent-row-codex")).getByRole("button", { name: /reconnect/i }));
    });
    // Never the stale saved URL, and `?agent=codex` appears exactly once.
    expect(lastPostedCommand()).toBe(
      "/u/bin/codex mcp remove libi && { /u/bin/codex mcp add libi --url 'http://127.0.0.1:3457/mcp?agent=codex'; }",
    );
  });

  it("Reconnect on a Claude entry found in the local scope removes it from that scope", async () => {
    registration = { "claude-code": { state: "stale-port", scope: "local" }, codex: { state: "not-connected" } };
    renderTab();
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("libi-agent-row-claude-code")).getByRole("button", { name: /reconnect/i }));
    });
    expect(lastPostedCommand()).toBe(
      "/u/bin/claude mcp remove --scope local libi && { /u/bin/claude mcp add --scope user --transport http libi http://127.0.0.1:3457/mcp; }",
    );
  });

  it("a Claude registration with no detected scope is treated as unreadable: Retry, no Disconnect", () => {
    registration = { "claude-code": { state: "connected" }, codex: { state: "not-connected" } };
    renderTab();
    const claude = screen.getByTestId("libi-agent-row-claude-code");
    expect(claude).toHaveTextContent(/couldn.t read/i);
    expect(within(claude).queryByRole("button", { name: /disconnect/i })).toBeNull();
    fireEvent.click(within(claude).getByRole("button", { name: /retry/i }));
    // A fresh read, not a refetch the server could answer from a failure it memoised a moment ago.
    expect(refreshRegistration).toHaveBeenCalledTimes(1);
    expect(refetchRegistration).not.toHaveBeenCalled();
  });

  it("CLI not installed → the row links to the Agents tab for that agent, no command", () => {
    renderTab();
    showAgent("codex");
    const codex = screen.getByTestId("libi-agent-row-codex");
    expect(codex).toHaveTextContent("CLI not installed");
    expect(within(codex).getByRole("link", { name: /set up in agents/i })).toHaveAttribute("href", "/agents?tab=agents&agent=codex");
    expect(within(codex).queryByRole("button")).toBeNull();
  });

  it("a CLI below the minimum version says it needs an update and links to the Agents tab, no command", () => {
    status = {
      "claude-code": { ...ready("/u/bin/claude"), cli: { path: "/u/bin/claude", realPath: "/u/bin/claude", version: "1.0.0", meetsMinimum: false } },
      codex: notInstalled(),
    };
    renderTab();
    const claude = screen.getByTestId("libi-agent-row-claude-code");
    expect(claude).toHaveTextContent("CLI needs an update");
    expect(claude).not.toHaveTextContent("CLI not installed");
    expect(within(claude).getByRole("link", { name: /set up in agents/i })).toHaveAttribute(
      "href",
      "/agents?tab=agents&agent=claude-code",
    );
    expect(within(claude).queryByRole("button")).toBeNull();
  });

  it("unknown → says the config could not be read and offers Retry, affecting only that row", () => {
    registration = { "claude-code": { state: "unknown" }, codex: { state: "connected" } };
    status = { "claude-code": ready("/u/bin/claude"), codex: ready("/u/bin/codex") };
    renderTab();
    expect(screen.getByTestId("libi-agent-row-claude-code")).toHaveTextContent(/couldn.t read/i);
    fireEvent.click(within(screen.getByTestId("libi-agent-row-claude-code")).getByRole("button", { name: /retry/i }));
    // A fresh read, not a refetch the server could answer from a failure it memoised a moment ago.
    expect(refreshRegistration).toHaveBeenCalledTimes(1);
    expect(refetchRegistration).not.toHaveBeenCalled();
    showAgent("codex");
    expect(screen.getByTestId("libi-agent-row-codex")).toHaveTextContent("Connected");
  });

  it("a Codex registration from codex's last good listing keeps its state and action, marked last known, with the Providers tab's notice and a Retry that asks for a fresh read — never 'Couldn't read'", () => {
    const url = "http://127.0.0.1:3457/mcp?agent=codex";
    registration = { "claude-code": { state: "not-connected" }, codex: { state: "connected", url, stale: true } };
    status = { "claude-code": ready("/u/bin/claude"), codex: ready("/u/bin/codex") };
    renderTab();
    // Claude Code's own config was read fresh: no marker, no notice.
    expect(screen.getByTestId("libi-agent-row-claude-code")).not.toHaveTextContent("last known");
    expect(screen.queryByTestId("libi-agent-row-claude-code-stale")).toBeNull();
    expect(screen.queryByTestId("libi-agent-stale-claude-code")).toBeNull();
    showAgent("codex");
    const codex = screen.getByTestId("libi-agent-row-codex");
    expect(codex).toHaveTextContent("Connected");
    expect(codex).not.toHaveTextContent(/couldn.t read/i);
    expect(screen.getByTestId("libi-agent-row-codex-stale")).toHaveTextContent("· last known");
    expect(within(codex).getByRole("button", { name: /disconnect/i })).toBeEnabled();
    const notice = screen.getByTestId("libi-agent-stale-codex");
    expect(notice).toHaveTextContent("Couldn't re-read Codex's config just now, so this shows what it said earlier.");
    fireEvent.click(within(notice).getByRole("button", { name: /retry/i }));
    expect(refreshRegistration).toHaveBeenCalledTimes(1);
    expect(refetchRegistration).not.toHaveBeenCalled();
  });

  it("Codex's last-known state stays steady across polls whose served listing goes stale after a slow run, stale after a failed run, then stale after a slow run again, and a later fresh answer drops the marker", () => {
    const url = "http://127.0.0.1:3457/mcp?agent=codex";
    status = { "claude-code": ready("/u/bin/claude"), codex: ready("/u/bin/codex") };
    const qc = new QueryClient();
    const tree = () => (
      <QueryClientProvider client={qc}>
        <SetupTerminalHost>
          <LibiMcpTab extension={null} />
          <GlobalSetupTab />
        </SetupTerminalHost>
      </QueryClientProvider>
    );
    const assertSteady = () => {
      const codex = screen.getByTestId("libi-agent-row-codex");
      expect(codex).toHaveTextContent("Connected to an old port");
      expect(codex).toHaveTextContent("· last known");
      expect(within(codex).getByRole("button", { name: /reconnect/i })).toBeInTheDocument();
      expect(codex).not.toHaveTextContent(/couldn.t read/i);
    };
    // Server-side (Minor B), a slow run and one that has since failed both answer from the same
    // last good listing, marked stale — never "unknown" for the failed one, which is what made
    // this row flip between "Connected to an old port" and "Couldn't read Codex's config" before
    // that fix. That collapse is deliberate and happens server-side (detectCodex in
    // lib/agents/libi-registration.ts derives the same { state, url, stale } shape from
    // `lastGood.entries` either way — no `reason` field ever reaches the client), so codex's own
    // payload is legitimately identical for a slow poll and a failed-since poll; asserting that
    // fact is what detect-shared.test.ts's fake-timer fixer scenario does, server-side, where the
    // difference actually exists. What this render-level test must still prove is that the codex
    // row is a pure function of ITS OWN input across genuinely different renders of one mounted
    // tab — never remounted — so each of the three "polls" below carries a distinct mocked
    // registration object (not the same literal repeated three times), and unrelated data (here,
    // Claude Code's own state, which really is independent of codex's timing) changes alongside
    // it, to rule out the row silently reusing a stale prior render instead of reading its own data.
    registration = { "claude-code": { state: "not-connected" }, codex: { state: "stale-port", url, stale: true } };
    const { rerender } = render(tree());
    showAgent("codex");
    assertSteady();
    // "Failed since the last good listing" — same served shape, a different surrounding payload.
    registration = { "claude-code": { state: "connected", scope: "user" }, codex: { state: "stale-port", url, stale: true } };
    rerender(tree());
    assertSteady();
    // Slow again — back to Claude Code not connected, still served from the same last good listing.
    registration = { "claude-code": { state: "not-connected" }, codex: { state: "stale-port", url, stale: true } };
    rerender(tree());
    assertSteady();
    // Codex finally answers fresh: the marker and the notice both go away.
    registration = { "claude-code": { state: "not-connected" }, codex: { state: "stale-port", url } };
    rerender(tree());
    expect(screen.getByTestId("libi-agent-row-codex")).not.toHaveTextContent("last known");
    expect(screen.queryByTestId("libi-agent-stale-codex")).toBeNull();
  });

  it("disables every command button until the shell flavor is known", () => {
    flavor = undefined;
    renderTab();
    expect(within(screen.getByTestId("libi-agent-row-claude-code")).getByRole("button", { name: /^connect$/i })).toBeDisabled();
  });

  it("a CLI that is found but won't run says so, and still links to the Agents tab", () => {
    status = {
      "claude-code": { ...ready("/u/bin/claude"), cli: { foundButBroken: true, path: "/u/bin/claude" }, ready: false },
      codex: notInstalled(),
    };
    renderTab();
    const claude = screen.getByTestId("libi-agent-row-claude-code");
    expect(claude).toHaveTextContent("Claude Code CLI found but won't run");
    expect(claude).not.toHaveTextContent("CLI not installed");
    expect(within(claude).getByRole("link", { name: /set up in agents/i })).toHaveAttribute(
      "href",
      "/agents?tab=agents&agent=claude-code",
    );
    expect(within(claude).queryByRole("button")).toBeNull();
  });

  it("an agent status that could not be read is not 'CLI not installed': both rows say so and Retry re-reads the status", () => {
    status = undefined;
    renderTab();
    for (const [id, name] of [["claude-code", "Claude Code"], ["codex", "Codex"]] as const) {
      showAgent(id);
      const row = screen.getByTestId(`libi-agent-row-${id}`);
      expect(row).toHaveTextContent(`Couldn't read ${name}'s status`);
      expect(row).not.toHaveTextContent("CLI not installed");
      expect(within(row).queryByRole("button", { name: /connect/i })).toBeNull();
      expect(within(row).queryByRole("link")).toBeNull();
    }
    fireEvent.click(within(screen.getByTestId("libi-agent-row-codex")).getByRole("button", { name: /retry/i }));
    expect(refetchStatus).toHaveBeenCalledTimes(1);
    expect(refetchRegistration).not.toHaveBeenCalled();
    expect(refreshRegistration).not.toHaveBeenCalled();
  });

  it("types the CLI's REAL path, not the path it was found at", async () => {
    status = { "claude-code": ready("/u/bin/claude", "/opt/claude-code/2.1.0/claude"), codex: notInstalled() };
    renderTab();
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("libi-agent-row-claude-code")).getByRole("button", { name: /^connect$/i }));
    });
    expect(lastPostedCommand()).toBe(
      "/opt/claude-code/2.1.0/claude mcp add --scope user --transport http libi http://127.0.0.1:3457/mcp",
    );
  });

  const commandButtonCases = [
    ["Connect", { state: "not-connected" }],
    ["Disconnect", { state: "connected", scope: "user" }],
    ["Reconnect", { state: "stale-port", scope: "user" }],
  ] as const;

  it.each(commandButtonCases)("disables %s while the endpoint URL is not known", (button, reg) => {
    health = undefined;
    registration = { "claude-code": { ...reg }, codex: { state: "not-connected" } };
    renderTab();
    const claude = screen.getByTestId("libi-agent-row-claude-code");
    expect(within(claude).getByRole("button", { name: new RegExp(`^${button}$`, "i") })).toBeDisabled();
  });

  it.each(commandButtonCases.slice(1))("disables %s while the shell flavor is unknown", (button, reg) => {
    flavor = undefined;
    registration = { "claude-code": { ...reg }, codex: { state: "not-connected" } };
    renderTab();
    const claude = screen.getByTestId("libi-agent-row-claude-code");
    expect(within(claude).getByRole("button", { name: new RegExp(`^${button}$`, "i") })).toBeDisabled();
  });

  it("closing the setup terminal re-reads the registration and the agent status once, after the DELETE", async () => {
    renderTab();
    await waitFor(() => expect(registrationFetches).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("libi-agent-row-claude-code")).getByRole("button", { name: /^connect$/i }));
    });
    expect(screen.getByTestId("setup-terminal-global-setup")).toBeInTheDocument();
    registrationFetches.mockClear();
    statusFetches.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    });
    expect(screen.queryByTestId("setup-terminal-global-setup")).not.toBeInTheDocument();
    await waitFor(() => expect(registrationFetches).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(statusFetches).toHaveBeenCalledTimes(1));

    // The server drops its memo when the DELETE lands, so the re-read must come after it.
    const deleteIndex = fetchMock.mock.calls.findIndex(([, init]) => init?.method === "DELETE");
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(fetchMock.mock.invocationCallOrder[deleteIndex]).toBeLessThan(registrationFetches.mock.invocationCallOrder[0]);
    expect(fetchMock.mock.invocationCallOrder[deleteIndex]).toBeLessThan(statusFetches.mock.invocationCallOrder[0]);

    // Once, not a poll: nothing re-reads again afterwards.
    await new Promise((r) => setTimeout(r, 50));
    expect(registrationFetches).toHaveBeenCalledTimes(1);
    expect(statusFetches).toHaveBeenCalledTimes(1);
    expect(registrationOpts).toHaveBeenLastCalledWith(expect.objectContaining({ refetchInterval: false }));
  });

  it.each(["simulate-exit", "simulate-gone"])(
    "a terminal that ends on its own (%s) re-reads the registration and the agent status once, and stops the poll",
    async (ending) => {
      renderTab();
      await act(async () => {
        fireEvent.click(within(screen.getByTestId("libi-agent-row-claude-code")).getByRole("button", { name: /^connect$/i }));
      });
      expect(registrationOpts).toHaveBeenLastCalledWith(expect.objectContaining({ refetchInterval: 3000 }));
      // Opening a terminal is not an ending.
      expect(refetchRegistration).not.toHaveBeenCalled();
      expect(refetchStatus).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: ending }));
      expect(refetchRegistration).toHaveBeenCalledTimes(1);
      expect(refetchStatus).toHaveBeenCalledTimes(1);
      expect(registrationOpts).toHaveBeenLastCalledWith(expect.objectContaining({ refetchInterval: false }));

      // A second report about the same terminal is not a second ending.
      fireEvent.click(screen.getByRole("button", { name: /simulate-exit/ }));
      fireEvent.click(screen.getByRole("button", { name: /simulate-gone/ }));
      expect(refetchRegistration).toHaveBeenCalledTimes(1);
      expect(refetchStatus).toHaveBeenCalledTimes(1);
    },
  );

  it("polls the registration only while the tab holds a setup terminal", async () => {
    renderTab();
    expect(registrationOpts).toHaveBeenLastCalledWith(expect.objectContaining({ refetchInterval: false }));
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("libi-agent-row-claude-code")).getByRole("button", { name: /^connect$/i }));
    });
    expect(registrationOpts).toHaveBeenLastCalledWith(expect.objectContaining({ refetchInterval: 3000 }));
  });
});

describe("libi MCP tab — active sessions, extensions, small print", () => {
  it("reads the breakdown from /healthz", () => {
    health = {
      ok: true,
      url: "u",
      childStatus: "running",
      port: 3457,
      sessions: 3,
      sessionsBy: { inApp: { claude: 2, codex: 0 }, cli: { claude: 1, codex: 0 } },
    };
    renderTab();
    expect(screen.getByTestId("active-sessions")).toHaveTextContent(
      "3 active: in-app chat 2 · Claude Code CLI 1 · Codex CLI 0",
    );
  });

  it("an endpoint that answers without the breakdown shows its total, not 'unreachable'", () => {
    health = { ok: true, url: "u", childStatus: "running", port: 3457, sessions: 2 };
    renderTab();
    const line = screen.getByTestId("active-sessions");
    expect(line).toHaveTextContent(/^2 active$/);
    expect(line).not.toHaveTextContent(/unreachable/i);
  });

  it("an endpoint that answers with no count at all gets a neutral line", () => {
    health = { ok: true, url: "u", childStatus: "running", port: 3457 };
    renderTab();
    expect(screen.getByTestId("active-sessions")).not.toHaveTextContent(/unreachable/i);
  });

  it("only an endpoint that did not answer reads 'unreachable'", () => {
    health = { ok: false, url: "u", childStatus: "running", error: "ECONNREFUSED" };
    renderTab();
    expect(screen.getByTestId("active-sessions")).toHaveTextContent("No session count while the endpoint is unreachable.");
  });

  it("shows skeletons for the endpoint card, the agent rows and the sessions line while they load — never 'Loading' text", () => {
    health = undefined;
    healthLoading = true;
    registrationLoading = true;
    statusLoading = true;
    const { container } = renderTab();
    const skeletons = (el: Element) => el.querySelectorAll('[data-slot="skeleton"]');
    const tabRoot = container.firstElementChild!;
    expect(tabRoot.firstElementChild).toHaveAttribute("data-slot", "skeleton");
    expect(screen.queryByTestId("endpoint-card")).toBeNull();
    const agents = screen.getByRole("region", { name: "Claude Code and Codex setup" });
    expect(agents).toHaveTextContent("Add Libi MCP to your global Claude Code and Codex configuration");
    // One skeleton of the list under the switch — its Tools and Skills blocks — never a skeleton per agent card.
    expect(within(agents as HTMLElement).getByTestId("global-setup-agent-switch")).toBeInTheDocument();
    const list = within(agents as HTMLElement).getByTestId("global-setup-list-skeleton");
    expect(list.children).toHaveLength(2);
    for (const block of Array.from(list.children)) expect(skeletons(block).length).toBeGreaterThan(0);
    expect(skeletons(agents)).toHaveLength(skeletons(list).length);
    expect(within(agents as HTMLElement).queryByTestId(/libi-agent-(row|card)-/)).toBeNull();
    const sessions = screen.getByRole("heading", { name: /active sessions/i }).closest("section")!;
    expect(skeletons(sessions)).toHaveLength(1);
    expect(screen.queryByTestId("active-sessions")).toBeNull();
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it("renders the extensions section and parks + dispatches the ?extension= scroll intent", () => {
    renderTab({ extension: "whisper" });
    expect(screen.getByTestId("extensions")).toBeInTheDocument();
    expect(scrollEvents).toEqual(["whisper"]);
    expect(setPendingMcpScroll).toHaveBeenCalledWith("whisper");
  });

  it("keeps `npx @nagellabs/libi connect` as small print with a Copy button", async () => {
    renderTab();
    expect(screen.getByText("npx @nagellabs/libi connect", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/in a terminal,/i)).toHaveTextContent(
      "In a terminal, npx @nagellabs/libi connect in a folder does the same: libi's tools for your whole account, and libi's skills for that folder.",
    );
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith("npx @nagellabs/libi connect"));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Copied"));
  });

  it("gives every button and link cursor-pointer", () => {
    renderTab();
    // Each agent's list in turn, with its Add folder field open; Codex's CLI isn't installed, so its row is a link.
    for (const id of AGENT_IDS) {
      showAgent(id);
      fireEvent.click(within(screen.getByTestId(`libi-agent-card-${id}`)).getByRole("button", { name: /^add folder$/i }));
      for (const el of [...screen.getAllByRole("button"), ...screen.queryAllByRole("link"), ...screen.getAllByRole("tab")]) {
        expect(el.className).toContain("cursor-pointer");
      }
    }
    expect(within(screen.getByTestId("libi-agent-row-codex")).getByRole("link").className).toContain("cursor-pointer");
  });
});

describe("libi MCP tab — skills for the user's own agents", () => {
  const card = (id: "claude-code" | "codex") => within(screen.getByTestId(`libi-agent-card-${id}`));

  it("says libi's own chats always have tools and skills, and polls the installs", () => {
    renderTab();
    expect(screen.getByText("libi's own chats and terminal always have libi's tools and skills.")).toBeInTheDocument();
    expect(installsQueryOpts).toHaveBeenCalledWith({ poll: true });
  });

  it.each(["claude-code", "codex"] as const)("%s: both skills rows render with Not installed and an empty folder list, whatever the CLI state", (id) => {
    renderTab();
    showAgent(id);
    const c = card(id);
    const user = within(c.getByTestId(`skills-user-row-${id}`));
    expect(user.getByText("Every folder")).toBeInTheDocument();
    const dir = id === "claude-code" ? "~/.claude/skills" : "~/.agents/skills";
    const agent = id === "claude-code" ? "Claude Code" : "Codex";
    expect(user.getByText(`Installs libi's skills into ${dir}, so every ${agent} chat in every folder can use them. libi keeps them up to date.`)).toBeInTheDocument();
    expect(user.getByText("Not installed")).toBeInTheDocument();
    expect(user.getByRole("button", { name: /^install$/i })).toBeEnabled();
    const folders = within(c.getByTestId(`skills-folders-row-${id}`));
    expect(folders.getByText("Specific folders")).toBeInTheDocument();
    expect(folders.getByText("No folders yet.")).toBeInTheDocument();
    expect(folders.getByRole("button", { name: /^add folder$/i })).toBeEnabled();
  });

  it.each(["claude-code", "codex"] as const)("%s: statuses, the skipped note, and the cli label", (id) => {
    installs!.installs = [
      install({ id: "u", agentId: id, scope: "user", folderPath: null, path: "/home/me/.claude/skills", installedCount: 12, skippedNames: ["captions", "ugc"] }),
    ];
    const { rerender } = renderTab();
    showAgent(id);
    const user = within(card(id).getByTestId(`skills-user-row-${id}`));
    expect(user.getByText("Installed · 12 skills")).toBeInTheDocument();
    const note = user.getByText("Skipped 2 skills whose names you already use");
    expect(note).toHaveAttribute("title", "captions, ugc");
    expect(user.getByRole("button", { name: /^remove$/i })).toBeInTheDocument();

    installs = {
      ...installs!,
      installs: [
        install({ id: "f1", agentId: id, folderPath: "/a", path: "/a/.claude/skills" }),
        install({ id: "f2", agentId: id, folderPath: "/b", path: "/b/.claude/skills", status: "folder-not-found", source: "cli" }),
        install({ id: "f3", agentId: id, folderPath: "/c", path: "/c/.claude/skills", status: "error", error: "permission denied" }),
        install({ id: "u2", agentId: id === "claude-code" ? "codex" : "claude-code", scope: "user", folderPath: null, status: "error", error: "disk full" }),
      ],
    };
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <SetupTerminalHost>
          <LibiMcpTab extension={null} />
          <GlobalSetupTab />
        </SetupTerminalHost>
      </QueryClientProvider>,
    );
    const folders = within(card(id).getByTestId(`skills-folders-row-${id}`));
    expect(within(folders.getByTestId("skills-folder-f1")).getByText("Up to date")).toBeInTheDocument();
    expect(within(folders.getByTestId("skills-folder-f2")).getByText("Folder not found")).toBeInTheDocument();
    expect(within(folders.getByTestId("skills-folder-f2")).getByText("added with libi connect")).toBeInTheDocument();
    expect(within(folders.getByTestId("skills-folder-f3")).getByText("Couldn't update: permission denied")).toBeInTheDocument();
    expect(folders.queryByTestId("skills-folder-u2")).toBeNull();
    const other = id === "claude-code" ? "codex" : "claude-code";
    showAgent(other);
    expect(within(card(other).getByTestId(`skills-user-row-${other}`)).getByText("Couldn't update: disk full")).toBeInTheDocument();
  });

  it.each(["user", "folder"] as const)("the %s row's skipped names are a keyboard-reachable disclosure, not hover-only", (scope) => {
    installs!.installs = [
      scope === "user"
        ? install({ id: "u", agentId: "codex", scope: "user", folderPath: null, skippedNames: ["captions", "ugc"] })
        : install({ id: "f1", agentId: "codex", skippedNames: ["captions", "ugc"] }),
    ];
    renderTab();
    showAgent("codex");
    const row = within(scope === "user" ? card("codex").getByTestId("skills-user-row-codex") : screen.getByTestId("skills-folder-f1"));
    const summary = row.getByText("Skipped 2 skills whose names you already use");
    expect(summary).toBeInTheDocument();
    const toggle = row.getByRole("button", { name: "Show names" });
    expect(toggle).toHaveClass("cursor-pointer");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Tied to its own row's summary text, so a page with several rows still
    // gives a screen reader the right context for each button.
    expect(toggle).toHaveAttribute("aria-describedby", summary.id);
    expect(row.queryByRole("list")).toBeNull();
    // The list is already in the DOM — merely hidden — so aria-controls never
    // dangles even before the first toggle.
    const collapsedList = row.getByRole("list", { hidden: true });
    expect(collapsedList).toHaveAttribute("hidden");
    expect(toggle).toHaveAttribute("aria-controls", collapsedList.id);

    toggle.focus();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    const expanded = row.getByRole("button", { name: "Hide names" });
    expect(expanded).toHaveAttribute("aria-expanded", "true");
    expect(expanded).toHaveAttribute("aria-describedby", summary.id);
    const list = row.getByRole("list");
    expect(list).not.toHaveAttribute("hidden");
    expect(expanded).toHaveAttribute("aria-controls", list.id);
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["captions", "ugc"]);

    fireEvent.click(expanded);
    expect(row.queryByRole("list")).toBeNull();
    expect(row.getByRole("list", { hidden: true })).toHaveAttribute("hidden");
    expect(row.getByRole("button", { name: "Show names" })).toHaveAttribute("aria-expanded", "false");
  });

  it("uses singular form for 1 skipped skill", () => {
    installs!.installs = [install({ id: "u", agentId: "codex", scope: "user", folderPath: null, skippedNames: ["captions"] })];
    renderTab();
    showAgent("codex");
    const user = within(card("codex").getByTestId("skills-user-row-codex"));
    expect(user.getByText("Skipped 1 skill whose name you already use")).toBeInTheDocument();
  });

  it("uses singular form for 1 installed skill", () => {
    installs!.installs = [install({ id: "u", agentId: "claude-code", scope: "user", folderPath: null, installedCount: 1 })];
    renderTab();
    const user = within(card("claude-code").getByTestId("skills-user-row-claude-code"));
    expect(user.getByText("Installed · 1 skill")).toBeInTheDocument();
  });

  it("Install for every folder with no folder installs adds straight away", async () => {
    renderTab();
    showAgent("codex");
    await act(async () => { fireEvent.click(within(card("codex").getByTestId("skills-user-row-codex")).getByRole("button", { name: /^install$/i })); });
    expect(addInstall).toHaveBeenCalledWith({ agentId: "codex", scope: "user" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Install for every folder with folder installs asks first, naming the count, then adds", async () => {
    installs!.installs = [install({ id: "f1", agentId: "codex" }), install({ id: "f2", agentId: "codex", folderPath: "/q" })];
    renderTab();
    showAgent("codex");
    fireEvent.click(within(card("codex").getByTestId("skills-user-row-codex")).getByRole("button", { name: /^install$/i }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Install for every folder?");
    expect(dialog).toHaveTextContent("This also removes libi's skills from your 2 folders, since every folder will have them.");
    expect(addInstall).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /^install$/i })); });
    expect(addInstall).toHaveBeenCalledWith({ agentId: "codex", scope: "user" });
  });

  it("Install for every folder rejected with a message shows it inline on that row (direct install, no folder installs)", async () => {
    const { SkillInstallRequestError } = await import("@/lib/queries/skill-installs");
    addInstall.mockRejectedValueOnce(
      new SkillInstallRequestError("not_writable", "libi can't write to ~/.claude/skills (permission denied). Your folder installs were kept."),
    );
    renderTab();
    showAgent("codex");
    const user = within(card("codex").getByTestId("skills-user-row-codex"));
    await act(async () => {
      fireEvent.click(user.getByRole("button", { name: /^install$/i }));
    });
    expect(user.getByRole("alert")).toHaveTextContent(
      "libi can't write to ~/.claude/skills (permission denied). Your folder installs were kept.",
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Install for every folder rejected via the confirmation dialog shows the message inline; the folder installs list is unchanged", async () => {
    installs!.installs = [install({ id: "f1", agentId: "codex" }), install({ id: "f2", agentId: "codex", folderPath: "/q" })];
    const { SkillInstallRequestError } = await import("@/lib/queries/skill-installs");
    addInstall.mockRejectedValueOnce(
      new SkillInstallRequestError("not_writable", "libi can't write to ~/.claude/skills (permission denied). Your folder installs were kept."),
    );
    renderTab();
    showAgent("codex");
    fireEvent.click(within(card("codex").getByTestId("skills-user-row-codex")).getByRole("button", { name: /^install$/i }));
    const dialog = screen.getByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /^install$/i }));
    });
    const user = within(card("codex").getByTestId("skills-user-row-codex"));
    expect(user.getByRole("alert")).toHaveTextContent(
      "libi can't write to ~/.claude/skills (permission denied). Your folder installs were kept.",
    );
    expect(screen.getByTestId("skills-folder-f1")).toBeInTheDocument();
    expect(screen.getByTestId("skills-folder-f2")).toBeInTheDocument();
  });

  it("falls back to a fixed message when a failed every-folder install has no message", async () => {
    const { SkillInstallRequestError } = await import("@/lib/queries/skill-installs");
    addInstall.mockRejectedValueOnce(new SkillInstallRequestError("request_failed", ""));
    renderTab();
    showAgent("codex");
    const user = within(card("codex").getByTestId("skills-user-row-codex"));
    await act(async () => {
      fireEvent.click(user.getByRole("button", { name: /^install$/i }));
    });
    expect(user.getByRole("alert")).toHaveTextContent("Couldn't install libi's skills. Try again.");
  });

  it("a new every-folder install attempt clears the earlier alert, and success clears it too", async () => {
    const { SkillInstallRequestError } = await import("@/lib/queries/skill-installs");
    addInstall.mockRejectedValueOnce(new SkillInstallRequestError("not_writable", "permission denied"));
    renderTab();
    showAgent("codex");
    const user = within(card("codex").getByTestId("skills-user-row-codex"));
    await act(async () => {
      fireEvent.click(user.getByRole("button", { name: /^install$/i }));
    });
    expect(user.getByRole("alert")).toHaveTextContent("permission denied");
    addInstall.mockResolvedValueOnce(install({ id: "new", agentId: "codex", scope: "user", folderPath: null }));
    await act(async () => {
      fireEvent.click(user.getByRole("button", { name: /^install$/i }));
    });
    expect(user.queryByRole("alert")).toBeNull();
  });

  it("a failed Remove on the every-folder row shows the error inline on that row instead of swallowing it", async () => {
    installs!.installs = [install({ id: "u", agentId: "codex", scope: "user", folderPath: null })];
    const { SkillInstallRequestError } = await import("@/lib/queries/skill-installs");
    removeInstall.mockRejectedValueOnce(new SkillInstallRequestError("install_failed", "libi can't remove ~/.agents/skills (permission denied)."));
    renderTab();
    showAgent("codex");
    const user = within(card("codex").getByTestId("skills-user-row-codex"));
    fireEvent.click(user.getByRole("button", { name: /^remove$/i }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^remove$/i }));
    });
    expect(user.getByRole("alert")).toHaveTextContent("libi can't remove ~/.agents/skills (permission denied).");
  });

  it("a failed Remove on a folder row shows the error inline on that row instead of swallowing it", async () => {
    installs!.installs = [install({ id: "f1", agentId: "codex" })];
    const { SkillInstallRequestError } = await import("@/lib/queries/skill-installs");
    removeInstall.mockRejectedValueOnce(new SkillInstallRequestError("install_failed", "disk is read-only"));
    renderTab();
    showAgent("codex");
    const row = screen.getByTestId("skills-folder-f1");
    fireEvent.click(within(row).getByRole("button", { name: /^remove$/i }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^remove$/i }));
    });
    expect(within(row).getByRole("alert")).toHaveTextContent("disk is read-only");
  });

  it("falls back to a fixed message when a failed Remove has no message", async () => {
    installs!.installs = [install({ id: "f1", agentId: "codex" })];
    const { SkillInstallRequestError } = await import("@/lib/queries/skill-installs");
    removeInstall.mockRejectedValueOnce(new SkillInstallRequestError("request_failed", ""));
    renderTab();
    showAgent("codex");
    const row = screen.getByTestId("skills-folder-f1");
    fireEvent.click(within(row).getByRole("button", { name: /^remove$/i }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^remove$/i }));
    });
    expect(within(row).getByRole("alert")).toHaveTextContent("Couldn't remove libi's skills. Try again.");
  });

  it("a failed Remove: only a SkillInstallRequestError's own message is shown, not any Error's", async () => {
    installs!.installs = [install({ id: "f1", agentId: "codex" })];
    removeInstall.mockRejectedValueOnce(new Error("boom"));
    renderTab();
    showAgent("codex");
    const row = screen.getByTestId("skills-folder-f1");
    fireEvent.click(within(row).getByRole("button", { name: /^remove$/i }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^remove$/i }));
    });
    expect(within(row).getByRole("alert")).toHaveTextContent("Couldn't remove libi's skills. Try again.");
    expect(within(row).getByRole("alert")).not.toHaveTextContent("boom");
  });

  it("retrying a failed Remove clears the earlier alert", async () => {
    installs!.installs = [install({ id: "f1", agentId: "codex" })];
    const { SkillInstallRequestError } = await import("@/lib/queries/skill-installs");
    removeInstall.mockRejectedValueOnce(new SkillInstallRequestError("install_failed", "disk is read-only"));
    renderTab();
    showAgent("codex");
    const row = screen.getByTestId("skills-folder-f1");
    fireEvent.click(within(row).getByRole("button", { name: /^remove$/i }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^remove$/i }));
    });
    expect(within(row).getByRole("alert")).toHaveTextContent("disk is read-only");
    removeInstall.mockResolvedValueOnce({ removed: 1 });
    fireEvent.click(within(row).getByRole("button", { name: /^remove$/i }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^remove$/i }));
    });
    expect(within(row).queryByRole("alert")).toBeNull();
  });

  it("while a user-level install exists, Add folder is disabled and says why", () => {
    installs!.installs = [install({ id: "u", agentId: "claude-code", scope: "user", folderPath: null })];
    renderTab();
    const folders = within(card("claude-code").getByTestId("skills-folders-row-claude-code"));
    expect(folders.getByRole("button", { name: /^add folder$/i })).toBeDisabled();
    expect(folders.getByText("Skills are installed for every folder, so every folder already has them.")).toBeInTheDocument();
    // The other agent is unaffected.
    showAgent("codex");
    expect(within(card("codex").getByTestId("skills-folders-row-codex")).getByRole("button", { name: /^add folder$/i })).toBeEnabled();
  });

  it("Add folder reveals the picker; picking fills the field; Add posts the folder; a validation message shows inline", async () => {
    renderTab();
    const folders = within(card("claude-code").getByTestId("skills-folders-row-claude-code"));
    fireEvent.click(folders.getByRole("button", { name: /^add folder$/i }));
    pickResult = { status: "picked", path: "/Users/me/proj" };
    await act(async () => { fireEvent.click(folders.getByRole("button", { name: /choose folder/i })); });
    expect(folders.getByRole("textbox")).toHaveValue("/Users/me/proj");
    await act(async () => { fireEvent.click(folders.getByRole("button", { name: /^add$/i })); });
    expect(addInstall).toHaveBeenCalledWith({ agentId: "claude-code", scope: "folder", folderPath: "/Users/me/proj" });
    // The field closes on success.
    expect(folders.queryByRole("textbox")).toBeNull();

    const { SkillInstallRequestError } = await import("@/lib/queries/skill-installs");
    addInstall.mockRejectedValueOnce(new SkillInstallRequestError("not_found", "That folder doesn't exist."));
    fireEvent.click(folders.getByRole("button", { name: /^add folder$/i }));
    fireEvent.change(folders.getByRole("textbox"), { target: { value: "/nope" } });
    await act(async () => { fireEvent.click(folders.getByRole("button", { name: /^add$/i })); });
    expect(folders.getByRole("alert")).toHaveTextContent("That folder doesn't exist.");
  });

  it.each(["claude-code", "codex"] as const)("%s: Cancel closes the Add folder field without adding, and it reopens empty", (id) => {
    renderTab();
    showAgent(id);
    const folders = within(card(id).getByTestId(`skills-folders-row-${id}`));
    expect(folders.queryByRole("button", { name: /^cancel$/i })).toBeNull();
    fireEvent.click(folders.getByRole("button", { name: /^add folder$/i }));
    fireEvent.change(folders.getByRole("textbox"), { target: { value: "/Users/me/half-typed" } });
    const cancel = folders.getByRole("button", { name: /^cancel$/i });
    expect(cancel).toHaveClass("cursor-pointer");
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(folders.queryByRole("textbox")).toBeNull();
    expect(folders.queryByRole("button", { name: /^cancel$/i })).toBeNull();
    expect(addInstall).not.toHaveBeenCalled();
    const addFolder = folders.getByRole("button", { name: /^add folder$/i });
    expect(addFolder).toBeEnabled();
    fireEvent.click(addFolder);
    expect(folders.getByRole("textbox")).toHaveValue("");
  });

  it.each(["claude-code", "codex"] as const)("%s: a pick that resolves after Cancel does not pre-fill the field on reopen", async (id) => {
    renderTab();
    showAgent(id);
    const folders = within(card(id).getByTestId(`skills-folders-row-${id}`));
    let resolvePick!: (r: PickResult) => void;
    pickFolderImpl = () => new Promise((resolve) => { resolvePick = resolve; });

    fireEvent.click(folders.getByRole("button", { name: /^add folder$/i }));
    fireEvent.click(folders.getByRole("button", { name: /choose folder/i }));
    // The dialog is a separate window — Cancel unmounts the field while it is
    // still open.
    fireEvent.click(folders.getByRole("button", { name: /^cancel$/i }));
    expect(folders.queryByRole("textbox")).toBeNull();

    // The (now-stale) pick resolves after the fact.
    await act(async () => { resolvePick({ status: "picked", path: "/late/pick" }); });

    fireEvent.click(folders.getByRole("button", { name: /^add folder$/i }));
    expect(folders.getByRole("textbox")).toHaveValue("");
  });

  it.each(["claude-code", "codex"] as const)("%s: the Add folder field's Cancel is not available while an add is pending", (id) => {
    addPending = true;
    renderTab();
    showAgent(id);
    const folders = within(card(id).getByTestId(`skills-folders-row-${id}`));
    fireEvent.click(folders.getByRole("button", { name: /^add folder$/i }));
    expect(folders.getByRole("button", { name: /^cancel$/i })).toBeDisabled();
  });

  it("Add folder falls back to 'Try again' wording, and only a SkillInstallRequestError's own message is shown", async () => {
    renderTab();
    const folders = within(card("claude-code").getByTestId("skills-folders-row-claude-code"));

    // A non-SkillInstallRequestError (e.g. a network failure) is not narrow enough to trust its
    // message verbatim — it falls back to the fixed wording instead of leaking "boom".
    addInstall.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(folders.getByRole("button", { name: /^add folder$/i }));
    fireEvent.change(folders.getByRole("textbox"), { target: { value: "/x" } });
    await act(async () => { fireEvent.click(folders.getByRole("button", { name: /^add$/i })); });
    expect(folders.getByRole("alert")).toHaveTextContent("Couldn't install libi's skills. Try again.");

    // A SkillInstallRequestError with no message also falls back to the same fixed wording.
    const { SkillInstallRequestError } = await import("@/lib/queries/skill-installs");
    addInstall.mockRejectedValueOnce(new SkillInstallRequestError("request_failed", ""));
    fireEvent.change(folders.getByRole("textbox"), { target: { value: "/y" } });
    await act(async () => { fireEvent.click(folders.getByRole("button", { name: /^add$/i })); });
    expect(folders.getByRole("alert")).toHaveTextContent("Couldn't install libi's skills. Try again.");
  });

  it("Install for every folder: only a SkillInstallRequestError's own message is shown, not any Error's", async () => {
    renderTab();
    showAgent("codex");
    const user = within(card("codex").getByTestId("skills-user-row-codex"));
    addInstall.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      fireEvent.click(user.getByRole("button", { name: /^install$/i }));
    });
    expect(user.getByRole("alert")).toHaveTextContent("Couldn't install libi's skills. Try again.");
  });

  it("the unavailable dialog hint shows next to the field", async () => {
    renderTab();
    showAgent("codex");
    const folders = within(card("codex").getByTestId("skills-folders-row-codex"));
    fireEvent.click(folders.getByRole("button", { name: /^add folder$/i }));
    pickResult = { status: "unavailable", reason: "timed out" };
    await act(async () => { fireEvent.click(folders.getByRole("button", { name: /choose folder/i })); });
    expect(folders.getByText("Couldn't open a folder dialog here — paste the path instead.")).toBeInTheDocument();
  });

  it.each([
    ["user", "u", "/home/me/.agents/skills"],
    ["folder", "f1", "/p/.agents/skills"],
  ] as const)("Remove on a %s install asks first with the path, then deletes", async (scope, id, p) => {
    installs!.installs = [install({ id, agentId: "codex", scope, folderPath: scope === "user" ? null : "/p", path: p })];
    renderTab();
    showAgent("codex");
    const row = scope === "user" ? card("codex").getByTestId("skills-user-row-codex") : screen.getByTestId(`skills-folder-${id}`);
    fireEvent.click(within(row).getByRole("button", { name: /^remove$/i }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Remove libi's skills?");
    expect(dialog).toHaveTextContent(`Removes libi's skills from ${p}. Skills you added there yourself stay.`);
    expect(removeInstall).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    expect(removeInstall).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: /^remove$/i }));
    await act(async () => { fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^remove$/i })); });
    expect(removeInstall).toHaveBeenCalledWith(id);
  });

  it("shows skeletons for the skills rows while the installs load", () => {
    installsLoading = true;
    installs = undefined;
    renderTab();
    expect(screen.queryByText(/loading/i)).toBeNull();
    expect(card("claude-code").getAllByTestId("skills-skeleton").length).toBeGreaterThanOrEqual(2);
  });

  it("a failed installs fetch shows an error row with Retry, not a permanent skeleton, and Retry refetches", () => {
    installs = undefined;
    renderTab();
    const c = card("claude-code");
    expect(c.queryByTestId("skills-skeleton")).toBeNull();
    expect(c.getByText("Couldn't read libi's skill installs.")).toBeInTheDocument();
    const retry = c.getByRole("button", { name: /^retry$/i });
    expect(retry.className).toContain("cursor-pointer");
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(refetchInstalls).toHaveBeenCalledTimes(1);
  });

  it("Retry reads Retrying… and is disabled while the installs are already refetching", () => {
    installs = undefined;
    installsFetching = true;
    renderTab();
    const retrying = card("claude-code").getByRole("button", { name: /retrying/i });
    expect(retrying).toBeDisabled();
  });

  it("disables the Remove buttons, on both rows, while a remove is pending", () => {
    installs!.installs = [
      install({ id: "u", agentId: "claude-code", scope: "user", folderPath: null }),
      install({ id: "f1", agentId: "codex" }),
    ];
    removePending = true;
    renderTab();
    expect(within(card("claude-code").getByTestId("skills-user-row-claude-code")).getByRole("button", { name: /^remove$/i })).toBeDisabled();
    showAgent("codex");
    expect(within(screen.getByTestId("skills-folder-f1")).getByRole("button", { name: /^remove$/i })).toBeDisabled();
  });

  it("the confirm-remove dialog's own Remove action is disabled while the remove mutation is pending", () => {
    installs!.installs = [install({ id: "f1", agentId: "codex" })];
    const { rerender } = renderTab();
    showAgent("codex");
    fireEvent.click(within(screen.getByTestId("skills-folder-f1")).getByRole("button", { name: /^remove$/i }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: /^remove$/i })).toBeEnabled();
    removePending = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <SetupTerminalHost>
          <LibiMcpTab extension={null} />
          <GlobalSetupTab />
        </SetupTerminalHost>
      </QueryClientProvider>,
    );
    expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^remove$/i })).toBeDisabled();
  });

  it("the confirm-every-folder dialog's own Install action is disabled while the add mutation is pending", () => {
    installs!.installs = [install({ id: "f1", agentId: "codex" })];
    const { rerender } = renderTab();
    showAgent("codex");
    fireEvent.click(within(card("codex").getByTestId("skills-user-row-codex")).getByRole("button", { name: /^install$/i }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: /^install$/i })).toBeEnabled();
    addPending = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <SetupTerminalHost>
          <LibiMcpTab extension={null} />
          <GlobalSetupTab />
        </SetupTerminalHost>
      </QueryClientProvider>,
    );
    expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^install$/i })).toBeDisabled();
  });
});

describe("Global setup tab — agent switch", () => {
  const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
  const tree = (node: React.ReactNode) => (
    <QueryClientProvider client={new QueryClient()}>
      <SetupTerminalHost>{node}</SetupTerminalHost>
    </QueryClientProvider>
  );
  const panelOf = (agentId: (typeof AGENT_IDS)[number]) => document.getElementById(option(agentId).getAttribute("aria-controls")!)!;
  const bothReady = () => {
    status = { "claude-code": ready("/u/bin/claude"), codex: ready("/u/bin/codex") };
  };
  /** Opens the tab's terminal the way a button does, naming `anchor` as its agent (or none). */
  function Opener({ anchor }: { anchor?: string }) {
    const host = useSetupTerminalHost();
    return (
      <button className="cursor-pointer" onClick={() => void host.open("global-setup", "echo hi", "connect-libi", anchor).catch(() => undefined)}>
        open-terminal
      </button>
    );
  }

  it("is a tablist labelled Set up libi for, under the tab's subtitle, whose panel is one list for the selected agent — Tools, a divider, then Skills — with no card border and no agent header", () => {
    renderTab();
    const sectionEl = screen.getByRole("region", { name: "Claude Code and Codex setup" });
    const section = within(sectionEl);
    const subtitle = section.getByText(/Add Libi MCP to your global Claude Code and Codex configuration/i);
    const tablist = section.getByRole("tablist", { name: "Set up libi for" });
    expect(tablist).toBe(screen.getByTestId("global-setup-agent-switch"));
    expect(within(tablist).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Claude Code", "Codex"]);
    expect(subtitle.compareDocumentPosition(tablist) & FOLLOWING).toBeTruthy();

    const list = screen.getByTestId("libi-agent-card-claude-code");
    expect(panelOf("claude-code")).toHaveAttribute("role", "tabpanel");
    expect(panelOf("claude-code")).toContainElement(list);
    expect(tablist.compareDocumentPosition(list) & FOLLOWING).toBeTruthy();
    // No card: nothing bordered or rounded around the list, and no header naming the agent — the switch does that.
    expect(list.className).not.toMatch(/border|rounded/);
    expect(section.queryByRole("heading", { name: /^(claude code|codex)$/i })).toBeNull();

    const tools = within(list).getByRole("region", { name: "Claude Code tools" });
    const skills = within(list).getByRole("region", { name: "Claude Code skills" });
    expect(Array.from(list.children)).toEqual([tools, skills]);
    expect(within(tools).getByRole("heading", { name: "Tools", level: 2 })).toBeInTheDocument();
    expect(within(skills).getByRole("heading", { name: "Skills", level: 2 })).toBeInTheDocument();
    expect(tools).not.toHaveClass("border-t");
    expect(skills).toHaveClass("border-t");
    // The rows keep their own row look, so it still reads as a list.
    expect(within(tools).getByTestId("libi-agent-row-claude-code")).toHaveClass("rounded-lg", "bg-muted/40");
    expect(within(skills).getByTestId("skills-user-row-claude-code")).toHaveClass("rounded-lg", "bg-muted/40");
  });

  it.each([
    ["claude-code", "claude-code"],
    ["codex", "codex"],
    [null, "claude-code"],
  ] as const)("with no setupAgent in the URL, the sidebar's agent (%s) picks the agent shown (%s)", (sidebar, shown) => {
    activeProviderId = sidebar;
    renderTab();
    const hidden = shown === "codex" ? "claude-code" : "codex";
    expect(option(shown)).toHaveAttribute("aria-selected", "true");
    expect(option(hidden)).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId(`libi-agent-card-${shown}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`libi-agent-card-${hidden}`)).toBeNull();
    // Nothing was picked, so nothing is written.
    expect(replace).not.toHaveBeenCalled();
  });

  it("switching shows only that agent's Tools and Skills, and writes setupAgent to the URL", () => {
    renderTab();
    showAgent("codex");
    expect(option("codex")).toHaveAttribute("aria-selected", "true");
    expect(option("claude-code")).toHaveAttribute("aria-selected", "false");
    expect(replace).toHaveBeenCalledWith("/agents?setupAgent=codex", { scroll: false });
    expect(screen.getByRole("region", { name: "Codex tools" })).toContainElement(screen.getByTestId("libi-agent-row-codex"));
    expect(screen.getByRole("region", { name: "Codex skills" })).toContainElement(screen.getByTestId("skills-folders-row-codex"));
    for (const testId of ["libi-agent-card-claude-code", "libi-agent-row-claude-code", "skills-user-row-claude-code", "skills-folders-row-claude-code"]) {
      expect(screen.queryByTestId(testId)).toBeNull();
    }
    expect(screen.queryByRole("region", { name: /^Claude Code (tools|skills)$/ })).toBeNull();

    showAgent("claude-code");
    expect(replace).toHaveBeenLastCalledWith("/agents?setupAgent=claude-code", { scroll: false });
    expect(screen.getByTestId("libi-agent-row-claude-code")).toBeInTheDocument();
    expect(screen.queryByTestId("libi-agent-row-codex")).toBeNull();
  });

  it("a half-typed folder on one agent doesn't carry over to the other", () => {
    renderTab();
    const claudeFolders = within(screen.getByTestId("skills-folders-row-claude-code"));
    fireEvent.click(claudeFolders.getByRole("button", { name: /^add folder$/i }));
    fireEvent.change(claudeFolders.getByRole("textbox"), { target: { value: "/Users/me/half-typed" } });
    showAgent("codex");
    expect(within(screen.getByTestId("skills-folders-row-codex")).queryByRole("textbox")).toBeNull();
    expect(screen.queryByDisplayValue("/Users/me/half-typed")).toBeNull();
  });

  it("shares its selection with the Providers tab: the setupAgent one writes is the agent the other opens on, over the sidebar's", () => {
    const queryOf = () => (replace.mock.lastCall![0] as string).split("?")[1];
    activeProviderId = "claude-code";
    const globalSetup = render(tree(<GlobalSetupTab />));
    showAgent("codex");
    search = queryOf();
    expect(search).toBe("setupAgent=codex");
    globalSetup.unmount();

    const providers = render(tree(<ProvidersTab provider={null} />));
    expect(screen.getByTestId("providers-agent-option-codex")).toHaveAttribute("aria-selected", "true");

    // And back: a pick on Providers is what Global setup opens on, even with Codex in the sidebar.
    activeProviderId = "codex";
    fireEvent.click(screen.getByTestId("providers-agent-option-claude-code"));
    search = queryOf();
    expect(search).toBe("setupAgent=claude-code");
    providers.unmount();

    render(tree(<GlobalSetupTab />));
    expect(option("claude-code")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("libi-agent-card-claude-code")).toBeInTheDocument();
    expect(screen.queryByTestId("libi-agent-card-codex")).toBeNull();
  });

  it("says Connected beside an agent whose Libi MCP row is connected, and nothing while loading or when its status or config can't be read", () => {
    bothReady();
    registration = { "claude-code": { state: "connected", scope: "user" }, codex: { state: "not-connected" } };
    const { rerender } = render(tree(<GlobalSetupTab />));
    expect(option("claude-code").textContent).toBe("Claude Code Connected");
    expect(option("codex").textContent).toBe("Codex");

    // Codex's row keeps Connected from its last good listing (marked last known), so the switch says so too.
    registration = {
      "claude-code": { state: "stale-port", scope: "user" },
      codex: { state: "connected", url: "http://127.0.0.1:3457/mcp?agent=codex", stale: true },
    };
    rerender(tree(<GlobalSetupTab />));
    expect(option("claude-code").textContent).toBe("Claude Code");
    expect(option("codex").textContent).toBe("Codex Connected");

    // The config can't be read.
    registration = { "claude-code": { state: "unknown" }, codex: { state: "unknown" } };
    rerender(tree(<GlobalSetupTab />));
    expect(option("claude-code").textContent).toBe("Claude Code");
    expect(option("codex").textContent).toBe("Codex");

    // The status can't be read, so neither can the config's meaning.
    registration = { "claude-code": { state: "connected", scope: "user" }, codex: { state: "connected", url: "u" } };
    status = undefined;
    rerender(tree(<GlobalSetupTab />));
    expect(option("claude-code").textContent).toBe("Claude Code");
    expect(option("codex").textContent).toBe("Codex");

    // Still loading.
    bothReady();
    registrationLoading = true;
    rerender(tree(<GlobalSetupTab />));
    expect(option("claude-code").textContent).toBe("Claude Code");
    expect(option("codex").textContent).toBe("Codex");

    registrationLoading = false;
    rerender(tree(<GlobalSetupTab />));
    expect(option("claude-code").textContent).toBe("Claude Code Connected");
    expect(option("codex").textContent).toBe("Codex Connected");
  });

  it("a terminal open for the other agent leaves one line where the list starts, and Show <Agent> switches back to it under the Tools row", async () => {
    bothReady();
    registration = {
      "claude-code": { state: "connected", scope: "local" },
      codex: { state: "stale-port", url: "http://127.0.0.1:3400/mcp?agent=codex" },
    };
    renderTab();
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("libi-agent-row-claude-code")).getByRole("button", { name: /disconnect/i }));
    });
    expect(within(screen.getByRole("region", { name: "Claude Code tools" })).getByTestId("setup-terminal-global-setup")).toBeInTheDocument();
    expect(screen.queryByTestId("global-setup-other-agent-terminal")).toBeNull();

    showAgent("codex");
    expect(screen.queryByTestId("setup-terminal-global-setup")).toBeNull();
    const line = screen.getByTestId("global-setup-other-agent-terminal");
    expect(line).toHaveTextContent("Claude Code has a setup command open.");
    expect(panelOf("codex")).toContainElement(line);
    expect(line.compareDocumentPosition(screen.getByTestId("libi-agent-card-codex")) & FOLLOWING).toBeTruthy();
    // Switching hides the terminal; it never closes it.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    replace.mockClear();
    const show = within(line).getByRole("button", { name: "Show Claude Code" });
    expect(show).toHaveClass("cursor-pointer");
    fireEvent.click(show);
    expect(option("claude-code")).toHaveAttribute("aria-selected", "true");
    expect(replace).toHaveBeenCalledWith("/agents?setupAgent=claude-code", { scroll: false });
    expect(screen.queryByTestId("global-setup-other-agent-terminal")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Claude Code tools" })).getByTestId("setup-terminal-global-setup")).toBeInTheDocument();

    // The same the other way round.
    showAgent("codex");
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("libi-agent-row-codex")).getByRole("button", { name: /reconnect/i }));
    });
    showAgent("claude-code");
    expect(screen.getByTestId("global-setup-other-agent-terminal")).toHaveTextContent("Codex has a setup command open.");
    fireEvent.click(screen.getByRole("button", { name: "Show Codex" }));
    expect(within(screen.getByRole("region", { name: "Codex tools" })).getByTestId("setup-terminal-global-setup")).toBeInTheDocument();
    expect(screen.getAllByTestId("setup-terminal-global-setup")).toHaveLength(1);
  });

  it.each([
    ["simulate-exit", "Claude Code's setup command finished."],
    ["simulate-gone", "Claude Code's setup terminal was closed."],
  ] as const)("once the other agent's terminal ends (%s) its line says %j, and Show Claude Code still leads back to it", async (ending, text) => {
    bothReady();
    registration = { "claude-code": { state: "connected", scope: "local" }, codex: { state: "not-connected" } };
    renderTab();
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("libi-agent-row-claude-code")).getByRole("button", { name: /disconnect/i }));
    });
    fireEvent.click(screen.getByRole("button", { name: ending }));

    showAgent("codex");
    const line = screen.getByTestId("global-setup-other-agent-terminal");
    expect(line).toHaveTextContent(text);
    expect(line).not.toHaveTextContent("has a setup command open");
    fireEvent.click(within(line).getByRole("button", { name: "Show Claude Code" }));
    expect(option("claude-code")).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("region", { name: "Claude Code tools" })).getByTestId("setup-terminal-global-setup")).toBeInTheDocument();
  });

  it("a terminal whose button named no agent shows under the list, whichever agent is selected", async () => {
    render(tree(<><Opener /><GlobalSetupTab /></>));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "open-terminal" }));
    });
    for (const id of AGENT_IDS) {
      showAgent(id);
      const terminal = screen.getByTestId("setup-terminal-global-setup");
      const list = screen.getByTestId(`libi-agent-card-${id}`);
      expect(list).not.toContainElement(terminal);
      expect(list.compareDocumentPosition(terminal) & FOLLOWING).toBeTruthy();
      expect(panelOf(id)).toContainElement(terminal);
      expect(screen.queryByTestId("global-setup-other-agent-terminal")).toBeNull();
    }
  });

  it("while the list loads, one skeleton stands in for it under the switch; a terminal for the selected agent still shows, and one for the other agent leaves the line", async () => {
    registrationLoading = true;
    render(tree(<><Opener anchor="claude-code" /><GlobalSetupTab /></>));
    const skeleton = screen.getByTestId("global-setup-list-skeleton");
    expect(screen.getByTestId("global-setup-agent-switch").compareDocumentPosition(skeleton) & FOLLOWING).toBeTruthy();
    expect(screen.queryAllByTestId(/^libi-agent-(card|row)-/)).toHaveLength(0);
    expect(screen.queryByText(/loading/i)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "open-terminal" }));
    });
    expect(screen.getByTestId("setup-terminal-global-setup")).toBeInTheDocument();
    expect(skeleton.compareDocumentPosition(screen.getByTestId("setup-terminal-global-setup")) & FOLLOWING).toBeTruthy();

    showAgent("codex");
    expect(screen.getByTestId("global-setup-list-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-terminal-global-setup")).toBeNull();
    expect(screen.getByTestId("global-setup-other-agent-terminal")).toHaveTextContent("Claude Code has a setup command open.");
  });
});

describe("which tab holds what", () => {
  function renderOnly(node: React.ReactNode) {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <SetupTerminalHost>{node}</SetupTerminalHost>
      </QueryClientProvider>,
    );
  }

  it("the Libi MCP tab keeps the endpoint, sessions and extensions, and no longer holds the agents' global setup", () => {
    renderOnly(<LibiMcpTab extension={null} />);
    expect(screen.getByTestId("endpoint-card")).toBeInTheDocument();
    expect(screen.getByTestId("extensions")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Claude Code and Codex setup" })).toBeNull();
    expect(screen.queryByTestId(/libi-agent-card-/)).toBeNull();
    expect(screen.queryByText("npx @nagellabs/libi connect", { exact: true })).toBeNull();
  });

  it("the Global setup tab holds the Claude Code | Codex switch, one agent's list at a time, and the connect command, and nothing about the endpoint", () => {
    renderOnly(<GlobalSetupTab />);
    expect(screen.getByRole("region", { name: "Claude Code and Codex setup" })).toBeInTheDocument();
    expect(screen.queryByText("Global Claude Code and Codex configuration")).toBeNull();
    expect(screen.getByTestId("global-setup-agent-switch")).toBeInTheDocument();
    expect(screen.getByTestId("libi-agent-card-claude-code")).toBeInTheDocument();
    expect(screen.queryByTestId("libi-agent-card-codex")).toBeNull();
    showAgent("codex");
    expect(screen.getByTestId("libi-agent-card-codex")).toBeInTheDocument();
    expect(screen.queryByTestId("libi-agent-card-claude-code")).toBeNull();
    expect(screen.getByText("npx @nagellabs/libi connect", { exact: true })).toBeInTheDocument();
    expect(screen.queryByTestId("endpoint-card")).toBeNull();
    expect(screen.queryByTestId("extensions")).toBeNull();
  });
});

describe("Global setup tab — libi_mcp_connected is the OBSERVED registration, never the click", () => {
  function tree(qc: QueryClient) {
    return (
      <QueryClientProvider client={qc}>
        <SetupTerminalHost>
          <GlobalSetupTab />
        </SetupTerminalHost>
      </QueryClientProvider>
    );
  }

  it("Connect reports nothing on the click; the registration reading connected afterwards reports it once", async () => {
    vi.mocked(trackEvent).mockClear();
    const qc = new QueryClient();
    const { rerender } = render(tree(qc));
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("libi-agent-row-claude-code")).getByRole("button", { name: /^connect$/i }));
    });
    expect(trackEvent).toHaveBeenCalledWith("setup_terminal_opened", { surface: "global-setup", action: "connect-libi" });
    expect(trackEvent).not.toHaveBeenCalledWith("libi_mcp_connected", expect.anything());

    registration = { "claude-code": { state: "connected", scope: "user" }, codex: { state: "not-connected" } };
    act(() => rerender(tree(qc)));
    expect(screen.getByTestId("libi-agent-row-claude-code")).toHaveTextContent("Connected");
    expect(trackEvent).toHaveBeenCalledWith("libi_mcp_connected", { agent: "claude-code", action: "connect-libi", surface: "global-setup" });
    act(() => rerender(tree(qc)));
    expect(vi.mocked(trackEvent).mock.calls.filter(([name]) => name === "libi_mcp_connected")).toHaveLength(1);
  });

  it("Reconnect from an old port reports action reconnect-libi, and a stale (last known) Codex listing does not count", async () => {
    vi.mocked(trackEvent).mockClear();
    registration = { "claude-code": { state: "not-connected" }, codex: { state: "stale-port", url: "http://127.0.0.1:3400/mcp?agent=codex" } };
    status = { "claude-code": ready("/u/bin/claude"), codex: ready("/u/bin/codex") };
    const qc = new QueryClient();
    const { rerender } = render(tree(qc));
    showAgent("codex");
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("libi-agent-row-codex")).getByRole("button", { name: /reconnect/i }));
    });
    registration = { "claude-code": { state: "not-connected" }, codex: { state: "connected", stale: true } };
    act(() => rerender(tree(qc)));
    expect(trackEvent).not.toHaveBeenCalledWith("libi_mcp_connected", expect.anything());
    registration = { "claude-code": { state: "not-connected" }, codex: { state: "connected" } };
    act(() => rerender(tree(qc)));
    expect(trackEvent).toHaveBeenCalledWith("libi_mcp_connected", { agent: "codex", action: "reconnect-libi", surface: "global-setup" });
  });

  it("an agent that was already connected when the tab opened reports nothing", () => {
    vi.mocked(trackEvent).mockClear();
    registration = { "claude-code": { state: "connected", scope: "user" }, codex: { state: "not-connected" } };
    render(tree(new QueryClient()));
    expect(screen.getByTestId("libi-agent-row-claude-code")).toHaveTextContent("Connected");
    expect(trackEvent).not.toHaveBeenCalledWith("libi_mcp_connected", expect.anything());
  });
});
