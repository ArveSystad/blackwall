ALTER TABLE `repos` ADD `agent_trust` text DEFAULT 'locked' NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `trust_project_mcp` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `trust_project_hooks` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `steps` ADD `trust` text;--> statement-breakpoint
ALTER TABLE `steps` ADD `trust_forced` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_branch` text;--> statement-breakpoint
UPDATE `tasks` SET `pr_branch` = 'unchecked' WHERE json_extract(`origin`, '$.kind') = 'github-pr';
