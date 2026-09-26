/**
 * Name-based error guards for errors thrown from a globalThis singleton (session manager, process
 * manager, JobManager and its runners, terminal manager, social service). In Next each route bundle
 * has its own copy of the module that defines the class, and the singleton was built from whichever
 * bundle loaded it first, so `instanceof` in another bundle misses. Each guard must accept the real
 * class, accept a foreign copy (a plain Error with the same name and fields), and reject a
 * look-alike that lacks the fields a caller reads.
 */
import { describe, expect, it } from "vitest";
import { isSessionRestartError, SessionRestartError } from "@/lib/sessions/restart-error";
import { AgentSpawnRefusedError, isAgentSpawnRefused } from "@/lib/agents/spawn-refused-error";
import { CancelledError, isCancelledError, isJobNotFoundError, JobNotFoundError } from "@/lib/jobs/types";
import { isTemplateInstallError, TemplateInstallError } from "@/lib/jobs/runners/template-install";
import { isTerminalCapacityError, TerminalCapacityError } from "@/lib/terminal/manager";
import { isSocialError, SocialError } from "@/lib/social/errors";

const foreign = (name: string, fields: Record<string, unknown> = {}) => Object.assign(new Error("x"), { name, ...fields });

describe.each([
  ["SessionRestartError", isSessionRestartError, new SessionRestartError("timed_out", "m"), { code: "timed_out" }, true],
  ["AgentSpawnRefusedError", isAgentSpawnRefused, new AgentSpawnRefusedError("codex", { code: "not_installed", message: "m" }), { reason: { message: "m" } }, true],
  ["CancelledError", isCancelledError, new CancelledError("j"), { jobId: "j" }, false],
  ["JobNotFoundError", isJobNotFoundError, new JobNotFoundError("j"), { jobId: "j" }, false],
  ["TemplateInstallError", isTemplateInstallError, new TemplateInstallError("m", "not_found"), { code: "not_found" }, true],
  ["TerminalCapacityError", isTerminalCapacityError, new TerminalCapacityError(50), {}, false],
  ["SocialError", isSocialError, new SocialError("not_found", "m"), { kind: "not_found" }, true],
] as const)("%s", (name, guard, real, fields, needsFields) => {
  it("accepts the real class", () => {
    expect(guard(real)).toBe(true);
  });

  it("accepts another bundle's copy (same name and fields)", () => {
    expect(guard(foreign(name, fields))).toBe(true);
  });

  it("rejects other errors and non-errors", () => {
    expect(guard(new Error("x"))).toBe(false);
    expect(guard({ name, ...fields })).toBe(false);
    expect(guard(undefined)).toBe(false);
    if (needsFields) expect(guard(foreign(name))).toBe(false);
  });
});
