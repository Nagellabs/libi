PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_jobs` (
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
	`last_progress_at` integer,
	FOREIGN KEY (`piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_jobs`("id", "kind", "piece_id", "file_id", "status", "params_hash", "params_json", "progress_done", "progress_total", "progress_unit", "ms_per_unit", "partial_path", "result_json", "error", "created_at", "started_at", "completed_at", "last_progress_at") SELECT "id", "kind", "piece_id", "file_id", "status", "params_hash", "params_json", "progress_done", "progress_total", "progress_unit", "ms_per_unit", "partial_path", "result_json", "error", "created_at", "started_at", "completed_at", "last_progress_at" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `jobs_kind_params_idx` ON `jobs` (`kind`,`params_hash`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_piece_idx` ON `jobs` (`piece_id`);--> statement-breakpoint
CREATE INDEX `jobs_file_idx` ON `jobs` (`file_id`);