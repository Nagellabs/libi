-- A libi database exactly as it existed BEFORE migration 0051 (the providers
-- migration). NOT hand-reconstructed from the drizzle history: the DDL below is
-- the verbatim `.schema` of a real worktree DB at migration 0050
-- (`~/.libi/worktrees/mcp-http/libi.sqlite`, copied read-only on 2026-09-09),
-- so the migration test runs against the schema real users carry. The
-- `__drizzle_migrations` row marks 0050 as applied so `migrate()` runs only
-- what comes after it. The five `mcp_servers` rows model an upgrading user:
-- a fal-ai row WITH a stored key, the two other bundled third-party rows, one
-- user-added custom row, and the core libi row.
CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at numeric
			);
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`npm_url` text,
	`type` text NOT NULL,
	`command` text,
	`args` text,
	`url` text,
	`headers` text,
	`env_vars` text,
	`enabled` integer DEFAULT true NOT NULL,
	`require_approval` integer DEFAULT true NOT NULL,
	`bundled` integer DEFAULT false NOT NULL,
	`install_status` text DEFAULT 'pending' NOT NULL,
	`install_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
, `dependency_status` text, `server_status` text DEFAULT 'unknown' NOT NULL, `server_error` text, `server_last_checked` integer);
CREATE TABLE `pieces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`name_set_by_user` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
, `has_draft` integer DEFAULT false NOT NULL, `snapshot_summary` text, `snapshot_committed_at` integer, `folder_id` text REFERENCES folders(id), `last_opened_at` integer);
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`preferred_agent` text,
	`panel_chat_size` real DEFAULT 40 NOT NULL,
	`panel_editor_size` real DEFAULT 40 NOT NULL,
	`panel_resources_size` real DEFAULT 20 NOT NULL,
	`panel_chat_visible` integer DEFAULT true NOT NULL,
	`panel_resources_visible` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
, `agent_approval_modes` text, `notifications` text, `export_defaults` text, `agent_model_preferences` text, `skill_digest_cache` text, `analytics` text, `onboarding_persona` text, `persona_selected_at` integer, `agent_ever_connected` integer DEFAULT false NOT NULL, `codex` text, `crash_reports` text, `onboarding_demo_offered_at` integer, `onboarding_demo_dismissed_at` integer, `piece_defaults` text);
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`source` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`body` text,
	`frontmatter` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
