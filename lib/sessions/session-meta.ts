import fs from "node:fs";
import { agentChildPath, freshPathDirs, pathEnvKey } from "@/lib/agents/agent-path";
import { claudeConfigPath } from "@/lib/agents/libi-registration";
import { skipsUserSettings } from "@/lib/sessions/skip-user-settings";

/**
 * Whether the user turned Claude in Chrome on for their own Claude Code ("Enabled by default" in `/chrome`,
 * stored as `claudeInChromeDefaultEnabled` in `~/.claude.json`). Read-only, like every other read of that file.
 *
 * That setting reaches only an INTERACTIVE `claude`: the headless one claude-agent-acp spawns loads the
 * `claude-in-chrome` server only when started with `--chrome` (measured on 2.1.282 — `claude -p` lists no Chrome
 * tool without it, all of them with it). So an in-app chat could never use Chrome, setting or not. libi mirrors
 * the user's own choice rather than turning a browser on for everyone: a user who never enabled it gets nothing.
 */
export function claudeInChromeEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeConfigPath(env), "utf-8")) as unknown;
    return !!parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).claudeInChromeDefaultEnabled === true;
  } catch {
    return false;
  }
}

/**
 * Per-agent session `_meta` for `newSession(...)`.
 *
 * claude-agent-acp reads a `claudeCode`-namespaced options bag; here we ensure
 * thinking content is streamed (`display: "summarized"`) rather than omitted,
 * which is the default on Opus 4.7+. Codex (and any non-claude agent) ignores
 * unknown `_meta` keys, so sending the claude-namespaced bag is a benign no-op —
 * but it's Claude-specific, so we send `{}` instead to keep the wire honest.
 *
 * Hermetic evals: claude-agent-acp defaults `settingSources` to
 * `["user", "project", "local"]`, so the HOST user's `~/.claude/CLAUDE.md`,
 * `~/.claude/settings.json` (hooks, plugins, env) and `~/.claude/skills` reach
 * the in-app agent. That is right for a real user and wrong for skill-eval,
 * whose verdicts must not depend on whose machine ran them. With
 * `LIBI_AGENT_SKIP_USER_SETTINGS=1` AND `LIBI_TEST_MODE=1` (the skill-eval
 * harness sets both) the session loads `["project", "local"]` only — the agent
 * workspace's own `.claude/skills` still load. Auth is untouched: it is not a
 * setting source (keychain / credentials file), so nothing is copied or
 * redirected. Both flags are required so a stray env var can never change a
 * real user's session.
 *
 * Claude in Chrome: `--chrome` (`extraArgs`) when the user enabled it for their own Claude Code — see
 * `claudeInChromeEnabled`. Never in a hermetic eval, whose verdicts must not depend on the host's browser.
 * The same meta goes on `session/load`, so a chat reopened later gets it too.
 *
 * NOTE: a codex reasoning-effort control is NOT yet plumbed here. Spike S3
 * (SP2 Task 4.4 / G2) was statically inconclusive — codex-acp is a launcher and
 * advertises no confirmed reasoning-effort config option — so that half is
 * deferred to Phase 5 live verification. This is not an oversight.
 */
export function sessionMetaFor(
  agentId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  loginDirs: readonly string[] | null = freshPathDirs(),
  chromeEnabled: () => boolean = () => claudeInChromeEnabled(env),
): Record<string, unknown> {
  if (agentId === "claude-code") {
    const skipUser = skipsUserSettings(env);
    const chrome = !skipUser && chromeEnabled();
    // A launcher installed since libi booted is on the login-shell PATH but not on the adapter's: claude-agent-acp
    // starts this chat's `claude` with its own environment plus `options.env`, so the PATH goes here — only when
    // the login shell adds a folder (`lib/agents/agent-path.ts`).
    const childPath = agentChildPath(env, loginDirs);
    return {
      claudeCode: {
        options: {
          thinking: { type: "adaptive", display: "summarized" },
          ...(skipUser ? { settingSources: ["project", "local"] } : {}),
          ...(chrome ? { extraArgs: { chrome: null } } : {}),
          ...(childPath !== undefined && childPath !== env[pathEnvKey(env)] ? { env: { [pathEnvKey(env)]: childPath } } : {}),
        },
      },
    };
  }
  return {};
}
