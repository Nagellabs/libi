/**
 * What libi RECOMMENDS, as data. libi manages none of these and holds no
 * key or sign-in for any of them. A keyed provider's `commands` carry a
 * literal `<your key>` placeholder for the user to fill in and run in their own
 * shell or the built-in Terminal; a provider the user signs in to with their own
 * account (`auth: "oauth"`) has no key at all, and its agent's own `mcp login`
 * opens their browser. Nothing here is ever executed with a substituted secret.
 *
 * Adding a provider = one entry here + one skill reference file
 * (`mcp/skills/<skill>/references/providers/<id>.md`) + its rows in the
 * provider setup scripts (`lib/agents/setup/scripts/`), when it has commands.
 */

import { KOKORO_DOWNLOAD_MB } from "@/lib/tts/model-size";
import { MANAGED_PYTHON_DISK_MB } from "@/lib/uv-env/managed-python-size";

/** Every on-device Python feature also needs libi's own CPython, once per
 *  machine (lib/uv-env/managed-python-size.ts). */
const PYTHON_ONCE = `plus ~${MANAGED_PYTHON_DISK_MB} MB for libi's own Python the first time`;

/** `browser` is the one kind that makes no media: a tool the agent drives a web page with (posting to a site's own
 *  uploader — `mcp/skills/browser-posting`). */
