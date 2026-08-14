ALTER TABLE `files` ADD `proxy_filename` text;--> statement-breakpoint
ALTER TABLE `files` ADD `proxy_status` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `files` ADD `proxy_generated_at` integer;