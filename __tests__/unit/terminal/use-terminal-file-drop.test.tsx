// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const uploadFileTo = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
vi.mock("@/lib/queries/files", () => ({ uploadFileTo: (...a: unknown[]) => uploadFileTo(...a) }));
vi.mock("sonner", () => ({
  toast: { error: (m: string) => toastError(m), info: (m: string) => toastInfo(m) },
}));

import { useTerminalFileDrop } from "@/hooks/terminal/use-terminal-file-drop";
import { TERMINAL_INSERT_TEXT_EVENT } from "@/lib/onboarding/demo";

const png = (name = "shot.png") =>
  new File([new Uint8Array([1])], name, { type: "image/png" });

let inserted: string[];
let listener: EventListener;
beforeEach(() => {
  vi.clearAllMocks();
  inserted = [];
  listener = ((e: Event) => {
    inserted.push((e as CustomEvent<{ text: string }>).detail.text);
  }) as EventListener;
  window.addEventListener(TERMINAL_INSERT_TEXT_EVENT, listener);
  // The hook now hits TWO endpoints — the file's location and the server's
  // shell flavor — so the stub must tell them apart by URL rather than
  // answering every call identically.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/shell-flavor")) {
      return { ok: true, json: async () => ({ flavor: "posix" }) };
    }
    return { ok: true, json: async () => ({ path: "/store/shot.png", exists: true }) };
  }));
});

afterEach(() => {
  window.removeEventListener(TERMINAL_INSERT_TEXT_EVENT, listener);
});

function setup(opts: { hasLiveTerminal?: boolean } = {}) {
  return renderHook(() =>
    useTerminalFileDrop({
      hasLiveTerminal: opts.hasLiveTerminal ?? true,
    }),
  );
}

