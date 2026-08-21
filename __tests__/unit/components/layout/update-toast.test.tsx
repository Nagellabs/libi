// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { act } from "react";
import "@testing-library/jest-dom/vitest";
import { toast } from "sonner";
import {
  UpdateToast,
  UPDATE_TOAST_DISMISS_KEY,
  UPDATE_TOAST_ID,
} from "@/components/layout/update-toast";
import type { RuntimeUpdateDto } from "@/lib/queries/runtime-update";

/**
 * The auto-download toast contract: downloads are SILENT, the toast's job is
 * announcing a finished download ("Libi X is ready — Restart now"), and the
 * only legacy "Install & restart" left is a shell offer surfaced by an OLD
 * desktop shell that cannot download itself. A regression here either nags
 * the user for downloads again or restarts without a click.
 */

// sonner is mocked so assertions run against the toast CONTRACT (id, copy,
// action, dismiss handler) rather than portal DOM — same isolation approach
// as the settings component tests' query-hook mocks.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { loading: vi.fn(), dismiss: vi.fn() }),
}));

const installMutate = vi.fn();
const restartMutate = vi.fn();

let dto: RuntimeUpdateDto;

function baseDto(): RuntimeUpdateDto {
  return {
    current: { version: "0.1.0", source: "bundled", shellApiVersion: 1 },
    shellApi: { min: 1, max: 1 },
    update: {
      state: "up-to-date",
      currentVersion: "0.1.0",
      latestVersion: null,
      latestShellApiVersion: null,
      checkedAt: 0,
    },
    pendingVersion: null,
    install: null,
    shell: null,
  };
}

