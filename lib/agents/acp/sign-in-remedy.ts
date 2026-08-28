/**
 * The per-agent sign-in remedy, resolved to a real command on THIS machine.
 *
 * Colocated with `agent-registry.ts`'s detection table because it reuses the
 * same npm-tree walk (`codexCandidateTreeRoots`) `detectCodex` uses — but
 * kept as its OWN registry on purpose. `lib/agents/setup/registry.ts`
 * declares WHAT to say (pure, no filesystem, safe to render in the browser);
 * this resolves WHICH binary, WHERE, on disk — filesystem work that must
 * never reach the browser bundle. Two different questions, two registries.
 *
 * `signInRemedyFor` in `lib/sessions/session-manager.ts` used to fork on
 * agentId (`if (agentId === "codex") … else if (agentId === "claude-code")
 * …`); this turns it into a lookup instead, keyed the same way
 * `getKnownAgents()`'s entries are.
 */
import { codexCandidateTreeRoots } from "./agent-registry";
import { resolveClaudeNativeBinary } from "@/lib/agents/claude-native-binary";
import { getAgentInstallRoot } from "@/lib/agents/runtime-install";
import {
  claudeSignInRemedy,
  codexSignInRemedy,
  type TerminalRemedy,
} from "@/lib/agents/terminal-remedy";

const SIGN_IN_RESOLVERS: Record<string, () => TerminalRemedy | null> = {
  // The engine libi already SHIPS can perform the login, so walk the same
  // npm tree roots `detectCodex` walks and hand the first tree holding an
  // engine binary to `codexSignInRemedy`. Nothing to install.
  codex: () => {
    for (const root of codexCandidateTreeRoots(process.cwd())) {
      const remedy = codexSignInRemedy(root);
      if (remedy) return remedy;
    }
    return null;
  },
  // The CLI libi downloaded (`@anthropic-ai/claude-agent-sdk-*`) IS the
  // sign-in flow, so point at that binary rather than the ACP adapter
  // (running the adapter would start a stdio server, not a login) and fall
  // back to the bare `claude` name, which resolves in the Terminal's LOGIN
  // shell even though it would not resolve in this server process.
  "claude-code": () => {
    let bin: string | null = null;
    for (const root of [process.cwd(), getAgentInstallRoot()]) {
      bin = resolveClaudeNativeBinary(root);
      if (bin) break;
    }
    return claudeSignInRemedy(bin);
  },
};

/**
 * The Terminal command that fixes "this agent isn't signed in", or null when
 * this map has no remedy for `agentId` (an id it doesn't know, or one — like
 * "terminal" — that has no sign-in flow to begin with).
 */
export function resolveSignInRemedy(agentId: string): TerminalRemedy | null {
  // `Object.hasOwn`, not a bare index: `SIGN_IN_RESOLVERS["constructor"]` is
  // `Object`, which is truthy and callable, so the bare form returned `{}` —
  // an empty object masquerading as a TerminalRemedy that every caller would
  // then render and try to run. Unreachable today (ids come from libi's own
  // provider list), which is exactly when it is cheap to close.
  if (!Object.hasOwn(SIGN_IN_RESOLVERS, agentId)) return null;
  return SIGN_IN_RESOLVERS[agentId]() ?? null;
}

/** The agent ids this module can resolve a sign-in command for. See
 *  `knownAgentIds()` in agent-registry.ts for why these are exposed. */
export function signInResolverIds(): string[] {
  return Object.keys(SIGN_IN_RESOLVERS);
}
