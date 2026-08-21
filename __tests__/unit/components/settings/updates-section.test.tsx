// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { UpdatesSection } from "@/components/settings/updates-section";
import type { RuntimeUpdateDto } from "@/lib/queries/runtime-update";

/**
 * The Settings card under auto-download: the normal lifecycle needs no
 * clicks until the end (found → background download copy → ready → "Restart
 * to apply"), the restart NEVER fires without a click, and the legacy
 * "Install & restart" button survives only for a failed runtime download
 * ("Try again") and for shell offers from OLD shells that can't download
 * themselves.
 */

// Same mocking pattern as privacy-tab.test.tsx: stub the React Query hooks so
// the component renders in isolation, no QueryClientProvider or network.
const installMutate = vi.fn();
const recheckMutate = vi.fn();
// Stateful like the real useMutation: isIdle flips false once mutate() runs —
// the component renders "Restarting…" off exactly that.
const restartMutate = vi.fn();

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

function failedInstall(version: string): RuntimeUpdateDto["install"] {
  return {
    id: "job", kind: "runtime_update", status: "failed", progress: null,
    error: "disk full", createdAt: 0, updatedAt: 0, version,
  } as unknown as RuntimeUpdateDto["install"];
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
    useRestartToApply: () => ({
      mutate: restartMutate,
      isIdle: restartMutate.mock.calls.length === 0,
      isError: false,
    }),
  };
});

beforeEach(() => {
  dto = baseDto();
  installMutate.mockClear();
  recheckMutate.mockClear();
  restartMutate.mockClear();
});

