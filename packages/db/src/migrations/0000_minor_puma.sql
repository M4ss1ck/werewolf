CREATE TABLE `game_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_user_id` text,
	`scope` text NOT NULL,
	`scope_id` text,
	`command_id` text,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `game_events_game_id_idx` ON `game_events` (`game_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `game_events_game_command_idx` ON `game_events` (`game_id`,`command_id`);--> statement-breakpoint
CREATE TABLE `game_players` (
	`game_id` text NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text NOT NULL,
	`joined_at` integer NOT NULL,
	`original_role` text,
	`role` text,
	`faction` text,
	`role_state_json` text DEFAULT '{}' NOT NULL,
	`phase_state_json` text DEFAULT '{}' NOT NULL,
	`wolf_since_event_id` integer,
	PRIMARY KEY(`game_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `game_players_user_game_idx` ON `game_players` (`user_id`,`game_id`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`join_code` text,
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
	`rng_seed` text,
	`winner_json` text,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `games_status_phase_ends_idx` ON `games` (`status`,`phase_ends_at`);--> statement-breakpoint
CREATE INDEX `games_status_scheduled_idx` ON `games` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `games_join_code_idx` ON `games` (`join_code`);