import { sqliteTable, text, integer, real, uniqueIndex, primaryKey, index, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { sql } from "drizzle-orm";

export const folders = sqliteTable(
  "folders",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    parentFolderId: text("parent_folder_id").references(
      (): AnySQLiteColumn => folders.id,
      { onDelete: "set null" },
    ),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    parentIdx: index("idx_folders_parent").on(t.parentFolderId),
  }),
);

export const pieces = sqliteTable("pieces", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  description: text("description"),
  nameSetByUser: integer("name_set_by_user", { mode: "boolean" })
    .notNull()
    .default(false),
  hasDraft: integer("has_draft", { mode: "boolean" })
    .notNull()
    .default(false),
  snapshotSummary: text("snapshot_summary"),
  snapshotCommittedAt: integer("snapshot_committed_at", { mode: "timestamp" }),
  folderId: text("folder_id").references((): AnySQLiteColumn => folders.id, {
    onDelete: "set null",
  }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  /**
   * When this piece was last OPENED in the editor — distinct from `updatedAt`,
   * which moves on every mutation the agent makes. Stamped by
   * POST /api/editor/open-piece, the one chokepoint every open already flows
   * through (UI clicks, restore-on-boot, and the agent's `libi.show_piece`,
   * which lands here via the SSE navigation event).
   *
   * Nullable on purpose: pieces created before this column existed, and pieces
   * the agent created but nobody has opened yet, have honestly never been
   * opened. Readers must order NULLs last rather than coalescing them into a
   * fake open time — see lib/pieces/recent.ts.
   */
  lastOpenedAt: integer("last_opened_at", { mode: "timestamp" }),
});

export const assetFolders = sqliteTable(
  "asset_folders",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // NULL = global asset folder (organizes _global files).
    // Set = belongs to a piece; cascades on piece delete.
    pieceId: text("piece_id").references(() => pieces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    parentFolderId: text("parent_folder_id").references(
      (): AnySQLiteColumn => assetFolders.id,
      { onDelete: "set null" },
    ),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    pieceIdx: index("idx_asset_folders_piece").on(t.pieceId),
    parentIdx: index("idx_asset_folders_parent").on(t.parentFolderId),
  }),
);

