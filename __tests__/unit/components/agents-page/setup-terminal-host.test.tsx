// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const trackEvent = vi.fn();
vi.mock("@/lib/analytics/client", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

interface ViewProps {
  terminalId: string;
  onExited?: (c: number) => void;
  onSessionGone?: () => void;
}
/** The last props each terminal id's view rendered with, so a test can fire a late event from a replaced view. */
const viewProps = new Map<string, ViewProps>();
vi.mock("@/components/terminal/terminal-view", () => ({
  default: (props: ViewProps) => {
    viewProps.set(props.terminalId, props);
    return (
      <div data-testid="terminal-view" data-terminal-id={props.terminalId}>
        <button onClick={() => props.onExited?.(0)}>simulate-exit</button>
        <button onClick={() => props.onSessionGone?.()}>simulate-gone</button>
      </div>
    );
  },
}));

import {
  SetupTerminalHost,
  useSetupTerminalHost,
  type SetupTerminalEntry,
  type SetupTerminalHostValue,
} from "@/components/agents-page/setup-terminal-host";
import { OPEN_SETUP_TERMINAL_TIMEOUT_MS } from "@/lib/queries/setup-terminals";
import { SetupTerminal } from "@/components/terminal/setup-terminal";

const fetchMock = vi.fn<typeof fetch>();
let nextId = 1;

function Opener({ surface }: { surface: "agents" | "global-setup" | "providers" }) {
  const host = useSetupTerminalHost();
  return (
    <>
      <button onClick={() => void host.open(surface, `echo ${surface}`, "connect-libi").catch(() => undefined)}>
        open-{surface}
      </button>
      <button onClick={() => void host.close(surface)}>close-{surface}</button>
      <SetupTerminal surface={surface} />
    </>
  );
}

let captured: SetupTerminalHostValue | null = null;
function Capture() {
  const host = useSetupTerminalHost();
  useEffect(() => {
    captured = host;
  }, [host]);
  return null;
}

function renderHost(ui: React.ReactNode) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <SetupTerminalHost>{ui}</SetupTerminalHost>
    </QueryClientProvider>,
  );
}

