CREATE TABLE `page_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`visit_id` text NOT NULL,
	`load_id` text NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`path` text,
	`demo` text,
	`props` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`browser` text,
	`browser_version` text,
	`os` text,
	`os_version` text,
	`device` text,
	`mobile` integer,
	`accept_language` text,
	`country` text,
	`city` text,
	`region` text
);
--> statement-breakpoint
CREATE INDEX `page_events_at_idx` ON `page_events` (`at`);--> statement-breakpoint
CREATE INDEX `page_events_visit_idx` ON `page_events` (`visit_id`,`at`);