export const files = sqliteTable(
  "files",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    pieceId: text("piece_id")
      .references(() => pieces.id, { onDelete: "cascade" }),
    // NULL = file at the root of its scope. References asset_folders.
    //
    // FK ACTIONS DO RUN IN PRODUCTION. An earlier note here claimed the
    // opposite ("prod runs FK-off"), which is not what the runtime does:
    // better-sqlite3 opens every connection with `foreign_keys = 1`, and the
    // one place libi turns it off (`migrateDatabase`) uses a throwaway
    // connection it closes again. Measured two ways — the pragma reads 1 on a
    // fresh better-sqlite3 handle, and deleting a piece row from a COPY of a
    // real `~/.libi/libi.sqlite` cascaded through 30 `files` rows and took the
    // dependent `tracks` row with it. Code that relies on a cascade (the
    // onboarding build's rollback does) is relying on something real.
    folderId: text("folder_id").references((): AnySQLiteColumn => assetFolders.id, {
      onDelete: "set null",
    }),
    filename: text("filename").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    type: text("type").notNull(),
    storagePath: text("storage_path").notNull(),
    contentType: text("content_type"),
    size: integer("size").notNull().default(0),
    mediaDuration: real("media_duration"),
    mediaWidth: integer("media_width"),
    mediaHeight: integer("media_height"),
    /** True iff ffprobe reported at least one audio stream. Populated at
     *  upload; null for files uploaded before this column existed (post-
     *  wipe, this should never be null in practice). */
    hasAudio: integer("has_audio", { mode: "boolean" }),
    /** True iff the video stream carries an alpha channel (probed at upload —
     *  yuva- or rgba-family pixel formats, or the WebM `alpha_mode` tag).
     *  Alpha-bearing videos NEVER get a proxy (H.264 yuv420p strips alpha
     *  silently) and `pickVideoUrl` always serves their original bytes.
     *  Null on rows from before this column existed. */
    hasAlpha: integer("has_alpha", { mode: "boolean" }),
    /** Filename of the proxy file on disk (same directory as original). */
    proxyFilename: text("proxy_filename"),
    /** 'idle' | 'generating' | 'ready' | 'failed' — 'queued' was written by the old proxy pipeline and may appear in rows from prior versions but is never written by the current JobManager-backed flow. */
    proxyStatus: text("proxy_status")
      .$type<"idle" | "generating" | "ready" | "failed">()
      .notNull()
      .default("idle"),
    /** Last successful generation timestamp (unix seconds). */
    proxyGeneratedAt: integer("proxy_generated_at", { mode: "timestamp" }),
    /**
     * Actual encoded height of the proxy MP4, probed from the output via
     * ffprobe after generation. Null for proxies generated before this column
     * existed (the resolution-aware-regen signal) or when probing failed.
     * `downscaled = proxyHeight != null && mediaHeight != null && proxyHeight < mediaHeight`.
     */
    proxyHeight: integer("proxy_height"),
    /**
     * Filename of the timeline filmstrip sprite on disk (same directory as
     * original) — a horizontal JPG of N sampled frames painted inside timeline
     * bars / base-scene blocks. Mirrors the proxy_* lifecycle.
     */
    filmstripFilename: text("filmstrip_filename"),
    /** 'idle' | 'generating' | 'ready' | 'failed' — filmstrip sprite gen status. */
    filmstripStatus: text("filmstrip_status")
      .$type<"idle" | "generating" | "ready" | "failed">()
      .notNull()
      .default("idle"),
    /** Last successful filmstrip generation timestamp. */
    filmstripGeneratedAt: integer("filmstrip_generated_at", { mode: "timestamp" }),
    /** Number of frames tiled into the sprite (for CSS background-size math). */
    filmstripFrames: integer("filmstrip_frames"),
    /** Per-frame height of the sprite in px (for CSS sizing). */
    filmstripHeight: integer("filmstrip_height"),
    notes: text("notes"),
    /**
     * AI-generation provenance for files produced by a generation tool.
     * JSON-serialized `AiGenerationMeta` (`lib/ai-generation/types.ts`).
     *
     * `provider` is a CATALOG id (`lib/providers/catalog.ts`) — "fal",
     * "elevenlabs", "kokoro", "ace-step". Rows written before the catalog
     * existed carry the old bundled-MCP ids ("fal-ai", "local-tts",
     * "local-music"); those are mapped forward on read and on write by
     * `normalizeProviderId`, so nothing downstream sees two spellings of one
     * provider. An id the catalog does not know is kept verbatim rather than
     * rejected — the user's own agent may have a provider libi does not.
     * In test mode fake-fal stamps "fal", exactly as production does.
     *   {
     *     provider: "fal" | "elevenlabs" | "kokoro" | "ace-step" | "...",
     *     model: string,
     *     prompt: string,
     *     costEstimate?: { amount, currency, tier? },
     *     costActual?:   { amount, currency, source: "tool" | "page-scrape" | "manual" },
     *     startedAt, completedAt: ISO timestamp,
     *     durationMs: number,
     *     providerJobId?: string,
     *     attemptNumber?: number,
     *   }
     * Null on non-AI files (uploads, trims, concats). Populated only for new
     * generations from 2026-05-27 onwards — no backwards compatibility.
     */
    aiGeneration: text("ai_generation"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    folderIdx: index("idx_files_folder_id").on(t.folderId),
  }),
);

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey().default(1),
  preferredAgent: text("preferred_agent"),
  panelChatSize: real("panel_chat_size").notNull().default(40),
  panelEditorSize: real("panel_editor_size").notNull().default(40),
  panelResourcesSize: real("panel_resources_size").notNull().default(20),
  panelChatVisible: integer("panel_chat_visible", { mode: "boolean" }).notNull().default(true),
  panelResourcesVisible: integer("panel_resources_visible", { mode: "boolean" }).notNull().default(false),

  agentApprovalModes: text("agent_approval_modes"),
  /** JSON-serialized Record<agentId, modelId> — the user's chosen model per agent.
   *  Re-applied to each new/standby/resumed session (adapters don't persist it). Null = none. */
  agentModelPreferences: text("agent_model_preferences"),
  /** JSON-serialized NotificationsSetting (see lib/db/settings.ts). Null = use defaults. */
  notifications: text("notifications"),
  /** Legacy JSON column, no longer read or written; kept to avoid a migration. */
  codex: text("codex"),
  /** JSON-serialized ExportDefaultsSetting (folder, format, quality). Null = use OS-aware defaults. */
  exportDefaults: text("export_defaults"),
  /** JSON-serialized PieceDefaultsSetting ({aspectRatioId}, see lib/db/settings.ts).
   *  Applied when a piece is CREATED; never retroactive. Null = use 9:16. */
  pieceDefaults: text("piece_defaults"),
  /** JSON {version, digests: {skillName: sha256}} — per-app-version cache of
   *  bundled skill content digests. Recomputed once per version change. */
  skillDigestCache: text("skill_digest_cache"),
  /** JSON-serialized AnalyticsSettings (see lib/db/settings.ts). Null = defaults
   *  (analytics enabled, no userId yet). GA4 product-analytics system. */
  analytics: text("analytics"),
  /** JSON-serialized CrashReportSettings (see lib/db/settings.ts). Null = defaults
   *  (choice "unset", which behaves as enabled — see that file). */
  crashReports: text("crash_reports"),
  /** JSON-serialized SocialSettings (see lib/db/settings.ts): chosen social
   *  provider + defaults. NEVER a token — the grant lives in lib/social/token-store.ts. */
  social: text("social"),
  /** JSON-serialized TemplatesAuthorSetting (see lib/db/settings.ts): the
   *  install's public-catalog creator key, its derived author id and the
   *  chosen nickname. The key is a bearer the SITE never stores; here it is
   *  the one secret this table holds, so it is never included in any API
   *  response except POST /api/templates/cloud/key/reveal (Settings →
   *  General's explicit Reveal or Copy). */
  templatesAuthor: text("templates_author"),
  /** JSON-serialized TemplatesCatalogSetting (see lib/db/settings.ts): which
   *  public templates catalog a DEV build reads — production or a development
   *  site — and that site's Vercel protection-bypass token. Read only by dev
   *  builds (lib/templates/cloud/catalog-setting.ts); a packaged or npm build
   *  ignores it. The token is a secret: never in getSettings(), never in any
   *  API response (masked only), never logged. Null = the default. */
  templatesCatalog: text("templates_catalog"),
  /** JSON string[] of piece ids already told that their canvas-scene layers
   *  from libi 0.1.0/0.1.1 were not loaded (hooks/editor/use-legacy-scenes-notice.ts).
   *  Server-side on purpose: the packaged app's origin changes every launch
   *  (ephemeral port), so browser storage cannot keep "once per piece". A
   *  deleted piece's id is removed (lib/pieces/delete-piece.ts). Null = none. */
  legacyScenesNoticed: text("legacy_scenes_noticed"),
  onboardingPersona: text("onboarding_persona"),
  personaSelectedAt: integer("persona_selected_at", { mode: "timestamp" }),
  agentEverConnected: integer("agent_ever_connected", { mode: "boolean" })
    .notNull()
    .default(false),
  /** Set once, server-side, the first time an agent connects (same guard as
   *  agentEverConnected) — arms the "Show me how it works" demo chip. Null =
   *  never armed. */
  onboardingDemoOfferedAt: integer("onboarding_demo_offered_at", { mode: "timestamp" }),
  /** Set once the user dismisses OR takes the demo offer. Independent of
   *  onboardingDemoOfferedAt so a dismissal can never be confused with
   *  "never offered" — and, once set, is final: the offer never returns. */
  onboardingDemoDismissedAt: integer("onboarding_demo_dismissed_at", { mode: "timestamp" }),
  /** The setup wizard's "I've signed in" / "I'm already signed in" for this
   *  agent. A UI gate ONLY — the server never blocks a chat on it — and cleared
   *  the moment the agent is OBSERVED rejecting auth. */
  claudeSignInConfirmedAt: integer("claude_sign_in_confirmed_at", { mode: "timestamp" }),
  codexSignInConfirmedAt: integer("codex_sign_in_confirmed_at", { mode: "timestamp" }),
  /** The Agents tab's setup wizard: when an agent was FIRST picked in it, and
   *  the agent being set up (the latest pick until the wizard is finished).
   *  Both null = the user's first onboarding. */
  agentWizardChosenAt: integer("agent_wizard_chosen_at", { mode: "timestamp" }),
  agentWizardAgent: text("agent_wizard_agent"),
  /** When the setup wizard first reached its end (Open chat succeeded). */
  agentWizardFinishedAt: integer("agent_wizard_finished_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  description: text("description"),
  npmUrl: text("npm_url"),
  type: text("type").notNull(), // 'stdio' | 'http'
  command: text("command"),
  args: text("args"), // JSON array
  url: text("url"),
  headers: text("headers"), // JSON object
  envVars: text("env_vars"), // JSON object
  requireApproval: integer("require_approval", { mode: "boolean" }).notNull().default(true),
  bundled: integer("bundled", { mode: "boolean" }).notNull().default(false),
  installStatus: text("install_status").notNull().default("pending"), // 'pending' | 'checking' | 'installed' | 'failed' | 'not_required'
  installError: text("install_error"),
  /**
   * Per-binary install status, JSON: [{ binary, installed, source }].
   * Written by DependencyManager; read by the API and UI.
   */
  dependencyStatus: text("dependency_status"),
  /** 'unknown' | 'starting' | 'up' | 'down' — set by ServerProber after each install run. */
  serverStatus: text("server_status").notNull().default("unknown"),
  /** Last stderr capture (truncated to 4 KiB) when serverStatus === 'down'. */
  serverError: text("server_error"),
  /** Unix timestamp of the most recent probe attempt. */
  serverLastChecked: integer("server_last_checked", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * One-shot rescue of the provider API keys libi used to store, so a user
 * upgrading does not lose the key they gave us. Written ONCE by
 * `migrateProviderRows` (lib/db/migrate-providers.ts), read ONCE by the
 * connect panel's notice (lib/providers/legacy.ts), and the values are
 * DELETED the moment the user acknowledges it. Nothing else in the codebase
 * may read this table — libi holds no provider key.
 *
 * The rescue is TEMPORARY, and `rescuedAt` is what makes that true rather
 * than aspirational: a row nobody ever acknowledges is blanked at boot once
 * it passes `LEGACY_KEY_TTL_DAYS` (lib/providers/legacy.ts), and a row whose
 * provider the user has since reconnected is blanked the moment the detector
 * sees it. Without the stamp there was no exit at all — a user who never
 * opened the panel kept a live API key in libi's database forever, which is
 * the exact opposite of what the branch that added this table set out to do.
 */
export const legacyProviderKeys = sqliteTable("legacy_provider_keys", {
  /** The OLD bundled row id: "fal-ai" | "elevenlabs" | "youtube-downloader". */
  providerId: text("provider_id").primaryKey(),
  /** JSON object of the row's env_vars, verbatim. Blanked to `{}` on acknowledge. */
  envVars: text("env_vars").notNull(),
  /** When the migration lifted the key out of `mcp_servers`. Drives the TTL. */
  rescuedAt: integer("rescued_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  shownAt: integer("shown_at", { mode: "timestamp" }),
});

export const skills = sqliteTable(
  "skills",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    source: text("source", { enum: ["bundled", "user"] }).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    body: text("body"),
    frontmatter: text("frontmatter").notNull().default("{}"),
    tags: text("tags").notNull().default("[]"),
    /** sha256 digest of the bundled skill folder at the moment this override
     *  was created. Only set on source="user" rows that shadow a bundled
     *  skill. Null = pre-feature fork (staleness reports "unknown"). */
    forkedFromDigest: text("forked_from_digest"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    nameSourceUnique: uniqueIndex("skills_name_source_unique").on(t.name, t.source),
  }),
);

export const analysisSteps = sqliteTable(
  "analysis_steps",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    pieceId: text("piece_id"),
    /** "transcript" | "summary" | "frames" — kept open-ended for future kinds. */
    kind: text("kind").notNull(),
    /** "not_started" | "ready" | "failed" */
    status: text("status").notNull().default("not_started"),
    /** Transcript text, or stringified JSON for summary. Null when not_started/failed. */
    content: text("content"),
    /** Stringified JSON: { provider?, model?, segments?, durationMs?, ... } or VideoSummary custom. */
    metadata: text("metadata"),
    errorMessage: text("error_message"),
    /** Source video mtime captured when this step was last saved. Used for staleness detection. */
    sourceModifiedAt: integer("source_modified_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    fileKindUnique: uniqueIndex("analysis_steps_file_kind_unique").on(t.fileId, t.kind),
  }),
);

export const analysisKeyframes = sqliteTable(
  "analysis_keyframes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    /** FK to the kind='frames' analysis_steps row for this file. */
    stepId: text("step_id")
      .notNull()
      .references(() => analysisSteps.id, { onDelete: "cascade" }),
    /** Relative to the frames dir, e.g. "frame-0001.png". */
    filePath: text("file_path").notNull(),
    frameIndex: integer("frame_index").notNull(),
    /** Seconds. */
    timestamp: real("timestamp").notNull(),
    /** Stringified FrameDescription JSON. Null when skipped. */
    description: text("description"),
    skipped: integer("skipped", { mode: "boolean" }).notNull().default(false),
    skipReason: text("skip_reason"),
    /** Stringified JSON freeform bag. */
    custom: text("custom"),
    sourceModifiedAt: integer("source_modified_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    fileFrameUnique: uniqueIndex("analysis_keyframes_file_frame_unique").on(t.fileId, t.frameIndex),
    stepIdx: index("analysis_keyframes_step_idx").on(t.stepId),
  }),
);

