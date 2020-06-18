import * as orm from 'typeorm';
import { addWeeks, addDays } from 'date-fns';
import { BattleDepot, convertImage, NestedHashDir } from '../depot';
import { S2GameLobbyRepository } from '../repository/S2GameLobbyRepository';
import { logger, logIt } from '../logger';
import { S2GameLobbySlotKind, S2GameLobbySlot } from '../entity/S2GameLobbySlot';
import { S2Document } from '../entity/S2Document';
import { S2StatsPeriod } from '../entity/S2StatsPeriod';
import { S2StatsPeriodMap } from '../entity/S2StatsPeriodMap';


async function generateMapStats(conn: orm.Connection, statPeriod: S2StatsPeriod) {
    logger.info(`fetching ${statPeriod.dateFrom.toDateString()} len=${statPeriod.length}..`);

    const dateTo = addDays(statPeriod.dateFrom, statPeriod.length);

    const lobRecords = await conn.getCustomRepository(S2GameLobbyRepository)
        .createQueryBuilder('lobby')
        .select([])
        .addSelect(qb => {
            return qb
                .from(S2Document, 'map')
                .select('map.id')
                .where('map.regionId = lobby.regionId AND map.bnetId = lobby.mapBnetId')
                .limit(1)
            ;
        }, 'docId')
        .addSelect('lobby.regionId', 'regionId')
        .addSelect('lobby.mapBnetId', 'mapBnetId')
        .addSelect('GROUP_CONCAT(lobby.id SEPARATOR \',\')', 'lobbyIds')
        .addSelect('COUNT(DISTINCT lobby.id)', 'lobbiesHosted')
        .addSelect('SUM(lobby.status = \'started\')', 'lobbiesStarted')
        .addSelect('ABS(AVG(CASE WHEN lobby.status = \'started\' THEN (UNIX_TIMESTAMP(lobby.closedAt) - UNIX_TIMESTAMP(lobby.createdAt)) ELSE 0 END))', 'pendingTimeAverage')
        .andWhere('lobby.closedAt >= :from AND lobby.closedAt < :to', { from: statPeriod.dateFrom, to: dateTo })
        .groupBy('lobby.regionId, lobby.mapBnetId')
        .addOrderBy('lobbiesHosted', 'DESC')
        .getRawMany()
    ;
    logger.info(`result count=${lobRecords.length}`);

    for (const [i, lobMap] of lobRecords.entries()) {
        // logger.info('dump', lobMap);
        const lobIds = lobMap.lobbyIds;
        delete lobMap.lobbyIds;
        const slotMap = await conn.getRepository(S2GameLobbySlot)
            .createQueryBuilder('slot')
            .select([])
            .innerJoin('slot.lobby', 'lobby')
            .addSelect('COUNT(DISTINCT slot.id)', 'participantsTotal')
            .addSelect('COUNT(DISTINCT IFNULL(slot.profile, slot.name))', 'participantsUniqueTotal')
            .andWhere('lobby.status = \'started\'')
            .andWhere('slot.lobby_id IN (' + lobIds + ')')
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

        if (statPeriod.dateFrom < new Date('2020-04-27')) {
            statsRecord.participantsUniqueTotal = 0;
        }
        await conn.getRepository(S2StatsPeriodMap).insert({
            period: statPeriod,
            document: statsRecord.docId,
            lobbiesHosted: statsRecord.lobbiesHosted,
            lobbiesStarted: statsRecord.lobbiesStarted,
            participantsTotal: statsRecord.participantsTotal,
            participantsUniqueTotal: statsRecord.participantsUniqueTotal,
            pendingTimeAverage: statsRecord.pendingTimeAverage,
        });
        // logger.info(`dump [${i + 1}/${lobRecords.length}]`, statsRecord);
    }
}

export async function buildStatsForPeriod(conn: orm.Connection, statPeriodLength: number) {
    const statDateResult = await conn.getRepository(S2StatsPeriod)
        .createQueryBuilder('stPer')
        .select('MAX(stPer.dateFrom)', 'dateFrom')
        .andWhere('stPer.completed = true AND length = :length', { length: statPeriodLength })
        .getRawOne()
    ;

    let currDate = statDateResult?.dateFrom;
    if (currDate) {
        currDate = addDays(currDate, statPeriodLength);
    }
    else {
        currDate = new Date('2020-01-27');
    }

    while (addDays(currDate, statPeriodLength) < new Date()) {
        await conn.getRepository(S2StatsPeriod)
            .createQueryBuilder()
            .delete()
            .where('dateFrom = :dateFrom AND length = :length', { dateFrom: currDate, length: statPeriodLength })
            .execute()
        ;
        const statPeriod = new S2StatsPeriod();
        statPeriod.dateFrom = currDate;
        statPeriod.length = statPeriodLength;
        await conn.getRepository(S2StatsPeriod).save(statPeriod);

        await generateMapStats(conn, statPeriod);
        statPeriod.completed = true;
        await conn.getRepository(S2StatsPeriod).save(statPeriod);

        currDate = addDays(currDate, statPeriodLength);
    }
}
