/**
 * The harness fails fast (T11 fix round 1). An expired sign-in used to cost the full
 * `timeoutSec` (1200 s on templates/04): the watcher settled only on `agent-complete`,
 * dropped the session's `agent-status: error`, and filtered out `agent-readiness` —
 * a system event with no sessionId — before it could be read. These run the REAL
 * watcher against a stub studio's SSE stream.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { turnEndingFailure, watchSession } from "@/scripts/skill-eval/harness";

const SID = "sess-1";
let server: http.Server | null = null;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/** A stub studio whose /api/agent/events opens the stream, then sends `frames` 50 ms apart and stays open. */
async function studio(frames: object[]): Promise<string> {
  server = http.createServer((req, res) => {
    if (req.url !== "/api/agent/events") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": connected\n\n");
    frames.forEach((f, i) => setTimeout(() => res.write(`data: ${JSON.stringify(f)}\n\n`), 50 * (i + 1)));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function watch(frames: object[], timeoutMs = 20_000) {
  const base = await studio(frames);
  const w = watchSession(base, SID, { timeoutMs, approve: [], currentTurn: () => 1, agent: "claude-code" });
  await w.ready();
  const started = Date.now();
  const outcome = await w.waitForCompletions(1).then(
    () => ({ ok: true as const, ms: Date.now() - started }),
    (e: Error) => ({ ok: false as const, name: e.name, message: e.message, ms: Date.now() - started }),
  );
  await w.close();
  return outcome;
}

const NEEDS_AUTH = {
  type: "agent-readiness",
  agentId: "claude-code",
  readiness: { state: "needs-auth", agentId: "claude-code", message: "Claude Code isn't signed in on this machine." },
};

describe("watchSession fails fast", () => {
  it("ends the turn on needs-auth for the scenario's agent — a system event with no sessionId", async () => {
    const r = await watch([NEEDS_AUTH]);
    expect(r).toMatchObject({ ok: false, name: "Error" });
    expect(r.ok ? "" : r.message).toMatch(/^agent not signed in — run `claude` then \/login/);
    expect(r.ms).toBeLessThan(5_000);
  });

  it("ends the turn on the session's agent-status error, with the error text", async () => {
    const r = await watch([{ type: "agent-status", sessionId: SID, status: "error", error: "Failed to authenticate: OAuth session expired" }]);
    expect(r).toMatchObject({ ok: false, message: "agent error: Failed to authenticate: OAuth session expired" });
    expect(r.ms).toBeLessThan(5_000);
  });

  it("is never a timeout: the failure is not an AbortError, so the run ends errored", async () => {
    const r = await watch([NEEDS_AUTH]);
    expect(r.ok ? "" : r.name).not.toBe("AbortError");
  });

  it("ignores another session's error, another agent's needs-auth, and non-error statuses — the turn still completes", async () => {
    const r = await watch([
      { type: "agent-status", sessionId: "other", status: "error", error: "not ours" },
      { ...NEEDS_AUTH, agentId: "codex", readiness: { ...NEEDS_AUTH.readiness, agentId: "codex" } },
      { type: "agent-readiness", agentId: "claude-code", readiness: { state: "ready" } },
      { type: "agent-status", sessionId: SID, status: "connected" },
      { type: "agent-complete", sessionId: SID },
    ]);
    expect(r).toMatchObject({ ok: true });
  });

  it("still times out as before when nothing arrives", async () => {
    const r = await watch([], 300);
    expect(r).toMatchObject({ ok: false, name: "AbortError" });
  });
});

describe("turnEndingFailure", () => {
  it("names a non-claude agent's sign-in without the claude command", () => {
    expect(turnEndingFailure({ type: "agent-readiness", agentId: "codex", readiness: { state: "needs-auth", message: "m" } }, SID, "codex")).toBe(
      "agent not signed in — sign codex in (libi: m)",
    );
  });
  it("returns null for everything that does not end the turn", () => {
    expect(turnEndingFailure({ type: "agent-complete", sessionId: SID }, SID, "claude-code")).toBeNull();
    expect(turnEndingFailure({ type: "agent-status", sessionId: SID, status: "prompting" }, SID, "claude-code")).toBeNull();
    expect(turnEndingFailure({ type: "agent-readiness", agentId: "claude-code", readiness: { state: "not-installed" } }, SID, "claude-code")).toBeNull();
  });
});
