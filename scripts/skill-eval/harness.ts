import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { ParsedScenario, TraceCall } from "./types";

export interface HarnessResult {
  status: "completed" | "errored" | "timeout";
  trace: TraceCall[];
  transcript: string;
  errorMessage?: string;
}

const REPO_ROOT = process.cwd();

/** The fake-fal scenario config object for this run (currently just strict mode). */
export function buildFakeFalConfig(scenario: ParsedScenario): { strict: boolean } {
  return { strict: scenario.falStrict === true };
}

/**
 * Pick a concrete free TCP port. We CANNOT use LIBI_PORT=0 — libi's port file
 * is written from `process.env.PORT` verbatim (see
 * `lib/server/lifecycle/category-b.ts#writePortFileAndInstallSignals`), so a
 * `0` would land a literal "0" in `<LIBI_HOME>/port` even though Next bound a
 * random port. We therefore bind-and-release a free port ourselves and pass
 * the concrete number as LIBI_PORT, which flows
 * `resolvePort` → `next dev --port` → `PORT` → the port file.
 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not resolve a free port")));
      }
    });
  });
}

/** Poll `<home>/port` until the server writes it (boot complete). */
function waitForPort(home: string, timeoutMs: number): Promise<number> {
  const portFile = join(home, "port");
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(portFile)) {
        const port = parseInt(readFileSync(portFile, "utf8").trim(), 10);
        if (!Number.isNaN(port)) return resolve(port);
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("server boot timed out"));
      setTimeout(tick, 500);
    };
    tick();
  });
}

/** Stream /api/agent/events and resolve when agent-complete for `sessionId`. */
async function waitForAgentComplete(
  base: string,
  sessionId: string,
  timeoutMs: number,
  onConnected?: () => void,
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let signalledConnected = false;
  try {
    const res = await fetch(`${base}/api/agent/events`, { signal: ctrl.signal });
    if (!res.body) throw new Error("no SSE body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream closed before agent-complete");
      // First non-done chunk ⇒ the SSE stream is live, which means the
      // server-side subscription is definitely registered. Signal once so
      // the caller can safely send the prompt without racing the subscribe.
      if (!signalledConnected) {
        signalledConnected = true;
        onConnected?.();
      }
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let evt: { type?: string; sessionId?: string };
        try { evt = JSON.parse(line.slice(6)); } catch { continue; }
        if (evt.type === "agent-complete" && evt.sessionId === sessionId) return;
      }
    }
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

async function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function readJsonlTagged(path: string, provider: "fal" | "elevenlabs"): TraceCall[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => ({ ...(JSON.parse(l) as TraceCall), provider }));
}

function readTrace(home: string): TraceCall[] {
  const dir = join(home, "test-mode");
  const fal = readJsonlTagged(join(dir, "fal-calls.jsonl"), "fal");
  const eleven = readJsonlTagged(join(dir, "elevenlabs-calls.jsonl"), "elevenlabs");
  return [...fal, ...eleven].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
}

function truncateTrace(home: string): void {
  const dir = join(home, "test-mode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fal-calls.jsonl"), "");
  writeFileSync(join(dir, "elevenlabs-calls.jsonl"), "");
}

/**
 * Structural subset of `AgentMessage` (`lib/agents/message-types.ts`). The text
 * content lives in `parts[]` — a discriminated union — not on the message
 * itself. We render role + a human-readable flattening of every part so a
 * coding agent can judge the transcript.
 */
interface AgentMessagePartLike {
  type?: string;
  text?: string;
  rawTitle?: string;
  args?: unknown;
  result?: unknown;
  [k: string]: unknown;
}
interface AgentMessageLike {
  role?: string;
  parts?: AgentMessagePartLike[];
}