export const analysisAudioChunks = sqliteTable(
  "analysis_audio_chunks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    /** FK to the kind='transcript' analysis_steps row for this file. */
    stepId: text("step_id")
      .notNull()
      .references(() => analysisSteps.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    /** Source-audio start in seconds. */
    startSeconds: real("start_seconds").notNull(),
    /** Source-audio end in seconds (with overlap into next chunk). */
    endSeconds: real("end_seconds").notNull(),
    /** Relative to analysis dir, e.g. "audio-chunks/chunk-0001.wav". */
    filePath: text("file_path"),
    /** "not_started" | "ready" | "failed" */
    status: text("status").notNull().default("not_started"),
    /** Transcribed text for this chunk. */
    text: text("text"),
    /** JSON: SttWord[] (lib/analysis/types.ts) with timestamps already offset to source audio. */
    words: text("words"),
    language: text("language"),
    languageProbability: real("language_probability"),
    errorMessage: text("error_message"),
    sourceModifiedAt: integer("source_modified_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    fileChunkUnique: uniqueIndex("analysis_audio_chunks_file_chunk_unique").on(t.fileId, t.chunkIndex),
    stepIdx: index("analysis_audio_chunks_step_idx").on(t.stepId),
  }),
);

export const characters = sqliteTable(
  "characters",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description").notNull().default(""),
    representativeImageFileId: text("representative_image_file_id").references(() => files.id, { onDelete: "set null" }),
    nameSetByUser: integer("name_set_by_user", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
);

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description").notNull().default(""),
    representativeImageFileId: text("representative_image_file_id").references(() => files.id, { onDelete: "set null" }),
    nameSetByUser: integer("name_set_by_user", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
);

export const characterAssets = sqliteTable(
  "character_assets",
  {
    characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.characterId, t.fileId] }),
    fileIdx: index("character_assets_file_idx").on(t.fileId),
  }),
);

