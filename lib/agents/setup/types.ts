/**
 * How an agent gets from "not usable yet" to "ready to chat with" — pure
 * declarations, no machine-specific resolution. The connect screen renders
 * one card shape from these; the command a user actually types on their
 * machine (often 120 characters of node_modules path) is resolved separately
 * in `lib/agents/terminal-remedy.ts`, never here.
 */

/** One line of a manual walkthrough. Exactly one sentence. */
export interface ManualStep {
  text: string;
  /** Rendered inline as code inside `text` at the {cmd} placeholder. */
  command?: string;
}

/** The do-it-yourself route, shown NEXT TO the button and never instead of it.
 *  Always three steps, always the same three beats:
 *    1. run this   2. what will happen   3. come back and retry
 *  Three because two leaves people staring at a browser window wondering what
 *  it is for, and four stops being read. */
export type ManualInstructions = readonly [ManualStep, ManualStep, ManualStep];

export interface AgentInstallDeclaration {
  /** What libi's button runs, and what step 1 shows. Same string — an install
   *  is a package name, so unlike sign-in there is nothing long to hide. */
  command: string;
  /** Shown next to the button, e.g. "about 345 MB". Never a version number. */
  sizeLabel: string;
  manual: ManualInstructions;
}

export interface AgentSignInDeclaration {
  /** The SHORT form, for the manual block: `claude`, `codex login`. NOT what
   *  libi's button runs — that is resolved per machine and is often 120
   *  characters of node_modules path, which reads like a bug when printed. */
  displayCommand: string;
  /** The environment variable this agent accepts INSTEAD of an interactive
   *  sign-in — `ANTHROPIC_API_KEY` for Claude Code. Optional, and omitted
   *  wherever no such variable exists: the sentence naming it is dropped
   *  entirely rather than defaulted, because naming ONE vendor's variable to
   *  a user of another agent is worse than saying nothing. The name only —
   *  never a value, and never read from the environment here. */
  envVar?: string;
  manual: ManualInstructions;
}

export interface AgentSetup {
  id: string;
  /** Display name. The single source — replaces agentLabel()'s fork. */
  name: string;
  /** One line under the name on the connect screen. */
  blurb: string;
  /** Null when libi already ships the agent (codex) — declaring an install
   *  step that does not exist is how users get told to install something they
   *  already have, to fix a problem installing does not fix. */
  install: AgentInstallDeclaration | null;
  signIn: AgentSignInDeclaration;
}