export const PROVIDER_KINDS = ["image", "video", "music", "voice", "sfx", "transcription", "social", "browser"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Runtime guard for a kind that arrived over the wire (`POST /api/notify`). */
export function isProviderKind(v: unknown): v is ProviderKind {
  return typeof v === "string" && (PROVIDER_KINDS as readonly string[]).includes(v);
}

export type ProviderId = "fal" | "higgsfield" | "elevenlabs" | "playwright" | "ace-step" | "kokoro" | "whisper" | "zernio";

export interface ProviderDef {
  id: ProviderId;
  name: string;
  kinds: ProviderKind[];
  /** "remote-mcp" = the user adds it to their own agent. "extension" = libi-owned, on-device. */
  kind: "remote-mcp" | "extension";
  docsUrl?: string;
  /** remote-mcp only. */
  transport?: "http" | "stdio";
  /** Env-var NAME, a label for the UI. Never a value. */
  keyName?: string;
  /**
   * How the user proves who they are to this provider. Absent: an API key
   * (`keyName`, and `<your key>` in `commands`). `"oauth"`: they sign in with
   * their own account in a browser, through the agent's own `mcp login`, and the
   * agent keeps that sign-in. Such a provider has no key, so nothing may treat
   * a missing key as a problem (`lib/providers/detect.ts`). `"none"`: nothing to prove — a local server the
   * agent starts itself (Playwright), so there is no key to ask for and no sign-in step.
   */
  auth?: "oauth" | "none";
  /** How the detector recognises an entry already in the agent's config. */
  match: { names: string[]; urls?: string[] };
  /**
   * Exact add commands with a literal `<your key>` placeholder. The Providers
   * tab runs these same commands through libi's setup scripts
   * (`lib/agents/setup/scripts/`), which carry their own copy so the typed line
   * stays short; a test keeps every script equal to this catalog, so change
   * them together.
   */
  commands?: { claude: string; codex: string };
  /**
   * The add command on native Windows, where it differs from `commands` (the PowerShell setup scripts carry
   * these instead, kept equal by the same test). Claude Code on Windows cannot start `npx` directly — its
   * docs wrap a local stdio server in `cmd /c`.
   */
  windowsCommands?: { claude?: string; codex?: string };
  /**
   * `auth: "oauth"` only: each agent's own sign-in command for the entry the
   * add creates. The Providers tab's Sign in runs these through
   * `lib/agents/setup/scripts/signin-provider.*`, kept equal by the same test.
   */
  signInCommands?: { claude: string; codex: string };
  /**
   * `auth: "oauth"` only: the agents whose add command also runs the sign-in and
   * waits for it, so ONE action performs both setup steps on the Providers tab
   * (`lib/providers/setup-steps.ts`). Codex's own `mcp add` signs in; for Claude
   * Code, libi's add script runs `claude mcp login` after an add that worked. An
   * agent not listed adds first, then signs in as a separate step.
   */
  addSignsIn?: readonly ("claude" | "codex")[];
  /**
   * One line shown with the Codex command when it needs saying (the CLI surface prints it beside the raw command).
   * On the Providers tab it is the caption under Codex's Add while that add is still to do, except where the add
   * performs several steps at once (`addSignsIn`): that one action gets its own line, built from the steps it
   * performs, and this note is not repeated beside it.
   */
  codexNote?: string;
  /**
   * The env-var NAME Codex reads this provider's key from. When set, the
   * Providers tab's Codex add asks for the key at a hidden prompt and saves it
   * under this name — the user's shell profile on posix, the Windows user
   * environment on PowerShell — before the add. Never a value.
   */
  codexKeyEnv?: string;
  /** extension only — the `BundledMcpDef.id` this maps to. */
  extensionId?: string;
  /** extension only — download size, shown before the user starts an install. */
  sizeNote?: string;
}

export const PROVIDER_CATALOG: readonly ProviderDef[] = [
  {
    id: "fal",
    name: "fal.ai",
    kinds: ["image", "video"],
    kind: "remote-mcp",
    docsUrl: "https://fal.ai/docs/documentation/setting-up/mcp",
    transport: "http",
    keyName: "FAL_KEY",
    match: { names: ["fal", "fal-ai", "fal.ai"], urls: ["mcp.fal.ai"] },
    commands: {
      claude:
        'claude mcp add --scope user --transport http fal-ai https://mcp.fal.ai/mcp --header "Authorization: Bearer <your key>"',
      // `codex mcp add` has NO --header flag; HTTP auth is an env-var reference
      // that Codex reads from its own environment at launch.
      codex: "codex mcp add fal-ai --url https://mcp.fal.ai/mcp --bearer-token-env-var FAL_KEY",
    },
    codexNote:
      "Codex reads FAL_KEY from its own environment at launch, so export it in your shell profile.",
    codexKeyEnv: "FAL_KEY",
  },
  {
    id: "higgsfield",
    name: "Higgsfield",
    kinds: ["image", "video"],
    kind: "remote-mcp",
    // Higgsfield's official hosted MCP server (streamable HTTP). It signs in
    // with the user's Higgsfield account (OAuth); there is no API key.
    // Credits, the source for "generations use your Higgsfield credits" on the
    // Providers tab, in explain.ts and in the manual: the MCP FAQ's answer to
    // "How does pricing work?" on https://higgsfield.ai/mcp says "Your existing
    // Higgsfield plan credits work seamlessly through any connected agent."
    docsUrl: "https://higgsfield.ai/mcp",
    transport: "http",
    auth: "oauth",
    match: { names: ["higgsfield"], urls: ["higgsfield.ai"] },
    commands: {
      claude: "claude mcp add --transport http --scope user higgsfield https://mcp.higgsfield.ai/mcp",
      // `codex mcp add` starts the browser sign-in itself and returns only once
      // it has finished or been interrupted.
      codex: "codex mcp add higgsfield --url https://mcp.higgsfield.ai/mcp",
    },
    signInCommands: {
      // Verified on claude 2.1.245, libi's minimum: `claude mcp login <name>`
      // runs the OAuth flow, and only in an interactive terminal.
      claude: "claude mcp login higgsfield",
      codex: "codex mcp login higgsfield",
    },
    // Codex's add is the sign-in too (see `commands.codex`). Claude Code's add
    // finishes before any sign-in, so libi's add script runs its `mcp login`
    // right after an add that worked: one action for both steps on either agent.
    addSignsIn: ["codex", "claude"],
    codexNote: "Add opens your browser to sign in with your Higgsfield account, and waits until you finish.",
  },
  {
    id: "zernio",
    name: "Zernio",
    kinds: ["social"],
    kind: "remote-mcp",
    // Zernio's hosted MCP (streamable HTTP, OAuth 2.1 + PKCE). The agent signs
    // in with the user's Zernio account; there is no key. Posts go out from the
    // accounts the user connected at Zernio. libi's OWN grant for the Social
    // page is a separate sign-in (lib/social/), never this entry.
    docsUrl: "https://docs.zernio.com/mcp",
    transport: "http",
    auth: "oauth",
    match: { names: ["zernio"], urls: ["mcp.zernio.com"] },
    commands: {
      claude: "claude mcp add --transport http --scope user zernio https://mcp.zernio.com/mcp",
      codex: "codex mcp add zernio --url https://mcp.zernio.com/mcp",
    },
    signInCommands: { claude: "claude mcp login zernio", codex: "codex mcp login zernio" },
    addSignsIn: ["codex", "claude"],
    codexNote: "Add opens your browser to sign in with your Zernio account, and waits until you finish.",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    // Voice, music and sound effects. Its hosted server also generates images and video; libi doesn't
    // recommend it for those.
    kinds: ["voice", "music", "sfx"],
    kind: "remote-mcp",
    // ElevenLabs' hosted MCP server (streamable HTTP). It signs in with the user's ElevenLabs account (OAuth),
    // installs nothing and has no key; generations bill that account's plan. It replaced the local
    // `uvx elevenlabs-mcp` server (2026-09-25): that needed uv, and on a computer without it the entry read
    // connected while the chat had no ElevenLabs tools.
    //
    // WHY api.us: the documented https://api.elevenlabs.io/v1/mcp answers 401 with `resource_metadata` naming
    // https://api.us.elevenlabs.io/v1/mcp as the protected resource, and Claude Code 2.x refuses that sign-in
    // ("Protected resource https://api.us.elevenlabs.io… does not match expected https://api.elevenlabs.io").
    // Verified live on 2026-09-25: the api.us URL adds and signs in on Claude Code, and Codex's add starts the
    // OAuth flow against it. Credits, the source for "generations use your ElevenLabs credits": the server's own
    // tool descriptions say a run "Charges credits" (creative_run_flow_nodes, creative_design_voice), and every
    // generate tool takes `estimate_only` to price a run first.
    docsUrl: "https://elevenlabs.io/mcp",
    transport: "http",
    auth: "oauth",
    // `urls` also recognises an entry the user added under another name, at either host.
    match: { names: ["elevenlabs", "eleven-labs", "eleven_labs"], urls: ["elevenlabs.io"] },
    commands: {
      claude: "claude mcp add --transport http --scope user elevenlabs https://api.us.elevenlabs.io/v1/mcp",
      // As for Higgsfield, `codex mcp add` starts the browser sign-in itself and waits for it.
      codex: "codex mcp add elevenlabs --url https://api.us.elevenlabs.io/v1/mcp",
    },
    signInCommands: { claude: "claude mcp login elevenlabs", codex: "codex mcp login elevenlabs" },
    addSignsIn: ["codex", "claude"],
    codexNote: "Add opens your browser to sign in with your ElevenLabs account, and waits until you finish.",
  },
  {
    id: "playwright",
    name: "Playwright",
    // A browser the agent drives: it opens its own Chrome window, where the user signs in to a site once (the
    // login is kept between runs), then uploads a file BY PATH — so a video's size doesn't matter, unlike Claude
    // in Chrome's 10 MB upload. The browser-posting skill posts to TikTok Studio with it (2026-10-02).
    kinds: ["browser"],
    kind: "remote-mcp",
    docsUrl: "https://github.com/microsoft/playwright-mcp",
    // A local server the agent starts with npx: no key, no sign-in, needs Node.js on the computer.
    transport: "stdio",
    auth: "none",
    match: { names: ["playwright"] },
    commands: {
      claude: "claude mcp add --scope user playwright -- npx @playwright/mcp@latest",
      codex: "codex mcp add playwright -- npx @playwright/mcp@latest",
    },
    windowsCommands: {
      claude: "claude mcp add --scope user playwright -- cmd /c npx @playwright/mcp@latest",
    },
    codexNote: "Runs on your computer with npx (needs Node.js). No key or sign-in.",
  },
  {
    id: "ace-step",
    name: "ACE-Step (on-device music)",
    kinds: ["music"],
    kind: "extension",
    extensionId: "local-music",
    sizeNote: `~8.3 GB model weights, ${PYTHON_ONCE}, downloaded once, then free and offline.`,
    match: { names: [] },
  },
  {
    id: "kokoro",
    name: "Kokoro (on-device voice)",
    kinds: ["voice"],
    kind: "extension",
    extensionId: "local-tts",
    sizeNote: `~${KOKORO_DOWNLOAD_MB} MB model, ${PYTHON_ONCE}, downloaded once, then free and offline.`,
    match: { names: [] },
  },
  {
    id: "whisper",
    name: "Whisper (on-device transcription)",
    kinds: ["transcription"],
    kind: "extension",
    extensionId: "whisper",
    sizeNote: `~150 MB–1.5 GB depending on model size, ${PYTHON_ONCE}, downloaded once.`,
    match: { names: [] },
  },
];

/** Every catalog id, derived from the catalog so the two cannot drift. */
export const PROVIDER_IDS = PROVIDER_CATALOG.map((p) => p.id) as readonly ProviderId[];

/**
 * Spellings of a provider that predate the catalog, mapped forward.
 *
 * These are BUNDLED-MCP ids — what libi called its own rows while it still
 * managed MCP servers, and what it stamped into `files.ai_generation.provider`
 * at the time. They are still on disk in every user's DB.
 *
 * `fal-ai` is the one that has already cost something: the fake fal and a skill
 * disagreed over `fal` vs `fal-ai`, which is exactly the class of bug an id
 * with two spellings produces.
 *
 * Related but deliberately separate: `lib/providers/legacy.ts` has its own,
 * narrower map for the RESCUED-KEY rows — only providers libi ever held a key
 * for belong there, and adding an on-device extension to it would be wrong.
 */
const LEGACY_PROVIDER_IDS: Readonly<Record<string, ProviderId>> = {
  "fal-ai": "fal",
  "local-tts": "kokoro",
  "local-music": "ace-step",
};

const ID_SET = new Set<string>(PROVIDER_IDS);

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && ID_SET.has(v);
}