export const itemAssets = sqliteTable(
  "item_assets",
  {
    itemId: text("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.itemId, t.fileId] }),
    fileIdx: index("item_assets_file_idx").on(t.fileId),
  }),
);

export const tracks = sqliteTable("tracks", {
  id: text("id").primaryKey(),
  fileId: text("file_id")
    .notNull()
    .references(() => files.id, { onDelete: "cascade" }),
  subjectId: text("subject_id"),
  label: text("label"),
  method: text("method").notNull(), // TrackMethod
  framerate: real("framerate").notNull(),
  durationSec: real("duration_sec").notNull(),
  sampleCount: integer("sample_count").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});


export const modelSchemas = sqliteTable("model_schemas", {
  id: text("id").primaryKey(),
  apiUrl: text("api_url").notNull(),
  model: text("model").notNull(),
  schemaJson: text("schema_json").notNull(),
  source: text("source"),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  keyIdx: uniqueIndex("model_schemas_key_idx").on(table.apiUrl, table.model),
}));

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  clientKey: text("client_key").notNull().default(""),
  pieceId: text("piece_id").references(() => pieces.id, { onDelete: "cascade" }),
  fileId: text("file_id").references(() => files.id, { onDelete: "cascade" }),
  status: text("status").notNull().$type<
    "queued" | "running" | "completed" | "failed" | "cancelled" | "cancel-requested"
  >(),
  paramsHash: text("params_hash").notNull(),
  paramsJson: text("params_json").notNull(),
  progressDone: integer("progress_done").notNull().default(0),
  progressTotal: integer("progress_total").notNull().default(0),
  progressUnit: text("progress_unit").notNull().default("items"),
  msPerUnit: real("ms_per_unit"),
  partialPath: text("partial_path"),
  resultJson: text("result_json"),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  lastProgressAt: integer("last_progress_at", { mode: "timestamp_ms" }),
}, (table) => ({
  kindParamsIdx: index("jobs_kind_params_idx").on(table.kind, table.paramsHash),
  clientKeyIdx: index("jobs_client_key_idx").on(table.clientKey),
  statusIdx: index("jobs_status_idx").on(table.status),
  pieceIdx: index("jobs_piece_idx").on(table.pieceId),
  fileIdx: index("jobs_file_idx").on(table.fileId),
}));

