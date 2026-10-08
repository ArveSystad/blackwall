-- Pipeline engine: the gate a needs-you task waits on, why a task failed,
-- and which visit of its stage a step belongs to (for resume).
ALTER TABLE `steps` ADD `visit` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `gate` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `error` text;