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

// sonner is mocked so assertions run against the toast CONTRACT (id, copy,
// action, dismiss handler) rather than portal DOM — same isolation approach
// as the settings component tests' query-hook mocks.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { loading: vi.fn(), dismiss: vi.fn() }),
}));

const installMutate = vi.fn();
const resetMutate = vi.fn();
const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

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

function shellDto(
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
  };
});

vi.mock("@/lib/queries/server-status", () => ({
  useResetServer: () => ({
    mutate: resetMutate,
    isIdle: resetMutate.mock.calls.length === 0,
  }),
}));

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
  resetMutate.mockClear();
  routerPush.mockClear();
  toastMock.mockClear();
  toastMock.loading.mockClear();
  sessionStorage.clear();
});

describe("UpdateToast", () => {
  it("offers a runtime update as a persistent, dismissible toast with an install action", () => {
    render(<UpdateToast />);
    expect(toastMock).toHaveBeenCalledWith(
      "Libi 0.2.0 is available",
      expect.objectContaining({
        id: UPDATE_TOAST_ID,
        duration: Infinity,
        closeButton: true,
        action: expect.objectContaining({ label: "Install & restart" }),
      }),
    );
  });

  it("offers a SHELL update with the identical surface — the channel is invisible", () => {
    dto = shellDto("update-available");
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
    expect(routerPush).toHaveBeenCalledWith("/settings?highlight=version");
  });

  it("stays silent when there is nothing installable on either channel", () => {
    for (const state of ["unsupported", "unknown", "up-to-date", "shell-update-required"] as const) {
      dto = {
        ...baseDto(),
        update: { ...baseDto().update, state },
      };
      render(<UpdateToast />);
    }
    for (const phase of ["idle", "checking", "up-to-date", "error"] as const) {
      dto = shellDto(phase, { latestVersion: null });
      render(<UpdateToast />);
    }
    dto = { ...baseDto(), pendingVersion: "0.2.0" }; // downloaded earlier, no consent here
    render(<UpdateToast />);
    expect(toastMock).not.toHaveBeenCalled();
    expect(resetMutate).not.toHaveBeenCalled();
  });

  it("a shell release turns `shell-update-required` from a dead end into an offer", () => {
    dto = {
      ...shellDto("update-available"),
      update: { ...baseDto().update, state: "shell-update-required", latestVersion: "0.5.0" },
    };
    render(<UpdateToast />);
    expect(toastMock).toHaveBeenCalledWith("Libi 0.4.0 is available", expect.anything());
  });

  it("dismissing silences THIS LAUNCH only — sessionStorage, so a new launch re-offers", () => {
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

    // A NEWER version still breaks through within the same launch.
    dto = {
      ...baseDto(),
      update: { ...baseDto().update, latestVersion: "0.3.0" },
    };
    render(<UpdateToast />);
    expect(toastMock).toHaveBeenCalledWith("Libi 0.3.0 is available", expect.anything());
  });

  it("install action starts the install, then the completed download auto-restarts", () => {
    const { rerender } = render(<UpdateToast />);
    act(() => lastToastOpts().action.onClick());
    expect(installMutate).toHaveBeenCalledWith({ target: "runtime", version: "0.2.0" });
    // The click lands the user on the Settings Version section (flashed on
    // arrival) instead of the toast just vanishing.
    expect(routerPush).toHaveBeenCalledWith("/settings?highlight=version");
    expect(resetMutate).not.toHaveBeenCalled();

    // Poll delivers the running install → progress toast, same id (no stack).
    dto = {
      ...baseDto(),
      install: {
        id: "job", kind: "runtime_update", status: "running", progress: null,
        error: null, createdAt: 0, updatedAt: 0, version: "0.2.0",
      } as unknown as RuntimeUpdateDto["install"],
    };
    rerender(<UpdateToast />);
    expect(toastMock.loading).toHaveBeenCalledWith(
      expect.stringContaining("Downloading the new Libi"),
      expect.objectContaining({ id: UPDATE_TOAST_ID }),
    );

    // Poll delivers the completed download → restart fires exactly once.
    dto = { ...baseDto(), pendingVersion: "0.2.0" };
    rerender(<UpdateToast />);
    expect(resetMutate).toHaveBeenCalledTimes(1);
    rerender(<UpdateToast />);
    expect(resetMutate).toHaveBeenCalledTimes(1);
    expect(toastMock.loading).toHaveBeenCalledWith(
      "Restarting Libi…",
      expect.objectContaining({ id: UPDATE_TOAST_ID }),
    );
  });

  it("a shell install shows download percent, then 'Restarting…' — and never calls reset", () => {
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
    // The SHELL restarts itself from the main process — the web app resetting
    // the server underneath it at the same time would race that.
    expect(resetMutate).not.toHaveBeenCalled();
  });

  it("an install click is not a dismissal — nothing is remembered", () => {
    render(<UpdateToast />);
    act(() => lastToastOpts().action.onClick());
    expect(sessionStorage.getItem(UPDATE_TOAST_DISMISS_KEY)).toBeNull();
  });
});
