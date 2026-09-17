import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
import { getDb } from "@/lib/db/client";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { clearSignInConfirmation, getSignInConfirmedAt, setSignInConfirmed } from "@/lib/agents/sign-in-confirmation";
import { getSettings } from "@/lib/db/settings";

describe("sign-in confirmation (the only persisted setup-wizard value)", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "libi-signin-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = tmpHome;
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  });
  afterEach(() => {
    resetTestDb();
    // `process.env.X = undefined` stores the STRING "undefined" and leaks a relative home into later files.
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("starts null for both agents", () => {
    expect(getSignInConfirmedAt("claude-code")).toBeNull();
    expect(getSignInConfirmedAt("codex")).toBeNull();
  });

  it("set is per agent and round-trips through settings", () => {
    const at = new Date("2026-09-10T12:00:00Z");
    setSignInConfirmed("codex", at);
    expect(getSignInConfirmedAt("codex")?.toISOString()).toBe(at.toISOString());
    expect(getSignInConfirmedAt("claude-code")).toBeNull();
    expect(getSettings().codexSignInConfirmedAt?.toISOString()).toBe(at.toISOString());
  });

  it("clear removes only that agent's confirmation", () => {
    setSignInConfirmed("claude-code");
    setSignInConfirmed("codex");
    clearSignInConfirmation("claude-code");
    expect(getSignInConfirmedAt("claude-code")).toBeNull();
    expect(getSignInConfirmedAt("codex")).not.toBeNull();
  });
});
