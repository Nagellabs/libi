import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import {
  pieces,
  files,
  settings,
  mcpServers,
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
} from "@/lib/db/schema/sqlite";

const schema = { pieces, files, settings, mcpServers, skills, analysisSteps, analysisKeyframes, analysisAudioChunks, characters, items, characterAssets, itemAssets, tracks, jobs, assetFolders, folders, modelSchemas, seenAnnouncements };

declare global {
  // eslint-disable-next-line no-var
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
      fal_uploaded_url TEXT,
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
      skill_digest_cache TEXT,
      analytics TEXT,
      crash_reports TEXT,
      onboarding_persona TEXT,
      persona_selected_at INTEGER,
      agent_ever_connected INTEGER NOT NULL DEFAULT 0,
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
      enabled INTEGER NOT NULL DEFAULT 1,
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
  `);

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
