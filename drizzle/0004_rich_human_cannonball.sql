CREATE TABLE `log_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`level` text NOT NULL,
	`source` text,
	`message` text NOT NULL,
	`context` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `log_created_idx` ON `log_entries` (`created_at`);--> statement-breakpoint
CREATE TABLE `watch_progress` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`movie_id` integer,
	`episode_id` integer,
	`series_id` integer,
	`position_seconds` integer DEFAULT 0 NOT NULL,
	`duration_seconds` integer DEFAULT 0 NOT NULL,
	`watched` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`movie_id`) REFERENCES `movies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watch_user_movie_unique` ON `watch_progress` (`user_id`,`movie_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `watch_user_episode_unique` ON `watch_progress` (`user_id`,`episode_id`);--> statement-breakpoint
CREATE INDEX `watch_user_updated_idx` ON `watch_progress` (`user_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `series` ADD `is_anime` integer DEFAULT false NOT NULL;