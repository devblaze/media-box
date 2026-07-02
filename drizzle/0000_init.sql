CREATE TABLE `blocklist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_type` text NOT NULL,
	`series_id` integer,
	`movie_id` integer,
	`source_title` text NOT NULL,
	`info_hash` text,
	`reason` text,
	`date` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `commands` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`payload` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`trigger` text DEFAULT 'system' NOT NULL,
	`queued_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `commands_status_idx` ON `commands` (`status`,`priority`);--> statement-breakpoint
CREATE TABLE `download_clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`settings` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 1 NOT NULL,
	`remove_completed_downloads` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `downloads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`download_client_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`media_type` text NOT NULL,
	`series_id` integer,
	`movie_id` integer,
	`episode_ids` text,
	`title` text NOT NULL,
	`quality` text,
	`indexer_id` integer,
	`protocol` text DEFAULT 'torrent' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`status_message` text,
	`size` integer,
	`size_left` integer,
	`output_path` text,
	`grabbed_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`download_client_id`) REFERENCES `download_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`movie_id`) REFERENCES `movies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `downloads_client_external_unique` ON `downloads` (`download_client_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `downloads_status_idx` ON `downloads` (`status`);--> statement-breakpoint
CREATE TABLE `episode_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` integer NOT NULL,
	`relative_path` text NOT NULL,
	`size` integer NOT NULL,
	`quality` text NOT NULL,
	`release_group` text,
	`scene_name` text,
	`date_added` integer NOT NULL,
	`media_info` text,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	`episode_number` integer NOT NULL,
	`absolute_number` integer,
	`tmdb_episode_id` integer,
	`title` text,
	`overview` text,
	`air_date_utc` integer,
	`runtime` integer,
	`monitored` integer DEFAULT true NOT NULL,
	`episode_file_id` integer,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`episode_file_id`) REFERENCES `episode_files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_series_season_episode_unique` ON `episodes` (`series_id`,`season_number`,`episode_number`);--> statement-breakpoint
CREATE INDEX `episodes_air_date_idx` ON `episodes` (`series_id`,`air_date_utc`);--> statement-breakpoint
CREATE INDEX `episodes_missing_idx` ON `episodes` (`monitored`,`episode_file_id`);--> statement-breakpoint
CREATE TABLE `history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`media_type` text NOT NULL,
	`series_id` integer,
	`episode_id` integer,
	`movie_id` integer,
	`source_title` text,
	`quality` text,
	`indexer_id` integer,
	`download_client_id` integer,
	`download_external_id` text,
	`data` text,
	`date` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `history_date_idx` ON `history` (`date`);--> statement-breakpoint
CREATE TABLE `indexers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`api_key` text,
	`categories` text DEFAULT '[5000,5030,5040,2000,2010,2020,2030,2040,2045,2060]' NOT NULL,
	`enable_rss` integer DEFAULT true NOT NULL,
	`enable_automatic_search` integer DEFAULT true NOT NULL,
	`enable_interactive_search` integer DEFAULT true NOT NULL,
	`supports_tv` integer DEFAULT true NOT NULL,
	`supports_movies` integer DEFAULT true NOT NULL,
	`minimum_seeders` integer DEFAULT 1 NOT NULL,
	`priority` integer DEFAULT 25 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `movie_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`movie_id` integer NOT NULL,
	`relative_path` text NOT NULL,
	`size` integer NOT NULL,
	`quality` text NOT NULL,
	`release_group` text,
	`scene_name` text,
	`date_added` integer NOT NULL,
	`media_info` text,
	FOREIGN KEY (`movie_id`) REFERENCES `movies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `movie_tags` (
	`movie_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	FOREIGN KEY (`movie_id`) REFERENCES `movies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `movie_tags_unique` ON `movie_tags` (`movie_id`,`tag_id`);--> statement-breakpoint
CREATE TABLE `movies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tmdb_id` integer NOT NULL,
	`imdb_id` text,
	`title` text NOT NULL,
	`sort_title` text NOT NULL,
	`year` integer,
	`overview` text,
	`runtime` integer,
	`status` text DEFAULT 'announced' NOT NULL,
	`physical_release` integer,
	`digital_release` integer,
	`poster_path` text,
	`backdrop_path` text,
	`path` text NOT NULL,
	`root_folder_id` integer,
	`quality_profile_id` integer NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	`minimum_availability` text DEFAULT 'released' NOT NULL,
	`movie_file_id` integer,
	`added_at` integer NOT NULL,
	`last_refresh_at` integer,
	FOREIGN KEY (`root_folder_id`) REFERENCES `root_folders`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`quality_profile_id`) REFERENCES `quality_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`movie_file_id`) REFERENCES `movie_files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `movies_tmdb_id_unique` ON `movies` (`tmdb_id`);--> statement-breakpoint
