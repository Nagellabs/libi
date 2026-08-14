ALTER TABLE `mcp_servers` ADD `server_status` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `server_error` text;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `server_last_checked` integer;