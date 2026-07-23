CREATE TABLE `jellyfin_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`jellyfin_user_id` text NOT NULL,
	`jellyfin_username` text NOT NULL,
	`access_token` text NOT NULL,
	`device_id` text NOT NULL,
	`last_sync_at` integer,
	`last_sync_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jellyfin_links_user_unique` ON `jellyfin_links` (`user_id`);