import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import type { TerminalRemedy } from "@/lib/agents/terminal-remedy";

// ── Types ───────────────────────────────────────────────────────────

/**
 * WHOSE codex did we find?
 *
 * This distinction is the whole point of the fix. The old probe ran
 * `which codex` in the Next.js server's environment, where npm has prepended
 * `<repo>/node_modules/.bin` — which, since the codex-acp migration, contains a
 * `codex` shim. So the probe answered "yes" truthfully about a binary the user
 * can never invoke, `codex mcp add` really ran, and libi's tools were installed
 * into a codex that exists only inside libi. Nothing lied; the answer was to
 * the wrong question.
 *
 * - `"user"`          — a genuine codex on the USER's login-shell PATH. The
 *                       only state where Install does anything useful.
 * - `"libi-internal"` — the only codex found belongs to libi's own tree.
 * - `"none"`          — no codex anywhere.
 */
export type CodexCliSource = "user" | "libi-internal" | "none";

export type CodexConnectState = {
  /** Codex CLI usable for `codex mcp add` — i.e. `cliSource === "user"`. */
  available: boolean;
  /** LIVE ground truth: libi's `libi` MCP server is present in the codex home. */
  installed: boolean;
  /** Outcome of the last install/uninstall attempt. */
  status: "ok" | "error" | "idle";
  /** Whose codex the probe found. See CodexCliSource. */
  cliSource?: CodexCliSource;
  /** How the user would get a codex of their own, when they lack one. */
  remedy?: TerminalRemedy | null;
  /**
   * Whether libi-owned `[mcp_servers.*]` entries are in the codex config RIGHT
   * NOW — independent of `installed`, which is scoped to the user's own CLI.
   * They differ exactly in the state the old probe created: entries written via
   * libi's in-tree codex shim, invisible to a UI that only looked at
   * `installed`.
   */
  libiEntriesPresent?: boolean;
  /** Why Install (or an automatic Uninstall) is unavailable, or null. */
  reason?: "codex_not_installed" | "manual_cleanup_required" | null;
  /** The codex home libi writes for this instance (real ~/.codex or scoped). */
  codexHome?: string;
  /** Absolute path to that home's config.toml (for the "Open config" button). */
  configPath?: string;
  /** Whether that config.toml exists on disk yet. */
  configExists?: boolean;
};

/**
 * A refused connect/disconnect. The `manual_cleanup_required` case is the
 * honest dead end: libi's entries are in the config and there is no codex
 * anywhere to run `codex mcp remove` with, so the server hands back a
 * ready-to-render instruction instead of a success that changed nothing.
 */
export class CodexConnectRefusal extends Error {
  readonly reason?: string;
  readonly configPath?: string;
  readonly managedNames: string[];
  constructor(body: {
    message: string;
    reason?: string;
    configPath?: string;
    managedNames?: string[];
  }) {
    super(body.message);
    this.name = "CodexConnectRefusal";
    this.reason = body.reason;
    this.configPath = body.configPath;
    this.managedNames = body.managedNames ?? [];
  }
}

// ── Query keys ──────────────────────────────────────────────────────

export const codexConnectKeys = {
  all: ["codex-connect"] as const,
};

// ── Queries ─────────────────────────────────────────────────────────

export function useCodexConnect() {
  return useQuery({
    queryKey: codexConnectKeys.all,
    queryFn: async (): Promise<CodexConnectState> => {
      const res = await fetch("/api/codex/connect");
      if (!res.ok) throw new Error("Failed to fetch codex connect state");
      return (await res.json()) as CodexConnectState;
    },
  });
}

// ── Mutations ───────────────────────────────────────────────────────

export function useSetCodexConnect() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (connected: boolean): Promise<CodexConnectState> => {
      const res = await fetch("/api/codex/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connected }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
          reason?: string;
          configPath?: string;
          managedNames?: string[];
        };
        // The server writes the user-facing sentence into `message` for a
        // refusal (`error` is reserved for malformed input), so prefer it —
        // dropping it would put us straight back to a generic dead end.
        throw new CodexConnectRefusal({
          message:
            body.message ?? body.error ?? "Failed to update codex connect state",
          reason: body.reason,
          configPath: body.configPath,
          managedNames: body.managedNames,
        });
      }
      return (await res.json()) as CodexConnectState;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: codexConnectKeys.all });
    },
  });
}
