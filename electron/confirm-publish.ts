// electron/confirm-publish.ts
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { mainSyncLog } from "./sync-log";

/**
 * The desktop app's native confirm before a template goes public (EL-1).
 *
 * "An agent can prepare a publish; only the user can publish" (AGENTS.md). In
 * the desktop window, "Publish publicly" first asks Electron main for this
 * dialog. It is an EXTRA confirm on top of the page's gates (arming delay,
 * rights box, the browser-only confirm route), never a replacement for them.
 *
 * WHAT IT GUARDS, AND WHAT IT DOES NOT. It guards clicks inside the desktop
 * window only: script in that page, or DOM automation of it, cannot answer a
 * main-process dialog. It does NOT guard the studio itself. Any real browser
 * pointed at the studio's loopback port — Chrome driven by an agent's browser
 * tool, a Playwright MCP — loads the same review page with no bridge, never
 * asks, and publishes through the browser-only confirm as before; computer-use
 * can click the dialog itself; and a compromised renderer can skip the ask.
 * Closing that needs main to attest to the server (e.g. a per-launch secret the
 * confirm route requires when packaged), which is out of scope — the gap is
 * named in lib/approval/extensions.ts LIMITATIONS.
 *
 * The strings come from the renderer, so they are checked before they reach a
 * native dialog, by the catalog's own single-line rule (mirrored below, since
 * electron/ cannot import lib/; a test pins the parity) plus length caps. A
 * refused name answers "refused", never a silent Cancel, so the page can say why.
 * Only the app's own top frame, on the studio's origin, may ask.
 */
export const CONFIRM_PUBLISH_CHANNEL = "libi:confirm-publish";
export const TEMPLATE_NAME_MAX_CHARS = 200;
/** A DNS name's own maximum — or the fixed "the test-mode catalog" words. */
export const CATALOG_HOST_MAX_CHARS = 253;

// ---- mirrors lib/templates/cloud/text-rules.ts#singleLineTextProblem ----
// Kept in step by __tests__/unit/electron/confirm-publish-ipc.test.ts. LRM,
// RLM and ALM stay allowed: RTL writers legitimately type them.
const SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
const LINE_SEPARATORS = /[\u2028\u2029]/;
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/;
const SUBDIVISION_FLAGS = /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}/gu;
const TAG_CHARACTER = /[\u{E0000}-\u{E007F}]/u;
const MAX_COMBINING_MARKS = 6;
const COMBINING_STACK = new RegExp(`\\p{M}{${MAX_COMBINING_MARKS + 1},}`, "u");

/** Why `s` is not acceptable single-line text, or null — the catalog's rule. */
export function confirmPublishTextProblem(s: string): string | null {
  if (SINGLE_LINE_CONTROLS.test(s)) return "may not contain control characters";
  if (LINE_SEPARATORS.test(s)) return "may not contain line breaks";
  if (BIDI_CONTROLS.test(s)) return "may not contain bidi override or isolate characters";
  if (TAG_CHARACTER.test(s.replace(SUBDIVISION_FLAGS, ""))) return "may not contain Unicode tag characters";
  if (COMBINING_STACK.test(s)) return `may not stack more than ${MAX_COMBINING_MARKS} combining marks on one character`;
  return null;
}
// ---- end mirror ----

export interface ConfirmPublishArgs {
  templateName: string;
  catalogHost: string;
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && confirmPublishTextProblem(value) === null;
}

export function validConfirmPublishArgs(args: unknown): ConfirmPublishArgs | null {
  if (!args || typeof args !== "object") return null;
  const { templateName, catalogHost } = args as Record<string, unknown>;
  if (!safeText(templateName, TEMPLATE_NAME_MAX_CHARS)) return null;
  if (!safeText(catalogHost, CATALOG_HOST_MAX_CHARS)) return null;
  return { templateName, catalogHost };
}

/** What the renderer hears: Publish pressed, anything else, or arguments this dialog won't show. */
export type ConfirmPublishAnswer = boolean | "refused";

/** The frame that asked must be the app window's own top frame, on the studio's origin. */
function fromAppTopFrame(e: Pick<IpcMainInvokeEvent, "senderFrame">, appOrigin: string | null): boolean {
  const frame = e.senderFrame as { url?: string; parent?: unknown } | null | undefined;
  if (!appOrigin || !frame || frame.parent) return false;
  try {
    return new URL(frame.url ?? "").origin === appOrigin;
  } catch {
    return false;
  }
}

/** True only when the user pressed "Publish". Cancel, Escape, a foreign frame, no window: false. Bad args: "refused". */
export async function confirmPublishHandler(
  e: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  args: unknown,
  appOrigin: string | null,
): Promise<ConfirmPublishAnswer> {
  if (!fromAppTopFrame(e, appOrigin)) {
    mainSyncLog("confirm-publish: refused — not the app window's own top frame");
    return false;
  }
  const valid = validConfirmPublishArgs(args);
  if (!valid) {
    mainSyncLog("confirm-publish: refused — arguments failed validation");
    return "refused";
  }
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) {
    mainSyncLog("confirm-publish: refused — no live window for the sender");
    return false;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["Cancel", "Publish"],
    defaultId: 0,
    cancelId: 0,
    // Plain buttons on Windows: without it Electron draws every button it
    // doesn't recognise as a common one ("Publish") as a command link.
    noLink: true,
    // FSI … PDI isolate the name, so an RTL name keeps its own direction
    // inside the English sentence (the rule above refuses stray isolates).
    message: `Publish "\u2068${valid.templateName}\u2069" to the public catalog?`,
    detail: `It will be listed at ${valid.catalogHost} for anyone to use.`,
  });
  const ok = response === 1;
  mainSyncLog(`confirm-publish: ${ok ? "publish" : "cancel"}`);
  return ok;
}

/** `appOrigin`: the studio origin the main window loaded, or null before there is one. */
export function registerConfirmPublishIpc(appOrigin: () => string | null): void {
  ipcMain.handle(CONFIRM_PUBLISH_CHANNEL, (e, args) => confirmPublishHandler(e, args, appOrigin()));
}
