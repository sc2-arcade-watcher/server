import * as orm from 'typeorm';
import * as program from 'commander';
import * as pMap from 'p-map';
import { S2Profile } from '../entity/S2Profile';
import { logger } from '../logger';
import { S2GameLobbyPlayerJoin } from '../entity/S2GameLobbyPlayerJoin';
import { S2Map } from '../entity/S2Map';
import { formatISO } from 'date-fns';
import { oneLine } from 'common-tags';

program.command('profile:update-last-online')
    .option<Number>('--id [number]', 'db id', (value, previous) => Number(value), null)
    .option<Number>('--offset [number]', 'offset', (value, previous) => Number(value), 0)
    .option<Number>('--concurrency [number]', 'concurrency', (value, previous) => Number(value), 5)
    .action(async function (cmd: program.Command) {
        const conn = await orm.createConnection();

        let lastRecordId = cmd.offset;

        while (true) {
            const qb = conn.getRepository(S2Profile).createQueryBuilder('profile')
                .andWhere('profile.id > :lastRecordId', { lastRecordId: lastRecordId })
                .limit(5000)
            ;

            if (cmd.id) {
                qb.andWhere('profile.id = :id', { id: cmd.id });
            }

            const results = await qb.getMany();
            if (!results.length) break;

            lastRecordId = results[results.length - 1].id;
            logger.info(`Retrieved ${results.length} records.. lastRecordId=${lastRecordId}`);

            await pMap(results, async (profile) => {
                const lobbyJoin = await conn.getRepository(S2GameLobbyPlayerJoin).createQueryBuilder('joinInfo')
                    .select([])
                    .addSelect('MAX(joinInfo.joinedAt)', 'date')
                    .andWhere('joinInfo.profile = :pid', { pid: profile.id })
                    .getRawOne()
                ;
                const mapUpload = await conn.getRepository(S2Map).createQueryBuilder('map')
                    .select([])
                    .addSelect('MAX(map.updatedAt)', 'date')
                    .andWhere('map.author = :pid', { pid: profile.id })
                    .getRawOne()
                ;

                let lastOnlineAt: Date = profile.lastOnlineAt;
                if (lobbyJoin.date && (!lastOnlineAt || lobbyJoin.date > lastOnlineAt)) {
                    lastOnlineAt = lobbyJoin.date;
                }
                if (mapUpload.date && (!lastOnlineAt || mapUpload.date > lastOnlineAt)) {
                    lastOnlineAt = mapUpload.date;
                }

                if (lastOnlineAt === null) {
                    logger.warn(`[${profile.id}] ${profile.name}#${profile.discriminator} - null activity`);
                }
                else if (profile.lastOnlineAt === null || lastOnlineAt.getTime() - profile.lastOnlineAt.getTime() > 1000) {
                    await conn.getRepository(S2Profile).update(profile.id, {
                        lastOnlineAt: lastOnlineAt,
                    });

                    logger.verbose(oneLine`
                        [${profile.id}] ${profile.name}#${profile.discriminator}.
                        curr=${formatISO(lastOnlineAt)} prev=${profile.lastOnlineAt ? formatISO(profile.lastOnlineAt) : null}
                    `);
                }
            }, {
                concurrency: cmd.concurrency,
            });
        }

        await conn.close();
    })
;