/**
 * A provider id as the catalog spells it.
 *
 * Deliberately TOTAL rather than validating: an unrecognised value is returned
 * unchanged, not rejected. libi no longer owns the list of providers a user can
 * have — their agent's MCP config does — so a generation made through a
 * provider this catalog has never heard of is a normal thing for provenance to
 * record, and losing it would be worse than recording a name libi cannot
 * resolve. Use `isProviderId` where the difference matters.
 */
export function normalizeProviderId(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  return LEGACY_PROVIDER_IDS[raw] ?? raw;
}

const BY_ID = new Map<ProviderId, ProviderDef>(PROVIDER_CATALOG.map((p) => [p.id, p]));

export function findProvider(id: ProviderId): ProviderDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`unknown provider id: ${id}`);
  return def;
}

/**
 * The catalog provider an agent's MCP entry is for, by its name (any of `match.names`, in any case) or its url's
 * host (`match.urls`, or a subdomain of one); null for a server the catalog doesn't know. Provider detection reads
 * rows with it (`./detect.ts`), and test mode puts its fakes over the user's real entries with it
 * (`lib/mcp-config.ts`).
 */
export function matchProvider(name: string, url: string | undefined): ProviderId | null {
  const lower = name.toLowerCase();
  let host = "";
  if (url) {
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      host = "";
    }
  }
  for (const def of PROVIDER_CATALOG) {
    if (def.match.names.some((n) => n.toLowerCase() === lower)) return def.id;
    if (host && def.match.urls?.some((u) => host === u || host.endsWith(`.${u}`))) return def.id;
  }
  return null;
}

