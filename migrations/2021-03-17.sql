--
-- add profileGameId & battleTag
--
ALTER TABLE `s2_profile` ADD `profile_game_id` bigint UNSIGNED NULL AFTER `profile_id`;
ALTER TABLE `s2_profile` ADD `battle_tag` varchar(32) NULL AFTER `discriminator`;
CREATE UNIQUE INDEX `profile_game_region_idx` ON `s2_profile` (`profile_game_id`, `region_id`);
CREATE INDEX `battle_tag_idx` ON `s2_profile` (`battle_tag`);

--
-- fix profile tracking
--

RENAME TABLE s2_profile_tracking TO s2_profile_tracking_old;

CREATE TABLE `s2_profile_tracking` (`local_profile_id` int UNSIGNED NOT NULL, `region_id` tinyint UNSIGNED NOT NULL, `map_stats_updated_at` datetime NULL, `name_updated_at` datetime NULL, `battle_tag_updated_at` datetime NULL, PRIMARY KEY (`local_profile_id`, `region_id`)) ENGINE=ROCKSDB;

SET session sql_log_bin=0;
SET session rocksdb_bulk_load=1;
INSERT INTO s2_profile_tracking (region_id, local_profile_id, map_stats_updated_at, name_updated_at)
SELECT
spt.region_id,
(spt.profile_id | (CASE WHEN spt.realm_id = 2 THEN CAST(0x80000000 AS DECIMAL) ELSE 0 END)),
spt.map_stats_updated_at,
(CASE WHEN spt.name_updated_at = '1000-01-01 00:00:00' THEN NULL ELSE spt.name_updated_at END)
FROM s2_profile_tracking_old spt
ORDER BY (spt.profile_id | (CASE WHEN spt.realm_id = 2 THEN CAST(0x80000000 AS DECIMAL) ELSE 0 END)) ASC, spt.region_id ASC
;
SET session sql_log_bin=1;
SET session rocksdb_bulk_load=0;

DROP TABLE s2_profile_tracking_old;

--
-- fix map tracking
--

RENAME TABLE s2_map_tracking TO s2_map_tracking_old;

CREATE TABLE `s2_map_tracking` (`map_id` mediumint UNSIGNED NOT NULL, `region_id` tinyint UNSIGNED NOT NULL, `last_checked_at` datetime NULL, `last_seen_available_at` datetime NULL, `first_seen_unvailable_at` datetime NULL, `unavailability_counter` smallint UNSIGNED NOT NULL DEFAULT 0, `reviews_updated_entirely_at` datetime NULL, `reviews_updated_partially_at` datetime NULL, INDEX `last_checked_at_idx` (`last_checked_at`), INDEX `unavailability_counter_idx` (`unavailability_counter`), INDEX `reviews_updated_entirely_at_idx` (`reviews_updated_entirely_at`), PRIMARY KEY (`map_id`, `region_id`)) ENGINE=ROCKSDB;

SET session sql_log_bin=0;
SET session rocksdb_bulk_load=1;
INSERT INTO s2_map_tracking (region_id, map_id, last_checked_at, last_seen_available_at, first_seen_unvailable_at, unavailability_counter)
SELECT
smt.region_id,
smt.bnet_id,
smt.last_checked_at,
smt.last_seen_available_at,
smt.first_seen_unvailable_at,
smt.unavailability_counter
FROM s2_map_tracking_old smt
ORDER BY smt.bnet_id ASC, smt.region_id ASC
;
SET session sql_log_bin=1;
SET session rocksdb_bulk_load=0;

DROP TABLE s2_map_tracking_old;

--
-- reviews
--

CREATE TABLE `s2_map_review_revision` (`review_id` int UNSIGNED NOT NULL, `date` datetime(0) NOT NULL, `rating` tinyint UNSIGNED NOT NULL, `body` text NULL, INDEX `review_idx` (`review_id`), PRIMARY KEY (`review_id`, `date`)) ENGINE=ROCKSDB;
CREATE TABLE `s2_map_review` (`id` int UNSIGNED NOT NULL AUTO_INCREMENT, `region_id` tinyint UNSIGNED NOT NULL, `author_local_profile_id` int UNSIGNED NOT NULL, `map_id` mediumint UNSIGNED NOT NULL, `created_at` datetime(0) NOT NULL, `updated_at` datetime(0) NOT NULL, `rating` tinyint UNSIGNED NOT NULL, `helpful_count` mediumint UNSIGNED NOT NULL, `body` text NULL, INDEX `map_region_helpful_idx` (`map_id`, `region_id`, `helpful_count`), INDEX `map_region_rating_idx` (`map_id`, `region_id`, `rating`), INDEX `map_region_date_idx` (`map_id`, `region_id`, `updated_at`), UNIQUE INDEX `author_region_map_idx` (`author_local_profile_id`, `region_id`, `map_id`), PRIMARY KEY (`id`)) ENGINE=ROCKSDB;

ALTER TABLE `s2_map` ADD `user_reviews_count` smallint UNSIGNED NOT NULL DEFAULT 0 AFTER `published_at`;
ALTER TABLE `s2_map` ADD `user_reviews_rating` decimal(4,3) UNSIGNED NOT NULL DEFAULT 0 AFTER `user_reviews_count`;
CREATE INDEX `user_reviews_count_idx` ON `s2_map` (`user_reviews_count`);
CREATE INDEX `user_reviews_rating` ON `s2_map` (`user_reviews_rating`);
