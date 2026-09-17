// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentStatus } from "@/lib/agents/agent-status";
import { connectLibiCommand, reconnectLibiCommand } from "@/lib/agents/setup/commands";
import type { JobStatusSnapshot } from "@/lib/jobs/types";
import type { SkillInstallView, SkillInstallsResponse } from "@/lib/agents/skill-installs-types";

/**
 * The setup wizard's steps. libi never runs an installer or writes an agent's
 * config: every command is typed into the page's setup terminal and the user
 * presses Enter. The setup terminal host is the real one over a stubbed fetch,
 * so the command a button opens is observable in the POST body.
 */

let status: AgentStatus | undefined;
let statusReadStartedAt = Date.now();
let job: JobStatusSnapshot | null = null;
let flavor: "posix" | "powershell" | undefined = "posix";
let endpointUrl: string | undefined = "http://127.0.0.1:3457/mcp";
const statusCalls = vi.fn();
const recheck = vi.fn(async () => status as AgentStatus);
const startInstall = vi.fn();
let startState: { isPending: boolean; isError: boolean; error: Error | null; data?: { jobId: string } } = {
  isPending: false,
  isError: false,
  error: null,
};
let installs: SkillInstallsResponse | undefined = { installs: [], userSkillsDirs: { "claude-code": "~/.claude/skills", codex: "~/.agents/skills" } };
let installsLoading = false;
let installsFetching = false;
const refetchInstalls = vi.fn();
let addPending = false;
const addInstall = vi.fn<(v: unknown) => Promise<SkillInstallView>>();
const toastError = vi.fn();
const trackEvent = vi.fn();
const push = vi.fn();
const selectAgent = vi.fn<(id: string) => Promise<unknown>>(async () => null);
const createSessionWithResult = vi.fn(async () => ({ sessionId: "s1" as string | null, error: null as string | null }));
const setLastSessionId = vi.fn();

vi.mock("@/hooks/agents/use-agent-status", () => ({
  useWizardAgentStatus: (agent: string | null, opts: { polling: boolean }) => {
    statusCalls(agent, opts);
    return { status: agent ? status : undefined, isLoading: false, readStartedAt: statusReadStartedAt, recheck, rechecking: false };
  },
}));
// The sign-in confirmation is the real hook, so its POST reaches the stubbed fetch.
vi.mock("@/lib/queries/agent-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/agent-status")>();
  return {
    agentStatusKeys: actual.agentStatusKeys,
    useConfirmAgentSignIn: actual.useConfirmAgentSignIn,
    useAgentInstall: () => ({ data: { job } }),
    useStartAgentInstall: () => ({ mutate: startInstall, ...startState }),
    isAgentInstallInFlight: (j: JobStatusSnapshot | null | undefined) =>
      j?.status === "queued" || j?.status === "running" || j?.status === "cancel-requested",
  };
});
vi.mock("@/hooks/terminal/use-shell-flavor", () => ({ useShellFlavor: () => ({ data: flavor }) }));
vi.mock("@/lib/queries/mcp-health", () => ({
  useMcpHealth: () => ({ data: endpointUrl ? { url: endpointUrl } : undefined }),
}));
const refreshRegistration = vi.fn();
let refreshRegistrationPending = false;
vi.mock("@/lib/queries/libi-registration", () => ({
  useRefreshLibiRegistration: () => ({ mutate: refreshRegistration, isPending: refreshRegistrationPending }),
}));
vi.mock("@/lib/queries/skill-installs", async (orig) => {
  const actual = await orig<typeof import("@/lib/queries/skill-installs")>();
  return {
    ...actual,
    useSkillInstalls: () => ({ data: installs, isLoading: installsLoading, isFetching: installsFetching, refetch: refetchInstalls }),
    useAddSkillInstall: () => ({ mutateAsync: addInstall, isPending: addPending }),
    useRemoveSkillInstall: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});
type WizardPickResult = { status: "picked"; path: string } | { status: "cancelled" } | { status: "unavailable"; reason: string } | { status: "busy" };
// Overridden by tests that need to control exactly when the dialog "resolves"
// (e.g. a pick that comes back after the user has already cancelled).
let pickFolderImpl: (() => Promise<WizardPickResult>) | null = null;
vi.mock("@/lib/shell/client", () => ({
  pickFolder: async () => (pickFolderImpl ? pickFolderImpl() : { status: "picked", path: "/Users/me/proj" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) } }));
vi.mock("@/lib/agents/cli/min-versions", () => ({
  AGENT_CLI_MIN_VERSION: { "claude-code": "2.1.245", codex: "0.153.4" },
  CLAUDE_UPDATE_SUBCOMMAND_EXISTS: true,
}));
vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ selectAgent, sessionList: { createSessionWithResult }, setLastSessionId }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/analytics/client", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));
vi.mock("@/components/terminal/setup-terminal", async () => {
  const { useSetupTerminalHost } = await import("@/components/agents-page/setup-terminal-host");
  return {
    SetupTerminal: ({ surface }: { surface: "agents" }) => {
      const entry = useSetupTerminalHost().terminals[surface];
      return entry ? <div data-testid={`setup-terminal-${surface}`} data-command={entry.command} /> : null;
    },
  };
});

import { Wizard } from "@/components/agents-page/agents-tab/wizard";
import { SetupTerminalHost } from "@/components/agents-page/setup-terminal-host";
import type { WizardStep } from "@/components/agents-page/agents-tab/wizard-state";

const fetchMock = vi.fn<typeof fetch>();
const onStep = vi.fn();
const onAgent = vi.fn();
const onClose = vi.fn();
const onFinish = vi.fn();
let qc: QueryClient;

// `path` is what the user's PATH found; `realPath` is where it resolves. Every
// printed command must use `realPath`, so the two differ in every fixture.
const CLAUDE_PATHS = { path: "/usr/local/bin/claude", realPath: "/u/claude" };

function usable(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    agentId: "claude-code",
    cli: { ...CLAUDE_PATHS, version: "2.1.250", meetsMinimum: true },
    adapter: "ready",
    signIn: { confirmedAt: null, needsAuth: false },
    libiTools: { state: "not-connected" },
    ready: true,
    ...over,
  };
}

function installJob(over: Partial<JobStatusSnapshot>): JobStatusSnapshot {
  return {
    id: "j1",
    kind: "agent_install",
    status: "running",
    pieceId: null,
    fileId: null,
    progressDone: 0,
    progressTotal: 0,
    progressUnit: "step",
    etaMs: null,
    msPerUnit: null,
    msSinceProgress: null,
    error: null,
    resultJson: null,
    startedAt: null,
    completedAt: null,
    lastProgressAt: null,
    ...over,
  };
}

function install(over: Partial<SkillInstallView>): SkillInstallView {
  return {
    id: "i1",
    agentId: "claude-code",
    scope: "folder",
    path: "/p/.claude/skills",
    folderPath: "/p",
    source: "ui",
    status: "up-to-date",
    error: null,
    skippedNames: [],
    installedCount: 3,
    lastSyncedAt: null,
    ...over,
  };
}

/** `closable: false` is how the Agents tab renders a first onboarding's wizard: no onClose. */
function ui(step: WizardStep, agent: "claude-code" | "codex" | null = "claude-code", opts: { closable?: boolean } = {}) {
  return (
    <QueryClientProvider client={qc}>
      <SetupTerminalHost>
        <Wizard
          agent={agent}
          step={step}
          onStep={onStep}
          onAgent={onAgent}
          onClose={opts.closable === false ? undefined : onClose}
          onFinish={onFinish}
        />
      </SetupTerminalHost>
    </QueryClientProvider>
  );
}

function terminalPosts() {
  return fetchMock.mock.calls.filter(([input, init]) => init?.method === "POST" && String(input) === "/api/terminal/sessions");
}

function lastTerminalBody(): { initialInput: string; surface: string } {
  return JSON.parse(String(terminalPosts().at(-1)![1]!.body)) as { initialInput: string; surface: string };
}