function created(id: string, surface: unknown): Response {
  return new Response(
    JSON.stringify({ id, purpose: "setup", surface, title: "Setup", cliId: "shell", createdAt: 1, status: "running" }),
    { status: 201 },
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  nextId = 1;
  captured = null;
  viewProps.clear();
  trackEvent.mockClear();
  toastError.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return created(`term-${nextId++}`, body.surface);
    }
    if (init?.method === "DELETE") return new Response(JSON.stringify({ success: true }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SetupTerminalHost + SetupTerminal", () => {
  it("renders nothing for a surface with no terminal", () => {
    renderHost(<Opener surface="agents" />);
    expect(screen.queryByTestId("setup-terminal-agents")).not.toBeInTheDocument();
  });

  it("open() POSTs a fresh purpose:setup shell with the command as initialInput and shows it in that surface", async () => {
    renderHost(<Opener surface="agents" />);
    await act(async () => {
      fireEvent.click(screen.getByText("open-agents"));
    });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(String(post[0])).toBe("/api/terminal/sessions");
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      cliId: "shell", purpose: "setup", surface: "agents", initialInput: "echo agents",
    });
    expect(screen.getByTestId("setup-terminal-agents")).toBeInTheDocument();
    // xterm draws to a canvas, so these attributes are what an e2e reads the command from.
    expect(screen.getByTestId("setup-terminal-agents")).toHaveAttribute("data-command", "echo agents");
    expect(screen.getByTestId("setup-terminal-agents")).toHaveAttribute("data-action", "connect-libi");
    expect(screen.getByTestId("terminal-view")).toHaveAttribute("data-terminal-id", "term-1");
    expect(screen.getByText(/press enter/i)).toBeInTheDocument();
  });

  it("open() keeps the opener's explanation and scripts on the entry, and the terminal links each script", async () => {
    renderHost(<><Capture /><SetupTerminal surface="providers" /></>);
    const scripts = [{ name: "add-provider.sh", url: "/api/agents/setup-scripts/add-provider.sh" }];
    let withScripts: SetupTerminalEntry | undefined;
    await act(async () => {
      withScripts = await captured!.open("providers", "sh add-provider.sh fal claude /u/bin/claude", "provider-add", "fal:claude-code", "Adds fal.ai.", scripts);
    });
    expect(withScripts).toMatchObject({ action: "provider-add", anchor: "fal:claude-code", explanation: "Adds fal.ai.", scripts });
    expect(screen.getByRole("link", { name: "View add-provider.sh" })).toHaveAttribute("href", scripts[0]!.url);

    let without: SetupTerminalEntry | undefined;
    await act(async () => {
      without = await captured!.open("providers", "echo providers", "connect-libi");
    });
    expect(without).not.toHaveProperty("scripts");
    expect(screen.queryByRole("link", { name: /view/i })).toBeNull();
  });

  it("reports setup_terminal_opened with bounded params only once the terminal exists", async () => {
    renderHost(<Opener surface="providers" />);
    await act(async () => {
      fireEvent.click(screen.getByText("open-providers"));
    });
    expect(trackEvent).toHaveBeenCalledWith("setup_terminal_opened", { surface: "providers", action: "connect-libi" });
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    [409, "Too many terminals are open"],
    [400, "a setup terminal needs a surface"],
  ])("a refused spawn (%i) shows a toast, rejects, adds no terminal and reports nothing", async (status, message) => {
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ error: message }), { status });
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    renderHost(<><Capture /><Opener surface="agents" /></>);
    await act(async () => {
      await expect(captured!.open("agents", "echo agents", "install")).rejects.toThrow(message);
    });
    expect(toastError).toHaveBeenCalledWith(message);
    expect(screen.queryByTestId("setup-terminal-agents")).not.toBeInTheDocument();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("a second open() on the same surface replaces the view with the new terminal", async () => {
    renderHost(<Opener surface="agents" />);
    await act(async () => { fireEvent.click(screen.getByText("open-agents")); });
    await act(async () => { fireEvent.click(screen.getByText("open-agents")); });
    expect(screen.getAllByTestId("terminal-view")).toHaveLength(1);
    expect(screen.getByTestId("terminal-view")).toHaveAttribute("data-terminal-id", "term-2");
  });

  it("when two opens on one surface race, the newest click wins and the older terminal is deleted", async () => {
    const gates = [deferred(), deferred()];
    let posts = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method !== "POST") return base(input, init);
      const i = posts++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gates[i].promise;
      inFlight--;
      return created(`term-${i + 1}`, "agents");
    });
    renderHost(<Opener surface="agents" />);
    await act(async () => {
      fireEvent.click(screen.getByText("open-agents"));
      fireEvent.click(screen.getByText("open-agents"));
    });
    // The newer request's response is released first, the older one's last.
    await act(async () => { gates[1].resolve(); });
    await act(async () => { gates[0].resolve(); });

    await waitFor(() => expect(screen.getByTestId("terminal-view")).toHaveAttribute("data-terminal-id", "term-2"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/terminal/sessions/term-1",
      expect.objectContaining({ method: "DELETE", keepalive: true }),
    );
    expect(trackEvent).toHaveBeenCalledTimes(1);
    // One surface's POSTs go out one at a time, so the server creates (and
    // replaces) its terminals in click order.
    expect(maxInFlight).toBe(1);
  });

  it("a create POST that never answers is given up on: that open rejects with a toast, and the next open on the same surface still goes out", async () => {
    vi.useFakeTimers();
    const base = fetchMock.getMockImplementation()!;
    let posts = 0;
    let hungSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST" && posts++ === 0) {
        hungSignal = init.signal;
        return new Promise<Response>(() => undefined); // never settles, not even when aborted
      }
      return base(input, init);
    });
    renderHost(<><Capture /><Opener surface="agents" /></>);
    let first!: Promise<unknown>;
    let second!: Promise<SetupTerminalEntry>;
    await act(async () => {
      first = captured!.open("agents", "echo first", "install").catch((err: unknown) => err);
      second = captured!.open("agents", "echo second", "install");
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(OPEN_SETUP_TERMINAL_TIMEOUT_MS - 1); });
    expect(posts).toBe(1); // the second open waits behind the one still in flight
    expect(toastError).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/timed out/i));
    expect(await first).toBeInstanceOf(Error);
    expect(hungSignal?.aborted).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(posts).toBe(2);
    await expect(second).resolves.toMatchObject({ id: "term-1", command: "echo second" });
    expect(screen.getByTestId("terminal-view")).toHaveAttribute("data-terminal-id", "term-1");
  });

  it("keeps terminals on two surfaces independently", async () => {
    renderHost(<><Opener surface="agents" /><Opener surface="global-setup" /></>);
    await act(async () => { fireEvent.click(screen.getByText("open-agents")); });
    await act(async () => { fireEvent.click(screen.getByText("open-global-setup")); });
    expect(screen.getByTestId("setup-terminal-agents")).toBeInTheDocument();
    expect(screen.getByTestId("setup-terminal-global-setup")).toBeInTheDocument();
  });

  it("marks the surface finished when the PTY exits, and Close deletes it", async () => {
    renderHost(<Opener surface="agents" />);
    await act(async () => { fireEvent.click(screen.getByText("open-agents")); });
    fireEvent.click(screen.getByText("simulate-exit"));
    expect(screen.getByText(/finished/i)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText("close-agents")); });
    expect(fetchMock).toHaveBeenCalledWith("/api/terminal/sessions/term-1", expect.objectContaining({ method: "DELETE" }));
    expect(screen.queryByTestId("setup-terminal-agents")).not.toBeInTheDocument();
  });

  it("a terminal the server already closed says so instead of asking for Enter, and the step can be run again", async () => {
    renderHost(<Opener surface="agents" />);
    await act(async () => { fireEvent.click(screen.getByText("open-agents")); });
    fireEvent.click(screen.getByText("simulate-gone"));

    expect(screen.getByTestId("setup-terminal-agents")).toBeInTheDocument();
    expect(screen.getByText(/closed after being idle/i)).toBeInTheDocument();
    expect(screen.queryByText(/press enter/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal-view")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByText("open-agents")); });
    expect(screen.getByTestId("terminal-view")).toHaveAttribute("data-terminal-id", "term-2");
    expect(screen.getByText(/press enter/i)).toBeInTheDocument();
    expect(screen.queryByText(/closed after being idle/i)).not.toBeInTheDocument();
  });

  it("a late exit or close from a replaced terminal never changes the terminal that replaced it", async () => {
    renderHost(<Opener surface="agents" />);
    await act(async () => { fireEvent.click(screen.getByText("open-agents")); });
    await act(async () => { fireEvent.click(screen.getByText("open-agents")); });
    const replaced = viewProps.get("term-1")!;

    act(() => replaced.onExited?.(0));
    act(() => replaced.onSessionGone?.());

    expect(screen.getByTestId("terminal-view")).toHaveAttribute("data-terminal-id", "term-2");
    expect(screen.getByText(/press enter/i)).toBeInTheDocument();
    expect(screen.queryByText(/finished/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/closed after being idle/i)).not.toBeInTheDocument();
  });

  it("a slow close never removes a newer terminal opened on the same surface meanwhile", async () => {
    const deleteGate = deferred();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "DELETE" && !init.keepalive) {
        await deleteGate.promise;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return base(input, init);
    });
    renderHost(<Opener surface="agents" />);
    await act(async () => { fireEvent.click(screen.getByText("open-agents")); });
    await act(async () => { fireEvent.click(screen.getByText("close-agents")); });
    await act(async () => { fireEvent.click(screen.getByText("open-agents")); });
    expect(screen.getByTestId("terminal-view")).toHaveAttribute("data-terminal-id", "term-2");

    await act(async () => {
      deleteGate.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/terminal/sessions/term-1", expect.objectContaining({ method: "DELETE" }));
    expect(screen.getByTestId("terminal-view")).toHaveAttribute("data-terminal-id", "term-2");
  });

  it("deletes every live terminal when the host unmounts (route change away from /agents)", async () => {
    const { unmount } = renderHost(<><Opener surface="agents" /><Opener surface="providers" /></>);
    await act(async () => { fireEvent.click(screen.getByText("open-agents")); });
    await act(async () => { fireEvent.click(screen.getByText("open-providers")); });
    unmount();
    const deletes = fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([u]) => String(u));
    expect(deletes.sort()).toEqual(["/api/terminal/sessions/term-1", "/api/terminal/sessions/term-2"]);
  });

  it("deletes with keepalive on pagehide", async () => {
    renderHost(<Opener surface="agents" />);
    await act(async () => { fireEvent.click(screen.getByText("open-agents")); });
    window.dispatchEvent(new Event("pagehide"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/terminal/sessions/term-1",
      expect.objectContaining({ method: "DELETE", keepalive: true }),
    );
  });

  it("deletes a terminal whose POST resolves after the host already unmounted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") await gate;
      return base(input, init);
    });
    const { unmount } = renderHost(<Opener surface="agents" />);
    fireEvent.click(screen.getByText("open-agents"));
    unmount();
    await act(async () => {
      release();
      await gate;
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/terminal/sessions/term-1",
      expect.objectContaining({ method: "DELETE", keepalive: true }),
    );
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("useSetupTerminalHost throws outside the host", () => {
    function Bare() {
      useSetupTerminalHost();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/SetupTerminalHost/);
  });
});
