ALTER TABLE `s2_map_header` DROP FOREIGN KEY `FK_4c9d8fd10051155846a3d393847`;
DROP INDEX `IDX_4c9d8fd10051155846a3d39384` ON `s2_map_header`;
ALTER TABLE s2_map_header MODIFY COLUMN header_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;
ALTER TABLE s2_map_header MODIFY COLUMN archive_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;
ALTER TABLE `s2_map_header` ADD `archive_filename` varchar(255) NULL AFTER `archive_size`;
CREATE INDEX `archive_hash_idx` ON `s2_map_header` (`archive_hash`);

DROP INDEX `original_name_region_idx` ON `s2_map_locale`;
DROP INDEX `name_region_idx` ON `s2_map_locale`;
ALTER TABLE `s2_map_locale` ADD `initial_major_version` smallint UNSIGNED NOT NULL DEFAULT 0 AFTER `locale`;
ALTER TABLE `s2_map_locale` ADD `initial_minor_version` smallint UNSIGNED NOT NULL DEFAULT 0 AFTER `initial_major_version`;
ALTER TABLE `s2_map_locale` CHANGE `major_version` `latest_major_version` smallint UNSIGNED NOT NULL;
ALTER TABLE `s2_map_locale` CHANGE `minor_version` `latest_minor_version` smallint UNSIGNED NOT NULL;
ALTER TABLE `s2_map_locale` ADD `table_hash` char(64) COLLATE "ascii_bin" NULL AFTER `is_main`;
CREATE INDEX `original_name_idx` ON `s2_map_locale` (`original_name`);
CREATE INDEX `name_idx` ON `s2_map_locale` (`name`);

ALTER TABLE `s2_map` CHANGE `max_players` `max_players` tinyint UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE `s2_map` ADD `max_human_players` tinyint UNSIGNED NOT NULL DEFAULT 0 AFTER `max_players`;
ALTER TABLE `s2_map` CHANGE `initial_version_id` `initial_version_id` int NOT NULL;
ALTER TABLE `s2_map` CHANGE `published_at` `published_at` datetime NOT NULL;
ALTER TABLE `s2_map` CHANGE `updated_at` `updated_at` datetime NOT NULL;
ALTER TABLE `s2_map` ADD `available_locales` int UNSIGNED NOT NULL AFTER `initial_version_id`;
