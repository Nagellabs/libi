import { describe, it, expect } from "vitest";
import path from "path";
import { resolveConnectAgentDir } from "@/lib/cli/studio";

describe("resolveConnectAgentDir", () => {
  it("returns null when the flag is absent", () => {
    expect(resolveConnectAgentDir(undefined, {})).toBeNull();
    expect(resolveConnectAgentDir(false, {})).toBeNull();
  });

  it("bare flag resolves to LIBI_LAUNCH_CWD when set", () => {
    expect(
      resolveConnectAgentDir(true, { LIBI_LAUNCH_CWD: "/Users/me/proj" }),
    ).toBe("/Users/me/proj");
  });

  it("bare flag falls back to process.cwd() without LIBI_LAUNCH_CWD", () => {
    expect(resolveConnectAgentDir(true, {})).toBe(process.cwd());
  });

  it("explicit relative dir resolves against the launch cwd", () => {
    expect(
      resolveConnectAgentDir("../other", { LIBI_LAUNCH_CWD: "/Users/me/proj" }),
    ).toBe(path.resolve("/Users/me/proj", "../other"));
  });

  it("explicit absolute dir is used as-is", () => {
    expect(
      resolveConnectAgentDir("/abs/dir", { LIBI_LAUNCH_CWD: "/Users/me/proj" }),
    ).toBe("/abs/dir");
  });
});
