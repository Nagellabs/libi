import { studioBaseUrl } from "@/mcp/notify";
import { trackMcpEvent } from "@/mcp/analytics";
import { mcpLogger as logger } from "@/lib/logger";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import type { AgentSurface } from "@/lib/mcp/agent-surface";
import {
  PROVIDER_CATALOG,
  providersForKind,
  type ProviderDef,
  type ProviderId,
} from "@/lib/providers/catalog";
import type { DetectedMcp } from "@/lib/providers/detect";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { fetchConnectedProviders } from "./provider-http";
import type { ToolResult } from "./types";
import type { SuggestProviderParams } from "./schemas";

/**
 * Every provider the catalog knows, by name with its kinds, for the provider tools' descriptions. Claude Code keeps
 * MCP tools out of the prompt until a search finds them, and an agent asked "is fal.ai available?" searches for
 * "fal": a description that never names fal.ai is never found, and the agent answers in prose with no card.
 */
export const PROVIDER_NAMES_FOR_DESCRIPTIONS = PROVIDER_CATALOG.map((d) => `${d.name}: ${d.kinds.join(", ")}`).join("; ");

/**
 * Said on every answer, whatever its status: a provider connected after the chat started shows up in `covered` but
 * has no tools in that chat. The likely follow-up to connecting one mid-chat is asking again, which for a kind with
 * another provider still to offer is a card — never only "nothing to suggest". `connected` holds only the calling
 * agent's rows (see `suggestProvider`), so "registered for you" is true; its `name` is what the tools are listed
 * under (the config entry, `fal-ai`, not the catalog id `fal`), and a `signIn: "unknown"` row may simply not be signed
 * in, which no new chat fixes. A CLI session may also sit in a project the entry isn't registered for.
 */
function missingToolsNote(surface: AgentSurface): string {
  const lead =
    "A provider in `covered` with `via: \"connected\"` is registered for you: its row in `connected` has the `name` its tools are listed under — search your deferred tools for that name first.";
  return surface === "in-app"
    ? `${lead} If it has none, it was added after this chat started: say so and tell the user to open a new chat to use it — or, when that row's \`signIn\` is "unknown", to finish signing in to it on libi's Providers tab first.`
    : `${lead} If it has none, it was added after this session started or is registered only for another project: tell the user to start a new session where it is registered — or, when that row's \`signIn\` is "unknown", to sign in to it first.`;
}

/** `fetchConnectedProviders` already swallows transport errors; this guards
 *  the tool against anything else (a test double that rejects, say) so the
 *  answer is always "here is what to connect", never a tool error. */
async function connectedOrNone(): Promise<DetectedMcp[]> {
  try {
    return await fetchConnectedProviders();
  } catch {
    return [];
  }
}

/** A catalog provider for the asked-for kind that the agent can ALREADY use. */
interface CoveredProvider {
  id: ProviderId;
  name: string;
  /** "connected" = in the user's own agent config; "extension" = libi's own, installed. */
  via: "connected" | "extension";
}

/** Install states in which a libi extension's tools actually work. The same
 *  pair `libi.retry_mcp_server` and the dependency manager treat as ready. */
const USABLE_INSTALL_STATUS = new Set(["installed", "not_required"]);

/**
 * Split the catalog for `kind` into what is still worth suggesting and what
 * the agent already has.
 *
 * Two ways to already have one:
 *   - the user CONNECTED it to their own agent (`status: "connected"`; a
 *     `needs-key` or `disabled` row is exactly what the add command fixes, so
 *     it stays in `suggested`);
 *   - it is one of libi's own extensions and its dependencies are in place.
 *     An extension that is not installed yet is still a legitimate offer — the
 *     card's whole job for it is the download.
 */
function splitByCoverage(
  kind: SuggestProviderParams["kind"],
  connected: DetectedMcp[],
): { suggested: ProviderDef[]; covered: CoveredProvider[] } {
  const connectedIds = new Set(
    connected.flatMap((c) => (c.providerId && c.status === "connected" ? [c.providerId] : [])),
  );
  const installedExtensions = new Set(
    libiExtensions().flatMap((e) =>
      e.providerId && USABLE_INSTALL_STATUS.has(e.installStatus) ? [e.providerId] : [],
    ),
  );

  const suggested: ProviderDef[] = [];
  const covered: CoveredProvider[] = [];
  for (const def of providersForKind(kind)) {
    if (connectedIds.has(def.id)) covered.push({ id: def.id, name: def.name, via: "connected" });
    else if (installedExtensions.has(def.id))
      covered.push({ id: def.id, name: def.name, via: "extension" });
    else suggested.push(def);
  }
  return { suggested, covered };
}