function renderPart(part: AgentMessagePartLike): string {
  switch (part.type) {
    case "text":
      return part.text ?? "";
    case "thought":
      return `(thinking) ${part.text ?? ""}`;
    case "tool-call":
      return `[tool-call ${part.rawTitle ?? "?"}] ${JSON.stringify(part.args ?? {})}`;
    case "tool-result":
      return `[tool-result ${part.rawTitle ?? "?"} ${part.success ? "ok" : "fail"}] ${JSON.stringify(part.result ?? null)}`;
    case "file-attachment":
      return `[file-attachment ${String(part.filename ?? part.fileId ?? "?")}]`;
    case "permission-request":
      return `[permission-request ${String(part.status ?? "pending")}]`;
    case "subagent":
      return `[subagent ${String(part.subagentType ?? "?")}: ${String(part.description ?? "")}] ${String(part.result ?? "")}`;
    default:
      return `[${part.type ?? "unknown"}] ${JSON.stringify(part)}`;
  }
}

function renderTranscript(messages: AgentMessageLike[]): string {
  return messages
    .map((m, i) => {
      const role = m.role ?? "?";
      const body = (m.parts ?? []).map(renderPart).filter(Boolean).join("\n\n");
      return `### [${i}] ${role}\n\n${body}`;
    })
    .join("\n\n");
}

async function fetchMessages(base: string, sessionId: string): Promise<AgentMessageLike[]> {
  const res = await fetch(`${base}/api/agent/messages?sessionId=${sessionId}`);
  const { messages = [] } = (await res.json()) as { messages?: AgentMessageLike[] };
  return messages;
}

/**
 * Appended to every scenario prompt. An eval run is unattended — no human is
 * present to answer a clarifying question or approve a step. Skills routinely
 * tell the agent to ask "OK to generate?" before spending; left alone the turn
 * ends at that question and no generation happens (empty trace → false FAIL).
 * This pre-authorizes the agent to run the whole workflow to completion. Paired
 * with the configure route's "auto-with-generations" approval mode (which
 * silences the tool-level generation approval card), it lets the agent actually
 * reach the fal-ai calls the hard invariants assert on.
 */
const EVAL_PREAMBLE =
  "\n\n[AUTOMATED EVAL — no human is available to answer questions or approve steps. " +
  "You are PRE-AUTHORIZED to run the entire workflow to completion, including every paid " +
  "generation tool (in this test-mode run they return zero-cost deterministic placeholders). " +
  "Do NOT pause to ask for confirmation, approval, or clarification — pick sensible defaults " +
  "and proceed all the way through generation and final assembly in this turn.]";

export interface RunOnceOpts {
  scenario: ParsedScenario;
  agent: string;
  /** Keep the temp LIBI_HOME after the run (debugging). */
  keep?: boolean;
}