/** Analytics events waiting to reach GA4.
 *
 *  Durable on purpose. libi's "server" is a process on the user's own machine
 *  that stops when they quit the app, and the most valuable events in the
 *  funnel are fired by people who are about to do exactly that — someone who
 *  gives up during agent setup quits DURING the step we most need to see. A
 *  fire-and-forget fetch loses precisely the events that matter most. */
export const analyticsQueue = sqliteTable("analytics_queue", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  paramsJson: text("params_json").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  dueIdx: index("analytics_queue_due_idx").on(table.nextAttemptAt),
}));

/** Site announcements this install has already displayed (see
 *  lib/announcements/). Install-local presentation state — no FK to anything.
 *  Rows are pruned after 30 days by markSeen(); announcements themselves
 *  expire at 3 days, so the table stays a handful of rows. */
export const seenAnnouncements = sqliteTable("seen_announcements", {
  /** Firestore document id from the site's announcements endpoint. */
  announcementId: text("announcement_id").primaryKey(),
  seenAt: integer("seen_at", { mode: "timestamp" }).notNull(),
});

/**
 * Every place libi installed its skills for the user's OWN Claude Code / Codex,
 * so each copy is rewritten after every skill change and at every boot.
 * `folder_path` is `''` for a user-level ("every folder") install — SQLite
 * treats NULLs as distinct, so a plain unique index needs a real value there.
 * The user-level skills dir itself is never stored: the agent descriptor
 * (`lib/agents/skill-targets.ts`) resolves it at write time. Not piece-scoped.
 */
