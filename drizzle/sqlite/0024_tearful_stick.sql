CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`piece_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`default_file_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_assets_piece_id` ON `assets` (`piece_id`);--> statement-breakpoint
ALTER TABLE `files` ADD `asset_id` text REFERENCES assets(id);--> statement-breakpoint
CREATE INDEX `idx_files_asset_id` ON `files` (`asset_id`);