CREATE TABLE `analytics_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`params_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `analytics_queue_due_idx` ON `analytics_queue` (`next_attempt_at`);