export const skillInstalls = sqliteTable(
  "skill_installs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id", { enum: ["claude-code", "codex"] }).notNull(),
    scope: text("scope", { enum: ["user", "folder"] }).notNull(),
    /** realpath of the chosen folder; `''` for `scope = "user"`. */
    folderPath: text("folder_path").notNull().default(""),
    source: text("source", { enum: ["ui", "cli"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    /** Set after every successful write. */
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
    /** Short, user-readable; cleared on the next successful write. */
    lastError: text("last_error"),
    /** JSON array of skill names skipped because a dir of that name was not libi's. */
    skippedNames: text("skipped_names").notNull().default("[]"),
    /**
     * The skills root libi last wrote for this row — the one place its copy may live.
     * A user-level root is resolved from the environment at write time, so when it moves
     * the copy at this root is removed before the new root is written. NULL until the first write.
     */
    lastRoot: text("last_root"),
  },
  (t) => ({
    levelUnique: uniqueIndex("skill_installs_level_unique").on(t.agentId, t.scope, t.folderPath),
  }),
);

/**
 * The ONE relation libi cannot derive on demand: which provider post came from
 * which piece. Zernio stores `metadata.libi.pieceId` on the post but cannot
 * filter by it, so this table is the index and the stamp is what rebuilds it
 * ("Re-index from provider"). `last_status` is a display cache for the
 * Posting tab's offline/empty states; the provider is the truth. Piece DELETE
 * cascades here — the post at the provider is NOT deleted (the confirm says so).
 */
export const socialPostLinks = sqliteTable(
  "social_post_links",
  {
    providerId: text("provider_id").notNull(),
    providerPostId: text("provider_post_id").notNull(),
    pieceId: text("piece_id")
      .notNull()
      .references(() => pieces.id, { onDelete: "cascade" }),
    exportPath: text("export_path"),
    /** The x-request-id the post was created with; reused on retry. */
    requestId: text("request_id"),
    createdBy: text("created_by", { enum: ["agent", "ui"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    lastStatus: text("last_status"),
    lastStatusAt: integer("last_status_at", { mode: "timestamp" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.providerId, t.providerPostId] }),
    pieceIdx: index("idx_social_post_links_piece").on(t.pieceId),
  }),
);

/**
 * A piece <-> AD link, for an ad that was never an organic post.
 *
 * The other kind of ad needs no table at all: when an ad boosts a post, the
 * provider itself knows (`effectiveInstagramMediaId` matches that post's
 * target `platformPostId`), so it is discovered on every read and stored
 * nowhere. This table exists only for the case the provider cannot answer —
 * a piece published straight to an ad account as a "dark post", which has no
 * organic post to match against and so no trace back to the piece.
 *
 * Same shape and same reasoning as `social_post_links`: libi stores the LINK,
 * never the ad. Spend, status and creative all stay on the provider.
 */
export const socialAdLinks = sqliteTable(
  "social_ad_links",
  {
    providerId: text("provider_id").notNull(),
    /** The PROVIDER'S ad id (Zernio's `_id`), which is what its lists key on. */
    providerAdId: text("provider_ad_id").notNull(),
    /** The ad NETWORK'S id (Meta's ad id) when the creator knew it — the value
     *  `ad_campaigns_list_ads` takes as `platform_ad_id`. */
    platformAdId: text("platform_ad_id"),
    pieceId: text("piece_id")
      .notNull()
      .references(() => pieces.id, { onDelete: "cascade" }),
    createdBy: text("created_by", { enum: ["agent", "ui"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.providerId, t.providerAdId] }),
    pieceIdx: index("idx_social_ad_links_piece").on(t.pieceId),
  }),
);

/**
 * The write-ahead half of the dedupe contract: one row per logical post
 * ATTEMPT, written before the provider is asked to create anything.
 *
 * It exists because `social_post_links` is keyed `(provider_id,
 * provider_post_id)` — there is nothing to write there until an id comes
 * back, which is exactly the window a crashed or timed-out create falls into.
 * Zernio's MCP tools expose no idempotency header
 * (`.superpowers/sdd/zernio-live-shapes.md`), so this row plus the
 * `metadata.libi.requestId` stamp is the whole guard: a retry finds the row,
 * and either reuses the id on it or scans recent posts for its own
 * `requestId` before creating again.
 *
 * `piece_id` is nullable so a post that belongs to no piece can still be
 * guarded; when it is set, the FK cascade deletes the row with its piece,
 * same as `social_post_links`.
 */
export const socialPostIntents = sqliteTable(
  "social_post_intents",
  {
    providerId: text("provider_id").notNull(),
    /** The idempotency key, reused across every retry of this logical post. */
    requestId: text("request_id").notNull(),
    pieceId: text("piece_id").references(() => pieces.id, { onDelete: "cascade" }),
    /** Null until libi LEARNS the id — the uncovered window itself. */
    providerPostId: text("provider_post_id"),
    mode: text("mode", { enum: ["draft", "schedule", "now"] }).notNull(),
    /** `pending` = sent, outcome unknown · `linked` = id known · `unknown` = the attempt failed with the outcome unestablished. */
    state: text("state", { enum: ["pending", "linked", "unknown"] }).notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.providerId, t.requestId] }),
    pieceIdx: index("idx_social_post_intents_piece").on(t.pieceId),
  }),
);