/**
 * Tell the user how to connect a provider for `kind`.
 *
 * In-app: returns `status: "card"` — the chat renders a card with one button
 * per suggestion, on-device extensions first, then providers to
 * connect. Nothing is POSTed to the studio: the card IS the tool result, so
 * there is no screen claim that could turn out false.
 * CLI: returns `status: "cli"` with the same picture PLUS the exact add
 * commands, since there is no chat to render a card in, and an
 * `agentsPageUrl` per option — the same choice inside libi's own window.
 * Either surface: `status: "none"` when everything the catalog has for this
 * kind is already connected or already installed — nothing is offered,
 * because a suggestion for a provider the user is already using is noise, and
 * for a kind libi covers with its own extension it is worse than noise (it
 * offered the on-device model that had just answered the call). The agent
 * routes on that instead of hand-writing the exit.
 *
 * Every answer hands back what is already connected so the agent can say "you
 * have ElevenLabs, that covers voice — you need one for video". It never
 * returns, requests or logs a key.
 */
export async function suggestProvider(
  params: SuggestProviderParams,
  /** `dialect`: the calling agent, from the MCP entry's `?agent=`; unset when the server doesn't know it. */
  opts: { surface: AgentSurface; dialect?: "claude" | "codex" },
): Promise<ToolResult> {
  const detected = await connectedOrNone();
  // Only what is registered for the calling agent: fal added with `codex mcp add` is not in a Claude chat, and
  // counting it would offer Higgsfield alone and tell the user a new chat has fal, which it never will.
  const connected = opts.dialect ? detected.filter((c) => c.agent === opts.dialect) : detected;
  await settleCatalogExtensions();
  const { suggested: defs, covered } = splitByCoverage(params.kind, connected);
  const inApp = opts.surface === "in-app";
  const nothingToSuggest = defs.length === 0;

  logger.info(
    {
      tag: "providers",
      op: "suggest",
      kind: params.kind,
      surface: opts.surface,
      card: inApp,
      connected: connected.length,
      suggested: defs.length,
      covered: covered.length,
    },
    "suggested providers for a kind",
  );
  // Bounded by the schema's enum; `reason` is user-shaped text and never sent.
  trackMcpEvent("provider_suggested", { kind: params.kind });

  if (nothingToSuggest) {
    return {
      success: true,
      data: {
        status: "none",
        kind: params.kind,
        connected,
        suggested: [],
        covered,
        note:
          "There is nothing to suggest for this kind: everything libi knows of for it is already connected or already installed (see `covered`). Do NOT offer a provider card or ask for a key. Use what is listed there, or — if it cannot do what was asked — say plainly what libi cannot do. " +
          missingToolsNote(opts.surface),
      },
    };
  }

  // On-device first: an extension is free after one download and needs no
  // account, so it leads the card.
  const ordered = [...defs.filter((d) => d.kind === "extension"), ...defs.filter((d) => d.kind === "remote-mcp")];
  if (inApp) {
    return {
      success: true,
      data: {
        status: "card",
        kind: params.kind,
        connected,
        covered,
        suggested: ordered.map((d) => ({
          id: d.id,
          name: d.name,
          kinds: d.kinds,
          kind: d.kind,
          ...(d.extensionId ? { extensionId: d.extensionId } : {}),
          ...(d.sizeNote ? { sizeNote: d.sizeNote } : {}),
        })),
        note:
          "A card with one button per suggestion is now in the chat. Tell the user in one line what it offers and stop — never ask for a key. A provider added now is only picked up in a NEW session. " +
          missingToolsNote(opts.surface),
      },
    };
  }
  const base = studioBaseUrl();
  return {
    success: true,
    data: {
      status: "cli",
      kind: params.kind,
      connected,
      suggested: defs.map((d) => d.id),
      covered,
      options: defs.map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        docsUrl: d.docsUrl,
        sizeNote: d.sizeNote,
        commands: d.commands,
        ...(d.auth ? { auth: d.auth } : {}),
        ...(d.signInCommands ? { signInCommands: d.signInCommands } : {}),
        codexNote: d.codexNote,
        ...(base ? { agentsPageUrl: agentsPageUrlFor(base, d, opts.dialect) } : {}),
      })),
      note: "Show the command for the user's agent verbatim. A command with a literal <your key> placeholder needs the user's own key — they replace it and run it themselves. Never ask them to paste the key to you. An option with `auth: \"oauth\"` has no key: the user signs in with their own account in the browser — Codex's add starts that sign-in itself, and `signInCommands` holds each agent's sign-in command. A new MCP is only picked up in a NEW session. `agentsPageUrl` is the same choice inside libi's own window. " +
        missingToolsNote(opts.surface),
    },
  };
}

