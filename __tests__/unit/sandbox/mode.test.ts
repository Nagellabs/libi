// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { OVERLAY_SANDBOX_MODE_META, readOverlaySandboxMode, resolveOverlaySandboxMode } from "@/lib/sandbox/mode";

describe("resolveOverlaySandboxMode (spec §4.10 — dev-only escape hatch, no user toggle)", () => {
  it("is the sandbox unless LIBI_OVERLAY_SANDBOX=0 in an UNPACKAGED process", () => {
    expect(resolveOverlaySandboxMode({}, false)).toBe("sandbox");
    expect(resolveOverlaySandboxMode({ LIBI_OVERLAY_SANDBOX: "0" }, false)).toBe("in-origin");
    expect(resolveOverlaySandboxMode({ LIBI_OVERLAY_SANDBOX: "0" }, true)).toBe("sandbox"); // refused in packaged builds
    expect(resolveOverlaySandboxMode({ LIBI_OVERLAY_SANDBOX: "1" }, false)).toBe("sandbox");
    expect(resolveOverlaySandboxMode({ LIBI_OVERLAY_SANDBOX: "false" }, false)).toBe("sandbox");
  });

  it("is refused in a packaged build whatever NODE_ENV says", () => {
    for (const NODE_ENV of [undefined, "development", "test", "production"]) {
      expect(resolveOverlaySandboxMode({ LIBI_OVERLAY_SANDBOX: "0", NODE_ENV }, true)).toBe("sandbox");
    }
  });

  it("is refused in a production server even unpackaged (npx @nagellabs/libi)", () => {
    expect(resolveOverlaySandboxMode({ LIBI_OVERLAY_SANDBOX: "0", NODE_ENV: "production" }, false)).toBe("sandbox");
    expect(resolveOverlaySandboxMode({ LIBI_OVERLAY_SANDBOX: "0", NODE_ENV: "development" }, false)).toBe("in-origin");
  });
});

describe("readOverlaySandboxMode", () => {
  it("reads the layout's meta and defaults to the sandbox when it is absent or unknown", () => {
    expect(readOverlaySandboxMode(document)).toBe("sandbox");
    const meta = document.createElement("meta");
    meta.name = OVERLAY_SANDBOX_MODE_META;
    meta.content = "in-origin";
    document.head.appendChild(meta);
    expect(readOverlaySandboxMode(document)).toBe("in-origin");
    meta.content = "whatever";
    expect(readOverlaySandboxMode(document)).toBe("sandbox");
    meta.remove();
  });

  describe("in a production client bundle", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      document.querySelectorAll(`meta[name="${OVERLAY_SANDBOX_MODE_META}"]`).forEach((m) => m.remove());
    });

    it("refuses in-origin even when the meta asks for it (defence in depth behind the server gate)", () => {
      const meta = document.createElement("meta");
      meta.name = OVERLAY_SANDBOX_MODE_META;
      meta.content = "in-origin";
      document.head.appendChild(meta);
      vi.stubEnv("NODE_ENV", "production");
      expect(readOverlaySandboxMode(document)).toBe("sandbox");
      vi.stubEnv("NODE_ENV", "development");
      expect(readOverlaySandboxMode(document)).toBe("in-origin");
    });
  });
});