/**
 * A reusable video concept captured from a piece: instructions + overlays +
 * clips + media, stored under `<LIBI_HOME>/templates/<id>/` (the folder is
 * written only by lib/templates/store.ts). `origin: "installed"` and
 * `cloudId` are reserved for the public catalog (sub-project 3); a local
 * template keeps `cloudId` null until it is published.
 */
export const templates = sqliteTable(
  "templates",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** JSON string[] — lowercased, ≤ 10, each `^[a-z0-9][a-z0-9-]{0,29}$`. */
    tags: text("tags").notNull().default("[]"),
    origin: text("origin", { enum: ["local", "installed"] }).notNull().default("local"),
    cloudId: text("cloud_id"),
    /** A publish the catalog prepared that libi has not yet seen land: JSON,
     *  `PublishPending` in lib/templates/store.ts. It names the cloud id, so a
     *  retry finishes THAT publish instead of minting a second one. Cleared
     *  when the commit lands. */
    publishPending: text("publish_pending"),
    /** Which catalog `cloudId` and `publishPending` belong to — `catalogSource()`
     *  when they were written: "test-mode" (the fixture) or a site origin. A row
     *  linked to another catalog than this process reads is not linked here
     *  (lib/templates/cloud/catalog-source.ts). Null only with no link. */
    cloudSource: text("cloud_source"),
    /** Bumps on every update_template / re-extract. */
    version: integer("version").notNull().default(1),
    /** Lineage only — nulled when the source piece goes. */
    createdFromPieceId: text("created_from_piece_id").references(() => pieces.id, {
      onDelete: "set null",
    }),
    /** Any code/three body present (gates publish until sub-project 1 lands). */
    hasCode: integer("has_code", { mode: "boolean" }).notNull().default(false),
    /** Denormalised from template_uses. */
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    originUpdatedIdx: index("idx_templates_origin_updated").on(t.origin, t.updatedAt),
    /** One row per catalog template: a second install of the same cloud id
     *  (another process racing this one) fails its insert and uses the row
     *  that won (lib/templates/cloud/install.ts). */
    cloudIdUnique: uniqueIndex("templates_cloud_id_unique").on(t.cloudId).where(sql`${t.cloudId} IS NOT NULL`),
  }),
);

/** One row per apply. `reported` is whether the use reached the catalog
 *  (sub-project 3); a local-only template's rows stay `false` forever. */
