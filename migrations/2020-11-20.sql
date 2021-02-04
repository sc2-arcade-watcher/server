-- 
-- matches
-- 

ALTER TABLE `s2_profile_match` CHANGE `decision` `decision` enum ('left', 'win', 'loss', 'tie', 'observer', 'disagree', 'unknown') NOT NULL;

DROP INDEX `name_idx` ON `s2_map_locale`;
ALTER TABLE `s2_map_locale` ADD `original_name` varchar(255) NULL AFTER `is_main`;
CREATE INDEX `original_name_region_idx` ON `s2_map_locale` (`original_name`, `region_id`);
CREATE INDEX `name_region_idx` ON `s2_map_locale` (`name`, `region_id`);

CREATE INDEX `map_region_idx` ON `s2_profile_match` (`map_id`, `region_id`);
DROP INDEX `map_region_idx` ON `s2_profile_match`;
CREATE INDEX `map_region_date_idx` ON `s2_profile_match` (`map_id`, `region_id`, `date`);

CREATE TABLE `s2_profile_match_unknown_map` (`id` int UNSIGNED NOT NULL AUTO_INCREMENT, `locale` enum ('deDE', 'enGB', 'esES', 'frFR', 'itIT', 'plPL', 'ptPT', 'ruRU', 'zhCN', 'zhTW', 'koKR', 'enSG', 'enUS', 'esMX', 'ptBR') NOT NULL, `name` varchar(255) NOT NULL, `match_id` int UNSIGNED NOT NULL, INDEX `match_idx` (`match_id`), PRIMARY KEY (`id`, `locale`)) ENGINE=InnoDB;
ALTER TABLE `s2_profile_match_unknown_map` ADD CONSTRAINT `FK_49efbcfb9fed163d97e66346f7b` FOREIGN KEY (`match_id`) REFERENCES `s2_profile_match`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- 
-- stats
-- 

ALTER TABLE `s2_profile_tracking` ADD `map_stats_updated_at` datetime NULL;

CREATE TABLE `s2_stats_player_map` (`region_id` tinyint UNSIGNED NOT NULL, `realm_id` tinyint UNSIGNED NOT NULL, `profile_id` int UNSIGNED NOT NULL, `map_id` mediumint UNSIGNED NOT NULL, `lobbies_started` mediumint UNSIGNED NOT NULL, `lobbies_started_diff_days` mediumint UNSIGNED NOT NULL, `lobbies_joined` mediumint UNSIGNED NOT NULL, `lobbies_hosted` mediumint UNSIGNED NOT NULL, `lobbies_hosted_started` mediumint UNSIGNED NOT NULL, `time_spent_waiting` int UNSIGNED NOT NULL, `time_spent_waiting_as_host` int UNSIGNED NOT NULL, `last_played_at` datetime NOT NULL DEFAULT 0, INDEX `map_lob_host_started_idx` (`map_id`, `region_id`, `lobbies_hosted_started`), INDEX `map_lob_started_idx` (`map_id`, `region_id`, `lobbies_started`), PRIMARY KEY (`region_id`, `realm_id`, `profile_id`, `map_id`)) ENGINE=InnoDB;

CREATE TABLE `s2_stats_player_status` (`region_id` tinyint UNSIGNED NOT NULL, `updated_at` datetime NOT NULL DEFAULT 0, PRIMARY KEY (`region_id`)) ENGINE=InnoDB;

TRUNCATE TABLE `s2_stats_player_map`;
TRUNCATE TABLE `s2_stats_player_status`;
UPDATE `s2_profile_tracking` SET `map_stats_updated_at` = NULL;
INSERT INTO `s2_stats_player_status` (`region_id`, `updated_at`)
VALUES 
('1', '2020-01-20 00:00:00'),
('2', '2020-01-20 00:00:00'),
('3', '2020-01-20 00:00:00'),
('5', '2020-01-20 00:00:00')
;