// @vitest-environment jsdom
//
// EL-1: the renderer's side of the desktop app's native publish confirm. The
// bridge answers true/false; a bridge without the method (the web/npx studio,
// or an OLDER shell running this newer runtime) answers undefined, and the
// panel then publishes as it always has.
import { describe, it, expect, vi, afterEach } from "vitest";
import { confirmPublish, hasNativePublishConfirm } from "@/lib/shell/client";

const setBridge = (api: unknown) => {
  (window as unknown as { electronAPI?: unknown }).electronAPI = api;
};

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("confirmPublish (client)", () => {
  it("relays the bridge's answer and passes the template name and host through", async () => {
    const bridgeConfirm = vi.fn(async () => true);
    setBridge({ confirmPublish: bridgeConfirm, revealFile: vi.fn() });
    expect(hasNativePublishConfirm()).toBe(true);
    await expect(confirmPublish({ templateName: "Hook", catalogHost: "libi.nagellabs.com" })).resolves.toBe(true);
    expect(bridgeConfirm).toHaveBeenCalledWith({ templateName: "Hook", catalogHost: "libi.nagellabs.com" });
    bridgeConfirm.mockResolvedValueOnce(false);
    await expect(confirmPublish({ templateName: "Hook", catalogHost: "libi.nagellabs.com" })).resolves.toBe(false);
  });

  it("no bridge (web/npx) → undefined", async () => {
    expect(hasNativePublishConfirm()).toBe(false);
    await expect(confirmPublish({ templateName: "Hook", catalogHost: "libi.nagellabs.com" })).resolves.toBeUndefined();
  });

  it("an older shell's bridge without the method → undefined", async () => {
    setBridge({ revealFile: vi.fn(), pickDirectory: vi.fn() });
    expect(hasNativePublishConfirm()).toBe(false);
    await expect(confirmPublish({ templateName: "Hook", catalogHost: "libi.nagellabs.com" })).resolves.toBeUndefined();
  });

  it('"refused" (arguments the dialog won\'t show) is relayed, not turned into a Cancel', async () => {
    setBridge({ confirmPublish: vi.fn(async () => "refused") });
    await expect(confirmPublish({ templateName: "Hook", catalogHost: "libi.nagellabs.com" })).resolves.toBe("refused");
  });

  it("a non-boolean answer from the bridge is not a yes", async () => {
    setBridge({ confirmPublish: vi.fn(async () => "yes") });
    await expect(confirmPublish({ templateName: "Hook", catalogHost: "libi.nagellabs.com" })).resolves.toBe(false);
  });
});