export const templateUses = sqliteTable(
  "template_uses",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    templateId: text("template_id")
      .notNull()
      .references(() => templates.id, { onDelete: "cascade" }),
    pieceId: text("piece_id").references(() => pieces.id, { onDelete: "set null" }),
    usedAt: integer("used_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    reported: integer("reported", { mode: "boolean" }).notNull().default(false),
    /** The use reporter's (lib/templates/cloud/use-reporter.ts) failed tries
     *  for this row's template, kept on every unreported row of it. */
    reportAttempts: integer("report_attempts").notNull().default(0),
    /** Not before this may the reporter send this row: a backoff after a
     *  failure, or a claim while one process sends it — so two libi servers
     *  on one LIBI_HOME never send the same use. Null: due now. */
    reportNextAt: integer("report_next_at", { mode: "timestamp_ms" }),
    /** The catalog this process read when the use happened (`catalogSource()`):
     *  a use is only ever reported to that catalog. */
    source: text("source"),
  },
  (t) => ({
    templateUsedIdx: index("idx_template_uses_template_used").on(t.templateId, t.usedAt),
  }),
);

/**
 * A publish an agent PREPARED and only the user can make: `libi.publish_template`
 * records one after its local preflight, and the Templates page's review panel
 * publishes it (`POST /api/templates/cloud/publish-requests/:id/confirm`) or
 * discards it (lib/templates/cloud/publish-requests.ts). One per template; the
 * template's delete cascades to it.
 */
export const templatePublishRequests = sqliteTable(
  "template_publish_requests",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    templateId: text("template_id")
      .notNull()
      .references(() => templates.id, { onDelete: "cascade" }),
    /** The catalog this process read when the request was made (`catalogSource()`):
     *  test mode and a normal boot share LIBI_HOME, and a request prepared against
     *  the fixture must never be confirmed against the real catalog. */
    source: text("source").notNull(),
    /** JSON `{ fileId } | { path } | { exportPieceId }` — the example's source. */
    exampleVideo: text("example_video").notNull(),
    /** A nickname the agent passed with the request; applied only on confirm. */
    nickname: text("nickname"),
    /** sha256 of what the review showed (lib/templates/cloud/publish-content.ts#contentFingerprint):
     *  confirm refuses, and the job itself refuses, when the template changed since. */
    fingerprint: text("fingerprint").notNull(),
    /** Single-use proof the confirm came from the review panel: returned only by
     *  the page's read route to a browser request, rotated on every confirm. */
    confirmCode: text("confirm_code").notNull(),
    /** `awaiting` the user; `publishing` since a confirm started `jobId`; `failed`
     *  when that job did not publish (the panel offers a fresh confirm). */
    status: text("status", { enum: ["awaiting", "publishing", "failed"] }).notNull().default("awaiting"),
    jobId: text("job_id"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    templateUnique: uniqueIndex("template_publish_requests_template_unique").on(t.templateId),
  }),
);

/** The public catalog's index, cached locally (lib/templates/cloud/catalog-cache.ts).
 *  Replaced wholesale on every successful fetch; mirrored into templates_fts
 *  with scope "public" so one search serves local and public rows. Every text
 *  column is a STRANGER's words (validated by the cloud client, not trusted). */
export const catalogIndex = sqliteTable(
  "catalog_index",
  {
    cloudId: text("cloud_id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    tagsJson: text("tags_json").notNull().default("[]"),
    nickname: text("nickname").notNull().default(""),
    authorId: text("author_id").notNull().default(""),
    version: integer("version").notNull().default(1),
    hasCode: integer("has_code", { mode: "boolean" }).notNull().default(false),
    canvasWidth: integer("canvas_width").notNull(),
    canvasHeight: integer("canvas_height").notNull(),
    duration: real("duration").notNull().default(0),
    slotCount: integer("slot_count").notNull().default(0),
    /** Relative to the bucket base — resolved on read, never stored absolute. */
    poster: text("poster").notNull(),
    video: text("video").notNull(),
    usesTotal: integer("uses_total").notNull().default(0),
    uses7d: integer("uses_7d").notNull().default(0),
    heat: real("heat").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    trendingIdx: index("idx_catalog_index_uses7d").on(t.uses7d),
  }),
);

/** One row (id 1): the cached index's ETag, when it was last confirmed fresh,
 *  and which catalog it came from (`catalogSource()`: the test-mode
 *  fixture, or the site's origin). A copy from another source is never served. */
export const catalogIndexMeta = sqliteTable("catalog_index_meta", {
  id: integer("id").primaryKey().default(1),
  etag: text("etag"),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }),
  source: text("source"),
});
