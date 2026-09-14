-- Sonarr/Radarr-compatible naming: new tokens, an anime episode format, a
-- specials folder format and a configurable multi-episode style.
--
-- Hand-written on purpose. drizzle-kit's recreate for this change SELECTed the
-- three brand-new columns out of the OLD table (where they do not exist), which
-- fails. Recreating the table is still the right shape — it is how SQLite
-- changes a column DEFAULT — but the SELECT below supplies the new columns
-- explicitly.
--
-- The new DEFAULTs are Sonarr's and Radarr's and apply to NEW installs only:
-- `boot.ts` runs migrations first and only then inserts row 1, so a fresh
-- database has ZERO rows here and the INSERT ... SELECT copies nothing.
--
-- An EXISTING install keeps every value it already had, and the three new
-- columns are backfilled with the values that reproduce media-box's previous
-- output exactly:
--   anime_episode_format  <- standard_episode_format  (no separate anime scheme before)
--   specials_folder_format<- season_folder_format     (season 0 rendered as "Season 00")
--   multi_episode_style   <- 'scene'                  (E01-E02 was hard-coded)
-- so no library starts being written under a second naming scheme.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_naming_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`rename_episodes` integer DEFAULT true NOT NULL,
	`replace_illegal_characters` integer DEFAULT true NOT NULL,
	`standard_episode_format` text DEFAULT '{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}' NOT NULL,
	`anime_episode_format` text DEFAULT '{Series Title} - S{season:00}E{episode:00} - {absolute:000} - {Episode Title} {Quality Full}' NOT NULL,
	`series_folder_format` text DEFAULT '{Series Title} ({Year})' NOT NULL,
	`season_folder_format` text DEFAULT 'Season {season:00}' NOT NULL,
	`specials_folder_format` text DEFAULT 'Specials' NOT NULL,
	`multi_episode_style` text DEFAULT 'extend' NOT NULL,
	`movie_format` text DEFAULT '{Movie Title} ({Year}) {Quality Full}' NOT NULL,
	`movie_folder_format` text DEFAULT '{Movie Title} ({Year})' NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_naming_config`("id", "rename_episodes", "replace_illegal_characters", "standard_episode_format", "anime_episode_format", "series_folder_format", "season_folder_format", "specials_folder_format", "multi_episode_style", "movie_format", "movie_folder_format") SELECT "id", "rename_episodes", "replace_illegal_characters", "standard_episode_format", "standard_episode_format", "series_folder_format", "season_folder_format", "season_folder_format", 'scene', "movie_format", "movie_folder_format" FROM `naming_config`;--> statement-breakpoint
DROP TABLE `naming_config`;--> statement-breakpoint
ALTER TABLE `__new_naming_config` RENAME TO `naming_config`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
