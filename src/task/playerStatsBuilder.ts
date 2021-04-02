import * as orm from 'typeorm';
import * as pMap from 'p-map';
import { S2GameLobby } from '../entity/S2GameLobby';
import { addMinutes, subHours, isSameDay, differenceInDays } from 'date-fns';
import { logIt, logger } from '../logger';
import { parseProfileHandle, profileHandle, PlayerProfileParams } from '../bnet/common';
import { GameRegion } from '../common';
import { S2StatsPlayerStatus } from '../entity/S2StatsPlayerStatus';
import { S2StatsPlayerMap } from '../entity/S2StatsPlayerMap';
import { S2ProfileTracking } from '../entity/S2ProfileTracking';
import { S2Profile } from '../entity/S2Profile';
import { S2ProfileTrackingRepository } from '../repository/S2ProfileTrackingRepository';

interface PlayerMapStats {
    mapId: number;
    lobbiesStarted: number;
    lobbiesStartedDiffDays: number;
    lobbiesJoined: number;
    lobbiesHosted: number;
    lobbiesHostedStarted: number;
    timeSpentWaiting: number;
    timeSpentWaitingAsHost: number;
    lastPlayedAt: Date;
}

interface PlayerPeriodMapStats {
    regionId: number;
    realmId: number;
    profileId: number;
    fromDate: Date;
    toDate: Date;
    maps: Map<number, PlayerMapStats>;
}

interface RawLobbyStatsData {
    lobbyClosedAt: Date;
    profileHandle: string;
    mapId: number;
    extModId: number;
    globalProfileId: number;
    pendingTime: number;
    hasStarted: number;
    isHost: number;
}

function appendMapStats(pastData: S2StatsPlayerMap, newData: PlayerMapStats) {
    pastData.lobbiesStarted += newData.lobbiesStarted;
    pastData.lobbiesJoined += newData.lobbiesJoined;
    pastData.lobbiesHosted += newData.lobbiesHosted;
    pastData.lobbiesHostedStarted += newData.lobbiesHostedStarted;
    pastData.timeSpentWaiting += newData.timeSpentWaiting;
    pastData.timeSpentWaitingAsHost += newData.timeSpentWaitingAsHost;
    pastData.lobbiesStartedDiffDays += newData.lobbiesStartedDiffDays;
    if (newData.lastPlayedAt > pastData.lastPlayedAt) {
        if (newData.lobbiesStartedDiffDays === 0 && !isSameDay(pastData.lastPlayedAt, newData.lastPlayedAt)) {
            pastData.lobbiesStartedDiffDays += 1;
        }
        pastData.lastPlayedAt = newData.lastPlayedAt;
    }
}

export interface StatsBuilderPlayersOptions {
    queryConcurrency: number;
    periodDaysMax: number;
}

export type StatsBuilderPlayersOptionsOpt = Partial<StatsBuilderPlayersOptions>;

export class StatsBuilderPlayers {
    readonly options: StatsBuilderPlayersOptions;

    constructor(protected conn: orm.Connection, opts: StatsBuilderPlayersOptionsOpt = {}) {
        this.options = Object.assign<StatsBuilderPlayersOptions, StatsBuilderPlayersOptionsOpt>({
            queryConcurrency: 5,
            periodDaysMax: 7,
        }, opts);
    }

    protected async mergePlayerStats(periodStats: PlayerPeriodMapStats) {
        const profTracking = await this.conn.getCustomRepository(S2ProfileTrackingRepository).fetchOrCreate(periodStats);
        if (profTracking.mapStatsUpdatedAt && profTracking.mapStatsUpdatedAt >= periodStats.toDate) {
            // logger.debug(`skipping ${profileHandle(periodStats)} - map stats up-to-date`);
            return;
        }

        const existingPlayerMap = await this.conn.getRepository(S2StatsPlayerMap).createQueryBuilder('statPlayer')
            .andWhere('statPlayer.regionId = :regionId AND statPlayer.realmId = :realmId AND statPlayer.profileId = :profileId', {
                regionId: periodStats.regionId,
                realmId: periodStats.realmId,
                profileId: periodStats.profileId,
            })
            .andWhere('statPlayer.mapId IN (:mapIds)', {
                mapIds: Array.from(periodStats.maps.keys()),
            })
            .getMany()
        ;
        const newPlayerMap: S2StatsPlayerMap[] = [];

        for (const freshMapStats of periodStats.maps.values()) {
            let pastMapData = existingPlayerMap.find(x => x.mapId === freshMapStats.mapId);
            if (!pastMapData) {
                pastMapData = S2StatsPlayerMap.create({
                    regionId: periodStats.regionId,
                    realmId: periodStats.realmId,
                    profileId: periodStats.profileId,
                    mapId: freshMapStats.mapId,
                });
                newPlayerMap.push(pastMapData);
            }
            appendMapStats(pastMapData, freshMapStats);
        }

        profTracking.mapStatsUpdatedAt = periodStats.toDate;
        await this.conn.transaction(async (tsManager) => {
            await tsManager.getRepository(S2StatsPlayerMap).save(existingPlayerMap, { transaction: false });
            await tsManager.getRepository(S2StatsPlayerMap).insert(newPlayerMap);
            await tsManager.getRepository(S2ProfileTracking).update(tsManager.getRepository(S2ProfileTracking).getId(profTracking), {
                mapStatsUpdatedAt: profTracking.mapStatsUpdatedAt
            });
        });
    }