CREATE INDEX `movies_missing_idx` ON `movies` (`monitored`,`movie_file_id`);--> statement-breakpoint
CREATE TABLE `naming_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`rename_episodes` integer DEFAULT true NOT NULL,
	`replace_illegal_characters` integer DEFAULT true NOT NULL,
	`standard_episode_format` text DEFAULT '{Series Title} - S{season:00}E{episode:00} - {Episode Title} [{Quality}]' NOT NULL,
	`series_folder_format` text DEFAULT '{Series Title} ({Year})' NOT NULL,
	`season_folder_format` text DEFAULT 'Season {season:00}' NOT NULL,
	`movie_format` text DEFAULT '{Movie Title} ({Year}) [{Quality}]' NOT NULL,
	`movie_folder_format` text DEFAULT '{Movie Title} ({Year})' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quality_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`upgrade_allowed` integer DEFAULT true NOT NULL,
	`cutoff_quality_id` integer NOT NULL,
	`items` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `remote_path_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`download_client_id` integer NOT NULL,
	`remote_path` text NOT NULL,
	`local_path` text NOT NULL,
	FOREIGN KEY (`download_client_id`) REFERENCES `download_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`poster_path` text,
	`seasons` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decline_reason` text,
	`decided_by_user_id` integer,
	`decided_at` integer,
	`series_id` integer,
	`movie_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`movie_id`) REFERENCES `movies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `requests_status_idx` ON `requests` (`status`);--> statement-breakpoint
CREATE INDEX `requests_user_idx` ON `requests` (`user_id`);--> statement-breakpoint
CREATE TABLE `root_folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`media_type` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `root_folders_path_unique` ON `root_folders` (`path`);--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`interval_minutes` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`last_duration_ms` integer,
	`last_result` text,
	`next_run_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_tasks_name_unique` ON `scheduled_tasks` (`name`);--> statement-breakpoint
CREATE TABLE `seasons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seasons_series_season_unique` ON `seasons` (`series_id`,`season_number`);--> statement-breakpoint
CREATE TABLE `series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tmdb_id` integer NOT NULL,
	`tvdb_id` integer,
	`imdb_id` text,
	`title` text NOT NULL,
	`sort_title` text NOT NULL,
	`year` integer,
	`overview` text,
	`status` text DEFAULT 'continuing' NOT NULL,
	`network` text,
	`runtime` integer,
	`poster_path` text,
	`backdrop_path` text,
	`path` text NOT NULL,
	`root_folder_id` integer,
	`quality_profile_id` integer NOT NULL,
	`monitored` integer DEFAULT true NOT NULL,
	`season_folder` integer DEFAULT true NOT NULL,
	`added_at` integer NOT NULL,
	`last_refresh_at` integer,
	FOREIGN KEY (`root_folder_id`) REFERENCES `root_folders`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`quality_profile_id`) REFERENCES `quality_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `series_tmdb_id_unique` ON `series` (`tmdb_id`);--> statement-breakpoint
CREATE TABLE `series_tags` (
	`series_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `series_tags_unique` ON `series_tags` (`series_id`,`tag_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_label_unique` ON `tags` (`label`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);