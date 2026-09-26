import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import {
  pieces,
  files,
  settings,
  mcpServers,
  legacyProviderKeys,
  skills,
  analysisSteps,
  analysisKeyframes,
  analysisAudioChunks,
  characters,
  items,
  characterAssets,
  itemAssets,
  tracks,
  jobs,
  assetFolders,
  folders,
  modelSchemas,
  seenAnnouncements,
  analyticsQueue,
  skillInstalls,
  socialPostLinks,
  socialAdLinks,
  socialPostIntents,
  templates,
  templateUses,
  templatePublishRequests,
  catalogIndex,
  catalogIndexMeta,
} from "@/lib/db/schema/sqlite";
import { TEMPLATES_FTS_STATEMENTS } from "@/lib/db/templates-fts";

const schema = { pieces, files, settings, mcpServers, legacyProviderKeys, skills, analysisSteps, analysisKeyframes, analysisAudioChunks, characters, items, characterAssets, itemAssets, tracks, jobs, assetFolders, folders, modelSchemas, seenAnnouncements, analyticsQueue, skillInstalls, socialPostLinks, socialPostIntents, socialAdLinks, templates, templateUses, templatePublishRequests, catalogIndex, catalogIndexMeta };

declare global {
  var __libi_test_db: BetterSQLite3Database<typeof schema> | undefined;
}

/**
 * Creates an in-memory DB, seeds the schema, and installs it as the
 * global singleton consumed by production's `getDb()`. Tests using HTTP
 * route handlers MUST call this once per test in `beforeEach` — the
 * route handler then sees the same DB the test seeded.
 *
 * Call `resetTestDb()` in `afterEach` to clear the global (otherwise
 * stale state leaks into the next test).
 */
