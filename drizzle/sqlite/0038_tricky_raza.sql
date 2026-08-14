ALTER TABLE `settings` ADD `analytics_user_id` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `onboarding_persona` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `persona_selected_at` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD `agent_ever_connected` integer DEFAULT false NOT NULL;