    // @logIt({ profTime: true })
    async buildStatsForPeriod(fromDate: Date, toDate: Date, params: { regionId: number; realmId?: number; profileId?: number; }) {
        const qb = this.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .select([])
            .innerJoin('lobby.joinHistory', 'joinHistory')
            // .addSelect(
            //     '(CONCAT(lobby.regionId, "/", lobby.bnetBucketId, "/", lobby.bnetRecordId))',
            //     'lobbyHandle'
            // )
            .addSelect(
                '(SELECT CONCAT(sp.region_id, "-S2-", sp.realm_id, "-", sp.profile_id) FROM s2_profile sp WHERE sp.id = joinHistory.profile LIMIT 1)',
                'profileHandle'
            )
            .addSelect(
                'lobby.mapBnetId',
                'mapId'
            )
            .addSelect(
                'lobby.extModBnetId',
                'extModId'
            )
            .addSelect(
                'joinHistory.profile',
                'globalProfileId'
            )
            .addSelect(
                'lobby.closedAt',
                'lobbyClosedAt'
            )
            .addSelect(
                'ROUND(FORMAT(SUM(ABS(UNIX_TIMESTAMP(IFNULL(joinHistory.leftAt, lobby.closedAt)) - UNIX_TIMESTAMP(joinHistory.joinedAt))), 2))',
                'pendingTime'
            )
            .addSelect(
                '(COUNT(DISTINCT CASE WHEN (lobby.status = \'started\' AND joinHistory.leftAt IS NULL) THEN joinHistory.lobby END) > 0)',
                'hasStarted'
            )
            .addSelect(
                '((SELECT profile_id FROM s2_game_lobby_player_join WHERE lobby_id = lobby.id ORDER BY id ASC LIMIT 1))',
                'hostProfileId'
            )
            .addSelect(
                '(joinHistory.profile = (SELECT profile_id FROM s2_game_lobby_player_join WHERE lobby_id = lobby.id ORDER BY id ASC LIMIT 1))',
                'isHost'
            )
            .andWhere('lobby.regionId = :regionId', { regionId: params.regionId })
            .andWhere('lobby.closedAt >= :from AND lobby.closedAt < :to', { from: fromDate, to: toDate })
            .addGroupBy('joinHistory.profile')
            .addGroupBy('lobby.id')
            .addOrderBy('lobby.closedAt', 'ASC')
        ;

        if (params.realmId && params.profileId) {
            const profileQuery = qb.subQuery()
                .from(S2Profile, 'profile')
                .select('profile.id')
                .andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId')
                .limit(1)
                .getQuery()
            ;
            qb.andWhere('joinHistory.profile = ' + profileQuery, {
                realmId: params.realmId,
                profileId: params.profileId,
            });
        }

        const rawLobbyStats: RawLobbyStatsData[] = await qb.getRawMany();
        logger.debug(`fetched ${rawLobbyStats.length} player-lobby records, region ${params.regionId} from=${fromDate.toISOString()} to=${toDate.toISOString()}`);

        const playersMapStats = new Map<string, PlayerPeriodMapStats>();
        for (const rawLobbyData of rawLobbyStats) {
            let profileRecord = playersMapStats.get(rawLobbyData.profileHandle);
            const profileParams = parseProfileHandle(rawLobbyData.profileHandle);
            if (!profileRecord) {
                profileRecord = {
                    ...profileParams,
                    fromDate: fromDate,
                    toDate: toDate,
                    maps: new Map(),
                };
                playersMapStats.set(rawLobbyData.profileHandle, profileRecord);
            }

            const mapIds = [rawLobbyData.mapId];
            if (rawLobbyData.extModId) {
                mapIds.push(rawLobbyData.extModId);
            }

            for (const currMapId of mapIds) {
                let mapRecord = profileRecord.maps.get(currMapId);
                if (!mapRecord) {
                    mapRecord = {
                        mapId: currMapId,
                        lobbiesHosted: 0,
                        lobbiesHostedStarted: 0,
                        lobbiesJoined: 0,
                        lobbiesStarted: 0,
                        lobbiesStartedDiffDays: 0,
                        timeSpentWaiting: 0,
                        timeSpentWaitingAsHost: 0,
                        lastPlayedAt: new Date(0),
                    };
                    profileRecord.maps.set(currMapId, mapRecord);
                }

                mapRecord.lobbiesJoined++;
                mapRecord.timeSpentWaiting += rawLobbyData.pendingTime;
                if (rawLobbyData.isHost) {
                    mapRecord.lobbiesHosted++;
                    mapRecord.timeSpentWaitingAsHost += rawLobbyData.pendingTime;
                }
                if (rawLobbyData.hasStarted) {
                    mapRecord.lobbiesStarted++;
                }
                if (rawLobbyData.isHost && rawLobbyData.hasStarted) {
                    mapRecord.lobbiesHostedStarted++;
                }
                if (rawLobbyData.hasStarted && (rawLobbyData.lobbyClosedAt > mapRecord.lastPlayedAt)) {
                    if (mapRecord.lastPlayedAt.getTime() > 0 && !isSameDay(rawLobbyData.lobbyClosedAt, mapRecord.lastPlayedAt)) {
                        mapRecord.lobbiesStartedDiffDays += 1;
                    }
                    mapRecord.lastPlayedAt = rawLobbyData.lobbyClosedAt;
                }
            }
        }

        // logger.debug(`built map stats for ${playersMapStats.size} players`);

        return playersMapStats;
    }