async function click(name: RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  status = usable();
  statusReadStartedAt = Date.now();
  job = null;
  startState = { isPending: false, isError: false, error: null };
  flavor = "posix";
  endpointUrl = "http://127.0.0.1:3457/mcp";
  installs = { installs: [], userSkillsDirs: { "claude-code": "~/.claude/skills", codex: "~/.agents/skills" } };
  installsLoading = false;
  installsFetching = false;
  addPending = false;
  refetchInstalls.mockReset();
  addInstall.mockReset();
  addInstall.mockResolvedValue(install({ id: "new" }));
  pickFolderImpl = null;
  refreshRegistrationPending = false;
  for (const m of [
    statusCalls,
    recheck,
    startInstall,
    toastError,
    trackEvent,
    push,
    setLastSessionId,
    onStep,
    onAgent,
    onClose,
    onFinish,
    refreshRegistration,
  ]) {
    m.mockClear();
  }
  selectAgent.mockReset();
  selectAgent.mockImplementation(async () => null);
  createSessionWithResult.mockReset();
  createSessionWithResult.mockImplementation(async () => ({ sessionId: "s1", error: null }));
  let nextId = 1;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST" && url === "/api/terminal/sessions") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ id: `term-${nextId++}`, purpose: "setup", surface: body.surface, title: "Setup", cliId: "shell", createdAt: 1, status: "running" }),
        { status: 201 },
      );
    }
    if (init?.method === "POST" && url.endsWith("/sign-in-confirmation")) {
      return new Response(JSON.stringify({ confirmedAt: "2026-09-11T00:00:00.000Z" }), { status: 200 });
    }
    if (init?.method === "DELETE") return new Response(JSON.stringify({ success: true }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("Wizard — step 1, choose", () => {
  it("offers both agents with their blurbs; picking one reports it and moves on", async () => {
    render(ui(1, null));
    expect(screen.getByRole("button", { name: /claude code/i })).toHaveTextContent("Anthropic's coding agent. Best results with libi.");
    expect(screen.getByRole("button", { name: /codex/i })).toHaveTextContent("OpenAI's coding agent.");
    await click(/codex/i);
    expect(onAgent).toHaveBeenCalledWith("codex");
    expect(trackEvent).toHaveBeenCalledWith("agent_wizard_step_completed", { agent: "codex", step: "choose" });
  });
});

describe("Wizard — header", () => {
  it("Close closes the wizard", async () => {
    render(ui(2));
    await click(/^close$/i);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a wizard with nothing to close to (a first onboarding) has no Close, and can still go back to step 1", async () => {
    render(ui(2, "claude-code", { closable: false }));
    expect(screen.queryByRole("button", { name: /^close$/i })).toBeNull();
    await click(/set up again/i);
    expect(onStep).toHaveBeenCalledWith(1);
  });
});

describe("Wizard — step 2, install", () => {
  it("not found: says so, Install types the official installer, Next is disabled, Check again re-checks", async () => {
    status = usable({ cli: null, adapter: "missing", ready: false });
    render(ui(2));
    expect(screen.getByText(/couldn.t find claude code on your path\. install it\?/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^next$/i })).toBeDisabled();
    await click(/^install$/i);
    await waitFor(() => expect(terminalPosts()).toHaveLength(1));
    expect(lastTerminalBody()).toMatchObject({ surface: "agents", initialInput: "curl -fsSL https://claude.ai/install.sh | bash" });
    expect(await screen.findByTestId("setup-terminal-agents")).toHaveAttribute(
      "data-command",
      "curl -fsSL https://claude.ai/install.sh | bash",
    );
    // No usable CLI yet, so the adapter install does not start either.
    expect(startInstall).not.toHaveBeenCalled();
    await click(/check again/i);
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it("below the minimum version: says so, and Update types the CLI's own updater", async () => {
    status = usable({ cli: { ...CLAUDE_PATHS, version: "2.0.1", meetsMinimum: false }, ready: false });
    render(ui(2));
    expect(screen.getByText("Claude Code 2.0.1 is older than libi needs.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^next$/i })).toBeDisabled();
    await click(/^update$/i);
    await waitFor(() => expect(terminalPosts()).toHaveLength(1));
    expect(lastTerminalBody().initialInput).toBe("/u/claude update");
  });

  it("a CLI that won't run: shows the path, says so without \"found\", and Reinstall types the official installer; Next is disabled", async () => {
    status = usable({ cli: { foundButBroken: true, path: "/opt/broken/claude" }, adapter: "missing", ready: false });
    render(ui(2));
    expect(screen.getByText("/opt/broken/claude")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-step-install")).toHaveTextContent("Claude Code is installed but won't run. Reinstall it?");
    expect(screen.getByTestId("wizard-cli-broken-hint")).toHaveTextContent(
      "If Check again still shows this path after reinstalling, this copy comes first on your PATH — remove or repair it.",
    );
    expect(screen.getByTestId("wizard-step-install")).not.toHaveTextContent(/found/i);
    expect(screen.getByRole("button", { name: /^next$/i })).toBeDisabled();
    expect(startInstall).not.toHaveBeenCalled();
    await click(/^reinstall$/i);
    await waitFor(() => expect(terminalPosts()).toHaveLength(1));
    expect(lastTerminalBody()).toMatchObject({ surface: "agents", initialInput: "curl -fsSL https://claude.ai/install.sh | bash" });
  });

  it("a usable CLI with the adapter missing starts the adapter install exactly once", () => {
    status = usable({ adapter: "missing", ready: false });
    const { rerender } = render(ui(2));
    expect(startInstall).toHaveBeenCalledTimes(1);
    expect(startInstall).toHaveBeenCalledWith("claude-code");
    rerender(ui(2));
    rerender(ui(2));
    expect(startInstall).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /^starting download…$/i })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: /^next$/i })).toBeNull();
  });

  it("shows MB progress only when the job reports MB — a step count never reads as 1/1 MB", () => {
    status = usable({ adapter: "installing", ready: false });
    job = installJob({ status: "running", progressDone: 12, progressTotal: 56, progressUnit: "MB" });
    const { rerender } = render(ui(2));
    expect(screen.getByTestId("wizard-adapter-progress")).toHaveTextContent("Downloading Claude Code support…");
    expect(screen.getByTestId("wizard-adapter-progress")).toHaveTextContent("12 of 56 MB");
    expect(screen.getByRole("button", { name: /^downloading…$/i })).toHaveAttribute("aria-disabled", "true");
    job = installJob({ status: "running", progressDone: 1, progressTotal: 1, progressUnit: "step" });
    rerender(ui(2));
    // The explanation below always carries the size estimate; the PROGRESS line is what must not claim MB.
    expect(screen.getByTestId("wizard-adapter-progress")).toHaveTextContent("Downloading Claude Code support…");
    expect(screen.getByTestId("wizard-adapter-progress")).not.toHaveTextContent("MB");
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    // A job in flight is never started a second time.
    expect(startInstall).not.toHaveBeenCalled();
  });

  it("a failed install job is never restarted on its own: its error and Retry show, and Retry starts it", async () => {
    status = usable({ adapter: "missing", ready: false });
    job = installJob({ status: "failed", error: "npm exited with code 1" });
    const { rerender } = render(ui(2));
    rerender(ui(2));
    expect(startInstall).not.toHaveBeenCalled();
    expect(screen.getByTestId("wizard-adapter")).toHaveTextContent("npm exited with code 1");
    await click(/^retry download$/i);
    expect(startInstall).toHaveBeenCalledTimes(1);
    expect(startInstall).toHaveBeenCalledWith("claude-code");
  });

  it("a start POST the server refused shows its message and Retry, and only Retry starts it again", async () => {
    status = usable({ adapter: "missing", ready: false });
    const { rerender } = render(ui(2));
    expect(startInstall).toHaveBeenCalledTimes(1);
    startState = { isPending: false, isError: true, error: new Error("Another install is already running") };
    rerender(ui(2));
    const line = screen.getByTestId("wizard-adapter");
    expect(line).toHaveTextContent("Couldn't download Claude Code support.");
    expect(line).toHaveTextContent("Another install is already running");
    expect(startInstall).toHaveBeenCalledTimes(1);
    await click(/^retry download$/i);
    expect(startInstall).toHaveBeenCalledTimes(2);
    expect(startInstall).toHaveBeenLastCalledWith("claude-code");
  });

  it("reads as installing while the start POST is pending, before any job exists", () => {
    status = usable({ adapter: "missing", ready: false });
    startState = { isPending: true, isError: false, error: null };
    render(ui(2));
    expect(screen.getByTestId("wizard-adapter")).toHaveTextContent("Downloading Claude Code support…");
    expect(screen.queryByRole("button", { name: /^retry download$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^downloading…$/i })).toHaveAttribute("aria-disabled", "true");
  });

  it("a cancelled install job shows Retry and is not restarted; an adapter reported failed shows Retry too", () => {
    status = usable({ adapter: "missing", ready: false });
    job = installJob({ status: "cancelled" });
    const { unmount } = render(ui(2));
    expect(startInstall).not.toHaveBeenCalled();
    expect(screen.getByTestId("wizard-adapter")).toHaveTextContent("Downloading Claude Code support was cancelled.");
    expect(screen.getByRole("button", { name: /^retry download$/i })).toBeInTheDocument();
    unmount();
    status = usable({ adapter: "failed", ready: false });
    job = null;
    render(ui(2));
    expect(startInstall).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^retry download$/i })).toBeInTheDocument();
  });

  it("an install that finished with the adapter still missing offers Retry once its own start settled on that job", async () => {
    status = usable({ adapter: "missing", ready: false });
    job = installJob({ id: "j-old", status: "completed", completedAt: new Date("2026-09-01T00:00:00.000Z") });
    const { rerender } = render(ui(2));
    // An old success does not stop the step from trying again.
    expect(startInstall).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^retry download$/i })).toBeNull();
    // The server answered with that same finished job: there is nothing left to wait for.
    startState = { isPending: false, isError: false, error: null, data: { jobId: "j-old" } };
    rerender(ui(2));
    expect(screen.getByTestId("wizard-adapter")).toHaveTextContent("Couldn't download Claude Code support.");
    expect(screen.queryByRole("button", { name: /^next$/i })).toBeNull();
    await click(/^retry download$/i);
    expect(startInstall).toHaveBeenCalledTimes(2);
    expect(startInstall).toHaveBeenLastCalledWith("claude-code");
  });

  it("a start that queued a fresh job, or a status read before the job finished, never reads as a failure", () => {
    status = usable({ adapter: "missing", ready: false });
    job = installJob({ id: "j-old", status: "completed", completedAt: new Date("2026-09-01T00:00:00.000Z") });
    startState = { isPending: false, isError: false, error: null, data: { jobId: "j-new" } };
    const { rerender } = render(ui(2));
    expect(screen.queryByRole("button", { name: /^retry download$/i })).toBeNull();
    // The fresh job finished, but the read behind the status in hand began before it did.
    job = installJob({ id: "j-new", status: "completed", completedAt: new Date("2026-09-11T12:00:00.000Z") });
    statusReadStartedAt = Date.parse("2026-09-11T11:59:59.000Z");
    rerender(ui(2));
    expect(screen.queryByRole("button", { name: /^retry download$/i })).toBeNull();
    // A read that began after it still says missing: now the install really left nothing.
    statusReadStartedAt = Date.parse("2026-09-11T12:00:01.000Z");
    rerender(ui(2));
    expect(screen.getByRole("button", { name: /^retry download$/i })).toBeInTheDocument();
  });

  it("a wait that resolves to nothing turns the button into Retry download after a few seconds", () => {
    vi.useFakeTimers();
    try {
      status = usable({ adapter: "missing", ready: false });
      // Another window forced a newer job that also left no adapter; this window's
      // own start settled on the older one, so the finished job it sees is not its own.
      job = installJob({ id: "j3", status: "completed", completedAt: new Date("2026-09-11T12:00:00.000Z") });
      startState = { isPending: false, isError: false, error: null, data: { jobId: "j2" } };
      statusReadStartedAt = Date.parse("2026-09-11T12:00:01.000Z");
      const { rerender } = render(ui(2));
      expect(startInstall).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: /^retry download$/i })).toBeNull();
      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      rerender(ui(2)); // a status poll landing does not restart the wait
      expect(screen.queryByRole("button", { name: /^retry download$/i })).toBeNull();
      // Its own start reached the server, so until then the step reads as downloading, not starting over.
      expect(screen.getByRole("button", { name: /^downloading…$/i })).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByTestId("wizard-adapter-progress")).toHaveTextContent("Downloading Claude Code support…");
      act(() => {
        vi.advanceTimersByTime(1_500);
      });
      expect(screen.getByTestId("wizard-adapter")).not.toHaveTextContent("Couldn't download");
      expect(screen.queryByRole("button", { name: /^next$/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /^starting download…$|^downloading…$/i })).toBeNull();
      expect(screen.getByRole("button", { name: /^retry download$/i })).toBeEnabled();
      // Nothing on the panel still looks busy beside Retry.
      expect(screen.getByTestId("wizard-adapter-stalled")).toHaveTextContent("Claude Code support didn't start downloading.");
      expect(screen.queryByRole("progressbar")).toBeNull();
      expect(screen.getByTestId("wizard-adapter")).not.toHaveTextContent(/starting|downloading…/i);
      fireEvent.click(screen.getByRole("button", { name: /^retry download$/i }));
      expect(startInstall).toHaveBeenCalledTimes(2);
      expect(startInstall).toHaveBeenLastCalledWith("claude-code");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a usable CLI and a ready adapter enable Next, which reports the step and moves to sign-in", async () => {
    render(ui(2));
    expect(screen.getByText("Claude Code 2.1.250 is installed.")).toBeInTheDocument();
    expect(screen.getByText("/usr/local/bin/claude")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-adapter")).toHaveTextContent("Claude Code support is downloaded.");
    await click(/^next$/i);
    expect(onStep).toHaveBeenCalledWith(3);
    expect(trackEvent).toHaveBeenCalledWith("agent_wizard_step_completed", { agent: "claude-code", step: "install" });
    expect(startInstall).not.toHaveBeenCalled();
  });
});

