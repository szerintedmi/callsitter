CREATE TABLE `calls` (
	`id` text PRIMARY KEY NOT NULL,
	`call_control_id` text NOT NULL,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`diverted_from` text,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	`verdict` text,
	`category` text,
	`strategy` text,
	`luna_calls` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`summary` text,
	`recording_path` text
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`call_id` text NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_call_idx` ON `events` (`call_id`,`id`);