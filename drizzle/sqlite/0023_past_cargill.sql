ALTER TABLE `pieces` ADD `has_draft` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pieces` ADD `snapshot_summary` text;--> statement-breakpoint
ALTER TABLE `pieces` ADD `snapshot_committed_at` integer;