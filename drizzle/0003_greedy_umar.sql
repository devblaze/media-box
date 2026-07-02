CREATE TABLE `subtitle_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`movie_id` integer,
	`episode_id` integer,
	`language` text NOT NULL,
	`relative_path` text NOT NULL,
	`provider` text NOT NULL,
	`hearing_impaired` integer DEFAULT false NOT NULL,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`movie_id`) REFERENCES `movies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subtitle_movie_idx` ON `subtitle_files` (`movie_id`,`language`);--> statement-breakpoint
CREATE INDEX `subtitle_episode_idx` ON `subtitle_files` (`episode_id`,`language`);