/**
 * The step used to say "Found Claude Code 2.1.267." and then "Installing Claude
 * Code support…" — so was it found or not? The CLI is the user's and is
 * installed; what libi fetches is its own support for running that CLI in libi's
 * chat. The two lines say exactly that, and the download says it is a download.
 */
describe("Wizard — step 2, what the install step says", () => {
  it("an installed CLI reads as installed, and the download says what libi fetches for its chat and how big, once", () => {
    status = usable({ adapter: "installing", ready: false });
    job = installJob({ status: "running", progressDone: 22, progressTotal: 56, progressUnit: "MB" });
    render(ui(2));
    expect(screen.getByText("Claude Code 2.1.250 is installed.")).toBeInTheDocument();
    expect(screen.getByText("/usr/local/bin/claude")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-adapter-needed")).toHaveTextContent(
      "libi needs to download Claude Code support to run it in libi's chat (56 MB, one time).",
    );
    expect(screen.getByTestId("wizard-adapter-progress")).toHaveTextContent("Downloading Claude Code support…");
    expect(screen.getByTestId("wizard-adapter-progress")).toHaveTextContent("22 of 56 MB");
    expect(screen.getAllByText(/one time/)).toHaveLength(1);
    // Nothing on the step says the CLI was merely found, or that anything is being installed.
    expect(screen.getByTestId("wizard-step-install")).not.toHaveTextContent(/found|installing/i);
  });

  it("before the download starts, the step already says what it is and how big", () => {
    status = usable({ adapter: "missing", ready: false });
    render(ui(2));
    expect(startInstall).toHaveBeenCalledWith("claude-code");
    expect(screen.getByTestId("wizard-adapter-needed")).toHaveTextContent(
      "libi needs to download Claude Code support to run it in libi's chat (56 MB, one time).",
    );
    expect(screen.getByTestId("wizard-adapter")).not.toHaveTextContent("Downloading");
    expect(screen.getByTestId("wizard-adapter-starting")).toHaveTextContent("Starting to download Claude Code support…");
  });

  it("downloaded, failed and cancelled each say download, and none repeats the explanation", () => {
    const ready = render(ui(2));
    expect(screen.getByTestId("wizard-adapter")).toHaveTextContent("Claude Code support is downloaded.");
    expect(screen.queryByTestId("wizard-adapter-needed")).toBeNull();
    ready.unmount();

    status = usable({ adapter: "missing", ready: false });
    job = installJob({ status: "failed", error: "npm exited with code 1" });
    const failed = render(ui(2));
    expect(screen.getByTestId("wizard-adapter")).toHaveTextContent("Couldn't download Claude Code support.");
    expect(screen.queryByTestId("wizard-adapter-needed")).toBeNull();
    failed.unmount();

    job = installJob({ status: "cancelled" });
    render(ui(2));
    expect(screen.getByTestId("wizard-adapter")).toHaveTextContent("Downloading Claude Code support was cancelled.");
    expect(screen.queryByTestId("wizard-adapter-needed")).toBeNull();
  });

  it("Codex's lines name Codex and its own download size", () => {
    status = usable({
      agentId: "codex",
      cli: { path: "/usr/local/bin/codex", realPath: "/u/codex", version: "0.160.0", meetsMinimum: true },
      adapter: "missing",
      ready: false,
    });
    render(ui(2, "codex"));
    expect(screen.getByText("Codex 0.160.0 is installed.")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-adapter-needed")).toHaveTextContent(
      "libi needs to download Codex support to run it in libi's chat (17 MB, one time).",
    );
  });

  it("without the CLI the step still offers to install it, and says nothing about a download yet", () => {
    status = usable({ cli: null, adapter: "missing", ready: false });
    render(ui(2));
    expect(screen.getByText(/couldn.t find claude code on your path\. install it\?/i)).toBeInTheDocument();
    expect(screen.queryByTestId("wizard-adapter")).toBeNull();
  });
});