/** Boot a hermetic test-mode libi, run the scenario once, collect trace+transcript. */
export async function runScenarioOnce(opts: RunOnceOpts): Promise<HarnessResult> {
  const home = mkdtempSync(join(tmpdir(), "libi-skilleval-"));
  let child: ChildProcess | undefined;
  try {
    // Concrete free port — LIBI_PORT=0 is unsupported (see pickFreePort).
    const wantPort = await pickFreePort();
    // Per-scenario fake-fal config (strict mode). Inherited by the fake-fal
    // child via buildSpawnEnv → process.env propagation.
    const fakeFalCfgPath = join(home, "fake-fal-config.json");
    writeFileSync(fakeFalCfgPath, JSON.stringify(buildFakeFalConfig(opts.scenario)));
    // Normal headless boot (no --connect-agent): skill-eval drives the in-app agent, not an outside CLI, so it must NOT short-circuit agent warm or write merge-mode files into the repo root.
    child = spawn("node", ["bin/libi.js"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LIBI_TEST_MODE: "1",
        // RC-B: the /api/skill-eval/configure + /api/e2e/run-tool routes are
        // gated on this flag (no longer on NODE_ENV). The harness calls
        // /api/skill-eval/configure below, so it must opt the spawned libi in.
        LIBI_ENABLE_TEST_ROUTES: "1",
        LIBI_FAKE_FAL_CONFIG: fakeFalCfgPath,
        // Setting LIBI_HOME also suppresses the dev worktree-bootstrap's
        // home/port override (it only fires when LIBI_HOME is unset — see
        // `useHome`/`usePort` in lib/dev/worktree-bootstrap.ts), so the
        // hermetic temp home is honored.
        LIBI_HOME: home,
        LIBI_PORT: String(wantPort),
        // NB: there is NO PREFERRED_AGENT env — libi warms the agent from the
        // settings DB (`preferredAgent`). The configure route below calls
        // switchAgent(opts.agent), which fully re-warms + wires the requested
        // agent, so agent selection is driven there, not via env.
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so teardown can kill the WHOLE tree. `bin/libi.js`
      // spawns `next dev` (+ MCP children + the ACP agent) as descendants;
      // killing only the direct child orphans `next dev`, whose per-directory
      // singleton lock then blocks the next run from booting.
      detached: true,
    });
    const serverLog: string[] = [];
    child.stdout?.on("data", (d) => serverLog.push(String(d)));
    child.stderr?.on("data", (d) => serverLog.push(String(d)));

    const port = await waitForPort(home, 180_000).catch((e) => {
      throw new Error(`${e.message}\n--- server log tail ---\n${serverLog.slice(-40).join("")}`);
    });
    const base = `http://127.0.0.1:${port}`;

    // Configure wiring for this scenario.
    const cfg = await post(base, "/api/skill-eval/configure", {
      skills: opts.scenario.skills,
      mcps: opts.scenario.mcps,
      agent: opts.agent,
    });
    if (!cfg.ok) throw new Error(`configure failed: ${(await cfg.json()).error ?? cfg.status}`);

    // Fresh piece + clean trace.
    const pieceRes = await post(base, "/api/pieces", {});
    if (!pieceRes.ok) throw new Error(`create piece failed: ${pieceRes.status}`);
    truncateTrace(home);

    // Create session, subscribe, send prompt, await completion.
    const sessRes = await post(base, "/api/sessions", {});
    if (!sessRes.ok) throw new Error(`create session failed: ${(await sessRes.json()).error ?? sessRes.status}`);
    const { sessionId } = (await sessRes.json()) as { sessionId: string };

    let markConnected: () => void = () => {};
    const connected = new Promise<void>((r) => { markConnected = r; });
    const completion = waitForAgentComplete(
      base, sessionId, opts.scenario.timeoutSec * 1000, markConnected,
    );
    // Ensure the SSE subscription is live before sending, so a fast
    // completion can't be missed. Race against a short fallback so a
    // missing initial frame never blocks the send indefinitely.
    await Promise.race([connected, new Promise<void>((r) => setTimeout(r, 5000))]);
    const sendRes = await post(base, "/api/agent/send", {
      sessionId,
      text: opts.scenario.prompt + EVAL_PREAMBLE,
    });
    if (!sendRes.ok) throw new Error(`send failed: ${sendRes.status}`);

    try {
      await completion;
    } catch (e) {
      const messages = await fetchMessages(base, sessionId);
      const name = (e as Error).name;
      return {
        // A genuine timeout surfaces as AbortError (the AbortController fired);
        // Node's fetch rejects the in-flight read with name === "AbortError".
        status: name === "AbortError" ? "timeout" : "errored",
        trace: readTrace(home),
        transcript: renderTranscript(messages),
        errorMessage: (e as Error).message,
      };
    }

    const messages = await fetchMessages(base, sessionId);
    return { status: "completed", trace: readTrace(home), transcript: renderTranscript(messages) };
  } finally {
    if (child?.pid) {
      // Kill the whole process GROUP (negative pid), not just bin/libi.js —
      // otherwise next dev / MCP children / the ACP agent are orphaned and the
      // leaked next-dev singleton blocks the next run. Spawned with
      // `detached: true` so the child leads its own group.
      killProcessTree(child);
      await new Promise((r) => setTimeout(r, 1500));
      killProcessTree(child, "SIGKILL");
    }
    if (!opts.keep && existsSync(home)) rmSync(home, { recursive: true, force: true });
  }
}

/** Best-effort kill of the child's entire process group, then the child itself. */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.pid) return;
  try {
    // Negative pid → the whole process group (requires detached spawn).
    process.kill(-child.pid, signal);
  } catch {
    // group already gone, or not a group leader — fall back to the direct child
    try {
      child.kill(signal);
    } catch {
      // already dead
    }
  }
}