    async generateNextSegment(spStatus: S2StatsPlayerStatus) {
        const fromDate = spStatus.updatedAt;
        const fromCurrentDiffDays = differenceInDays(new Date(), fromDate);
        if (fromCurrentDiffDays <= 0) {
            return false;
        }

        const toDate = addMinutes(fromDate, 60 * 24 * Math.min(this.options.periodDaysMax, fromCurrentDiffDays));
        if ((new Date()) < toDate) {
            return false;
        }

        const pf = logger.startTimer();

        logger.verbose(`Building data for ${GameRegion[spStatus.regionId]} ${fromDate.toISOString()} -> ${toDate.toISOString()}`);
        const playersMapStats = await this.buildStatsForPeriod(fromDate, toDate, { regionId: spStatus.regionId });

        logger.verbose(`Merging player data (${playersMapStats.size} players)..`);
        await pMap(playersMapStats.values(), async (pStat) => {
            // logger.debug(`Processing ${profileHandle(pStat)}`);
            await this.mergePlayerStats(pStat);
        }, {
            concurrency: this.options.queryConcurrency,
        });

        spStatus.updatedAt = toDate;
        await this.conn.getRepository(S2StatsPlayerStatus).save(spStatus, { transaction: false });

        pf.done({ level: 'info', message: `Completed period ${GameRegion[spStatus.regionId]} ${fromDate.toISOString()} -> ${toDate.toISOString()}` });

        return true;
    }

    async rebuildForPlayer(params: PlayerProfileParams) {
        const spStatus = await this.conn.getRepository(S2StatsPlayerStatus).findOne({ where: { regionId: params.regionId } });
        const playersMapStats = await this.buildStatsForPeriod(new Date(0), spStatus.updatedAt, params);
        const pStat = Array.from(playersMapStats.values())[0];

        await this.conn.getRepository(S2StatsPlayerMap).delete(params);
        let profTracking = await this.conn.getRepository(S2ProfileTracking).findOne({ where: params });
        if (profTracking && profTracking.mapStatsUpdatedAt !== null) {
            profTracking.mapStatsUpdatedAt = null;
            await this.conn.getRepository(S2ProfileTracking).update(this.conn.getRepository(S2ProfileTracking).getId(profTracking), {
                mapStatsUpdatedAt: profTracking.mapStatsUpdatedAt,
            });
        }

        await this.mergePlayerStats(pStat);
    }

    async generateOverdue() {
        for (const spStatus of (await this.conn.getRepository(S2StatsPlayerStatus).find({ order: { regionId: 'ASC' } }))) {
            while ((await this.generateNextSegment(spStatus))) {}
        }
    }
}
