import * as orm from 'typeorm';
import * as pMap from 'p-map';
import { addDays, addWeeks, addMonths, addSeconds } from 'date-fns';
import { S2GameLobbyRepository } from '../repository/S2GameLobbyRepository';
import { logger, logIt } from '../logger';
import { S2GameLobbySlotKind, S2GameLobbySlot } from '../entity/S2GameLobbySlot';
import { S2StatsPeriod, S2StatsPeriodKind } from '../entity/S2StatsPeriod';
import { S2StatsPeriodMap } from '../entity/S2StatsPeriodMap';
import { S2GameLobby } from '../entity/S2GameLobby';
import { GameLobbyStatus } from '../gametracker';
import { S2StatsPeriodRegion } from '../entity/S2StatsPeriodRegion';
import { S2GameLobbyMap } from '../entity/S2GameLobbyMap';
import { GameRegion } from '../common';

function hasProfileIds(statPeriod: S2StatsPeriod) {
    return statPeriod.dateFrom >= new Date('2020-04-27');
}

interface MapStatTmp {
    regionId: number;
    bnetId: number;
    lobbyIds: number[];
    lobbiesHosted: number;
    lobbiesStarted: number;
    participantsTotal: number;
    participantsUniqueTotal: number;
    pendingTime: number[];
}

async function generateMapStats(conn: orm.Connection, statPeriod: S2StatsPeriod, includedRegions: Set<GameRegion>) {
    const mapStats = new Map<string, MapStatTmp>();

    let lrecords = await conn.getRepository(S2GameLobbyMap)
        .createQueryBuilder('lmap')
        .innerJoin('lmap.lobby', 'lobby')
        .select([])
        .addSelect('lmap.regionId', 'regionId')
        .addSelect('lmap.bnetId', 'bnetId')
        .addSelect('lobby.id', 'lobbyId')
        .addSelect('lobby.status', 'status')
        .addSelect('UNIX_TIMESTAMP(lobby.closedAt) - UNIX_TIMESTAMP(lobby.createdAt)', 'pendingTime')
        .andWhere('lobby.closedAt >= :from AND lobby.closedAt < :to', { from: statPeriod.dateFrom, to: statPeriod.dateTo })
        .andWhere('lobby.regionId IN (:includedRegions)', { includedRegions: Array.from(includedRegions.values()) })
        .getRawMany()
    ;
    logger.verbose(`LobbyMap records=${lrecords.length}`);

    for (const record of lrecords) {
        const mkey = `${record.regionId}/${record.bnetId}`;
        let mstat =  mapStats.get(mkey);
        if (!mstat) {
            mstat = {
                regionId: record.regionId,
                bnetId: record.bnetId,
                lobbyIds: [],
                lobbiesHosted: 0,
                lobbiesStarted: 0,
                participantsTotal: 0,
                participantsUniqueTotal: 0,
                pendingTime: [],
            };
            mapStats.set(mkey, mstat);
        }
        mstat.lobbyIds.push(record.lobbyId);
        ++mstat.lobbiesHosted;
        if (record.status === GameLobbyStatus.Started) {
            ++mstat.lobbiesStarted;
            mstat.pendingTime.push(Number(record.pendingTime));
        }
    }

    lrecords = [];

    async function getParticipantsData(regionId: number, bnetId: number, lobbyIds?: number[]) {
        const qb = conn.getCustomRepository(S2GameLobbyRepository)
            .createQueryBuilder('lobby')
            .leftJoin('lobby.slots', 'slot')
            .select([])
            .addSelect('COUNT(DISTINCT slot.id)', 'participantsTotal')
            .addSelect('COUNT(DISTINCT slot.profile)', 'participantsUniqueTotal')
        ;

        if (lobbyIds) {
            qb.andWhere(`lobby.id IN (${lobbyIds.join(',')})`);
        }
        else {
            qb.andWhere('lobby.regionId = :regionId AND lobby.mapBnetId = :mapBnetId', { regionId: regionId, mapBnetId: bnetId });
            qb.andWhere('lobby.closedAt >= :from AND lobby.closedAt < :to', { from: statPeriod.dateFrom, to: statPeriod.dateTo });
        }

        qb
            .andWhere('lobby.status = :status', { status: GameLobbyStatus.Started })
            .andWhere('slot.kind = :kind', { kind: S2GameLobbySlotKind.Human })
        ;
        const slotMap = await qb.getRawOne();

        return [ Number(slotMap.participantsTotal), Number(slotMap.participantsUniqueTotal) ];
    }

    await pMap(mapStats.values(), async (mstat) => {
        [ mstat.participantsTotal, mstat.participantsUniqueTotal ] = await getParticipantsData(
            mstat.regionId,
            mstat.bnetId,
            mstat.lobbyIds.length < 50000 ? mstat.lobbyIds : void 0
        );
        if (!hasProfileIds(statPeriod)) {
            mstat.participantsUniqueTotal = null;
        }
    }, {
        concurrency: 5,
    });

    logger.verbose(`stat records=${mapStats.size}`);
    const inserts = Array.from(mapStats.values()).map(x => {
        return {
            period: statPeriod,
            regionId: x.regionId,
            bnetId: x.bnetId,
            lobbiesHosted: x.lobbiesHosted,
            lobbiesStarted: x.lobbiesStarted,
            participantsTotal: x.participantsTotal,
            participantsUniqueTotal: x.participantsUniqueTotal,
            pendingTimeAverage: x.pendingTime.length ? Math.abs(x.pendingTime.reduce((prev, curr) => prev + curr, 0) / x.pendingTime.length) : 0,
        } as Partial<S2StatsPeriodMap>;
    });

    await conn.getRepository(S2StatsPeriodMap).insert(inserts);
}

