ALTER TABLE `files` ADD `filmstrip_filename` text;--> statement-breakpoint
ALTER TABLE `files` ADD `filmstrip_status` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `files` ADD `filmstrip_generated_at` integer;--> statement-breakpoint
ALTER TABLE `files` ADD `filmstrip_frames` integer;--> statement-breakpoint
ALTER TABLE `files` ADD `filmstrip_height` integer;