CREATE TABLE `channel_programs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`media_type` text NOT NULL,
	`movie_id` integer,
	`episode_id` integer,
	`title` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`duration_seconds` integer NOT NULL,
	FOREIGN KEY (`movie_id`) REFERENCES `movies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channel_programs_channel_start_idx` ON `channel_programs` (`channel`,`start_at`);--> statement-breakpoint
CREATE TABLE `channel_progress` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`ref_kind` text NOT NULL,
	`ref_id` integer NOT NULL,
	`last_episode_id` integer,
	`last_movie_id` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_progress_ref_unique` ON `channel_progress` (`channel`,`ref_kind`,`ref_id`);--> statement-breakpoint
ALTER TABLE `movies` ADD `collection_tmdb_id` integer;--> statement-breakpoint
ALTER TABLE `movies` ADD `collection_name` text;--> statement-breakpoint
CREATE INDEX `movies_collection_idx` ON `movies` (`collection_tmdb_id`);