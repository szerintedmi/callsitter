CREATE TABLE `plays` (
	`call_id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`goal` text NOT NULL,
	`player` text NOT NULL,
	`score_ms` integer,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `plays_board_idx` ON `plays` (`game`,`goal`,`score_ms`);