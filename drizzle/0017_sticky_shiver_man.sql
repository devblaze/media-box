ALTER TABLE `indexers` ADD `type` text DEFAULT 'torznab' NOT NULL;--> statement-breakpoint
ALTER TABLE `indexers` ADD `definition` text;