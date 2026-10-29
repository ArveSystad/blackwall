CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`source_task_id` text,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`files` text,
	`pinned` integer DEFAULT false NOT NULL,
	`awaiting_merge` integer DEFAULT false NOT NULL,
	`edited_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memories_repo_idx` ON `memories` (`repo_id`,`awaiting_merge`,`pinned`);--> statement-breakpoint
CREATE VIRTUAL TABLE `memories_fts` USING fts5(text, files, content='memories', content_rowid='rowid', tokenize='porter unicode61');
--> statement-breakpoint
CREATE TRIGGER `memories_ai` AFTER INSERT ON `memories` BEGIN
	INSERT INTO memories_fts(rowid, text, files) VALUES (new.rowid, new.text, new.files);
END;
--> statement-breakpoint
CREATE TRIGGER `memories_ad` AFTER DELETE ON `memories` BEGIN
	INSERT INTO memories_fts(memories_fts, rowid, text, files) VALUES ('delete', old.rowid, old.text, old.files);
END;
--> statement-breakpoint
CREATE TRIGGER `memories_au` AFTER UPDATE ON `memories` BEGIN
	INSERT INTO memories_fts(memories_fts, rowid, text, files) VALUES ('delete', old.rowid, old.text, old.files);
	INSERT INTO memories_fts(rowid, text, files) VALUES (new.rowid, new.text, new.files);
END;
