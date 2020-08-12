import * as orm from 'typeorm';
import { addDays, addWeeks, addMonths, addSeconds } from 'date-fns';
import { S2GameLobbyRepository } from '../repository/S2GameLobbyRepository';
import { logger, logIt } from '../logger';
import { S2GameLobbySlotKind, S2GameLobbySlot } from '../entity/S2GameLobbySlot';
import { S2StatsPeriod, S2StatsPeriodKind } from '../entity/S2StatsPeriod';
import { S2StatsPeriodMap } from '../entity/S2StatsPeriodMap';
import { S2GameLobby } from '../entity/S2GameLobby';
import { GameLobbyStatus } from '../gametracker';
import { S2StatsPeriodRegion } from '../entity/S2StatsPeriodRegion';

function hasProfileIds(statPeriod: S2StatsPeriod) {
    return statPeriod.dateFrom >= new Date('2020-04-27');
}

async function generateMapStats(conn: orm.Connection, statPeriod: S2StatsPeriod) {
    const lobRecords = await conn.getCustomRepository(S2GameLobbyRepository)
        .createQueryBuilder('lobby')
        .select([])
        .addSelect('lobby.regionId', 'regionId')
        .addSelect('lobby.mapBnetId', 'mapBnetId')
        .addSelect('COUNT(DISTINCT lobby.id)', 'lobbiesHosted')
        .addSelect('SUM(lobby.status = \'started\')', 'lobbiesStarted')
        .addSelect('ABS(AVG(CASE WHEN lobby.status = \'started\' THEN (UNIX_TIMESTAMP(lobby.closedAt) - UNIX_TIMESTAMP(lobby.createdAt)) ELSE 0 END))', 'pendingTimeAverage')
        .andWhere('lobby.closedAt >= :from AND lobby.closedAt < :to', { from: statPeriod.dateFrom, to: statPeriod.dateTo })
        .groupBy('lobby.regionId, lobby.mapBnetId')
        .getRawMany()
    ;

    for (const [i, lobMap] of lobRecords.entries()) {
        const slotMap = await conn.getCustomRepository(S2GameLobbyRepository)
            .createQueryBuilder('lobby')
            .leftJoin('lobby.slots', 'slot')
            .select([])
            .addSelect('COUNT(DISTINCT slot.id)', 'participantsTotal')
            .addSelect('COUNT(DISTINCT IFNULL(slot.profile, slot.name))', 'participantsUniqueTotal')
            .andWhere('lobby.regionId = :regionId AND lobby.mapBnetId = :mapBnetId', { regionId: lobMap.regionId, mapBnetId: lobMap.mapBnetId })
            .andWhere('lobby.status = :status', { status: GameLobbyStatus.Started })
            .andWhere('lobby.closedAt >= :from AND lobby.closedAt < :to', { from: statPeriod.dateFrom, to: statPeriod.dateTo })
            .andWhere('slot.kind = :kind', { kind: S2GameLobbySlotKind.Human })
            .getRawOne()
        ;

        const statsRecord = {
            ...lobMap,
            ...slotMap,
        };
        for (const [k, v] of Object.entries(statsRecord)) {
            statsRecord[k] = Number(v);
        }

        if (!hasProfileIds(statPeriod)) {
            statsRecord.participantsUniqueTotal = null;
        }
        await conn.getRepository(S2StatsPeriodMap).insert({
            period: statPeriod,
            regionId: statsRecord.regionId,
            bnetId: statsRecord.mapBnetId,
            lobbiesHosted: statsRecord.lobbiesHosted,
            lobbiesStarted: statsRecord.lobbiesStarted,
            participantsTotal: statsRecord.participantsTotal,
            participantsUniqueTotal: statsRecord.participantsUniqueTotal,
            pendingTimeAverage: statsRecord.pendingTimeAverage,
        });
    }
}

async function generateRegionStats(conn: orm.Connection, statPeriod: S2StatsPeriod) {
    const regRecords = await conn.getRepository(S2GameLobby)
        .createQueryBuilder('lobby')
        .select([])
        .leftJoin('lobby.slots', 'slot')
        .addSelect('lobby.regionId', 'regionId')
        .addSelect('COUNT(DISTINCT lobby.id)', 'lobbiesHosted')
        .addSelect('COUNT(DISTINCT CASE WHEN lobby.status = \'started\' THEN lobby.id END)', 'lobbiesStarted')
        .addSelect('COUNT(DISTINCT slot.id)', 'participantsTotal')
        .addSelect('COUNT(DISTINCT IFNULL(slot.profile, slot.name))', 'participantsUniqueTotal')
        .andWhere('lobby.closedAt >= :from AND lobby.closedAt < :to', { from: statPeriod.dateFrom, to: statPeriod.dateTo })
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
            case S2StatsPeriodKind.Weekly:
            {
                currDate = new Date('2020-01-27');
                break;
            }
            case S2StatsPeriodKind.Monthly:
            {
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

        logger.info('generating region stats..');
        await generateRegionStats(conn, statPeriod);
        logger.info('generating map stats..');
        await generateMapStats(conn, statPeriod);

        statPeriod.completed = true;
        await conn.getRepository(S2StatsPeriod).save(statPeriod);

        currDate = incDate(currDate);
    }
}
