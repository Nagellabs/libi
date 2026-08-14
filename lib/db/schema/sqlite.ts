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
    // NULL = file at the root of its scope. References asset_folders; FK action
    // is enforced only with PRAGMA foreign_keys=ON (tests) — prod runs FK-off.
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
    /** fal.ai storage URL for the uploaded video, persisted to avoid re-uploading across restarts. */
    falUploadedUrl: text("fal_uploaded_url"),
    notes: text("notes"),
    /**
     * AI-generation provenance for files produced by an MCP generation tool
     * (fal-ai, elevenlabs, local-tts, local-music, etc.). In test mode
     * fake-fal masquerades as fal-ai, so test-mode files also use "fal-ai".
     * JSON-serialized `AiGenerationMeta`:
     *   {
     *     provider: "fal-ai" | "elevenlabs" | "local-tts" | "local-music" | "...",
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
  /** JSON-serialized CodexConnectSetting ({connected, lastSyncStatus}, see lib/db/settings.ts).
   *  Null = use defaults ({connected:false, lastSyncStatus:"idle"}). */
  codex: text("codex"),
  /** JSON-serialized ExportDefaultsSetting (folder, format, quality). Null = use OS-aware defaults. */
  exportDefaults: text("export_defaults"),
  /** JSON {version, digests: {skillName: sha256}} — per-app-version cache of
   *  bundled skill content digests. Recomputed once per version change. */
  skillDigestCache: text("skill_digest_cache"),
  /** JSON-serialized AnalyticsSettings (see lib/db/settings.ts). Null = defaults
   *  (analytics enabled, no userId yet). GA4 product-analytics system. */
  analytics: text("analytics"),
  /** JSON-serialized CrashReportSettings (see lib/db/settings.ts). Null = defaults
   *  (choice "unset", which behaves as enabled — see that file). */
  crashReports: text("crash_reports"),
  onboardingPersona: text("onboarding_persona"),
  personaSelectedAt: integer("persona_selected_at", { mode: "timestamp" }),
  agentEverConnected: integer("agent_ever_connected", { mode: "boolean" })
    .notNull()
    .default(false),
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
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
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
    /** JSON: ElevenLabsWord[] with timestamps already offset to source audio. */
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

/** Site announcements this install has already displayed (see
 *  lib/announcements/). Install-local presentation state — no FK to anything.
 *  Rows are pruned after 30 days by markSeen(); announcements themselves
 *  expire at 3 days, so the table stays a handful of rows. */
export const seenAnnouncements = sqliteTable("seen_announcements", {
  /** Firestore document id from the site's announcements endpoint. */
  announcementId: text("announcement_id").primaryKey(),
  seenAt: integer("seen_at", { mode: "timestamp" }).notNull(),
});

