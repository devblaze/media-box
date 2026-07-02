ALTER TABLE `quality_profiles` ADD `preferred_terms` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `quality_profiles` ADD `required_terms` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `quality_profiles` ADD `ignored_terms` text DEFAULT '[]' NOT NULL;