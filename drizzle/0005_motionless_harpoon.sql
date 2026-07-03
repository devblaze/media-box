CREATE TABLE `organize_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_path` text NOT NULL,
	`dest_path` text,
	`media_type` text,
	`title` text,
	`detail` text,
	`action` text,
	`status` text NOT NULL,
	`message` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `organize_log_created_idx` ON `organize_log` (`created_at`);