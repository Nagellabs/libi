CREATE TABLE `seam_caches` (
	`id` text PRIMARY KEY NOT NULL,
	`piece_id` text NOT NULL,
	`boundary_index` integer NOT NULL,
	`inputs_hash` text NOT NULL,
	`filename` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`start_sec` real NOT NULL,
	`end_sec` real NOT NULL,
	`generated_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_seam_caches_piece` ON `seam_caches` (`piece_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `seam_caches_piece_boundary_unique` ON `seam_caches` (`piece_id`,`boundary_index`);