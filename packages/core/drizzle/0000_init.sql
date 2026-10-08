CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cli` text NOT NULL,
	`model` text,
	`prompt` text DEFAULT '' NOT NULL,
	`eligible_stages` text DEFAULT '[]' NOT NULL,
	`permission_overrides` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_unique` ON `agents` (`name`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text NOT NULL,
	`auth_meta` text DEFAULT '{}' NOT NULL,
	`token_set` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_name_unique` ON `connections` (`name`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text,
	`step_id` text,
	`reviewer_agent_id` text,
	`severity` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`file` text,
	`line_start` integer,
	`line_end` integer,
	`title` text NOT NULL,
	`explanation` text NOT NULL,
	`suggested_fix` text,
	`status` text DEFAULT 'open' NOT NULL,
	`round` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewer_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `findings_task_idx` ON `findings` (`task_id`);--> statement-breakpoint
CREATE TABLE `grill_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text,
	`step_id` text,
	`asked_by_agent_id` text,
	`question` text NOT NULL,
	`answer` text,
	`answered_by` text,
	`created_at` integer NOT NULL,
	`answered_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`asked_by_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `grill_questions_task_idx` ON `grill_questions` (`task_id`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`remote_url` text,
	`connection_id` text,
	`check_commands` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_path_unique` ON `repos` (`path`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`number` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_task_number_idx` ON `runs` (`task_id`,`number`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `step_events` (
	`step_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`step_id`, `seq`),
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`stage` text NOT NULL,
	`agent_id` text,
	`round` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`session_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `steps_run_idx` ON `steps` (`run_id`);--> statement-breakpoint
CREATE INDEX `steps_status_idx` ON `steps` (`status`);--> statement-breakpoint
CREATE TABLE `tags` (
	`name` text PRIMARY KEY NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`origin_kind` text NOT NULL,
	`origin` text DEFAULT '{}' NOT NULL,
	`mode` text,
	`repo_id` text NOT NULL,
	`branch` text,
	`worktree_path` text,
	`status` text DEFAULT 'pending' NOT NULL,
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
CREATE INDEX `tasks_repo_idx` ON `tasks` (`repo_id`);--> statement-breakpoint
CREATE INDEX `tasks_branch_idx` ON `tasks` (`repo_id`,`branch`);