// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { UpdatesSection } from "@/components/settings/updates-section";
import type { RuntimeUpdateDto } from "@/lib/queries/runtime-update";

// Same mocking pattern as privacy-tab.test.tsx: stub the React Query hooks so
// the component renders in isolation, no QueryClientProvider or network.
const installMutate = vi.fn();
const recheckMutate = vi.fn();
// Stateful like the real useMutation: isIdle flips false once mutate() runs —
// the component uses exactly that as its fired-already guard.
const resetMutate = vi.fn();

let dto: RuntimeUpdateDto;

function baseDto(): RuntimeUpdateDto {
  return {
    current: { version: "0.1.0", source: "bundled", shellApiVersion: 1 },
    shellApi: { min: 1, max: 1 },
    update: {
      state: "update-available",
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      latestShellApiVersion: 1,
      checkedAt: 0,
    },
    pendingVersion: null,
    install: null,
    shell: null,
  };
}

function withShell(
  phase: NonNullable<RuntimeUpdateDto["shell"]>["phase"],
  extra: Partial<NonNullable<RuntimeUpdateDto["shell"]>> = {},
): RuntimeUpdateDto {
  return {
    ...baseDto(),
    update: { ...baseDto().update, state: "up-to-date", latestVersion: null },
    shell: {
      phase,
      currentVersion: "0.1.0",
      latestVersion: "0.4.0",
      percent: null,
      error: null,
      checkedAt: 0,
      ...extra,
    },
  };
}

vi.mock("@/lib/queries/runtime-update", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/runtime-update")>();
  return {
    ...real,
    useRuntimeUpdate: () => ({ data: dto, isLoading: false, isError: false }),
    useInstallRuntimeUpdate: () => ({ mutate: installMutate, isPending: false, isError: false }),
    useRecheckRuntimeUpdate: () => ({ mutate: recheckMutate, isPending: false }),
  };
});

vi.mock("@/lib/queries/server-status", () => ({
  useResetServer: () => ({
    mutate: resetMutate,
    isIdle: resetMutate.mock.calls.length === 0,
  }),
}));

beforeEach(() => {
  dto = baseDto();
  installMutate.mockClear();
  recheckMutate.mockClear();
  resetMutate.mockClear();
});

describe("UpdatesSection — install & automatic restart", () => {
  it("offers Install & restart and starts the install on click", () => {
    render(<UpdatesSection />);
    const btn = screen.getByRole("button", { name: /install 0\.2\.0 & restart/i });
    fireEvent.click(btn);
    expect(installMutate).toHaveBeenCalledWith({ target: "runtime", version: "0.2.0" });
    // No restart yet — the install has not completed.
    expect(resetMutate).not.toHaveBeenCalled();
  });

  it("offers a SHELL update through the same button, targeting the shell channel", () => {
    dto = withShell("update-available");
    render(<UpdatesSection />);
    fireEvent.click(screen.getByRole("button", { name: /install 0\.4\.0 & restart/i }));
    expect(installMutate).toHaveBeenCalledWith({ target: "shell", version: "0.4.0" });
    // The shell restarts itself once downloaded — no reset from here, ever.
    expect(resetMutate).not.toHaveBeenCalled();
  });

  it("prefers the shell offer when both channels have one — the reverse order could install a runtime the old shell can't run", () => {
    dto = { ...withShell("update-available"), update: baseDto().update };
    render(<UpdatesSection />);
    expect(screen.getByRole("button", { name: /install 0\.4\.0 & restart/i })).toBeInTheDocument();
    expect(screen.queryByText(/install 0\.2\.0/i)).not.toBeInTheDocument();
  });

  it("renders shell download progress, then the self-restart", () => {
    dto = withShell("downloading", { percent: 42 });
    const { rerender } = render(<UpdatesSection />);
    expect(screen.getByText(/42%/)).toBeInTheDocument();

    dto = withShell("ready", { percent: 100 });
    rerender(<UpdatesSection />);
    expect(screen.getByText(/restarting libi/i)).toBeInTheDocument();
    expect(resetMutate).not.toHaveBeenCalled();
  });

  it("a shell release upgrades `shell-update-required` from passive copy to an install button", () => {
    // Without a shell release on the feed: the dead-end explanation.
    dto = {
      ...baseDto(),
      update: { ...baseDto().update, state: "shell-update-required", latestVersion: "0.5.0" },
    };
    const { rerender } = render(<UpdatesSection />);
    expect(screen.getByText(/needs a newer version of the desktop app/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /install/i })).not.toBeInTheDocument();

    // The moment the shell that can run it is on the feed, the button appears
    // and the dead-end copy goes away.
    dto = {
      ...withShell("update-available"),
      update: { ...baseDto().update, state: "shell-update-required", latestVersion: "0.5.0" },
    };
    rerender(<UpdatesSection />);
    expect(screen.getByRole("button", { name: /install 0\.4\.0 & restart/i })).toBeInTheDocument();
    expect(screen.queryByText(/needs a newer version of the desktop app/i)).not.toBeInTheDocument();
  });

  it("restarts automatically when an install started in this session completes", () => {
    const { rerender } = render(<UpdatesSection />);
    fireEvent.click(screen.getByRole("button", { name: /install 0\.2\.0 & restart/i }));

    // The poll delivers the completed install: pendingVersion appears.
    dto = { ...baseDto(), pendingVersion: "0.2.0" };
    rerender(<UpdatesSection />);

    expect(resetMutate).toHaveBeenCalledTimes(1);

    // The real useMutation re-renders when its state flips to non-idle; the
    // mock is not reactive, so the next render (poll tick) stands in for it.
    // That tick must ALSO not fire the restart again — the mutation is no
    // longer idle.
    rerender(<UpdatesSection />);
    expect(screen.getByText(/restarting libi/i)).toBeInTheDocument();
    expect(resetMutate).toHaveBeenCalledTimes(1);
  });

  it("flashes the section when arriving via ?highlight=version, and strips the param", () => {
    window.history.replaceState(null, "", "/settings?highlight=version");
    const { container } = render(<UpdatesSection />);
    expect(container.querySelector("[data-highlight]")).toBeInTheDocument();
    expect(window.location.search).toBe(""); // no re-flash on reload
    window.history.replaceState(null, "", "/");
  });

  it("does not flash on a plain visit", () => {
    const { container } = render(<UpdatesSection />);
    expect(container.querySelector("[data-highlight]")).not.toBeInTheDocument();
  });

  it("does NOT auto-restart for a pendingVersion that predates this session", () => {
    // App booted with an update already downloaded — the user never clicked
    // Install here, so consent for a restart was never given.
    dto = { ...baseDto(), pendingVersion: "0.2.0" };
    render(<UpdatesSection />);
    expect(resetMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/restart libi to finish updating/i)).toBeInTheDocument();
  });
});
