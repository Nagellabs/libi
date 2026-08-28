import { NextResponse } from "next/server";
import { detectInstalledAgents } from "@/lib/agents/acp/agent-registry";
import { resolveSignInRemedy } from "@/lib/agents/acp/sign-in-remedy";

export async function GET(): Promise<Response> {
  const agents = detectInstalledAgents().map((a) => ({
    id: a.id,
    name: a.name,
    installed: a.installed,
    detectCommand: a.detectCommand,
    /**
     * The whole remedy that signs this agent in on THIS machine — label,
     * command and detail, not just the command string — usually a long
     * absolute path inside libi's own tree, on Windows prefixed with
     * PowerShell's call operator.
     *
     * Served here because the connect screen needs it BEFORE any agent has
     * been selected, and readiness cannot supply it then: the client only
     * ever learns readiness for the ACTIVE agent, so on first paint every
     * card fell back to the short form (`codex login`) — which fails on
     * exactly the machines this screen exists for, since libi puts nothing
     * on PATH. This resolver reads the filesystem only (see
     * `sign-in-remedy.ts`); it starts no process and asserts nothing about
     * whether the agent actually NEEDS signing in.
     *
     * The whole object rather than the command alone because the connect
     * screen RUNS it, it does not merely print it: for Claude Code the
     * button has to open a terminal, since Claude answers `session/new`
     * happily with no credentials and connecting therefore proves nothing.
     */
    signInRemedy: resolveSignInRemedy(a.id),
  }));
  return NextResponse.json({ agents });
}
