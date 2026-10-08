-- Tasks: the origin JSON now carries its own `kind` (replacing `origin_kind`),
-- status uses the task status enum, and the current pipeline stage is stored.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`origin` text NOT NULL,
	`mode` text,
	`repo_id` text NOT NULL,
	`branch` text,
	`worktree_path` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text,
	`triage_mode` text DEFAULT 'intervene' NOT NULL,
	`agents` text DEFAULT '{}' NOT NULL,
	`delivery_targets` text DEFAULT '[]' NOT NULL,
	`free_text` text DEFAULT '' NOT NULL,
	`plan` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "title", "origin", "mode", "repo_id", "branch", "worktree_path", "status", "stage", "triage_mode", "agents", "delivery_targets", "free_text", "plan", "created_at", "updated_at") SELECT "id", "title", json_set("origin", '$.kind', "origin_kind"), "mode", "repo_id", "branch", "worktree_path", CASE WHEN "status" = 'pending' THEN 'queued' ELSE "status" END, NULL, "triage_mode", "agents", "delivery_targets", "free_text", "plan", "created_at", "updated_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tasks_repo_idx` ON `tasks` (`repo_id`);--> statement-breakpoint
CREATE INDEX `tasks_branch_idx` ON `tasks` (`repo_id`,`branch`);--> statement-breakpoint
ALTER TABLE `grill_questions` ADD `needs_human` integer DEFAULT false NOT NULL;