import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v3";
import { resolveCodexHome } from "@/lib/codex-config/canonical";
import {
  userCodexCli,
  probeInstalledServers,
  mcpAdd,
  mcpRemove,
  type CodexCliSource,
} from "@/lib/codex-config/codex-cli";
import { readManagedNames } from "@/lib/codex-config/managed-manifest";
import { codexInstallRemedy } from "@/lib/agents/terminal-remedy";
import {
  getCodexConnectSetting,
  setCodexConnectSetting,
} from "@/lib/db/settings";
import {
  syncCodexGlobalMcps,
  disconnectCodexGlobalMcps,
} from "@/lib/codex-config/sync";
import { serverLogger as logger } from "@/lib/logger";

const bodySchema = z.object({ connected: z.boolean() });

/**
 * "Install libi into Codex" — writes libi's MCP servers into the codex config
 * for THIS instance's codex home (`resolveCodexHome()`: real `~/.codex` on the
 * canonical app, a scoped `<LIBI_HOME>/.codex` in a worktree/dev build). The
 * home resolution makes writes structurally worktree-safe, so there is NO
 * canonical gate here — only a check that the USER has their own codex CLI
 * (`userCodexCli()`, see below); libi's own in-tree codex does not count.
 *
 * `installed` is read LIVE from `codex mcp list --json` (ground truth: whether
 * the `libi` server is actually configured) — not the stored intent flag.
 */
type UnavailableReason = "codex_not_installed";

/**
 * Why a POST was refused. `codex_not_installed` is the CONNECT refusal (the
 * user has no codex of their own, so installing would provision a codex only
 * libi can run). `manual_cleanup_required` is the DISCONNECT dead end: libi's
 * entries may be sitting in their config and there is no codex binary anywhere
 * to run `codex mcp remove` with, so the only honest answer is "delete this
 * block by hand, here is the file".
 */
type RefusalReason = UnavailableReason | "manual_cleanup_required";

/**
 * This surface shells out to the USER's OWN codex CLI (`codex mcp add`) so that
 * THEIR terminal and THEIR Codex app can load libi's tools. The gate is
 * therefore `userCodexCli()`, which answers "does the person have codex" —
 * NOT "can this server process spawn something called codex".
 *
 * A `libi-internal` hit (the `node_modules/.bin/codex` shim npm puts on the dev
 * server's PATH, or the packaged runtime bundle's copy) is REFUSED, not
 * accepted: writing `~/.codex/config.toml` for a binary that lives inside
 * libi's own tree is precisely the reported bug — a real install, of a codex
 * the user can never invoke.
 *
 * Do NOT read the agent registry's `installed` flag here either: since the
 * detectCodex fix that flag means "the bundled codex-acp ACP adapter can run"
 * (embedded engine, no PATH involved) — a third question with a third answer.
 */
function cliSource(): ReturnType<typeof userCodexCli> {
  return userCodexCli();
}

/**
 * Are libi-owned entries sitting in the codex config RIGHT NOW — regardless of
 * whose codex we found, or whether we found one at all?
 *
 * This deliberately does not depend on `available`. `installed` is only
 * computed when the user has their own CLI, so a user whose config was written
 * by the old buggy probe (via libi's in-tree shim) saw `installed:false` while
 * `[mcp_servers.libi]` really was in their file — the false negative that made
 * the state invisible and the entries unremovable.
 *
 * Ground truth, in order: a live `codex mcp list --json` run with whatever
 * binary we resolved (the config is selected by CODEX_HOME, not by which
 * executable runs it); failing that — no codex at all, or an unparseable
 * listing — libi's OWN sidecar manifest, which records the names libi wrote.
 * The manifest is a record of intent rather than of the file, so it is the
 * fallback and never the first answer.
 */
async function libiEntriesPresent(
  source: CodexCliSource,
  codexHome: string,
): Promise<boolean> {
  if (source.kind !== "none") {
    const names = await probeInstalledServers({ bin: source.path });
    if (names !== null) return names.includes("libi");
  }
  try {
    return readManagedNames(codexHome).size > 0;
  } catch {
    return false;
  }
}

/**
 * A sync CLI pinned to the exact binary we resolved, so `codex mcp add/remove`
 * runs the codex we classified rather than re-resolving the bare name against
 * this server process's PATH (a different search, and possibly a different
 * binary). `codexHome` still comes from the sync layer — this changes WHICH
 * EXECUTABLE runs, never WHICH CONFIG it edits.
 */
function cliWithBin(bin: string) {
  return {
    mcpAdd: (name: string, entry: Parameters<typeof mcpAdd>[1], opts?: { codexHome?: string }) =>
      mcpAdd(name, entry, { ...opts, bin }),
    mcpRemove: (name: string, opts?: { codexHome?: string }) =>
      mcpRemove(name, { ...opts, bin }),
  };
}