function shellDto(
  phase: NonNullable<RuntimeUpdateDto["shell"]>["phase"],
  extra: Partial<NonNullable<RuntimeUpdateDto["shell"]>> = {},
): RuntimeUpdateDto {
  return {
    ...baseDto(),
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

function runningInstall(version: string): RuntimeUpdateDto["install"] {
  return {
    id: "job", kind: "runtime_update", status: "running", progress: null,
    error: null, createdAt: 0, updatedAt: 0, version,
  } as unknown as RuntimeUpdateDto["install"];
}

vi.mock("@/lib/queries/runtime-update", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/runtime-update")>();
  return {
    ...real,
    useRuntimeUpdate: () => ({ data: dto, isLoading: false, isError: false }),
    useInstallRuntimeUpdate: () => ({ mutate: installMutate, isPending: false, isError: false }),
    useRestartToApply: () => ({
      mutate: restartMutate,
      isPending: false,
      isSuccess: restartMutate.mock.calls.length > 0,
    }),
  };
});

type ToastOpts = {
  id: string;
  action: { label: string; onClick: () => void };
  onDismiss: () => void;
  closeButton: boolean;
  duration: number;
};

const toastMock = toast as unknown as ReturnType<typeof vi.fn> & {
  loading: ReturnType<typeof vi.fn>;
};

function lastToastOpts(): ToastOpts {
  return toastMock.mock.calls.at(-1)![1] as ToastOpts;
}

beforeEach(() => {
  dto = baseDto();
  installMutate.mockClear();
  restartMutate.mockClear();
  toastMock.mockClear();
  toastMock.loading.mockClear();
  sessionStorage.clear();
});

describe("UpdateToast", () => {
  it("announces a downloaded runtime update with a Restart action", () => {
    dto = { ...baseDto(), pendingVersion: "0.2.0" };
    render(<UpdateToast />);
    expect(toastMock).toHaveBeenCalledWith(
      "Libi 0.2.0 is ready",
      expect.objectContaining({
        id: UPDATE_TOAST_ID,
        duration: Infinity,
        closeButton: true,
        action: expect.objectContaining({ label: "Restart now" }),
      }),
    );
  });

  it("Restart now applies the update and morphs into 'Restarting…'", () => {
    dto = { ...baseDto(), pendingVersion: "0.2.0" };
    const { rerender } = render(<UpdateToast />);
    act(() => lastToastOpts().action.onClick());
    expect(restartMutate).toHaveBeenCalledWith({ target: "runtime", version: "0.2.0" });

    rerender(<UpdateToast />);
    expect(toastMock.loading).toHaveBeenCalledWith(
      "Restarting Libi…",
      expect.objectContaining({ id: UPDATE_TOAST_ID }),
    );
  });

  it("a downloaded SHELL update gets the identical surface — the channel is invisible", () => {
    dto = shellDto("ready", { percent: 100, autoDownload: true });
    render(<UpdateToast />);
    expect(toastMock).toHaveBeenCalledWith(
      "Libi 0.4.0 is ready",
      expect.objectContaining({
        id: UPDATE_TOAST_ID,
        action: expect.objectContaining({ label: "Restart now" }),
      }),
    );
    act(() => lastToastOpts().action.onClick());
    expect(restartMutate).toHaveBeenCalledWith({ target: "shell", version: "0.4.0" });
  });

  it("stays SILENT while downloads run — that is the whole point of auto-download", () => {
    // Runtime download in flight.
    dto = {
      ...baseDto(),
      update: { ...baseDto().update, state: "update-available", latestVersion: "0.2.0" },
      install: runningInstall("0.2.0"),
    };
    render(<UpdateToast />);
    // Shell download in flight (auto-download shell).
    dto = shellDto("downloading", { percent: 40, autoDownload: true });
    render(<UpdateToast />);
    // A new shell that just found an update — the download starts itself.
    dto = shellDto("update-available", { autoDownload: true });
    render(<UpdateToast />);
    expect(toastMock).not.toHaveBeenCalled();
    expect(toastMock.loading).not.toHaveBeenCalled();
  });

  it("a failed runtime auto-download is Settings' problem, not a toast", () => {
    dto = {
      ...baseDto(),
      update: { ...baseDto().update, state: "update-available", latestVersion: "0.2.0" },
      install: {
        ...(runningInstall("0.2.0") as object),
        status: "failed",
      } as unknown as RuntimeUpdateDto["install"],
    };
    render(<UpdateToast />);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("an OLD shell's update still gets the legacy click-to-install toast", () => {
    dto = shellDto("update-available"); // no autoDownload field
    render(<UpdateToast />);
    expect(toastMock).toHaveBeenCalledWith(
      "Libi 0.4.0 is available",
      expect.objectContaining({
        id: UPDATE_TOAST_ID,
        action: expect.objectContaining({ label: "Install & restart" }),
      }),
    );
    act(() => lastToastOpts().action.onClick());
    expect(installMutate).toHaveBeenCalledWith({ target: "shell", version: "0.4.0" });
  });

  it("a legacy shell install shows download percent, then 'Restarting…'", () => {
    dto = shellDto("update-available");
    const { rerender } = render(<UpdateToast />);
    act(() => lastToastOpts().action.onClick());

    dto = shellDto("downloading", { percent: 37 });
    rerender(<UpdateToast />);
    expect(toastMock.loading).toHaveBeenCalledWith(
      expect.stringContaining("37%"),
      expect.objectContaining({ id: UPDATE_TOAST_ID }),
    );

    dto = shellDto("ready", { percent: 100 });
    rerender(<UpdateToast />);
    expect(toastMock.loading).toHaveBeenCalledWith(
      "Restarting Libi…",
      expect.objectContaining({ id: UPDATE_TOAST_ID }),
    );
    // The OLD shell restarts itself from the main process; the web app must
    // not fire its own restart on top of that.
    expect(restartMutate).not.toHaveBeenCalled();
  });

  it("an old shell's self-restarting 'ready' never renders as an offer", () => {
    dto = shellDto("ready", { percent: 100 }); // no autoDownload
    render(<UpdateToast />);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("dismissing silences THIS LAUNCH only — sessionStorage, so a new launch re-offers", () => {
    dto = { ...baseDto(), pendingVersion: "0.2.0" };
    const first = render(<UpdateToast />);
    act(() => lastToastOpts().onDismiss());
    // sessionStorage, NOT localStorage: it dies with the app session, which is
    // exactly the point — a dismissed update must nag again at next launch.
    expect(sessionStorage.getItem(UPDATE_TOAST_DISMISS_KEY)).toBe("0.2.0");
    expect(localStorage.getItem(UPDATE_TOAST_DISMISS_KEY)).toBeNull();
    first.unmount();

    toastMock.mockClear();
    render(<UpdateToast />);
    expect(toastMock).not.toHaveBeenCalled(); // same launch, stays dismissed

    // A NEWER downloaded version still breaks through within the same launch.
    dto = { ...baseDto(), pendingVersion: "0.3.0" };
    render(<UpdateToast />);
    expect(toastMock).toHaveBeenCalledWith("Libi 0.3.0 is ready", expect.anything());
  });

  it("a Restart click is not a dismissal — nothing is remembered", () => {
    dto = { ...baseDto(), pendingVersion: "0.2.0" };
    render(<UpdateToast />);
    act(() => lastToastOpts().action.onClick());
    expect(sessionStorage.getItem(UPDATE_TOAST_DISMISS_KEY)).toBeNull();
  });

  it("stays silent when there is nothing downloaded or offerable", () => {
    for (const state of ["unsupported", "unknown", "up-to-date", "shell-update-required"] as const) {
      dto = { ...baseDto(), update: { ...baseDto().update, state } };
      render(<UpdateToast />);
    }
    for (const phase of ["idle", "checking", "up-to-date", "error"] as const) {
      dto = shellDto(phase, { latestVersion: null });
      render(<UpdateToast />);
    }
    expect(toastMock).not.toHaveBeenCalled();
    expect(restartMutate).not.toHaveBeenCalled();
  });
});
