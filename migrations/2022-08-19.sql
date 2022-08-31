SET session sql_log_bin=0;
SET session rocksdb_bulk_load=1;

ALTER TABLE s2_map_locale ENGINE=RocksDB;
ALTER TABLE s2_map_category ENGINE=RocksDB;
ALTER TABLE s2_map_dependency ENGINE=RocksDB;
ALTER TABLE s2_map_header ENGINE=RocksDB;
ALTER TABLE s2_map_variant ENGINE=RocksDB;
ALTER TABLE s2_map ENGINE=RocksDB;

ALTER TABLE s2_stats_player_map ENGINE=RocksDB;
ALTER TABLE s2_stats_player_status ENGINE=RocksDB;

-- ALTER TABLE app_account ENGINE=RocksDB;
-- ALTER TABLE app_account_token ENGINE=RocksDB;
-- ALTER TABLE bn_account ENGINE=RocksDB;
-- ALTER TABLE bn_account_settings ENGINE=RocksDB;

-- ALTER TABLE s2_game_lobby ENGINE=RocksDB;
-- ALTER TABLE s2_game_lobby_map ENGINE=RocksDB;
-- ALTER TABLE s2_game_lobby_player_join ENGINE=RocksDB;
-- ALTER TABLE s2_game_lobby_slot ENGINE=RocksDB;
-- ALTER TABLE s2_game_lobby_title ENGINE=RocksDB;

-- ALTER TABLE s2_map ENGINE=RocksDB;
-- ALTER TABLE s2_map_category ENGINE=RocksDB;
-- ALTER TABLE s2_map_dependency ENGINE=RocksDB;
-- ALTER TABLE s2_map_header ENGINE=RocksDB;
-- ALTER TABLE s2_map_variant ENGINE=RocksDB;

-- ALTER TABLE s2_profile ENGINE=RocksDB;
-- ALTER TABLE s2_profile_account_link ENGINE=RocksDB;
-- ALTER TABLE s2_region ENGINE=RocksDB;

-- ALTER TABLE s2_stats_period ENGINE=RocksDB;
-- ALTER TABLE s2_stats_period_map ENGINE=RocksDB;
-- ALTER TABLE s2_stats_period_region ENGINE=RocksDB;

-- ALTER TABLE sys_feed_position ENGINE=RocksDB;
-- ALTER TABLE sys_feed_provider ENGINE=RocksDB;

-- ALTER TABLE tmp_query_cache ENGINE=RocksDB;

SET session rocksdb_bulk_load=0;