/** Where a suggestion lives inside libi: an extension on the libi MCP tab, a
 *  provider on the Providers tab — opened on the calling agent, when the session knows which one it is.
 *  Built on `studioBaseUrl()`, so always 127.0.0.1, never localhost. */
function agentsPageUrlFor(base: string, d: ProviderDef, dialect: "claude" | "codex" | undefined): string {
  if (d.kind === "extension") return `${base}/agents?tab=libi-mcp&extension=${encodeURIComponent(d.extensionId ?? d.id)}`;
  const agent = dialect === undefined ? "" : `&setupAgent=${dialect === "codex" ? "codex" : "claude-code"}`;
  return `${base}/agents?tab=providers&provider=${encodeURIComponent(d.id)}${agent}`;
}

/** Catalog id for a libi extension row, when that extension IS a provider. */
const EXTENSION_PROVIDER_ID = new Map<string, ProviderId>(
  PROVIDER_CATALOG.flatMap((p) =>
    p.extensionId ? [[p.extensionId, p.id] as [string, ProviderId]] : [],
  ),
);

/** Registry order, so the answer reads the same as the settings tab. */
const LIBI_ROW_ORDER = new Map(BUNDLED_MCP_SERVERS.map((d, i) => [d.id, i]));

interface LibiExtension {
  id: string;
  name: string;
  description: string | null;
  installStatus: string;
  /** The catalog provider this extension IS, when it is one. */
  providerId: ProviderId | null;
}

/**
 * libi's own rows and whether each is installed. Since migration 0051 the
 * `mcp_servers` table holds nothing else — this is the whole of what the
 * retired `libi.list_mcp_servers` reported, plus the catalog link.
 */
/**
 * Re-derive each catalogued extension's install status from DISK before it is
 * read.
 *
 * `installStatus` is a stored field an install path has to remember to write,
 * and QA caught it lying in the direction that matters: `libi.whisper_download_model`
 * really downloaded the model, the row stayed `pending` because nothing called
 * `libi.update_dep_status`, and `suggest_provider` therefore kept offering to
 * install a model already sitting on the user's disk. Coverage is a claim about
 * the machine, so it has to be answered from the machine.
 *
 * `settleInstallStatus` is exactly this question and is already run on every
 * boot from Category B — it probes files, never downloads and never spawns the
 * MCP. Only the extensions that ARE catalogue providers are settled, since
 * those are the only rows coverage reads. Failures are swallowed: a stale
 * status is a worse answer, not a broken tool.
 */
async function settleCatalogExtensions(): Promise<void> {
  const manager = new DependencyManager();
  await Promise.all(
    [...EXTENSION_PROVIDER_ID.keys()].map((id) =>
      manager.settleInstallStatus(id).catch((err: unknown) => {
        logger.warn(
          {
            tag: "providers",
            op: "settle_failed",
            mcpId: id,
            err: err instanceof Error ? err.message : String(err),
          },
          "could not re-derive an extension's install status from disk",
        );
        return null;
      }),
    ),
  );
}

function libiExtensions(): LibiExtension[] {
  let rows;
  try {
    rows = getDb().select().from(mcpServers).all();
  } catch {
    return [];
  }
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      installStatus: r.installStatus,
      providerId: EXTENSION_PROVIDER_ID.get(r.id) ?? null,
    }))
    .sort((a, b) => (LIBI_ROW_ORDER.get(a.id) ?? 99) - (LIBI_ROW_ORDER.get(b.id) ?? 99));
}

/**
 * What the user has connected, what libi recommends, and what libi can do on
 * device. Names only — no commands, no key names, no match rules; the agent
 * has no use for those and `suggest_provider` is where they belong.
 *
 * `extensions` is the fold of the retired `libi.list_mcp_servers`.
 * That tool read the same table and its description still told the agent to
 * "discover capabilities (e.g. AI image/video/audio MCPs)" there — which since
 * migration 0051 cannot happen, because the table holds only libi's own rows.
 * The half of it that still meant something is whether a libi extension is
 * INSTALLED, and that belongs next to the catalog entry it answers for: an
 * agent asking "who can make music" needs ACE-Step's install status in the
 * same breath as ACE-Step, not from a second tool.
 */
export async function listProviders(): Promise<ToolResult> {
  const connected = await connectedOrNone();
  // Same reason as `suggestProvider`: the agent reads `extensions[].installStatus`
  // to decide whether it must install something, so it must be disk truth.
  await settleCatalogExtensions();
  return {
    success: true,
    data: {
      connected,
      catalog: PROVIDER_CATALOG.map((p) => ({ id: p.id, name: p.name, kinds: p.kinds, kind: p.kind })),
      extensions: libiExtensions(),
    },
  };
}
