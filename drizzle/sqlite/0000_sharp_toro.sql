CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`piece_id` text NOT NULL,
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
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE TABLE `pieces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`name_set_by_user` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`preferred_agent` text,
	`panel_chat_size` real DEFAULT 40 NOT NULL,
	`panel_editor_size` real DEFAULT 40 NOT NULL,
	`panel_resources_size` real DEFAULT 20 NOT NULL,
	`panel_chat_visible` integer DEFAULT true NOT NULL,
	`panel_resources_visible` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
