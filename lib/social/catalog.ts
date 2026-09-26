/**
 * Social posting providers, as data. A provider is a hosted MCP libi talks to
 * as a CLIENT for its own UI (Social page, Posting tab) — see the AGENTS.md
 * amendment. The AGENT's entry for the same provider is a row in
 * `lib/providers/catalog.ts` (kind "social"); `agentProviderId` links them.
 * A second provider is one more entry here plus one adapter under
 * `lib/social/providers/<id>/`.
 */
/**
 * The platforms libi's OWN UI composes, schedules and publishes to. Narrower
 * than what the provider can reach on purpose — see `KnownPlatform`.
 */
export type SocialPlatform = "instagram" | "tiktok";

/**
 * Every platform this catalog names, by the PROVIDER'S own key. `twitter` is
 * X: that is the key Zernio's wire uses ("Platform-specific features" in its
 * docs lists X as `twitter`), and a row that arrives as `twitter` has to
 * render as "X" rather than as itself.
 *
 * Wider than `SocialPlatform` because an account, a post target or an
 * analytics row can legitimately carry any of these: the agent posts through
 * the provider's MCP, which supports far more platforms than libi's UI
 * drives, and libi still has to SHOW what the agent did. Every display site
 * goes through `platformLabel` / `platformGlyph`, and anything not listed
 * here falls back to the raw key rather than being renamed to a platform it
 * is not.
 */
export type KnownPlatform = SocialPlatform | "facebook" | "twitter" | "youtube";

export interface PlatformDef {
  id: KnownPlatform;
  label: string;
  /** Two characters for the round badge the accounts strip and status chips draw. */
  glyph: string;
  /**
   * Whether libi's own composer can build a post for it. `false` means
   * agent-only: the provider's MCP posts there today, libi's UI does not yet.
   * The UI must SAY so wherever such an account or post appears rather than
   * offering a flow that would fail — `catalog.platforms` has no entry for
   * these, so there are no limits to fit-check and no options to collect.
   */
  ui: boolean;
}

/** One row per platform libi names anywhere in its UI. */
export const PLATFORM_CATALOG: readonly PlatformDef[] = [
  { id: "instagram", label: "Instagram", glyph: "IG", ui: true },
  { id: "tiktok", label: "TikTok", glyph: "TT", ui: true },
  { id: "facebook", label: "Facebook", glyph: "FB", ui: false },
  { id: "twitter", label: "X", glyph: "X", ui: false },
  { id: "youtube", label: "YouTube", glyph: "YT", ui: false },
];

const PLATFORM_BY_ID = new Map<string, PlatformDef>(PLATFORM_CATALOG.map((p) => [p.id, p]));

/** "Instagram", "X", … — the raw key for a platform this build has never heard of. */
export function platformLabel(platform: string): string {
  return PLATFORM_BY_ID.get(platform)?.label ?? platform;
}

/** "IG", "X", … — the key's first two characters for anything unlisted. */
export function platformGlyph(platform: string): string {
  return PLATFORM_BY_ID.get(platform)?.glyph ?? platform.slice(0, 2).toUpperCase();
}

/**
 * Whether libi's composer can build a post for this platform. The ONE gate:
 * a target picker, a fit check or a draft restore that would otherwise hand
 * `defaultOptions` a platform it has no options for asks this first.
 */
export function isComposablePlatform(platform: string): platform is SocialPlatform {
  return PLATFORM_BY_ID.get(platform)?.ui === true;
}

export type InstagramPostType = "reel" | "feed" | "story";

/** ONE grant, ONE prompt: everything the closed UI list needs, requested at once. No `ads:write` —
 * Zernio's only ads scope also permits ad creation, so libi drops it entirely and reads ads read-only. */
export const OAUTH_SCOPES = ["accounts:read", "posts:read", "posts:write", "analytics:read"] as const;

export interface PlatformLimits {
  maxSeconds: number;
  maxBytes: number;
  /** Accepted aspect ratios as "w:h"; the fit check compares by ratio with 2% tolerance. */
  aspects: string[];
  captionMax: number;
  /** Characters visible before "more" — a soft marker read by the composer's caption counter (`caption-step.tsx`). */
  captionFold?: number;
}

