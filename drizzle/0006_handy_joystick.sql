CREATE TABLE `scan_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`root_folder_id` integer,
	`quality_profile_id` integer,
	`path` text NOT NULL,
	`video_path` text,
	`name` text NOT NULL,
	`parsed_title` text NOT NULL,
	`parsed_year` integer,
	`status` text NOT NULL,
	`suggested_tmdb_id` integer,
	`suggestions` text,
	`imported` integer DEFAULT false NOT NULL,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scan_candidates_type_idx` ON `scan_candidates` (`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `scan_candidates_path_unique` ON `scan_candidates` (`type`,`path`);