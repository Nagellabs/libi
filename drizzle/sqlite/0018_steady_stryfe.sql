CREATE TABLE `jobs` (
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
	`ms_per_unit` integer,
	`partial_path` text,
	`result_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`last_progress_at` integer,
	FOREIGN KEY (`piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_kind_params_idx` ON `jobs` (`kind`,`params_hash`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_piece_idx` ON `jobs` (`piece_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tracks` (
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
--> statement-breakpoint
INSERT INTO `__new_tracks`("id", "file_id", "subject_id", "label", "method", "framerate", "duration_sec", "sample_count", "created_at") SELECT "id", "file_id", "subject_id", "label", "method", "framerate", "duration_sec", "sample_count", "created_at" FROM `tracks`;--> statement-breakpoint
DROP TABLE `tracks`;--> statement-breakpoint
ALTER TABLE `__new_tracks` RENAME TO `tracks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;