export interface SocialProviderDef {
  /**
   * Narrowed to whatever literal ids actually appear in `SOCIAL_PROVIDER_CATALOG`
   * below — kept as the wide `string` here only so `SocialProviderId` (derived
   * FROM that catalog) doesn't circularly reference this field's own type.
   */
  id: string;
  name: string;
  docsUrl: string;
  dashboardUrl: string;
  mcpUrl: string;
  /**
   * The origins this provider serves a POST'S MEDIA from — the `url` on a
   * `mediaItems[]` row, which libi's own UI renders in a `<video>`/`<img>`
   * (`post-detail-sheet.tsx`, `post-row.tsx`).
   *
   * Declared here because libi's CSP has to allow them: `media-src 'self'`
   * blocked every preview in every post, silently apart from one console line
   * (QA 2026-09-21, finding 2). `lib/security/csp.ts` reads THIS rather than
   * hardcoding a host, so adding a second provider is a catalog entry and not
   * a security edit — and so the allowance stays exactly as wide as the
   * providers libi actually ships.
   *
   * Origins only (scheme + host, no path, no wildcard host): a CSP source is
   * matched by origin anyway, and a wildcard here would widen the policy for
   * every provider at once.
   */
  mediaOrigins: readonly string[];
  agentProviderId: "zernio";
  scopes: readonly string[];
  platforms: Record<SocialPlatform, {
    postTypes: readonly string[];
    limits: Record<string, PlatformLimits>;
    nonPublicMode: "none";
    unpublish: false;
  }>;
  capabilities: {
    drafts: true; scheduling: true; validation: true; partialStatus: true; metadataOnPost: true;
    mediaUpload: "presign"; ads: { readTree: true }; queue: true;
  };
}

const MB = 1024 * 1024;

export const SOCIAL_PROVIDER_CATALOG = [
  {
    id: "zernio",
    name: "Zernio",
    docsUrl: "https://docs.zernio.com",
    dashboardUrl: "https://zernio.com/dashboard",
    mcpUrl: "https://mcp.zernio.com/mcp",
    // Both halves of the upload's life: a presigned object lives at
    // `media.zernio.com/temp/…` and is promoted to `media.zernio.com/media/…`
    // when it is first attached to a post (zernio-live-shapes.md). One origin
    // covers both.
    mediaOrigins: ["https://media.zernio.com"],
    agentProviderId: "zernio",
    scopes: OAUTH_SCOPES,
    platforms: {
      instagram: {
        postTypes: ["reel", "feed", "story"],
        // https://docs.zernio.com/platforms/instagram (read 2026-09-20)
        limits: {
          reel: { maxSeconds: 90, maxBytes: 300 * MB, aspects: ["9:16"], captionMax: 2200, captionFold: 125 },
          feed: { maxSeconds: 60 * 60, maxBytes: 300 * MB, aspects: ["4:5", "1:1", "1.91:1"], captionMax: 2200, captionFold: 125 },
          story: { maxSeconds: 60, maxBytes: 100 * MB, aspects: ["9:16"], captionMax: 0 },
        },
        nonPublicMode: "none",
        unpublish: false,
      },
      tiktok: {
        postTypes: ["video"],
        // 600 s and PUBLIC_TO_EVERYONE-only were read from creator info on the
        // user's account (spec appendix); the fit check uses this as the ceiling
        // and the composer re-reads creator info live for the real values.
        limits: { video: { maxSeconds: 600, maxBytes: 4 * 1024 * MB, aspects: ["9:16"], captionMax: 2200 } },
        nonPublicMode: "none",
        unpublish: false,
      },
    },
    capabilities: {
      drafts: true, scheduling: true, validation: true, partialStatus: true, metadataOnPost: true,
      mediaUpload: "presign", ads: { readTree: true }, queue: true,
    },
  },
] satisfies readonly SocialProviderDef[];

/**
 * Every id present in the catalog above, derived by membership instead of
 * hardcoded a second and third time — the same shape `ProviderKind` /
 * `isProviderKind` take deriving from `PROVIDER_KINDS`
 * (`lib/providers/catalog.ts:16-23`). Add a provider to
 * `SOCIAL_PROVIDER_CATALOG` and this widens with it; there is nowhere else
 * that needs to know the literal id.
 */
export type SocialProviderId = (typeof SOCIAL_PROVIDER_CATALOG)[number]["id"];

export function isSocialProviderId(v: unknown): v is SocialProviderId {
  return typeof v === "string" && SOCIAL_PROVIDER_CATALOG.some((p) => p.id === v);
}

/**
 * Every social provider's media origins, de-duplicated and sorted — the CSP's
 * `media-src` / `img-src` allowance (`lib/security/csp.ts`).
 *
 * Deliberately the WHOLE catalog rather than the connected provider: the CSP
 * header is emitted per page response by `proxy.ts`, long before (and
 * independently of) whether the user has connected anything, and a policy that
 * changed with connection state would be a policy nobody could reason about.
 * The catalog is two entries' worth of hosts libi ships knowingly, not an
 * open door.
 */
export function socialMediaOrigins(): string[] {
  return [...new Set(SOCIAL_PROVIDER_CATALOG.flatMap((p) => p.mediaOrigins))].sort();
}

const BY_ID = new Map<SocialProviderId, SocialProviderDef>(SOCIAL_PROVIDER_CATALOG.map((p) => [p.id, p]));
export function findSocialProvider(id: SocialProviderId): SocialProviderDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`unknown social provider: ${id}`);
  return def;
}
