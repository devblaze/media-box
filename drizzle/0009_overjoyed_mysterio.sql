ALTER TABLE `commands` ADD `result` text;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `schedule_kind` text DEFAULT 'interval' NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `schedule_hour` integer;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `schedule_minute` integer;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `schedule_day` integer;