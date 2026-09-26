// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const KEY = "Ab3_-".repeat(8) + "xyz"; // 43 chars
const OTHER = "Zz9-_".repeat(8) + "abc";
const MASK = "Ab3_…-xyz"; // first 4 … last 4
const importMock = vi.fn();
const revealMock = vi.fn<() => Promise<string>>();
let keyQuery: { data?: { hasKey: boolean; masked: string | null; authorId: string | null; nickname: string | null; publishedHere: boolean }; isError?: boolean; refetch?: () => void };
const setNicknameMock = vi.fn();
let author: { data?: { nickname: string | null; authorId: string | null } };
let mine: { data?: { nickname: string | null; templates: unknown[]; error?: string; dropped?: number }; isPending: boolean };
let setState: { isPending: boolean; error: Error | null };

vi.mock("@/lib/queries/templates-cloud", async (importOriginal) => {
  const { CloudRouteError, REPLACE_REQUIRED } = await importOriginal<typeof import("@/lib/queries/templates-cloud")>();
  return {
    CloudRouteError,
    REPLACE_REQUIRED,
    useCreatorKeyStatus: () => keyQuery,
    useImportCreatorKey: () => ({ mutate: importMock, isPending: false }),
    revealCreatorKey: () => revealMock(),
    // The nickname row (NicknameEditor, shared with "Publishing as").
    useTemplatesAuthor: () => author,
    useCloudMine: () => mine,
    useSetNickname: () => ({ mutate: setNicknameMock, reset: vi.fn(), ...setState }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { CreatorKeyCard } from "@/components/settings/creator-key-card";
import { CloudRouteError } from "@/lib/queries/templates-cloud";

/** The server's answer to the latest import: a different key is stored, so replacing it needs a confirmation. */
function serverAsksToConfirm() {
  const [, opts] = importMock.mock.calls.at(-1)!;
  act(() => opts.onError(new CloudRouteError("This install already has a different creator key.", 409, "replace_required")));
}

beforeEach(() => {
  keyQuery = { data: { hasKey: true, masked: MASK, authorId: "a", nickname: "nadav", publishedHere: false } };
  author = { data: { nickname: "nadav", authorId: "a" } };
  mine = { data: { nickname: null, templates: [] }, isPending: false };
  setState = { isPending: false, error: null };
  revealMock.mockResolvedValue(KEY);
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CreatorKeyCard", () => {
  it("fetches nothing secret on mount: shows the server's mask, and says what the key can do", () => {
    render(<CreatorKeyCard />);
    expect(screen.getByTestId("creator-key-masked").textContent).toBe(MASK);
    expect(revealMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Anyone with this key can edit your published templates/)).toBeInTheDocument();
  });

  it("fetches the key only on Reveal, every time — Hide forgets it", async () => {
    render(<CreatorKeyCard />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(await screen.findByTestId("creator-key-full")).toHaveTextContent(KEY);
    expect(revealMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText(KEY)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(await screen.findByTestId("creator-key-full")).toHaveTextContent(KEY);
    expect(revealMock).toHaveBeenCalledTimes(2); // not cached
  });

  it("forgets a revealed key when the card unmounts", async () => {
    render(<CreatorKeyCard />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await screen.findByTestId("creator-key-full");
    cleanup();
    render(<CreatorKeyCard />);
    expect(screen.queryByText(KEY)).toBeNull();
    expect(screen.getByTestId("creator-key-masked")).toBeInTheDocument();
  });

  it("never shows a revealed key once the stored key has changed under it", async () => {
    const view = render(<CreatorKeyCard />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await screen.findByTestId("creator-key-full");
    keyQuery = { data: { hasKey: true, masked: "Zz9-…_abc", authorId: "b", nickname: null, publishedHere: false } };
    view.rerender(<CreatorKeyCard />);
    expect(screen.queryByText(KEY)).toBeNull();
    expect(screen.getByTestId("creator-key-masked").textContent).toBe("Zz9-…_abc");
  });

  it("a failed reveal says so and shows nothing", async () => {
    const { toast } = await import("sonner");
    revealMock.mockRejectedValueOnce(new Error("nope"));
    render(<CreatorKeyCard />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByTestId("creator-key-full")).toBeNull();
  });

  it("copies the whole key, fetched for the click, without revealing it", async () => {
    render(<CreatorKeyCard />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(KEY));
    expect(revealMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("creator-key-full")).toBeNull();
  });

  it("replacing a USED key takes a second, explicit confirmation — asked for by the server — offering a copy of the current key first", async () => {
    keyQuery = { data: { hasKey: true, masked: MASK, authorId: "a", nickname: "nadav", publishedHere: true } };
    render(<CreatorKeyCard />);
    fireEvent.click(screen.getByRole("button", { name: "Import a key" }));
    expect(screen.getByTestId("creator-key-import-warning").textContent).toMatch(/can no longer be edited, hidden or updated from here/);
    const input = screen.getByTestId("creator-key-input");
    fireEvent.change(input, { target: { value: "not a key" } });
    expect(screen.getByTestId("creator-key-input-error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use this key" })).toBeDisabled();
    fireEvent.change(input, { target: { value: `  ${OTHER}\n` } });
    expect(screen.queryByTestId("creator-key-input-error")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use this key" }));
    // The first submit never replaces: the server compares the whole key.
    expect(importMock).toHaveBeenCalledWith({ key: OTHER, replace: false }, expect.anything());
    serverAsksToConfirm();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the current key" }));
    });
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(KEY));
    fireEvent.click(screen.getByRole("button", { name: /Replace it/ }));
    expect(importMock).toHaveBeenLastCalledWith({ key: OTHER, replace: true }, expect.anything());
  });

  it("never trusts the mask: a different key that shares it still waits for the server, which asks to confirm", () => {
    const lookalike = KEY.slice(0, 4) + OTHER.slice(4, -4) + KEY.slice(-4);
    render(<CreatorKeyCard />);
    fireEvent.click(screen.getByRole("button", { name: "Import a key" }));
    fireEvent.change(screen.getByTestId("creator-key-input"), { target: { value: lookalike } });
    fireEvent.click(screen.getByRole("button", { name: "Use this key" }));
    expect(importMock).toHaveBeenCalledWith({ key: lookalike, replace: false }, expect.anything());
    serverAsksToConfirm();
    expect(screen.getByTestId("creator-key-replace-confirm")).toBeInTheDocument();
  });

  it("pasting the key already in use needs no confirmation: the server takes it as is", () => {
    render(<CreatorKeyCard />);
    fireEvent.click(screen.getByRole("button", { name: "Import a key" }));
    fireEvent.change(screen.getByTestId("creator-key-input"), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Use this key" }));
    expect(importMock).toHaveBeenCalledWith({ key: KEY, replace: false }, expect.anything());
    const [, opts] = importMock.mock.calls[0];
    act(() => opts.onSuccess());
    expect(screen.queryByTestId("creator-key-import")).toBeNull();
    expect(screen.queryByTestId("creator-key-replace-confirm")).toBeNull();
  });

  it("an unused key (nothing published here, the site lists nothing) shows no replacement warning; the server still decides", () => {
    render(<CreatorKeyCard />);
    fireEvent.click(screen.getByRole("button", { name: "Import a key" }));
    expect(screen.queryByTestId("creator-key-import-warning")).toBeNull();
    fireEvent.change(screen.getByTestId("creator-key-input"), { target: { value: OTHER } });
    fireEvent.click(screen.getByRole("button", { name: "Use this key" }));
    expect(importMock).toHaveBeenCalledWith({ key: OTHER, replace: false }, expect.anything());
  });

  it("warns when the site lists templates for the key, can't be read, or hasn't answered yet — a doubt warns", () => {
    for (const m of [
      { data: { nickname: null, templates: [{}] }, isPending: false },
      // Entries libi couldn't read are still the key's.
      { data: { nickname: null, templates: [], dropped: 1 }, isPending: false },
      // A nickname the site holds was chosen under this key.
      { data: { nickname: "Nadav", templates: [] }, isPending: false },
      { data: { nickname: null, templates: [], error: "unreachable" }, isPending: false },
      { data: undefined, isPending: true },
    ]) {
      mine = m;
      render(<CreatorKeyCard />);
      fireEvent.click(screen.getByRole("button", { name: "Import a key" }));
      expect(screen.getByTestId("creator-key-import-warning"), JSON.stringify(m)).toBeInTheDocument();
      cleanup();
    }
  });

  it("shows the public nickname — a default one before the first publish — and edits it in place", () => {
    author = { data: { nickname: "Brave Otter 4821", authorId: "a" } };
    render(<CreatorKeyCard />);
    const edit = screen.getByTestId("creator-key-nickname-edit");
    expect(edit).toHaveTextContent("Brave Otter 4821");
    expect(edit.className).toContain("cursor-pointer");
    fireEvent.click(edit);
    const input = screen.getByTestId("creator-key-nickname-input") as HTMLInputElement;
    expect(input.value).toBe("Brave Otter 4821");
    fireEvent.change(input, { target: { value: "  Nadav   N " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setNicknameMock).toHaveBeenCalledWith("Nadav N", expect.anything());
  });

  it("Settings: a rename refused as creator_not_approved gets the rename message, not the publish one", () => {
    setState = { isPending: false, error: Object.assign(new Error("Nothing was published."), { status: 403, code: "creator_not_approved" }) };
    render(<CreatorKeyCard />);
    fireEvent.click(screen.getByTestId("creator-key-nickname-edit"));
    fireEvent.change(screen.getByTestId("creator-key-nickname-input"), { target: { value: "someone" } });
    const shown = screen.getByTestId("creator-key-nickname-error").textContent ?? "";
    expect(shown).toBe("You can't change your nickname: once you've published a template, only an approved creator can change it, even while your templates are hidden.");
    expect(shown).not.toMatch(/Nothing was published|hide your|in the catalog/i);
  });

  it("a nickname save in flight says so on the field", () => {
    setState = { isPending: true, error: null };
    render(<CreatorKeyCard />);
    fireEvent.click(screen.getByTestId("creator-key-nickname-edit"));
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(screen.getByTestId("creator-key-nickname-input")).toBeDisabled();
  });

  it("there is no \"No key yet\" state or Create now: the key and its default nickname exist from the first view", () => {
    render(<CreatorKeyCard />);
    expect(screen.queryByText(/No key yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Create now/ })).toBeNull();
    expect(screen.getByTestId("creator-key-masked")).toBeInTheDocument();
    expect(screen.getByTestId("creator-key-nickname-edit")).toHaveTextContent("nadav");
  });

  it("shows a skeleton while loading and a retry when the read failed", () => {
    keyQuery = {};
    render(<CreatorKeyCard />);
    expect(screen.getByTestId("creator-key-skeleton")).toBeInTheDocument();
    cleanup();
    const refetch = vi.fn();
    keyQuery = { isError: true, refetch };
    render(<CreatorKeyCard />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });
});