/**
 * A disabled Next with the download in small print under the CLI line read as a
 * broken button. The download is its own panel with a bar, and every wait in the
 * wizard is named on the button that waits for it.
 */
describe("Wizard — a wait is named where the user looks", () => {
  it("while the download runs, the button reads Downloading… and the bar and readout say how far along it is", () => {
    status = usable({ adapter: "installing", ready: false });
    job = installJob({ status: "running", progressDone: 22, progressTotal: 56, progressUnit: "MB", etaMs: 90_000 });
    render(ui(2));
    expect(screen.getByRole("button", { name: /^downloading…$/i })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: /^next$/i })).toBeNull();
    expect(screen.getByRole("progressbar", { name: /download progress/i })).toHaveAttribute("aria-valuenow", "39");
    expect(screen.getByTestId("wizard-adapter-progress")).toHaveTextContent("22 of 56 MB · about 2 minutes left");
    expect(screen.getByRole("status")).toHaveTextContent("Downloading Claude Code support…");
  });

  it("a download past its size estimate says it is finishing, never a full bar with time left", () => {
    status = usable({ adapter: "installing", ready: false });
    job = installJob({ status: "running", progressDone: 56, progressTotal: 56, progressUnit: "MB", etaMs: 0 });
    render(ui(2));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByTestId("wizard-adapter-progress")).toHaveTextContent("Finishing up…");
    expect(screen.getByTestId("wizard-adapter-progress")).not.toHaveTextContent(/left|56 of 56/);
  });

  it("once its start reached the server, the step reads as downloading even before the job shows up", () => {
    status = usable({ adapter: "missing", ready: false });
    startState = { isPending: false, isError: false, error: null, data: { jobId: "j-new" } };
    render(ui(2));
    expect(screen.getByTestId("wizard-adapter-progress")).toHaveTextContent("Downloading Claude Code support…");
    expect(screen.queryByTestId("wizard-adapter-starting")).toBeNull();
    expect(screen.getByRole("button", { name: /^downloading…$/i })).toHaveAttribute("aria-disabled", "true");
  });

  it("pressing Retry download keeps keyboard focus on the button while it turns into Downloading…, which ignores clicks", () => {
    status = usable({ adapter: "missing", ready: false });
    job = installJob({ status: "failed", error: "npm exited with code 1" });
    const { rerender } = render(ui(2));
    const button = screen.getByRole("button", { name: /^retry download$/i });
    button.focus();
    fireEvent.click(button);
    expect(startInstall).toHaveBeenCalledTimes(1);
    startState = { isPending: true, isError: false, error: null };
    rerender(ui(2));
    const busy = screen.getByRole("button", { name: /^downloading…$/i });
    expect(busy).toBe(button);
    expect(busy).not.toBeDisabled();
    expect(busy).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(busy);
    expect(startInstall).toHaveBeenCalledTimes(1);
    expect(onStep).not.toHaveBeenCalled();
  });

  it("while the CLI itself isn't usable there is no download panel, and Next is simply disabled", () => {
    status = usable({ cli: { ...CLAUDE_PATHS, version: "2.0.1", meetsMinimum: false }, adapter: "missing", ready: false });
    render(ui(2));
    expect(screen.queryByTestId("wizard-adapter")).toBeNull();
    expect(screen.getByRole("button", { name: /^next$/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /downloading|starting|retry/i })).toBeNull();
    expect(startInstall).not.toHaveBeenCalled();
  });

  it("after Retry, the old failed job never flashes back while the new one is on its way", () => {
    status = usable({ adapter: "failed", ready: false });
    job = installJob({ id: "j1", status: "failed", error: "npm exited with code 1" });
    // The retry's POST returned job j2; the install query still holds j1.
    startState = { isPending: false, isError: false, error: null, data: { jobId: "j2" } };
    const { rerender } = render(ui(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /^retry download$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^downloading…$/i })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("wizard-adapter-progress")).toHaveTextContent("Downloading Claude Code support…");
    job = installJob({ id: "j2", status: "running", progressDone: 3, progressTotal: 56, progressUnit: "MB" });
    status = usable({ adapter: "installing", ready: false });
    rerender(ui(2));
    expect(screen.getByTestId("wizard-adapter-progress")).toHaveTextContent("3 of 56 MB");
    // Once the query has caught up with j2, a j2 that failed does show as failed.
    job = installJob({ id: "j2", status: "failed", error: "npm exited with code 1" });
    status = usable({ adapter: "failed", ready: false });
    rerender(ui(2));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't download Claude Code support.");
  });

  it("one live region stays mounted and says each step of the download as it happens", () => {
    status = usable({ adapter: "missing", ready: false });
    const { rerender } = render(ui(2));
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("Starting to download Claude Code support…");
    status = usable({ adapter: "installing", ready: false });
    job = installJob({ status: "running", progressDone: 10, progressTotal: 56, progressUnit: "MB" });
    rerender(ui(2));
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("Downloading Claude Code support…");
    expect(region).not.toHaveTextContent("MB");
    status = usable({ adapter: "ready" });
    job = installJob({ status: "completed", progressDone: 56, progressTotal: 56, progressUnit: "MB" });
    rerender(ui(2));
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("Claude Code support is downloaded.");
  });

  it("a failure mounts a fresh alert rather than turning the download panel into one", () => {
    status = usable({ adapter: "installing", ready: false });
    job = installJob({ status: "running", progressDone: 10, progressTotal: 56, progressUnit: "MB" });
    const { rerender } = render(ui(2));
    const panel = screen.getByTestId("wizard-adapter");
    status = usable({ adapter: "missing", ready: false });
    job = installJob({ status: "failed", error: "npm exited with code 1" });
    rerender(ui(2));
    expect(screen.getByRole("alert")).not.toBe(panel);
    expect(panel).not.toBeInTheDocument();
  });

  it("a retry whose job never shows up stalls to Retry download and still says what the last attempt reported", () => {
    vi.useFakeTimers();
    try {
      status = usable({ adapter: "failed", ready: false });
      job = installJob({ id: "j1", status: "failed", error: "npm exited with code 1" });
      startState = { isPending: false, isError: false, error: null, data: { jobId: "j2" } };
      render(ui(2));
      expect(screen.queryByRole("alert")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(5_500);
      });
      expect(screen.getByTestId("wizard-adapter-stalled")).toHaveTextContent("Claude Code support didn't start downloading.");
      expect(screen.getByTestId("wizard-adapter")).toHaveTextContent("The last attempt said: npm exited with code 1");
      expect(screen.getByRole("button", { name: /^retry download$/i })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("before the first megabyte lands, the bar keeps moving and claims no figure", () => {
    status = usable({ adapter: "installing", ready: false });
    job = installJob({ status: "running", progressDone: 0, progressTotal: 56, progressUnit: "MB", etaMs: null });
    render(ui(2));
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByTestId("wizard-adapter-progress")).not.toHaveTextContent("MB");
    expect(screen.getByRole("button", { name: /^downloading…$/i })).toHaveAttribute("aria-disabled", "true");
  });

  it("a download that failed puts Retry download where Next was, with the reason in an alert", () => {
    status = usable({ adapter: "missing", ready: false });
    job = installJob({ status: "failed", error: "npm exited with code 1" });
    render(ui(2));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't download Claude Code support.");
    expect(screen.getByRole("alert")).toHaveTextContent("npm exited with code 1");
    expect(screen.getByRole("button", { name: /^retry download$/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^next$|^downloading…$/i })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("once downloaded, Next is the button again and nothing is left moving", () => {
    render(ui(2));
    expect(screen.getByRole("button", { name: /^next$/i })).toBeEnabled();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("button", { name: /downloading|starting|retry/i })).toBeNull();
  });

  it("Codex downloads the same way, naming Codex", () => {
    status = usable({
      agentId: "codex",
      cli: { path: "/usr/local/bin/codex", realPath: "/u/codex", version: "0.160.0", meetsMinimum: true },
      adapter: "installing",
      ready: false,
    });
    job = installJob({ status: "running", progressDone: 5, progressTotal: 17, progressUnit: "MB" });
    render(ui(2, "codex"));
    expect(screen.getByTestId("wizard-adapter-progress")).toHaveTextContent("Downloading Codex support…");
    expect(screen.getByTestId("wizard-adapter-progress")).toHaveTextContent("5 of 17 MB");
    expect(screen.getByRole("button", { name: /^downloading…$/i })).toHaveAttribute("aria-disabled", "true");
  });

  it("the time left reads in plain words", async () => {
    const { remainingLabel } = await import("@/components/agents-page/agents-tab/steps/adapter-download");
    expect(remainingLabel(20_000)).toBe("less than a minute left");
    expect(remainingLabel(80_000)).toBe("about 1 minute left");
    expect(remainingLabel(185_000)).toBe("about 3 minutes left");
  });

  it("confirming a sign-in reads Saving… until the server answers", async () => {
    let release!: () => void;
    fetchMock.mockImplementation(async (input) => {
      if (!String(input).endsWith("/sign-in-confirmation")) throw new Error(`unexpected fetch ${String(input)}`);
      return new Promise<Response>((resolve) => {
        release = () => resolve(new Response(JSON.stringify({ confirmedAt: "2026-09-11T00:00:00.000Z" }), { status: 200 }));
      });
    });
    render(ui(3));
    await click(/i'm already signed in/i);
    const saving = await screen.findByRole("button", { name: /^saving…$/i });
    expect(saving).toHaveAttribute("aria-disabled", "true");
    // aria-disabled, not natively disabled: a native disable would drop keyboard focus.
    expect(saving).not.toBeDisabled();
    await act(async () => release());
    await waitFor(() => expect(onStep).toHaveBeenCalledWith(4));
  });

  it("Open chat names each wait: the agent starting, then the chat opening", async () => {
    let started!: () => void;
    let created!: () => void;
    selectAgent.mockImplementation(() => new Promise((resolve) => (started = () => resolve(null))));
    createSessionWithResult.mockImplementation(
      () => new Promise((resolve) => (created = () => resolve({ sessionId: "s1", error: null }))),
    );
    render(ui(4));
    await click(/^open chat$/i);
    const button = screen.getByRole("button", { name: /^starting claude code…$/i });
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    expect(selectAgent).toHaveBeenCalledTimes(1);
    await act(async () => started());
    expect(screen.getByRole("button", { name: /^opening chat…$/i })).toHaveAttribute("aria-disabled", "true");
    await act(async () => created());
    await waitFor(() => expect(push).toHaveBeenCalledWith("/editor"));
  });

  it("an Open chat that failed goes back to reading Open chat, ready to press again", async () => {
    selectAgent.mockImplementation(async () => {
      throw new Error("Claude Code isn't installed.");
    });
    render(ui(4));
    await click(/^open chat$/i);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Claude Code isn't installed."));
    const button = screen.getByRole("button", { name: /^open chat$/i });
    expect(button).not.toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
  });
});

describe("Wizard — step 3, sign in", () => {
  it("Sign in now types the sign-in command, then I've signed in stores the confirmation and moves on", async () => {
    render(ui(3));
    expect(screen.queryByRole("button", { name: /^i've signed in$/i })).toBeNull();
    await click(/sign in now/i);
    await waitFor(() => expect(terminalPosts()).toHaveLength(1));
    expect(lastTerminalBody()).toMatchObject({ surface: "agents", initialInput: "/u/claude" });
    const signedIn = await screen.findByRole("button", { name: /^i've signed in$/i });
    await act(async () => {
      fireEvent.click(signedIn);
    });
    await waitFor(() => expect(onStep).toHaveBeenCalledWith(4));
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/claude-code/sign-in-confirmation", expect.objectContaining({ method: "POST" }));
    expect(trackEvent).toHaveBeenCalledWith("agent_wizard_step_completed", { agent: "claude-code", step: "sign-in" });
  });

  it("Claude Code: says to type /login in the terminal, and why the sign-in has to be confirmed here", () => {
    render(ui(3));
    expect(screen.getByTestId("wizard-sign-in-how")).toHaveTextContent("Type /login there and finish signing in in your browser.");
    expect(screen.getByTestId("wizard-sign-in-confirm")).toHaveTextContent(
      "libi doesn't read your Claude Code credentials, so it can't detect when you've signed in. Confirm it here once you are.",
    );
  });

  it("Codex: says codex login runs in the terminal, and why the sign-in has to be confirmed here", () => {
    status = usable({ agentId: "codex", cli: { path: "/usr/local/bin/codex", realPath: "/u/codex", version: "0.160.0", meetsMinimum: true } });
    render(ui(3, "codex"));
    expect(screen.getByTestId("wizard-sign-in-how")).toHaveTextContent("run codex login in the terminal below");
    expect(screen.getByTestId("wizard-sign-in-how")).not.toHaveTextContent("/login");
    expect(screen.getByTestId("wizard-sign-in-confirm")).toHaveTextContent("libi doesn't read your Codex credentials, so it can't detect when you've signed in.");
  });

  it("I'm already signed in stores the confirmation without opening a terminal, and refreshes the status", async () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    render(ui(3));
    await click(/i'm already signed in/i);
    await waitFor(() => expect(onStep).toHaveBeenCalledWith(4));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agent-status"] });
    expect(terminalPosts()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/claude-code/sign-in-confirmation", expect.objectContaining({ method: "POST" }));
  });

  it("a confirmation the server refused says so and does not move on", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 500 }));
    render(ui(3));
    await click(/i'm already signed in/i);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onStep).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalledWith("agent_wizard_step_completed", expect.anything());
  });
});

describe("Wizard — step 4, open chat", () => {
  it("is the last step: selects the agent, creates a session, remembers it, reports the step, marks the wizard finished and goes to the editor", async () => {
    render(ui(4));
    expect(screen.getByTestId("agent-wizard-title")).toHaveTextContent("Step 4 of 4 — Open chat");
    await click(/open chat/i);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/editor"));
    expect(selectAgent).toHaveBeenCalledWith("claude-code");
    expect(createSessionWithResult).toHaveBeenCalledTimes(1);
    expect(setLastSessionId).toHaveBeenCalledWith("s1");
    expect(trackEvent).toHaveBeenCalledWith("agent_wizard_step_completed", { agent: "claude-code", step: "open-chat" });
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.invocationCallOrder[0]).toBeLessThan(push.mock.invocationCallOrder[0]);
    expect(screen.queryByRole("button", { name: /^next$|^skip$/i })).toBeNull();
  });

  it("a session that could not be created shows its error, stays put and reports nothing", async () => {
    createSessionWithResult.mockImplementation(async () => ({ sessionId: null, error: "Authentication required" }));
    render(ui(4));
    await click(/open chat/i);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Authentication required"));
    expect(push).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
    expect(setLastSessionId).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalledWith("agent_wizard_step_completed", expect.anything());
  });

  it("an agent that refuses to start shows its reason and never creates a session", async () => {
    selectAgent.mockImplementation(async () => {
      throw new Error("Claude Code isn't installed.");
    });
    render(ui(4));
    await click(/open chat/i);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Claude Code isn't installed."));
    expect(createSessionWithResult).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("the live status shows Installed and Signed in, never libi's tools", () => {
    render(ui(4));
    const live = screen.getByTestId("agent-wizard-live-status");
    expect(live).toHaveTextContent("Installed");
    expect(live).toHaveTextContent("Signed in");
    expect(live).not.toHaveTextContent(/libi tools/i);
  });
});

describe("Wizard — step 4, optional global connect", () => {
  it("sits under Open chat; Connect types the agent's own mcp add and reports nothing on the click", async () => {
    render(ui(4));
    const section = screen.getByTestId("wizard-connect-libi");
    expect(section).toHaveTextContent("Optional: use libi from your own Claude Code app or terminal");
    expect(screen.getByTestId("wizard-connect-state")).toHaveTextContent("Adds libi's tools to your global Claude Code configuration");
    await click(/^connect$/i);
    await waitFor(() => expect(terminalPosts()).toHaveLength(1));
    const expected = connectLibiCommand({ agentId: "claude-code", realPath: "/u/claude" }, "posix", "http://127.0.0.1:3457/mcp");
    expect(expected).toContain("mcp add");
    expect(lastTerminalBody()).toMatchObject({ surface: "agents", initialInput: expected });
    expect(onStep).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalledWith("agent_wizard_step_completed", expect.anything());
  });

  it("Connect is disabled until the endpoint URL is known", () => {
    endpointUrl = undefined;
    render(ui(4));
    expect(screen.getByRole("button", { name: /^connect$/i })).toBeDisabled();
  });

  it("reports the connect once the entry is observed after the user opened the command here", async () => {
    const { rerender } = render(ui(4));
    await click(/^connect$/i);
    await waitFor(() => expect(terminalPosts()).toHaveLength(1));
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    rerender(ui(4));
    expect(screen.getByTestId("wizard-connect-state")).toHaveTextContent("Connected");
    expect(screen.queryByRole("button", { name: /^connect$/i })).toBeNull();
    expect(trackEvent).toHaveBeenCalledWith("agent_wizard_step_completed", { agent: "claude-code", step: "connect" });
  });

  it("an entry that was already connected reads Connected and reports nothing", () => {
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    render(ui(4));
    expect(screen.getByTestId("wizard-connect-state")).toHaveTextContent("Connected");
    expect(trackEvent).not.toHaveBeenCalledWith("agent_wizard_step_completed", { agent: "claude-code", step: "connect" });
  });

  it.each([
    ["claude-code", "Claude Code"],
    ["codex", "Codex"],
  ] as const)("%s: the connected line says where to manage the connection", (id, name) => {
    status =
      id === "codex"
        ? usable({
            agentId: "codex",
            cli: { path: "/usr/local/bin/codex", realPath: "/u/codex", version: "0.160.0", meetsMinimum: true },
            libiTools: { state: "connected" },
          })
        : usable({ libiTools: { state: "connected", scope: "user" } });
    render(ui(4, id));
    expect(screen.getByTestId("wizard-connect-state")).toHaveTextContent(
      `Connected — ${name} can use libi's tools from its own app and terminal. Manage it on the Global setup tab.`,
    );
  });

  it("an entry on an old port offers Reconnect in the detected scope instead of a second add", async () => {
    status = usable({ libiTools: { state: "stale-port", scope: "local" } });
    render(ui(4));
    expect(screen.queryByRole("button", { name: /^connect$/i })).toBeNull();
    await click(/^reconnect$/i);
    await waitFor(() => expect(terminalPosts()).toHaveLength(1));
    expect(lastTerminalBody().initialInput).toBe(
      reconnectLibiCommand({ agentId: "claude-code", realPath: "/u/claude" }, "posix", "http://127.0.0.1:3457/mcp", "local"),
    );
  });

  it("Claude Code: an old-port entry with no detected scope disables Reconnect and says why, never guessing one", () => {
    status = usable({ libiTools: { state: "stale-port" } });
    render(ui(4));
    expect(screen.queryByRole("button", { name: /^connect$/i })).toBeNull();
    const reconnect = screen.getByRole("button", { name: /^reconnect$/i });
    expect(reconnect).toBeDisabled();
    fireEvent.click(reconnect);
    expect(terminalPosts()).toHaveLength(0);
    expect(screen.getByTestId("wizard-reconnect-scope-unknown")).toHaveTextContent(
      "Couldn't read which config Claude Code registered libi in",
    );
  });

  it("Codex has no scopes: an old-port entry reconnects without a detected scope", async () => {
    status = usable({
      agentId: "codex",
      cli: { path: "/usr/local/bin/codex", realPath: "/u/codex", version: "0.160.0", meetsMinimum: true },
      libiTools: { state: "stale-port" },
    });
    render(ui(4, "codex"));
    expect(screen.queryByTestId("wizard-reconnect-scope-unknown")).toBeNull();
    await click(/^reconnect$/i);
    await waitFor(() => expect(terminalPosts()).toHaveLength(1));
    const command = lastTerminalBody().initialInput;
    expect(command).toBe(
      reconnectLibiCommand({ agentId: "codex", realPath: "/u/codex" }, "posix", "http://127.0.0.1:3457/mcp", "user"),
    );
    expect(command).toContain("/u/codex mcp remove");
    expect(command).not.toContain("--scope");
  });

  it("a stale registration (Codex's last good listing while a fresh one is slow or failed) still shows the last-known state, marked · last known", () => {
    status = usable({
      agentId: "codex",
      cli: { path: "/usr/local/bin/codex", realPath: "/u/codex", version: "0.160.0", meetsMinimum: true },
      libiTools: { state: "connected", stale: true },
    });
    render(ui(4, "codex"));
    expect(screen.getByTestId("wizard-connect-state")).toHaveTextContent("Connected");
    expect(screen.getByTestId("wizard-connect-stale")).toHaveTextContent("· last known");
  });

  it("· last known comes with a Retry, matching the Global setup card's: forces a fresh listing, disabled while pending", () => {
    status = usable({
      agentId: "codex",
      cli: { path: "/usr/local/bin/codex", realPath: "/u/codex", version: "0.160.0", meetsMinimum: true },
      libiTools: { state: "connected", stale: true },
    });
    const { rerender } = render(ui(4, "codex"));
    const marker = () => screen.getByTestId("wizard-connect-stale");
    fireEvent.click(within(marker()).getByRole("button", { name: /^retry$/i }));
    // Same mutation as the Global setup card and the Providers tab: `?refresh=1`, never a plain
    // refetch that a listing's 5 s failure memo could answer with the same stale result.
    expect(refreshRegistration).toHaveBeenCalledTimes(1);

    refreshRegistrationPending = true;
    rerender(ui(4, "codex"));
    expect(within(marker()).getByRole("button", { name: /^retry$/i })).toBeDisabled();
  });

  it("no good listing at all (unknown) still says it couldn't read Codex, with no · last known marker", () => {
    status = usable({
      agentId: "codex",
      cli: { path: "/usr/local/bin/codex", realPath: "/u/codex", version: "0.160.0", meetsMinimum: true },
      libiTools: { state: "unknown" },
    });
    render(ui(4, "codex"));
    expect(screen.getByTestId("wizard-connect-state")).toHaveTextContent("Couldn't read whether Codex has libi's tools.");
    expect(screen.queryByTestId("wizard-connect-stale")).toBeNull();
  });

  it("a fresh, non-stale state never shows · last known", () => {
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    render(ui(4));
    expect(screen.queryByTestId("wizard-connect-stale")).toBeNull();
  });
});

describe("Wizard — step 4, part 2: install libi's skills", () => {
  it("is absent until the tools read Connected, then appears with the two choices and no Skip", () => {
    const { rerender } = render(ui(4));
    expect(screen.queryByTestId("wizard-install-skills")).toBeNull();
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    rerender(ui(4));
    const part = within(screen.getByTestId("wizard-install-skills"));
    expect(part.getByText("libi's tools are connected. Now install libi's skills so Claude Code knows how to use them.")).toBeInTheDocument();
    expect(part.getByRole("radio", { name: /every folder/i })).toBeChecked();
    expect(part.getByText("Installs into ~/.claude/skills. Every Claude Code chat in every folder can use them.")).toBeInTheDocument();
    expect(part.getByRole("radio", { name: /a specific folder/i })).toBeInTheDocument();
    expect(part.queryByRole("button", { name: /skip/i })).toBeNull();
  });

  it("appears immediately when the tools were already connected", () => {
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    render(ui(4));
    expect(screen.getByTestId("wizard-install-skills")).toBeInTheDocument();
  });

  it("Every folder + Install adds the user-level install straight away", async () => {
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    render(ui(4));
    const part = within(screen.getByTestId("wizard-install-skills"));
    await act(async () => {
      fireEvent.click(part.getByRole("button", { name: /^install$/i }));
    });
    expect(addInstall).toHaveBeenCalledWith({ agentId: "claude-code", scope: "user" });
  });

  it("A specific folder: the picker fills the field, Install posts the folder, an error shows inline", async () => {
    status = usable({
      agentId: "codex",
      cli: { path: "/usr/local/bin/codex", realPath: "/u/codex", version: "0.160.0", meetsMinimum: true },
      libiTools: { state: "connected" },
    });
    render(ui(4, "codex"));
    const part = within(screen.getByTestId("wizard-install-skills"));
    fireEvent.click(part.getByRole("radio", { name: /a specific folder/i }));
    await act(async () => {
      fireEvent.click(part.getByRole("button", { name: /choose folder/i }));
    });
    expect(part.getByRole("textbox")).toHaveValue("/Users/me/proj");
    await act(async () => {
      fireEvent.click(part.getByRole("button", { name: /^install$/i }));
    });
    expect(addInstall).toHaveBeenCalledWith({ agentId: "codex", scope: "folder", folderPath: "/Users/me/proj" });

    const { SkillInstallRequestError } = await import("@/lib/queries/skill-installs");
    addInstall.mockRejectedValueOnce(
      new SkillInstallRequestError("refused_home", "That's your home folder. To install libi's skills for every folder, choose Every folder."),
    );
    fireEvent.change(part.getByRole("textbox"), { target: { value: "/Users/me" } });
    await act(async () => {
      fireEvent.click(part.getByRole("button", { name: /^install$/i }));
    });
    expect(part.getByRole("alert")).toHaveTextContent("That's your home folder. To install libi's skills for every folder, choose Every folder.");
  });

  it("with installs: the summary, Add another folder (folders only) and the manage link", () => {
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    installs = { ...installs!, installs: [install({ id: "a" }), install({ id: "b", folderPath: "/q" }), install({ id: "c", agentId: "codex" })] };
    const { rerender } = render(ui(4));
    let part = within(screen.getByTestId("wizard-install-skills"));
    expect(part.getByText("Skills installed in 2 folders")).toBeInTheDocument();
    expect(part.getByRole("button", { name: /add another folder/i })).toBeInTheDocument();
    // It opens the Global setup tab on the agent this wizard just set up, not the sidebar's.
    expect(part.getByRole("link", { name: /manage on the global setup tab/i })).toHaveAttribute(
      "href",
      "/agents?tab=global-setup&setupAgent=claude-code",
    );
    expect(part.queryByRole("radio")).toBeNull();

    installs = { ...installs!, installs: [install({ id: "u", scope: "user", folderPath: null })] };
    rerender(ui(4));
    part = within(screen.getByTestId("wizard-install-skills"));
    expect(part.getByText("Skills installed for every folder")).toBeInTheDocument();
    expect(part.queryByRole("button", { name: /add another folder/i })).toBeNull();
  });

  it("Add another folder re-opens the choice; choosing Every folder with folder installs asks first", async () => {
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    installs = { ...installs!, installs: [install({ id: "a" })] };
    render(ui(4));
    const part = within(screen.getByTestId("wizard-install-skills"));
    fireEvent.click(part.getByRole("button", { name: /add another folder/i }));
    expect(part.getByRole("radio", { name: /a specific folder/i })).toBeChecked();
    fireEvent.click(part.getByRole("radio", { name: /every folder/i }));
    fireEvent.click(part.getByRole("button", { name: /^install$/i }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("This also removes libi's skills from your 1 folder, since every folder will have them.");
    expect(addInstall).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /^install$/i }));
    });
    expect(addInstall).toHaveBeenCalledWith({ agentId: "claude-code", scope: "user" });
  });

  it("the every-folder confirmation's Install button is disabled while the install is pending", async () => {
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    installs = { ...installs!, installs: [install({ id: "a" })] };
    const { rerender } = render(ui(4));
    const part = within(screen.getByTestId("wizard-install-skills"));
    fireEvent.click(part.getByRole("button", { name: /add another folder/i }));
    fireEvent.click(part.getByRole("radio", { name: /every folder/i }));
    fireEvent.click(part.getByRole("button", { name: /^install$/i }));
    let dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: /^install$/i })).toBeEnabled();
    addPending = true;
    rerender(ui(4));
    dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: /^install$/i })).toBeDisabled();
  });

  it("every button in part 2 has cursor-pointer", () => {
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    render(ui(4));
    fireEvent.click(screen.getByRole("radio", { name: /a specific folder/i }));
    for (const b of within(screen.getByTestId("wizard-install-skills")).getAllByRole("button")) expect(b).toHaveClass("cursor-pointer");
  });

  it("shows the skeleton only while loading, and an error row with Retry (mirroring connected-agents) when the installs fetch fails", () => {
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    installsLoading = true;
    const { rerender } = render(ui(4));
    let part = within(screen.getByTestId("wizard-install-skills"));
    expect(part.queryByText(/couldn.t read/i)).toBeNull();
    expect(part.queryByRole("radio")).toBeNull();

    installsLoading = false;
    installs = undefined;
    rerender(ui(4));
    part = within(screen.getByTestId("wizard-install-skills"));
    expect(part.getByText("Couldn't read libi's skill installs.")).toBeInTheDocument();
    const retry = part.getByRole("button", { name: /^retry$/i });
    expect(retry.className).toContain("cursor-pointer");
    fireEvent.click(retry);
    expect(refetchInstalls).toHaveBeenCalledTimes(1);

    installsFetching = true;
    rerender(ui(4));
    expect(within(screen.getByTestId("wizard-install-skills")).getByRole("button", { name: /retrying/i })).toBeDisabled();
  });

  it("the radio group has an accessible name", () => {
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    render(ui(4));
    expect(screen.getByRole("radiogroup", { name: "Where to install libi's skills" })).toBeInTheDocument();
  });

  it("changing the radio choice clears a pending inline error", async () => {
    status = usable({
      agentId: "codex",
      cli: { path: "/usr/local/bin/codex", realPath: "/u/codex", version: "0.160.0", meetsMinimum: true },
      libiTools: { state: "connected" },
    });
    render(ui(4, "codex"));
    const part = within(screen.getByTestId("wizard-install-skills"));
    fireEvent.click(part.getByRole("radio", { name: /a specific folder/i }));
    const { SkillInstallRequestError } = await import("@/lib/queries/skill-installs");
    addInstall.mockRejectedValueOnce(new SkillInstallRequestError("not_found", "That folder doesn't exist."));
    fireEvent.change(part.getByRole("textbox"), { target: { value: "/nope" } });
    await act(async () => {
      fireEvent.click(part.getByRole("button", { name: /^install$/i }));
    });
    expect(part.getByRole("alert")).toHaveTextContent("That folder doesn't exist.");
    fireEvent.click(part.getByRole("radio", { name: /every folder/i }));
    expect(part.queryByRole("alert")).toBeNull();
  });

  it("Add another folder offers a Cancel button back to the summary; the initial choice (no prior install) offers none", () => {
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    installs = { ...installs!, installs: [install({ id: "a" })] };
    render(ui(4));
    let part = within(screen.getByTestId("wizard-install-skills"));
    // Nothing to cancel back to before any install exists.
    expect(part.queryByRole("button", { name: /^cancel$/i })).toBeNull();

    fireEvent.click(part.getByRole("button", { name: /add another folder/i }));
    part = within(screen.getByTestId("wizard-install-skills"));
    const cancel = part.getByRole("button", { name: /^cancel$/i });
    expect(cancel.className).toContain("cursor-pointer");
    fireEvent.click(cancel);
    part = within(screen.getByTestId("wizard-install-skills"));
    expect(part.getByText("Skills installed in 1 folder")).toBeInTheDocument();
    expect(part.queryByRole("radio")).toBeNull();
  });
  it("a pick that resolves after Cancel does not pre-fill the field on reopen", async () => {
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    installs = { ...installs!, installs: [install({ id: "a" })] };
    render(ui(4));
    let part = within(screen.getByTestId("wizard-install-skills"));
    let resolvePick!: (r: WizardPickResult) => void;
    pickFolderImpl = () => new Promise((resolve) => { resolvePick = resolve; });

    fireEvent.click(part.getByRole("button", { name: /add another folder/i }));
    part = within(screen.getByTestId("wizard-install-skills"));
    fireEvent.click(part.getByRole("button", { name: /choose folder/i }));
    // The dialog is a separate window — Cancel unmounts the field while it is
    // still open.
    fireEvent.click(part.getByRole("button", { name: /^cancel$/i }));
    part = within(screen.getByTestId("wizard-install-skills"));
    expect(part.queryByRole("textbox")).toBeNull();

    // The (now-stale) pick resolves after the fact.
    await act(async () => { resolvePick({ status: "picked", path: "/late/pick" }); });

    fireEvent.click(part.getByRole("button", { name: /add another folder/i }));
    part = within(screen.getByTestId("wizard-install-skills"));
    expect(part.getByRole("textbox")).toHaveValue("");
  });
  it.each([
    ["Every folder", "user"],
    ["A specific folder", "folder"],
  ] as const)("%s: an install error with no message falls back to 'Try again' wording, never an empty alert", async (_label, choice) => {
    status = usable({ libiTools: { state: "connected", scope: "user" } });
    render(ui(4));
    const part = within(screen.getByTestId("wizard-install-skills"));
    if (choice === "folder") {
      fireEvent.click(part.getByRole("radio", { name: /a specific folder/i }));
      fireEvent.change(part.getByRole("textbox"), { target: { value: "/Users/me/proj" } });
    }
    const { SkillInstallRequestError } = await import("@/lib/queries/skill-installs");
    addInstall.mockRejectedValueOnce(new SkillInstallRequestError("request_failed", ""));
    await act(async () => {
      fireEvent.click(part.getByRole("button", { name: /^install$/i }));
    });
    expect(part.getByRole("alert")).toHaveTextContent("Couldn't install libi's skills. Try again.");

    // Not a SkillInstallRequestError: its message is not trusted verbatim either.
    addInstall.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      fireEvent.click(part.getByRole("button", { name: /^install$/i }));
    });
    const alerts = part.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("Couldn't install libi's skills. Try again.");
    expect(alerts[0]).not.toHaveTextContent("boom");
  });
});

