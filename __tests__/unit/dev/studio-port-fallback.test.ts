import { describe, it, expect } from "vitest";

import { resolvePort } from "@/lib/cli/studio";

describe("studio resolvePort", () => {
  it("uses the CLI-provided port when not the default 3456", () => {
    expect(resolvePort("3499", {})).toBe("3499");
  });
  it("falls back to LIBI_PORT when CLI is the default 3456 and env is set", () => {
    expect(resolvePort("3456", { LIBI_PORT: "3470" })).toBe("3470");
  });
  it("keeps 3456 when neither CLI override nor env is provided", () => {
    expect(resolvePort("3456", {})).toBe("3456");
  });
  it("ignores a non-numeric LIBI_PORT and keeps the CLI default", () => {
    expect(resolvePort("3456", { LIBI_PORT: "nope" })).toBe("3456");
  });
});
