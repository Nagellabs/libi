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
--> statement-breakpoint
CREATE INDEX `idx_asset_folders_piece` ON `asset_folders` (`piece_id`);--> statement-breakpoint
CREATE INDEX `idx_asset_folders_parent` ON `asset_folders` (`parent_folder_id`);--> statement-breakpoint
DROP TABLE `assets`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_files` (
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
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `asset_folders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_files`("id", "piece_id", "folder_id", "filename", "name", "description", "type", "storage_path", "content_type", "size", "media_duration", "media_width", "media_height", "has_audio", "proxy_filename", "proxy_status", "proxy_generated_at", "fal_uploaded_url", "notes", "ai_generation", "created_at") SELECT "id", "piece_id", NULL, "filename", "name", "description", "type", "storage_path", "content_type", "size", "media_duration", "media_width", "media_height", "has_audio", "proxy_filename", "proxy_status", "proxy_generated_at", "fal_uploaded_url", "notes", "ai_generation", "created_at" FROM `files`;--> statement-breakpoint
DROP TABLE `files`;--> statement-breakpoint
ALTER TABLE `__new_files` RENAME TO `files`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_files_folder_id` ON `files` (`folder_id`);