/**
 * Every provider that can produce `kind`, remote MCPs first. The order is the
 * order the panel and `libi.suggest_provider` present them in: a remote MCP is
 * one command away, an extension is a multi-GB download.
 */
export function providersForKind(kind: ProviderKind): ProviderDef[] {
  const hits = PROVIDER_CATALOG.filter((p) => p.kinds.includes(kind));
  return [
    ...hits.filter((p) => p.kind === "remote-mcp"),
    ...hits.filter((p) => p.kind === "extension"),
  ];
}

/**
 * Whether this provider's paid usage shows up as "generations use your X
 * credits" — true only for an `oauth` provider that actually generates media.
 * A posting-only provider (kind `"social"`, e.g. Zernio) signs in the same
 * way but produces no media and has no credits, so callers must never print
 * that sentence for it. Derived from `kinds` — already the field that marks a
 * provider as posting-only — rather than a special case for one provider id,
 * since more posting providers are planned.
 */
export function billsGenerationCredits(def: ProviderDef): boolean {
  return def.auth === "oauth" && !def.kinds.includes("social");
}

/** The literal placeholder every key-bearing command carries. */
export const KEY_PLACEHOLDER = "<your key>";

/**
 * True when the command contains the placeholder — i.e. the user has to put
 * their own key in before it can run. libi never holds that key.
 */
export function commandNeedsKey(command: string): boolean {
  return command.includes(KEY_PLACEHOLDER);
}