describe("useTerminalFileDrop", () => {
  it("always uploads with a null (UNASSIGNED) target", async () => {
    // The hook's Options no longer carries a pieceId, so there is no "a piece
    // is open" state for it to ignore — it simply never has a piece to scope
    // to. The agent decides whether a dropped file belongs to the piece;
    // libi does not decide for it. `null` is the global/unassigned target.
    //
    // NOTE: written as `await act(...)` + a trailing `expect`, matching every
    // other test in this file, rather than the brief's `return act(...).then(...)`.
    // `act()`'s return value is a bare thenable (`{ then(resolve, reject) {...} }`),
    // not a real Promise — its `.then` callback doesn't return anything, so
    // chaining `.then()` on it produces `undefined`, which `it()` doesn't await.
    // The assertion then runs later, asynchronously, after the test has already
    // been reported as passed and the next test's `beforeEach` has cleared the
    // mocks — throwing a same-tick "0 calls" AssertionError with no promise to
    // catch it, which vitest reports as an unhandled exception attributed to
    // whichever test happens to be running when it fires. Reproduced verbatim
    // against @testing-library/react 16.3.2 / react 19.2.4 before switching to
    // this form.
    uploadFileTo.mockResolvedValue({ id: "f1" });
    const { result } = setup();
    await act(async () => { await result.current.handleDrop([png()]); });
    expect(uploadFileTo).toHaveBeenCalledWith(null, expect.any(File));
  });

  it("does nothing but explain itself when no terminal is live", async () => {
    const { result } = setup({ hasLiveTerminal: false });
    await act(async () => { await result.current.handleDrop([png()]); });

    expect(uploadFileTo).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
    expect(toastInfo).toHaveBeenCalled();
  });

  it("pastes surviving paths when one file fails, and names the failure", async () => {
    // One bad file must not discard the others — the whole point of collecting
    // results rather than failing the batch.
    uploadFileTo
      .mockResolvedValueOnce({ id: "f1" })
      .mockRejectedValueOnce(new Error("disk is full"));
    const { result } = setup();
    await act(async () => {
      await result.current.handleDrop([png("a.png"), png("b.png")]);
    });

    expect(inserted).toEqual(["/store/shot.png "]);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("disk is full"));
  });

  it("skips a file whose path cannot be resolved", async () => {
    uploadFileTo.mockResolvedValue({ id: "f1" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const { result } = setup();
    await act(async () => { await result.current.handleDrop([png()]); });

    expect(inserted).toEqual([]);
    expect(toastError).toHaveBeenCalled();
  });

  it("skips a file whose location reports exists: false, keeping the others", async () => {
    // /location can resolve a path AND say it's no longer on disk — treat
    // that identically to an unresolvable path rather than pasting a path
    // that will silently fail to open.
    uploadFileTo
      .mockResolvedValueOnce({ id: "gone" })
      .mockResolvedValueOnce({ id: "ok" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/shell-flavor")) {
        return { ok: true, json: async () => ({ flavor: "posix" }) };
      }
      if (String(url).includes("/gone/")) {
        return { ok: true, json: async () => ({ path: "/store/gone.png", exists: false }) };
      }
      return { ok: true, json: async () => ({ path: "/store/ok.png", exists: true }) };
    }));

    const { result } = setup();
    await act(async () => {
      await result.current.handleDrop([png("gone.png"), png("ok.png")]);
    });

    expect(inserted).toEqual(["/store/ok.png "]);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("gone.png"));
  });

  it("dispatches nothing for an empty drop", async () => {
    const { result } = setup();
    await act(async () => { await result.current.handleDrop([]); });
    expect(uploadFileTo).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("uploads one file at a time — the second upload does not start until the first resolves", async () => {
    // Test doubles that resolve on the same microtask can't tell a `for...of`
    // await loop apart from `Promise.all(files.map(...))`; both pass 6/6.
    // Deferred promises we resolve by hand can tell them apart.
    let resolveFirst!: (v: { id: string }) => void;
    let resolveSecond!: (v: { id: string }) => void;
    const firstUpload = new Promise<{ id: string }>((res) => { resolveFirst = res; });
    const secondUpload = new Promise<{ id: string }>((res) => { resolveSecond = res; });
    uploadFileTo.mockReturnValueOnce(firstUpload).mockReturnValueOnce(secondUpload);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/shell-flavor")) {
          return { ok: true, json: async () => ({ flavor: "posix" }) };
        }
        return {
          ok: true,
          json: async () => ({
            path: String(url).includes("f1") ? "/store/a.png" : "/store/b.png",
          }),
        };
      }),
    );

    const { result } = setup();
    let dropPromise!: Promise<void>;
    act(() => {
      dropPromise = result.current.handleDrop([png("a.png"), png("b.png")]);
    });

    // Synchronous portion of the first loop iteration has run; the second
    // file's upload must not have been kicked off yet.
    expect(uploadFileTo).toHaveBeenCalledTimes(1);

    resolveFirst({ id: "f1" });
    await waitFor(() => expect(uploadFileTo).toHaveBeenCalledTimes(2));

    resolveSecond({ id: "f2" });
    await act(async () => { await dropPromise; });

    expect(inserted).toEqual(["/store/a.png /store/b.png "]);
  });

  it("tracks isUploading across the upload lifecycle, including on failure", async () => {
    const { result } = setup();
    expect(result.current.isUploading).toBe(false);

    let resolveUpload!: (v: { id: string }) => void;
    const pending = new Promise<{ id: string }>((res) => { resolveUpload = res; });
    uploadFileTo.mockReturnValueOnce(pending);

    let dropPromise!: Promise<void>;
    act(() => {
      dropPromise = result.current.handleDrop([png()]);
    });
    expect(result.current.isUploading).toBe(true);

    resolveUpload({ id: "f1" });
    await act(async () => { await dropPromise; });
    expect(result.current.isUploading).toBe(false);

    // Failure path — isUploading must still come back down, via the `finally`.
    uploadFileTo.mockRejectedValueOnce(new Error("disk is full"));
    act(() => {
      dropPromise = result.current.handleDrop([png()]);
    });
    expect(result.current.isUploading).toBe(true);

    await act(async () => { await dropPromise; });
    expect(result.current.isUploading).toBe(false);
  });

  it("quotes for the shell the SERVER reports, ignoring the browser's own OS", async () => {
    // The server says powershell — an embedded `'` must come back escaped as
    // `''`. Nothing in this test (or the hook, post-fix) ever imports or
    // consults `getShellPlatform`; if the hook silently fell back to it, this
    // would produce POSIX (`'\''`) escaping instead and the assertion below
    // would fail.
    uploadFileTo.mockResolvedValue({ id: "f1" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/shell-flavor")) {
        return { ok: true, json: async () => ({ flavor: "powershell" }) };
      }
      return { ok: true, json: async () => ({ path: "/store/o'brien.png" }) };
    }));

    const { result } = setup();
    await act(async () => { await result.current.handleDrop([png()]); });

    expect(inserted).toEqual(["'/store/o''brien.png' "]);
  });

  it("inserts nothing and toasts when the shell-flavor request fails — never guesses", async () => {
    uploadFileTo.mockResolvedValue({ id: "f1" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/shell-flavor")) {
        return { ok: false, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ path: "/store/shot.png" }) };
    }));

    const { result } = setup();
    await act(async () => { await result.current.handleDrop([png()]); });

    expect(inserted).toEqual([]);
    expect(toastError).toHaveBeenCalled();
  });
});
