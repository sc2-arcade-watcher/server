SET @@session.time_zone = '+00:00';

UPDATE s2_profile_tracking
SET name_updated_at = '1000-01-01 00:00:00'
WHERE name_updated_at = '0000-00-00 00:00:00'
;

ALTER TABLE `s2_profile_tracking` CHANGE `name_updated_at` `name_updated_at` datetime NOT NULL DEFAULT '1000-01-01 00:00:00';
