PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_files` (
	`id` text PRIMARY KEY NOT NULL,
	`piece_id` text,
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
INSERT INTO `__new_files`("id", "piece_id", "filename", "name", "description", "type", "storage_path", "content_type", "size", "media_duration", "media_width", "media_height", "created_at") SELECT "id", "piece_id", "filename", "name", "description", "type", "storage_path", "content_type", "size", "media_duration", "media_width", "media_height", "created_at" FROM `files`;--> statement-breakpoint
DROP TABLE `files`;--> statement-breakpoint
ALTER TABLE `__new_files` RENAME TO `files`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
