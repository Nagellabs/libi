import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * EL-1: the desktop app's native confirm before a template goes public. Only
 * Electron main can show it; page script and CDP can't click it (a real
 * browser on the loopback port never asks for it — lib/approval/extensions.ts
 * LIMITATIONS). `electron` is mocked: what is under test is what the dialog
 * says, that Cancel is the default AND the Escape answer, that only "Publish"
 * (response 1) says yes, that a name is held to the catalog's own
 * single-line rule (lib/templates/cloud/text-rules.ts#singleLineTextProblem —
 * electron/ can't import lib/, so the parity is pinned below), that a refused
 * name is told apart from Cancel, and that only the app's own top frame may ask.
 */
const h = vi.hoisted(() => ({
  handle: vi.fn(),
  showMessageBox: vi.fn(),
  fromWebContents: vi.fn(),
  log: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: h.handle },
  dialog: { showMessageBox: h.showMessageBox },
  BrowserWindow: { fromWebContents: h.fromWebContents },
}));
vi.mock("../../../electron/sync-log", () => ({ mainSyncLog: h.log }));

import {
  CONFIRM_PUBLISH_CHANNEL,
  TEMPLATE_NAME_MAX_CHARS,
  confirmPublishTextProblem,
  registerConfirmPublishIpc,
} from "../../../electron/confirm-publish";
import { singleLineTextProblem } from "@/lib/templates/cloud/text-rules";

const APP_ORIGIN = "http://127.0.0.1:55268";
const win = { isDestroyed: () => false };
const sender = { id: 7 };
const topFrame = { url: `${APP_ORIGIN}/templates?review=r1`, parent: null };
const event = (frame: unknown = topFrame) => ({ sender, senderFrame: frame });

function handler(origin: string | null = APP_ORIGIN): (e: unknown, args: unknown) => Promise<unknown> {
  h.handle.mockClear();
  registerConfirmPublishIpc(() => origin);
  const call = h.handle.mock.calls.find(([channel]) => channel === CONFIRM_PUBLISH_CHANNEL);
  expect(call, "the channel is registered with ipcMain.handle").toBeTruthy();
  return call![1];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.fromWebContents.mockReturnValue(win);
  h.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
});