describe("Wizard — setup terminal", () => {
  it("shows the setup terminal only under the agent whose step opened it", async () => {
    status = usable({ cli: null, adapter: "missing", ready: false });
    const { rerender } = render(ui(2, "codex"));
    await click(/^install$/i);
    await waitFor(() => expect(terminalPosts()).toHaveLength(1));
    expect(await screen.findByTestId("setup-terminal-agents")).toBeInTheDocument();
    // Codex's install command must never sit under Claude Code's wizard asking for Enter.
    rerender(ui(2, "claude-code"));
    expect(screen.queryByTestId("setup-terminal-agents")).toBeNull();
    rerender(ui(2, "codex"));
    expect(screen.getByTestId("setup-terminal-agents")).toBeInTheDocument();
    // Hidden is not closed: a command already running there must survive the detour.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
  });
});

describe("Wizard — frame", () => {
  it("every command button, on every step, is disabled until the shell flavor is known", () => {
    const cases: Array<[WizardStep, AgentStatus, RegExp]> = [
      [2, usable({ cli: null, adapter: "missing", ready: false }), /^install$/i],
      [2, usable({ cli: { ...CLAUDE_PATHS, version: "2.0.1", meetsMinimum: false }, ready: false }), /^update$/i],
      [3, usable(), /^sign in now$/i],
      [4, usable(), /^connect$/i],
      [4, usable({ libiTools: { state: "stale-port", scope: "user" } }), /^reconnect$/i],
    ];
    for (const [step, s, name] of cases) {
      for (const f of [undefined, "posix"] as const) {
        flavor = f;
        status = s;
        const { unmount } = render(ui(step));
        const button = screen.getByRole("button", { name });
        if (f) expect(button).toBeEnabled();
        else expect(button).toBeDisabled();
        unmount();
      }
    }
    expect(terminalPosts()).toHaveLength(0);
  });

  it("polls the agent's status only on the steps that wait on the machine", () => {
    const expected: Record<WizardStep, boolean> = { 1: false, 2: true, 3: false, 4: true };
    for (const step of [2, 3, 4] as const) {
      statusCalls.mockClear();
      const { unmount } = render(ui(step));
      expect(statusCalls).toHaveBeenCalled();
      for (const [, opts] of statusCalls.mock.calls) expect(opts).toEqual({ polling: expected[step] });
      unmount();
    }
  });

  it("renders no text input on any step, and every button has cursor-pointer", () => {
    for (const step of [1, 2, 3, 4] as const) {
      status = usable({ adapter: "missing", ready: false, libiTools: { state: "connected", scope: "user" } });
      job = installJob({ status: "failed" });
      const { container, unmount } = render(ui(step, step === 1 ? null : "claude-code"));
      // Step 4's "install skills" choice renders `Every folder` / `A specific
      // folder` radios by default — those are a choice, not free text, so they
      // are excluded here; the picker's own text field only mounts once
      // "A specific folder" is picked, which this render never does.
      expect(container.querySelector('input:not([type="radio"]), textarea')).toBeNull();
      for (const b of screen.getAllByRole("button")) expect(b.className).toContain("cursor-pointer");
      unmount();
    }
  });
});