export async function GET(): Promise<Response> {
  try {
    const source = cliSource();
    const available = source.kind === "user";
    const reason: UnavailableReason | null = available
      ? null
      : "codex_not_installed";
    const { lastSyncStatus } = getCodexConnectSetting();
    const codexHome = resolveCodexHome();
    const configPath = path.join(codexHome, "config.toml");
    const entriesPresent = await libiEntriesPresent(source, codexHome);
    return NextResponse.json({
      available,
      // Unchanged meaning (the frozen contract): "the user's own codex is set
      // up with libi". `libiEntriesPresent` is the one that answers the
      // independent question of what is actually in the file.
      installed: available && entriesPresent,
      status: lastSyncStatus,
      reason,
      codexHome,
      configPath,
      configExists: fs.existsSync(configPath),
      // What we actually found, and how the user fixes it. `libi-internal`
      // deliberately gets the SAME remedy as `none`: they still have no codex
      // of their own — the one we found is ours.
      cliSource: source.kind,
      remedy: available ? null : codexInstallRemedy(),
      // Independent of `available`: entries can be present in the config while
      // the user has no codex of their own — exactly the state the old probe
      // left behind, and the state the UI has to be able to offer cleanup for.
      libiEntriesPresent: entriesPresent,
    });
  } catch (err) {
    logger.error(
      {
        tag: "codex-connect",
        op: "get_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to read codex install state",
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // The precondition is DIRECTIONAL, because the two directions are not the
  // same act.
  //
  // CONNECT writes config for a binary; if that binary is only libi's, the
  // write is the reported bug, so `user` is required.
  //
  // DISCONNECT removes libi's OWN entries — by name, from libi's sidecar
  // manifest, so nothing of the user's is ever targeted. That is pure cleanup:
  // it cannot damage anything, and refusing it because the binary "isn't
  // theirs" would punish the user for OUR bug by stranding entries the old
  // probe wrote. Any resolvable codex is good enough to run `mcp remove`.
  const source = cliSource();
  const { connected } = parsed.data;
  const codexHome = resolveCodexHome();

  if (connected && source.kind !== "user") {
    return NextResponse.json(
      {
        available: false,
        cliSource: source.kind,
        reason: "codex_not_installed" satisfies RefusalReason,
        remedy: codexInstallRemedy(),
      },
      { status: 409 },
    );
  }

  if (!connected && source.kind === "none") {
    // The honest dead end: entries may be in their config and there is no
    // codex anywhere to run `mcp remove` with. Saying "disconnected" here
    // would be the same class of lie as the original bug — a real-looking
    // success that changed nothing. Name the file and the exact names libi
    // wrote so they can delete the block by hand.
    let names: string[] = [];
    try {
      names = [...readManagedNames(codexHome)].sort();
    } catch {
      /* best-effort — an unreadable manifest just means a vaguer message */
    }
    const configPath = path.join(codexHome, "config.toml");
    return NextResponse.json(
      {
        available: false,
        cliSource: source.kind,
        reason: "manual_cleanup_required" satisfies RefusalReason,
        remedy: codexInstallRemedy(),
        configPath,
        managedNames: names,
        message:
          `libi can't remove its entries automatically — there is no codex CLI on this machine to run \`codex mcp remove\` with. ` +
          (names.length > 0
            ? `Delete the ${names.map((n) => `[mcp_servers.${n}]`).join(" and ")} block${names.length > 1 ? "s" : ""} from ${configPath} by hand.`
            : `If libi entries are still listed in ${configPath}, delete their [mcp_servers.*] blocks by hand.`),
      },
      { status: 409 },
    );
  }

  try {
    setCodexConnectSetting({ connected, lastSyncStatus: "idle" });
    // Never throws — a sync failure surfaces as lastSyncStatus:"error".
    // Pin the resolved binary so we invoke the codex we classified rather than
    // re-resolving `codex` against this process's PATH.
    // Both guards above have already returned for every case where this is
    // null; keeping it a narrowing check rather than an assertion means a
    // future edit to those guards degrades to "did nothing" instead of a crash.
    const bin = source.kind === "none" ? null : source.path;
    if (bin && connected) {
      await syncCodexGlobalMcps({ cli: cliWithBin(bin) });
    } else if (bin) {
      await disconnectCodexGlobalMcps({ cli: cliWithBin(bin) });
    }
    const { lastSyncStatus } = getCodexConnectSetting();
    const entriesPresent = await libiEntriesPresent(source, codexHome);
    return NextResponse.json({
      available: source.kind === "user",
      installed: source.kind === "user" && entriesPresent,
      status: lastSyncStatus,
      codexHome,
      cliSource: source.kind,
      remedy: source.kind === "user" ? null : codexInstallRemedy(),
      libiEntriesPresent: entriesPresent,
    });
  } catch (err) {
    logger.error(
      {
        tag: "codex-connect",
        op: "post_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to toggle codex install",
    );
    return NextResponse.json({
      available: source.kind === "user",
      installed: false,
      status: "error" as const,
      cliSource: source.kind,
    });
  }
}
