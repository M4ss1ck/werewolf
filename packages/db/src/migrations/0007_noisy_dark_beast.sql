DROP INDEX "games_status_phase_ends_idx";--> statement-breakpoint
DROP INDEX "games_status_scheduled_idx";--> statement-breakpoint
DROP INDEX "games_join_code_idx";--> statement-breakpoint
CREATE TABLE `games_new` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`join_code` text NOT NULL,
	`visibility` text NOT NULL,
	`status` text NOT NULL,
	`scheduled_at` integer,
	`started_at` integer,
	`ended_at` integer,
	`day` integer DEFAULT 0 NOT NULL,
	`phase` text,
	`phase_id` integer DEFAULT 0 NOT NULL,
	`phase_started_at` integer,
	`phase_ends_at` integer,
	`settings_json` text NOT NULL,
	`balance_version` integer NOT NULL,
	`nights_without_elimination` integer DEFAULT 0 NOT NULL,
	`rng_seed` text,
	`winner_json` text,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `games_new` SELECT `id`, `owner_user_id`, `name`, `join_code`, `visibility`, `status`, `scheduled_at`, `started_at`, `ended_at`, `day`, `phase`, `phase_id`, `phase_started_at`, `phase_ends_at`, `settings_json`, `balance_version`, `nights_without_elimination`, `rng_seed`, `winner_json`, `version`, `created_at` FROM `games`;--> statement-breakpoint
DROP TABLE `games`;--> statement-breakpoint
ALTER TABLE `games_new` RENAME TO `games`;--> statement-breakpoint
CREATE INDEX `games_status_phase_ends_idx` ON `games` (`status`,`phase_ends_at`);--> statement-breakpoint
CREATE INDEX `games_status_scheduled_idx` ON `games` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `games_join_code_idx` ON `games` (`join_code`);--> statement-breakpoint
ALTER TABLE `game_players` ADD `membership_access` text DEFAULT 'active' NOT NULL;
