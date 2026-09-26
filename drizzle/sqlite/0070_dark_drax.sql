CREATE TABLE `template_publish_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`source` text NOT NULL,
	`example_video` text NOT NULL,
	`nickname` text,
	`fingerprint` text NOT NULL,
	`confirm_code` text NOT NULL,
	`status` text DEFAULT 'awaiting' NOT NULL,
	`job_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `template_publish_requests_template_unique` ON `template_publish_requests` (`template_id`);