describe("libi:confirm-publish", () => {
  it("asks on the sender's window with Cancel as the default and the cancel answer, plain buttons, the name isolated for RTL", async () => {
    expect(CONFIRM_PUBLISH_CHANNEL).toBe("libi:confirm-publish");
    await handler()(event(), { templateName: "Monday reset hook", catalogHost: "libi.nagellabs.com" });
    expect(h.fromWebContents).toHaveBeenCalledWith(sender);
    expect(h.showMessageBox).toHaveBeenCalledTimes(1);
    const [parent, opts] = h.showMessageBox.mock.calls[0];
    expect(parent).toBe(win);
    expect(opts).toMatchObject({
      type: "question",
      buttons: ["Cancel", "Publish"],
      defaultId: 0,
      cancelId: 0,
      // Windows would otherwise draw "Publish" as a command link, not a button.
      noLink: true,
      // FSI … PDI: an RTL name keeps its own direction inside the English sentence.
      message: 'Publish "\u2068Monday reset hook\u2069" to the public catalog?',
      detail: "It will be listed at libi.nagellabs.com for anyone to use.",
    });
  });

  it("returns true only for response 1 (Publish)", async () => {
    const ask = handler();
    const args = { templateName: "Hook", catalogHost: "libi.nagellabs.com" };
    h.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    await expect(ask(event(), args)).resolves.toBe(true);
    h.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    await expect(ask(event(), args)).resolves.toBe(false);
    h.showMessageBox.mockResolvedValueOnce({ response: 2, checkboxChecked: false });
    await expect(ask(event(), args)).resolves.toBe(false);
  });

  it("a Hebrew or Arabic name ending in RLM / ALM (catalog-valid) is asked about, not refused", async () => {
    const ask = handler();
    for (const templateName of ["\u05e4\u05ea\u05d9\u05d7 \u05e9\u05d1\u05d5\u05e2\u05d9\u200f", "\u0645\u0642\u062f\u0645\u0629 \u0623\u0633\u0628\u0648\u0639\u064a\u0629\u061c", "\u200eHook\u200e"]) {
      h.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
      await expect(ask(event(), { templateName, catalogHost: "libi.nagellabs.com" }), templateName).resolves.toBe(true);
    }
    expect(h.showMessageBox).toHaveBeenCalledTimes(3);
  });

  it('refuses ("refused", no dialog) what the catalog refuses, an over-long name or host, and malformed args', async () => {
    expect(TEMPLATE_NAME_MAX_CHARS).toBe(200);
    const ask = handler();
    const host = "libi.nagellabs.com";
    for (const args of [
      { templateName: "x".repeat(TEMPLATE_NAME_MAX_CHARS + 1), catalogHost: host },
      { templateName: "Hook\nPublish anyway", catalogHost: host },
      { templateName: "Hook\u2028Publish anyway", catalogHost: host },
      { templateName: "Hook\u2029", catalogHost: host },
      { templateName: "Hook\u0000", catalogHost: host },
      { templateName: "Hook\u007f", catalogHost: host },
      { templateName: "Hook\u202e", catalogHost: host },
      { templateName: "Hook\u2068", catalogHost: host },
      { templateName: "Hook\u{E0041}", catalogHost: host },
      { templateName: "Z\u0301\u0302\u0303\u0304\u0305\u0306\u0307", catalogHost: host },
      { templateName: "Hook", catalogHost: "evil.example\r\nlibi.nagellabs.com" },
      { templateName: "Hook", catalogHost: "h".repeat(254) },
      { templateName: "", catalogHost: host },
      { templateName: "Hook", catalogHost: "" },
      { templateName: 42, catalogHost: host },
      { templateName: "Hook" },
      null,
      "Hook",
    ]) {
      await expect(ask(event(), args), JSON.stringify(args)).resolves.toBe("refused");
    }
    expect(h.showMessageBox).not.toHaveBeenCalled();
    h.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    await expect(ask(event(), { templateName: "x".repeat(TEMPLATE_NAME_MAX_CHARS), catalogHost: host })).resolves.toBe(true);
  });

  it("the name rule is the catalog's singleLineTextProblem (parity pinned: electron/ cannot import lib/)", () => {
    const samples = [
      "Monday reset hook",
      "\u05e4\u05ea\u05d9\u05d7 \u05e9\u05d1\u05d5\u05e2\u05d9\u200f",
      "\u0645\u0642\u062f\u0645\u0629\u061c",
      "\u200eHook",
      "Hook\n",
      "Hook\r",
      "Hook\t",
      "Hook\u0085",
      "Hook\u2028",
      "Hook\u2029",
      "Hook\u202a",
      "Hook\u202d",
      "Hook\u2066",
      "Hook\u2069",
      "Hook\u{E0041}",
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} flag",
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0078}\u{E0078}\u{E0078}\u{E007F} fake flag",
      "Vi\u1ec7t",
      "a\u0301\u0302\u0303\u0304\u0305\u0306",
      "a\u0301\u0302\u0303\u0304\u0305\u0306\u0307",
      "\u101c\u103b\u103e\u102d\u102f\u1037\u101d\u103e\u1000\u103a",
      "emoji 1\ufe0f\u20e3",
      "zero\u200bwidth",
    ];
    for (const s of samples) {
      expect(confirmPublishTextProblem(s) === null, JSON.stringify(s)).toBe(singleLineTextProblem(s) === null);
    }
  });

  it("refuses (false, no dialog) a sender that is not the app's own top frame, or before the app has an origin", async () => {
    const args = { templateName: "Hook", catalogHost: "libi.nagellabs.com" };
    let ask = handler();
    await expect(ask(event({ url: "https://evil.example/", parent: null }), args)).resolves.toBe(false);
    await expect(ask(event({ url: `${APP_ORIGIN}/x`, parent: {} }), args)).resolves.toBe(false);
    await expect(ask(event({ url: "http://127.0.0.1:55269/templates", parent: null }), args)).resolves.toBe(false);
    await expect(ask(event(null), args)).resolves.toBe(false);
    ask = handler(null);
    await expect(ask(event(), args)).resolves.toBe(false);
    expect(h.showMessageBox).not.toHaveBeenCalled();
  });

  it("refuses when the sender has no live window (no parentless dialog)", async () => {
    const ask = handler();
    h.fromWebContents.mockReturnValueOnce(null);
    await expect(ask(event(), { templateName: "Hook", catalogHost: "libi.nagellabs.com" })).resolves.toBe(false);
    h.fromWebContents.mockReturnValueOnce({ isDestroyed: () => true });
    await expect(ask(event(), { templateName: "Hook", catalogHost: "libi.nagellabs.com" })).resolves.toBe(false);
    expect(h.showMessageBox).not.toHaveBeenCalled();
  });
});