export function createTestDb(): BetterSQLite3Database<typeof schema> {
  const sqlite = new Database(":memory:");

  // SQLite enforces FK cascades only when this pragma is on. Production
  // does not currently set it; tests opt in so cascade behaviour is exercised.
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX idx_folders_parent ON folders(parent_folder_id);
    CREATE TABLE pieces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      name_set_by_user INTEGER NOT NULL DEFAULT 0,
      has_draft INTEGER NOT NULL DEFAULT 0,
      snapshot_summary TEXT,
      snapshot_committed_at INTEGER,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_opened_at INTEGER
    );
    CREATE TABLE asset_folders (
      id TEXT PRIMARY KEY,
      piece_id TEXT REFERENCES pieces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      parent_folder_id TEXT REFERENCES asset_folders(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX idx_asset_folders_piece ON asset_folders(piece_id);
    CREATE INDEX idx_asset_folders_parent ON asset_folders(parent_folder_id);
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      piece_id TEXT REFERENCES pieces(id) ON DELETE CASCADE,
      folder_id TEXT REFERENCES asset_folders(id) ON DELETE SET NULL,
      filename TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      type TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      content_type TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      media_duration REAL,
      media_width INTEGER,
      media_height INTEGER,
      has_audio INTEGER,
      has_alpha INTEGER,
      proxy_filename TEXT,
      proxy_status TEXT NOT NULL DEFAULT 'idle',
      proxy_generated_at INTEGER,
      proxy_height INTEGER,
      filmstrip_filename TEXT,
      filmstrip_status TEXT NOT NULL DEFAULT 'idle',
      filmstrip_generated_at INTEGER,
      filmstrip_frames INTEGER,
      filmstrip_height INTEGER,
      notes TEXT,
      ai_generation TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX idx_files_folder_id ON files(folder_id);
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      preferred_agent TEXT,
      panel_chat_size REAL NOT NULL DEFAULT 40,
      panel_editor_size REAL NOT NULL DEFAULT 40,
      panel_resources_size REAL NOT NULL DEFAULT 20,
      panel_chat_visible INTEGER NOT NULL DEFAULT 1,
      panel_resources_visible INTEGER NOT NULL DEFAULT 0,
      agent_approval_modes TEXT,
      agent_model_preferences TEXT,
      notifications TEXT,
      codex TEXT,
      export_defaults TEXT,
      piece_defaults TEXT,
      skill_digest_cache TEXT,
      analytics TEXT,
      crash_reports TEXT,
      social TEXT,
      templates_author TEXT,
      templates_catalog TEXT,
      legacy_scenes_noticed TEXT,
      onboarding_persona TEXT,
      persona_selected_at INTEGER,
      agent_ever_connected INTEGER NOT NULL DEFAULT 0,
      onboarding_demo_offered_at INTEGER,
      onboarding_demo_dismissed_at INTEGER,
      claude_sign_in_confirmed_at INTEGER,
      codex_sign_in_confirmed_at INTEGER,
      agent_wizard_chosen_at INTEGER,
      agent_wizard_agent TEXT,
      agent_wizard_finished_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      npm_url TEXT,
      type TEXT NOT NULL,
      command TEXT,
      args TEXT,
      url TEXT,
      headers TEXT,
      env_vars TEXT,
      require_approval INTEGER NOT NULL DEFAULT 1,
      bundled INTEGER NOT NULL DEFAULT 0,
      install_status TEXT NOT NULL DEFAULT 'pending',
      install_error TEXT,
      dependency_status TEXT,
      server_status TEXT NOT NULL DEFAULT 'unknown',
      server_error TEXT,
      server_last_checked INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE legacy_provider_keys (
      provider_id TEXT PRIMARY KEY,
      env_vars TEXT NOT NULL,
      shown_at INTEGER,
      rescued_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      source TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      body TEXT,
      frontmatter TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      forked_from_digest TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX skills_name_source_unique ON skills(name, source);
    CREATE TABLE analysis_steps (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      piece_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'not_started',
      content TEXT,
      metadata TEXT,
      error_message TEXT,
      source_modified_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX analysis_steps_file_kind_unique ON analysis_steps(file_id, kind);
    CREATE TABLE analysis_keyframes (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL REFERENCES analysis_steps(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      frame_index INTEGER NOT NULL,
      timestamp REAL NOT NULL,
      description TEXT,
      skipped INTEGER NOT NULL DEFAULT 0,
      skip_reason TEXT,
      custom TEXT,
      source_modified_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX analysis_keyframes_file_frame_unique ON analysis_keyframes(file_id, frame_index);
    CREATE INDEX analysis_keyframes_step_idx ON analysis_keyframes(step_id);
    CREATE TABLE analysis_audio_chunks (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL REFERENCES analysis_steps(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      start_seconds REAL NOT NULL,
      end_seconds REAL NOT NULL,
      file_path TEXT,
      status TEXT NOT NULL DEFAULT 'not_started',
      text TEXT,
      words TEXT,
      language TEXT,
      language_probability REAL,
      error_message TEXT,
      source_modified_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX analysis_audio_chunks_file_chunk_unique ON analysis_audio_chunks(file_id, chunk_index);
    CREATE INDEX analysis_audio_chunks_step_idx ON analysis_audio_chunks(step_id);
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      representative_image_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
      name_set_by_user INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      representative_image_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
      name_set_by_user INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE character_assets (
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (character_id, file_id)
    );
    CREATE INDEX character_assets_file_idx ON character_assets(file_id);
    CREATE TABLE item_assets (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (item_id, file_id)
    );
    CREATE INDEX item_assets_file_idx ON item_assets(file_id);
    CREATE TABLE tracks (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      subject_id TEXT,
      label TEXT,
      method TEXT NOT NULL,
      framerate REAL NOT NULL,
      duration_sec REAL NOT NULL,
      sample_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      client_key TEXT NOT NULL DEFAULT '',
      piece_id TEXT REFERENCES pieces(id) ON DELETE CASCADE,
      file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      params_json TEXT NOT NULL,
      progress_done INTEGER NOT NULL DEFAULT 0,
      progress_total INTEGER NOT NULL DEFAULT 0,
      progress_unit TEXT NOT NULL DEFAULT 'items',
      ms_per_unit REAL,
      partial_path TEXT,
      result_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      last_progress_at INTEGER
    );
    CREATE INDEX jobs_kind_params_idx ON jobs(kind, params_hash);
    CREATE INDEX jobs_client_key_idx ON jobs(client_key);
    CREATE INDEX jobs_status_idx ON jobs(status);
    CREATE INDEX jobs_piece_idx ON jobs(piece_id);
    CREATE INDEX jobs_file_idx ON jobs(file_id);
    CREATE TABLE model_schemas (
      id TEXT PRIMARY KEY,
      api_url TEXT NOT NULL,
      model TEXT NOT NULL,
      schema_json TEXT NOT NULL,
      source TEXT,
      fetched_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX model_schemas_key_idx ON model_schemas(api_url, model);
    CREATE TABLE seen_announcements (
      announcement_id TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL
    );
    CREATE TABLE analytics_queue (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      params_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL
    );
    CREATE INDEX analytics_queue_due_idx ON analytics_queue(next_attempt_at);
    CREATE TABLE skill_installs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      folder_path TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_synced_at INTEGER,
      last_error TEXT,
      skipped_names TEXT NOT NULL DEFAULT '[]',
      last_root TEXT
    );
    CREATE UNIQUE INDEX skill_installs_level_unique ON skill_installs(agent_id, scope, folder_path);
    CREATE TABLE social_post_links (
      provider_id TEXT NOT NULL,
      provider_post_id TEXT NOT NULL,
      piece_id TEXT NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
      export_path TEXT,
      request_id TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_status TEXT,
      last_status_at INTEGER,
      PRIMARY KEY (provider_id, provider_post_id)
    );
    CREATE INDEX idx_social_post_links_piece ON social_post_links(piece_id);
    CREATE TABLE social_post_intents (
      provider_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      piece_id TEXT REFERENCES pieces(id) ON DELETE CASCADE,
      provider_post_id TEXT,
      mode TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER,
      PRIMARY KEY (provider_id, request_id)
    );
    CREATE INDEX idx_social_post_intents_piece ON social_post_intents(piece_id);
    CREATE TABLE social_ad_links (
      provider_id TEXT NOT NULL,
      provider_ad_id TEXT NOT NULL,
      platform_ad_id TEXT,
      piece_id TEXT NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (provider_id, provider_ad_id)
    );
    CREATE INDEX idx_social_ad_links_piece ON social_ad_links(piece_id);
    CREATE TABLE templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      origin TEXT NOT NULL DEFAULT 'local',
      cloud_id TEXT,
      publish_pending TEXT,
      cloud_source TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_from_piece_id TEXT REFERENCES pieces(id) ON DELETE SET NULL,
      has_code INTEGER NOT NULL DEFAULT 0,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX idx_templates_origin_updated ON templates(origin, updated_at);
    CREATE UNIQUE INDEX templates_cloud_id_unique ON templates(cloud_id) WHERE cloud_id IS NOT NULL;
    CREATE TABLE template_uses (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      piece_id TEXT REFERENCES pieces(id) ON DELETE SET NULL,
      used_at INTEGER NOT NULL DEFAULT (unixepoch()),
      reported INTEGER NOT NULL DEFAULT 0,
      report_attempts INTEGER NOT NULL DEFAULT 0,
      report_next_at INTEGER,
      source TEXT
    );
    CREATE INDEX idx_template_uses_template_used ON template_uses(template_id, used_at);
    CREATE TABLE template_publish_requests (
      id TEXT PRIMARY KEY NOT NULL,
      template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      example_video TEXT NOT NULL,
      nickname TEXT,
      fingerprint TEXT NOT NULL,
      confirm_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting',
      job_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX template_publish_requests_template_unique ON template_publish_requests(template_id);
    CREATE TABLE catalog_index (
      cloud_id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      nickname TEXT NOT NULL DEFAULT '',
      author_id TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      has_code INTEGER NOT NULL DEFAULT 0,
      canvas_width INTEGER NOT NULL,
      canvas_height INTEGER NOT NULL,
      duration REAL NOT NULL DEFAULT 0,
      slot_count INTEGER NOT NULL DEFAULT 0,
      poster TEXT NOT NULL,
      video TEXT NOT NULL,
      uses_total INTEGER NOT NULL DEFAULT 0,
      uses_7d INTEGER NOT NULL DEFAULT 0,
      heat REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE INDEX idx_catalog_index_uses7d ON catalog_index(uses_7d);
    CREATE TABLE catalog_index_meta (
      id INTEGER PRIMARY KEY NOT NULL DEFAULT 1,
      etag TEXT,
      fetched_at INTEGER,
      source TEXT
    );
  `);

  for (const statement of TEMPLATES_FTS_STATEMENTS) sqlite.exec(statement);

  const db = drizzle(sqlite, { schema });
  globalThis.__libi_test_db = db;
  return db;
}

export function resetTestDb(): void {
  globalThis.__libi_test_db = undefined;
}

export function seedPiece(db: BetterSQLite3Database<typeof schema>, overrides: Partial<{ id: string; name: string; nameSetByUser: boolean }> = {}) {
  const id = overrides.id ?? "test-piece-1";
  const name = overrides.name ?? "Test Piece";
  db.insert(pieces).values({
    id,
    name,
    nameSetByUser: overrides.nameSetByUser ?? false,
  }).run();
  return id;
}