, `tags` text DEFAULT '[]' NOT NULL, `forked_from_digest` text);
CREATE UNIQUE INDEX `skills_name_source_unique` ON `skills` (`name`,`source`);
CREATE TABLE `character_assets` (
	`character_id` text NOT NULL,
	`file_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`character_id`, `file_id`),
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `character_assets_file_idx` ON `character_assets` (`file_id`);
CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`representative_image_file_id` text,
	`name_set_by_user` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`representative_image_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE UNIQUE INDEX `characters_name_unique` ON `characters` (`name`);
CREATE TABLE `item_assets` (
	`item_id` text NOT NULL,
	`file_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`item_id`, `file_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `item_assets_file_idx` ON `item_assets` (`file_id`);
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`representative_image_file_id` text,
	`name_set_by_user` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`representative_image_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE UNIQUE INDEX `items_name_unique` ON `items` (`name`);
CREATE TABLE `analysis_keyframes` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`step_id` text NOT NULL,
	`file_path` text NOT NULL,
	`frame_index` integer NOT NULL,
	`timestamp` real NOT NULL,
	`description` text,
	`skipped` integer DEFAULT false NOT NULL,
	`skip_reason` text,
	`custom` text,
	`source_modified_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `analysis_steps`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `analysis_keyframes_file_frame_unique` ON `analysis_keyframes` (`file_id`,`frame_index`);
CREATE INDEX `analysis_keyframes_step_idx` ON `analysis_keyframes` (`step_id`);
CREATE TABLE `analysis_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`piece_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
	`content` text,
	`metadata` text,
	`error_message` text,
	`source_modified_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `analysis_steps_file_kind_unique` ON `analysis_steps` (`file_id`,`kind`);
CREATE TABLE `analysis_audio_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`step_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`start_seconds` real NOT NULL,
	`end_seconds` real NOT NULL,
	`file_path` text,
	`status` text DEFAULT 'not_started' NOT NULL,
	`text` text,
	`words` text,
	`language` text,
	`language_probability` real,
	`error_message` text,
	`source_modified_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `analysis_steps`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `analysis_audio_chunks_file_chunk_unique` ON `analysis_audio_chunks` (`file_id`,`chunk_index`);
CREATE INDEX `analysis_audio_chunks_step_idx` ON `analysis_audio_chunks` (`step_id`);
CREATE TABLE IF NOT EXISTS "tracks" (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`subject_id` text,
	`label` text,
	`method` text NOT NULL,
	`framerate` real NOT NULL,
	`duration_sec` real NOT NULL,
	`sample_count` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS "jobs" (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`piece_id` text,
	`file_id` text,
	`status` text NOT NULL,
	`params_hash` text NOT NULL,
	`params_json` text NOT NULL,
	`progress_done` integer DEFAULT 0 NOT NULL,
	`progress_total` integer DEFAULT 0 NOT NULL,
	`progress_unit` text DEFAULT 'items' NOT NULL,
	`ms_per_unit` real,
	`partial_path` text,
	`result_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`last_progress_at` integer, `client_key` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `jobs_kind_params_idx` ON `jobs` (`kind`,`params_hash`);
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);
CREATE INDEX `jobs_piece_idx` ON `jobs` (`piece_id`);
CREATE INDEX `jobs_file_idx` ON `jobs` (`file_id`);
CREATE INDEX `jobs_client_key_idx` ON `jobs` (`client_key`);
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_folder_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`parent_folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE INDEX `idx_folders_parent` ON `folders` (`parent_folder_id`);
CREATE TABLE `asset_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`piece_id` text,
	`name` text NOT NULL,
	`parent_folder_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_folder_id`) REFERENCES `asset_folders`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE INDEX `idx_asset_folders_piece` ON `asset_folders` (`piece_id`);
CREATE INDEX `idx_asset_folders_parent` ON `asset_folders` (`parent_folder_id`);
CREATE TABLE IF NOT EXISTS "files" (
	`id` text PRIMARY KEY NOT NULL,
	`piece_id` text,
	`folder_id` text,
	`filename` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`type` text NOT NULL,
	`storage_path` text NOT NULL,
	`content_type` text,
	`size` integer DEFAULT 0 NOT NULL,
	`media_duration` real,
	`media_width` integer,
	`media_height` integer,
	`has_audio` integer,
	`proxy_filename` text,
	`proxy_status` text DEFAULT 'idle' NOT NULL,
	`proxy_generated_at` integer,
	`fal_uploaded_url` text,
	`notes` text,
	`ai_generation` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL, `proxy_height` integer, `filmstrip_filename` text, `filmstrip_status` text DEFAULT 'idle' NOT NULL, `filmstrip_generated_at` integer, `filmstrip_frames` integer, `filmstrip_height` integer, `has_alpha` integer,
	FOREIGN KEY (`piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `asset_folders`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE INDEX `idx_files_folder_id` ON `files` (`folder_id`);
CREATE TABLE `model_schemas` (
	`id` text PRIMARY KEY NOT NULL,
	`api_url` text NOT NULL,
	`model` text NOT NULL,
	`schema_json` text NOT NULL,
	`source` text,
	`fetched_at` integer NOT NULL
);
CREATE UNIQUE INDEX `model_schemas_key_idx` ON `model_schemas` (`api_url`,`model`);
CREATE TABLE `seen_announcements` (
	`announcement_id` text PRIMARY KEY NOT NULL,
	`seen_at` integer NOT NULL
);
CREATE TABLE `analytics_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`params_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL
);
CREATE INDEX `analytics_queue_due_idx` ON `analytics_queue` (`next_attempt_at`);

INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('b7cc370a964952ebb7118d6e23885a90c3c10ac53ed4bc06de60bf13bd6db3d4', 1788525727378);

INSERT INTO mcp_servers (id, name, description, type, command, args, url, headers, env_vars, enabled, require_approval, bundled, install_status, server_status, created_at, updated_at) VALUES
 ('libi','Libi','core','stdio','','[]',NULL,NULL,NULL,1,0,1,'installed','up',unixepoch(),unixepoch()),
 ('fal-ai','fal-ai','gen','http','','[]','https://mcp.fal.ai/mcp','{"Authorization":"Bearer ${FAL_KEY}"}','{"FAL_KEY":"sk-legacy-123"}',1,1,1,'installed','up',unixepoch(),unixepoch()),
 ('elevenlabs','ElevenLabs','audio','stdio','uv','["tool","run","elevenlabs-mcp"]',NULL,NULL,NULL,1,1,1,'needs_config','unknown',unixepoch(),unixepoch()),
 ('youtube-downloader','YouTube Downloader','dl','stdio','npx','["-y","@kevinwatt/yt-dlp-mcp@0.9.0"]',NULL,NULL,NULL,1,0,1,'installed','up',unixepoch(),unixepoch()),
 ('my-custom-mcp','My Custom','user added','stdio','node','["s.js"]',NULL,NULL,'{"SOME_KEY":"x"}',1,1,0,'installed','up',unixepoch(),unixepoch());