async function generateRegionStats(conn: orm.Connection, statPeriod: S2StatsPeriod, includedRegions: Set<GameRegion>) {
    const regRecords = await conn.getRepository(S2GameLobby)
        .createQueryBuilder('lobby')
        .select([])
        .leftJoin('lobby.slots', 'slot')
        .addSelect('lobby.regionId', 'regionId')
        .addSelect('COUNT(DISTINCT lobby.id)', 'lobbiesHosted')
        .addSelect('COUNT(DISTINCT CASE WHEN lobby.status = \'started\' THEN lobby.id END)', 'lobbiesStarted')
        .addSelect('COUNT(DISTINCT slot.id)', 'participantsTotal')
        .addSelect('COUNT(DISTINCT slot.profile)', 'participantsUniqueTotal')
        .andWhere('lobby.closedAt >= :from AND lobby.closedAt < :to', { from: statPeriod.dateFrom, to: statPeriod.dateTo })
        .andWhere('lobby.regionId IN (:includedRegions)', { includedRegions: Array.from(includedRegions.values()) })
        .groupBy('lobby.regionId')
        .getRawMany()
    ;

    for (const statsRecord of regRecords) {
        if (!hasProfileIds(statPeriod)) {
            statsRecord.participantsUniqueTotal = null;
        }
        await conn.getRepository(S2StatsPeriodRegion).insert({
            period: statPeriod,
            regionId: statsRecord.regionId,
            lobbiesHosted: statsRecord.lobbiesHosted,
            lobbiesStarted: statsRecord.lobbiesStarted,
            participantsTotal: statsRecord.participantsTotal,
            participantsUniqueTotal: statsRecord.participantsUniqueTotal,
        });
    }
}

export async function buildStatsForPeriod(conn: orm.Connection, statKind: S2StatsPeriodKind) {
    function incDate(currDate: Date) {
        switch (statKind) {
            case S2StatsPeriodKind.Daily:
            {
                return addDays(currDate, 1);
            }
            case S2StatsPeriodKind.Weekly:
            {
                return addWeeks(currDate, 1);
            }
            case S2StatsPeriodKind.Monthly:
            {
                return addMonths(currDate, 1);
            }
        }
    }

    const statDateResult = await conn.getRepository(S2StatsPeriod)
        .createQueryBuilder('stPer')
        .select('MAX(stPer.dateFrom)', 'dateFrom')
        .andWhere('kind = :kind', { kind: statKind })
        .andWhere('stPer.completed = true')
        .getRawOne()
    ;

    let currDate = statDateResult?.dateFrom;
    if (currDate) {
        currDate = incDate(currDate);
    }
    else {
        switch (statKind) {
            case S2StatsPeriodKind.Daily:
            case S2StatsPeriodKind.Weekly: {
                currDate = new Date('2020-01-27');
                break;
            }
            case S2StatsPeriodKind.Monthly: {
                currDate = new Date('2020-02-01');
                break;
            }
        }
    }

    while (incDate(currDate) < new Date()) {
        logger.info(`fetching ${currDate.toDateString()} kind=${statKind}..`);
        await conn.getRepository(S2StatsPeriod)
            .createQueryBuilder()
            .delete()
            .andWhere('dateFrom = :dateFrom', { dateFrom: currDate })
            .andWhere('kind = :kind', { kind: statKind })
            .execute()
        ;
        const statPeriod = new S2StatsPeriod();
        statPeriod.kind = statKind;
        statPeriod.dateFrom = currDate;
        statPeriod.dateTo = incDate(currDate);
        await conn.getRepository(S2StatsPeriod).save(statPeriod);

        const includedRegions = new Set<GameRegion>([
            GameRegion.US,
            GameRegion.EU,
            GameRegion.KR,
        ]);

        // TODO: put a date in condition once it'll be stable
        if (false) {
            includedRegions.add(GameRegion.CN);
        }

        logger.info('generating region stats..');
        await generateRegionStats(conn, statPeriod, includedRegions);
        logger.info('generating map stats..');
        await generateMapStats(conn, statPeriod, includedRegions);

        statPeriod.completed = true;
        await conn.getRepository(S2StatsPeriod).save(statPeriod);
        logger.info(`done ${currDate.toDateString()} kind=${statKind}`);

        currDate = incDate(currDate);
    }
}
