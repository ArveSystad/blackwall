ALTER TABLE `repos` ADD `favorite` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `position` integer DEFAULT 0 NOT NULL;