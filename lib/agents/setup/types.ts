/**
 * What libi declares about each agent's setup — pure data, browser-safe, no
 * machine-specific resolution. The Agents page reads names and blurbs from here.
 * What libi downloads to run an agent in its chat, and how big that is, is
 * `lib/agents/adapter-copy.ts`; every command a setup terminal types is built in
 * `lib/agents/setup/commands.ts`, never here.
 */

export interface AgentSignInDeclaration {
  /** The short command a person types to sign in: `claude`, `codex login`. */
  displayCommand: string;
  /** The environment variable this agent accepts INSTEAD of an interactive
   *  sign-in — `ANTHROPIC_API_KEY` for Claude Code. Optional, and omitted
   *  wherever no such variable exists: the sentence naming it is dropped
   *  entirely rather than defaulted, because naming ONE vendor's variable to
   *  a user of another agent is worse than saying nothing. The name only —
   *  never a value, and never read from the environment here. */
  envVar?: string;
  /** Which ACP call an unauthenticated agent REJECTS. Codex refuses `session/new`,
   *  so a clean one proves sign-in there. Claude Code's `session/new` succeeds
   *  signed out and only `session/prompt` is refused, so for it a clean
   *  `session/new` proves nothing and must never undo an observed `needs-auth`. */
  rejectedAt: "session-new" | "prompt";
}

export interface AgentSetup {
  id: string;
  /** Display name. The single source — replaces agentLabel()'s fork. */
  name: string;
  /** One line under the name on the Agents page. */
  blurb: string;
  /** `true` when libi has a download to make before it can run this agent in its
   *  own chat — both agents today; the install route and runner refuse an agent
   *  without it. What that download is called, and how big it is, is
   *  `lib/agents/adapter-copy.ts`. Null when there is nothing for libi to fetch.
   *  Kept nullable because declaring a step that does not exist is how users get
   *  told to install something they already have, to fix a problem installing
   *  does not fix. */
  install: true | null;
  signIn: AgentSignInDeclaration;
}
