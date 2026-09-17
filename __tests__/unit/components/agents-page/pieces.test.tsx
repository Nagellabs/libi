// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LegacyKeyNotice as LegacyNotice } from "@/lib/queries/providers";

/**
 * The presentational pieces the Providers tab is built from, tested directly.
 * `CommandBox` is the read-only copy box: Copy writes the exact command, a
 * refused clipboard write says so instead of failing silently, and the
 * copied tick's reset timer dies with the component. `LegacyKeyNotice` is the
 * one place a rescued stored key is ever rendered, so it must poll only when
 * its host says so and render nothing at all when there is nothing to hand
 * back. `DocsLink`'s href and cursor are covered by providers-tab.test.tsx.
 */

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
}));

let notices: LegacyNotice[] | undefined = [];
const noticeOpts: { enabled?: boolean }[] = [];
const ackLegacy = vi.fn<(rowId: string) => Promise<void>>(async () => undefined);
vi.mock("@/lib/queries/providers", () => ({
  useLegacyKeyNotices: (opts: { enabled?: boolean }) => {
    noticeOpts.push(opts);
    return { data: notices === undefined ? undefined : { notices } };
  },
  useAcknowledgeLegacyKey: () => ({ mutateAsync: ackLegacy, isPending: false }),
}));

import { CommandBox, LegacyKeyNotice } from "@/components/agents-page/providers-tab/pieces";

// Multi-line on purpose: the copy must be the command verbatim, newline included.
const COMMAND =
  'export FAL_KEY="<your key>"\ncodex mcp add fal-ai --url https://mcp.fal.ai/mcp --bearer-token-env-var FAL_KEY';

const FAL_LEGACY: LegacyNotice = {
  rowId: "fal-ai",
  providerId: "fal",
  providerName: "fal.ai",
  command: "claude mcp add fal-ai … sk-legacy-123",
  commands: {
    claude: "claude mcp add fal-ai … sk-legacy-123",
    codex: 'export FAL_KEY="sk-legacy-123"\ncodex mcp add fal-ai …',
  },
};

const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>(async () => undefined) };

const copyButton = () => screen.getByRole("button", { name: /copy command/i });
const showsTick = () => copyButton().querySelector(".lucide-check") !== null;

beforeEach(() => {
  notices = [];
  noticeOpts.length = 0;
  toastError.mockClear();
  ackLegacy.mockReset();
  ackLegacy.mockImplementation(async () => undefined);
  clipboard.writeText.mockReset();
  clipboard.writeText.mockImplementation(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CommandBox", () => {
  it("shows the command read-only, and its Copy button has cursor-pointer", () => {
    render(<CommandBox id="fal" command={COMMAND} />);
    expect(screen.getByTestId("command-fal").textContent).toBe(COMMAND);
    expect(document.querySelectorAll("input, textarea")).toHaveLength(0);
    expect(copyButton().className).toContain("cursor-pointer");
  });

  it("Copy writes the exact command to the clipboard and shows the copied tick", async () => {
    render(<CommandBox id="fal" command={COMMAND} />);
    expect(showsTick()).toBe(false);
    fireEvent.click(copyButton());
    await waitFor(() => expect(showsTick()).toBe(true));
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledWith(COMMAND);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says so when the clipboard refuses the write, and shows no tick", async () => {
    clipboard.writeText.mockRejectedValueOnce(new Error("NotAllowedError"));
    render(<CommandBox id="fal" command={COMMAND} />);
    fireEvent.click(copyButton());
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't copy — select the command and copy it by hand."),
    );
    expect(showsTick()).toBe(false);
  });

  it("the tick reverts to the Copy icon after 1.5 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<CommandBox id="fal" command={COMMAND} />);
    await act(async () => {
      fireEvent.click(copyButton());
    });
    expect(showsTick()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(showsTick()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(showsTick()).toBe(false);
  });

  it("clears the copied tick's timer on unmount — nothing is left pending to fire", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = render(<CommandBox id="fal" command={COMMAND} />);
      const idle = vi.getTimerCount();
      await act(async () => {
        fireEvent.click(copyButton());
      });
      expect(showsTick()).toBe(true);
      expect(vi.getTimerCount()).toBe(idle + 1);
      view.unmount();
      expect(vi.getTimerCount()).toBe(idle);
      vi.advanceTimersByTime(5_000);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("LegacyKeyNotice", () => {
  it.each([true, false])("threads the host's polling switch (enabled=%s) into the notice query", (enabled) => {
    render(<LegacyKeyNotice agent="claude" enabled={enabled} />);
    expect(noticeOpts.length).toBeGreaterThan(0);
    for (const opts of noticeOpts) expect(opts).toEqual({ enabled });
  });

  it("renders nothing when there is no rescued key", () => {
    notices = [];
    const { container } = render(<LegacyKeyNotice agent="claude" enabled />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing before the query has answered (or while it is switched off)", () => {
    notices = undefined;
    const { container } = render(<LegacyKeyNotice agent="codex" enabled={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the key inside the agent's command, in a copy box", () => {
    notices = [FAL_LEGACY];
    render(<LegacyKeyNotice agent="codex" enabled />);
    expect(screen.getByTestId("legacy-key-fal-ai")).toHaveTextContent(/fal\.ai is no longer bundled/);
    expect(screen.getByTestId("command-legacy-fal-ai").textContent).toBe(FAL_LEGACY.commands.codex);
  });

  it("says so when clearing the key fails, rather than dropping the error", async () => {
    notices = [FAL_LEGACY];
    ackLegacy.mockRejectedValueOnce(new Error("500"));
    render(<LegacyKeyNotice agent="claude" enabled />);
    const ack = screen.getByRole("button", { name: /copied it/i });
    expect(ack.className).toContain("cursor-pointer");
    fireEvent.click(ack);
    expect(ackLegacy).toHaveBeenCalledWith("fal-ai");
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't clear the key — try again."));
  });
});
