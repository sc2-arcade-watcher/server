ALTER TABLE `s2_profile` ADD `local_profile_id` int UNSIGNED NOT NULL DEFAULT 0 AFTER `id`;
UPDATE s2_profile
SET local_profile_id = (profile_id | (CASE WHEN realm_id = 2 THEN CAST(0x80000000 AS DECIMAL) ELSE 0 END))
WHERE local_profile_id = 0
;
CREATE UNIQUE INDEX `local_profile_region_idx` ON `s2_profile` (`local_profile_id`, `region_id`);


DELETE spt FROM s2_profile_tracking spt
LEFT JOIN s2_profile sp ON spt.profile_id = sp.profile_id AND spt.realm_id = sp.realm_id AND spt.region_id = sp.region_id
WHERE sp.id IS NULL;


RENAME TABLE `s2_profile_match` TO `s2_profile_match_old`;
RENAME TABLE `s2_profile_match_map_name` TO `s2_profile_match_map_name_old`;

CREATE TABLE `s2_profile_match_map_name` (`match_id` int UNSIGNED NOT NULL, `locales` int UNSIGNED NOT NULL, `name` varchar(255) COLLATE "utf8mb4_bin" NOT NULL, INDEX `match_idx` (`match_id`), PRIMARY KEY (`match_id`, `locales`)) ENGINE=ROCKSDB;
CREATE TABLE `s2_profile_match` (`id` int UNSIGNED NOT NULL AUTO_INCREMENT, `region_id` tinyint UNSIGNED NOT NULL, `local_profile_id` int UNSIGNED NOT NULL, `date` datetime(0) NOT NULL, `type` enum ('custom', 'unknown', 'coop', '1v1', '2v2', '3v3', '4v4', 'ffa') NOT NULL, `decision` enum ('left', 'win', 'loss', 'tie', 'observer', 'disagree', 'unknown') NOT NULL, `speed` enum ('slower', 'slow', 'normal', 'fast', 'faster') NOT NULL, `map_id` mediumint UNSIGNED NOT NULL, INDEX `map_region_date_idx` (`map_id`, `region_id`, `date`), INDEX `local_profile_region_idx` (`local_profile_id`, `region_id`), PRIMARY KEY (`id`)) ENGINE=ROCKSDB;


CREATE TABLE `s2_profile_battle_tracking` (`local_profile_id` int UNSIGNED NOT NULL, `region_id` tinyint UNSIGNED NOT NULL, `profile_info_updated_at` datetime NULL, `match_history_updated_at` datetime NULL, `match_history_integrity_since` datetime NULL, `battle_api_error_counter` tinyint UNSIGNED NOT NULL DEFAULT 0, `battle_api_error_last` datetime NULL, `public_gateway_since` datetime NULL, PRIMARY KEY (`local_profile_id`, `region_id`)) ENGINE=ROCKSDB;


SET session sql_log_bin=0;
SET session rocksdb_bulk_load=1;
INSERT INTO s2_profile_match (id, region_id, local_profile_id, `date`, `type`, decision, speed, map_id)
SELECT
spmold.id,
spmold.region_id,
(spmold.profile_id | (CASE WHEN spmold.realm_id = 2 THEN CAST(0x80000000 AS DECIMAL) ELSE 0 END)),
spmold.`date`,
spmold.`type`,
spmold.decision,
spmold.speed,
spmold.map_id
FROM s2_profile_match_old spmold
;
SET session rocksdb_bulk_load=0;

SET session sql_log_bin=0;
SET session rocksdb_bulk_load=1;
INSERT INTO s2_profile_match_map_name (match_id, locales, `name`)
SELECT
spmmnold.match_id,
(
    (CASE WHEN LOCATE('enUS', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x2 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('koKR', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x4 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('frFR', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x10 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('deDE', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x20 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('zhCN', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x40 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('esES', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x80 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('zhTW', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x100 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('enGB', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x200 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('esMX', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x1000 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('ruRU', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x2000 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('ptBR', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x4000 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('itIT', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x8000 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('ptPT', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x10000 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('enSG', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x20000000 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('plPL', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x40000000 AS DECIMAL) ELSE 0 END)
),
spmmnold.name
FROM s2_profile_match_map_name_old spmmnold
GROUP BY spmmnold.match_id, spmmnold.name
ORDER BY spmmnold.match_id ASC, (
    (CASE WHEN LOCATE('enUS', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x2 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('koKR', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x4 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('frFR', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x10 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('deDE', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x20 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('zhCN', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x40 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('esES', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x80 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('zhTW', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x100 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('enGB', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x200 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('esMX', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x1000 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('ruRU', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x2000 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('ptBR', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x4000 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('itIT', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x8000 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('ptPT', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x10000 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('enSG', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x20000000 AS DECIMAL) ELSE 0 END) |
    (CASE WHEN LOCATE('plPL', GROUP_CONCAT(spmmnold.locale)) > 0 THEN CAST(0x40000000 AS DECIMAL) ELSE 0 END)
) ASC
;
SET session sql_log_bin=1;
SET session rocksdb_bulk_load=0;


SET session sql_log_bin=0;
SET session rocksdb_bulk_load=1;
INSERT INTO s2_profile_battle_tracking (region_id, local_profile_id, profile_info_updated_at, match_history_updated_at, match_history_integrity_since, battle_api_error_counter, battle_api_error_last, public_gateway_since)
SELECT
spt.region_id,
(spt.profile_id | (CASE WHEN spt.realm_id = 2 THEN CAST(0x80000000 AS DECIMAL) ELSE 0 END)),
spt.profile_info_updated_at,
spt.match_history_updated_at,
spt.match_history_integrity_since,
spt.battle_api_error_counter,
spt.battle_api_error_last,
(CASE WHEN spt.prefer_public_gateway = 1 THEN IFNULL(spt.match_history_updated_at, spt.profile_info_updated_at) ELSE NULL END)
FROM s2_profile_tracking spt
ORDER BY (spt.profile_id | (CASE WHEN spt.realm_id = 2 THEN CAST(0x80000000 AS DECIMAL) ELSE 0 END)) ASC, spt.region_id ASC
;
SET session sql_log_bin=1;
SET session rocksdb_bulk_load=0;


ALTER TABLE `s2_profile_tracking`
    DROP COLUMN `profile_info_updated_at`,
    DROP COLUMN `match_history_updated_at`,
    DROP COLUMN `match_history_integrity_since`,
    DROP COLUMN `battle_api_error_counter`,
    DROP COLUMN `battle_api_error_last`,
    DROP COLUMN `prefer_public_gateway`
;

DROP TABLE s2_profile_match_old;
DROP TABLE s2_profile_match_map_name_old;