describe("UpdatesSection — auto-download and explicit restart", () => {
  it("labels both halves of the install: Runtime and Desktop app", () => {
    dto = withShell("up-to-date", { latestVersion: null });
    render(<UpdatesSection />);
    expect(screen.getByText("Runtime")).toBeInTheDocument();
    expect(screen.getByText("Desktop app")).toBeInTheDocument();
  });

  it("shows NO install button for a fresh update-available — the download starts itself", () => {
    render(<UpdatesSection />);
    expect(screen.queryByRole("button", { name: /install/i })).not.toBeInTheDocument();
    expect(restartMutate).not.toHaveBeenCalled();
  });

  it("renders a background-download line while the runtime downloads", () => {
    dto = {
      ...baseDto(),
      install: {
        id: "job", kind: "runtime_update", status: "running", progress: null,
        error: null, createdAt: 0, updatedAt: 0, version: "0.2.0",
      } as unknown as RuntimeUpdateDto["install"],
    };
    render(<UpdatesSection />);
    expect(screen.getByText(/downloading libi/i)).toBeInTheDocument();
    expect(screen.getByText(/you choose\s+when to restart/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /install/i })).not.toBeInTheDocument();
  });

  it("a downloaded runtime waits for the click — never restarts on its own", () => {
    dto = { ...baseDto(), pendingVersion: "0.2.0" };
    const { rerender } = render(<UpdatesSection />);
    rerender(<UpdatesSection />); // poll ticks must not restart either
    expect(restartMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/downloaded\s+in the background/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /restart to apply/i }));
    expect(restartMutate).toHaveBeenCalledWith({ target: "runtime", version: "0.2.0" });

    rerender(<UpdatesSection />);
    expect(screen.getByText(/restarting libi/i)).toBeInTheDocument();
  });

  it("a failed auto-download says so and offers Try again", () => {
    dto = { ...baseDto(), install: failedInstall("0.2.0") };
    render(<UpdatesSection />);
    expect(screen.getByText(/didn't download/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again \(0\.2\.0\)/i }));
    expect(installMutate).toHaveBeenCalledWith({ target: "runtime", version: "0.2.0" });
  });

  it("an OLD shell's update keeps the click-to-install button", () => {
    dto = withShell("update-available"); // no autoDownload field
    render(<UpdatesSection />);
    fireEvent.click(screen.getByRole("button", { name: /install 0\.4\.0 & restart/i }));
    expect(installMutate).toHaveBeenCalledWith({ target: "shell", version: "0.4.0" });
    expect(restartMutate).not.toHaveBeenCalled();
  });

  it("a NEW shell downloads silently and then offers Restart to apply", () => {
    dto = withShell("update-available", { autoDownload: true });
    const { rerender } = render(<UpdatesSection />);
    expect(screen.queryByRole("button", { name: /install/i })).not.toBeInTheDocument();

    dto = withShell("downloading", { percent: 42, autoDownload: true });
    rerender(<UpdatesSection />);
    expect(screen.getByText(/42%/)).toBeInTheDocument();
    expect(screen.getByText(/keeps working/i)).toBeInTheDocument();

    dto = withShell("ready", { percent: 100, autoDownload: true });
    rerender(<UpdatesSection />);
    fireEvent.click(screen.getByRole("button", { name: /restart to apply/i }));
    expect(restartMutate).toHaveBeenCalledWith({ target: "shell", version: "0.4.0" });
  });

  it("an OLD shell's ready state renders as the self-restart it is", () => {
    dto = withShell("ready", { percent: 100 }); // no autoDownload
    render(<UpdatesSection />);
    expect(screen.getByText(/restarting libi/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /restart to apply/i })).not.toBeInTheDocument();
    expect(restartMutate).not.toHaveBeenCalled();
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

    // The moment the shell that can run it is on the feed (an old shell —
    // the only kind that needs the button), the button appears.
    dto = {
      ...withShell("update-available"),
      update: { ...baseDto().update, state: "shell-update-required", latestVersion: "0.5.0" },
    };
    rerender(<UpdatesSection />);
    expect(screen.getByRole("button", { name: /install 0\.4\.0 & restart/i })).toBeInTheDocument();
    expect(screen.queryByText(/needs a newer version of the desktop app/i)).not.toBeInTheDocument();
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
});

/**
 * The blocked card (A0). Everything else in this component follows "a failed
 * check is invisible"; this is the documented exception, because the user is
 * pinned to their version until THEY move the app, and the old behaviour —
 * a log line plus a "Try again" that re-downloaded 481 MB to fail
 * identically — is what silence looks like from the inside.
 */
describe("UpdatesSection — an install that can't update itself", () => {
  function blockedDto(
    reason: NonNullable<NonNullable<RuntimeUpdateDto["shell"]>["blockedReason"]>,
    blockedPath: string,
  ): RuntimeUpdateDto {
    return withShell("blocked", { blockedReason: reason, blockedPath });
  }

  it("names the cause, gives steps, and shows the path verbatim", () => {
    dto = blockedDto(
      "translocated",
      "/private/var/folders/gh/x8k/T/AppTranslocation/A1B2/d/Libi.app",
    );
    render(<UpdatesSection />);

    expect(screen.getByText(/can't update itself from where it's running/i)).toBeInTheDocument();
    expect(screen.getByText(/temporary read-only copy/i)).toBeInTheDocument();
    expect(screen.getByText(/drag Libi into Applications/i)).toBeInTheDocument();
    // The path is the evidence — abbreviating it would defeat the point.
    expect(
      screen.getByText(
        /\/private\/var\/folders\/gh\/x8k\/T\/AppTranslocation\/A1B2\/d\/Libi\.app/,
      ),
    ).toBeInTheDocument();
  });

  it("offers a re-check and a manual download, and NO install button", () => {
    dto = blockedDto("translocated", "/private/var/AppTranslocation/x/Libi.app");
    render(<UpdatesSection />);

    // "Check again" re-runs the write probe, so a fix made in Finder while
    // Libi is open clears the block without a restart.
    expect(screen.getByRole("button", { name: /check again/i })).toBeEnabled();
    expect(
      screen.getByRole("link", { name: /download 0\.4\.0 manually/i }),
    ).toHaveAttribute("href", expect.stringContaining("releases"));
    // Offering an action that cannot succeed IS the bug being fixed.
    expect(screen.queryByRole("button", { name: /install/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /restart to apply/i })).not.toBeInTheDocument();
  });

  it("does not also claim Libi is up to date", () => {
    // The runtime channel being current says nothing about the desktop app
    // the user is stuck on; together the two lines read as a contradiction.
    dto = blockedDto("translocated", "/private/var/AppTranslocation/x/Libi.app");
    render(<UpdatesSection />);
    expect(screen.queryByText(/libi is up to date/i)).not.toBeInTheDocument();
  });

  it("tailors the advice to each reason", () => {
    const cases: Array<[NonNullable<NonNullable<RuntimeUpdateDto["shell"]>["blockedReason"]>, RegExp]> = [
      ["running-from-dmg", /straight from its disk image/i],
      ["not-in-applications", /isn't allowed to write to/i],
      ["read-only-location", /an administrator may need to do this/i],
    ];
    for (const [reason, copy] of cases) {
      dto = blockedDto(reason, "/somewhere/Libi.app");
      const { unmount } = render(<UpdatesSection />);
      expect(screen.getByText(copy)).toBeInTheDocument();
      unmount();
    }
  });
});
