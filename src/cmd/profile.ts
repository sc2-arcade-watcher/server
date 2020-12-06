import * as orm from 'typeorm';
import * as program from 'commander';
import * as pMap from 'p-map';
import { S2Profile } from '../entity/S2Profile';
import { logger } from '../logger';
import { S2GameLobbyPlayerJoin } from '../entity/S2GameLobbyPlayerJoin';
import { S2Map } from '../entity/S2Map';
import { formatISO } from 'date-fns';
import { oneLine } from 'common-tags';
import { S2ProfileMatch } from '../entity/S2ProfileMatch';

program.command('profile:update-last-online')
    .option<Number>('--id <number>', 'db id', (value, previous) => Number(value), null)
    .option<Number>('--offset <number>', 'offset', (value, previous) => Number(value), null)
    .option<Number>('--concurrency <number>', 'concurrency', (value, previous) => Number(value), 5)
    .option('--desc', '', false)
    .action(async function (cmd: program.Command) {
        const conn = await orm.createConnection();

        let lastRecordId: number | null = cmd.offset;

        while (true) {
            const qb = conn.getRepository(S2Profile).createQueryBuilder('profile')
                .limit(5000)
            ;

            if (lastRecordId !== null) {
                if (cmd.desc) {
                    qb.andWhere('profile.id < :lastRecordId', { lastRecordId: lastRecordId });
                }
                else {
                    qb.andWhere('profile.id > :lastRecordId', { lastRecordId: lastRecordId });
                }
            }

            if (cmd.desc) {
                qb.addOrderBy('profile.id', 'DESC');
            }
            else {
                qb.addOrderBy('profile.id', 'ASC');
            }

            if (cmd.id) {
                qb.andWhere('profile.id = :id', { id: cmd.id });
            }

            const results = await qb.getMany();
            if (!results.length) break;

            lastRecordId = results[results.length - 1].id;
            logger.verbose(`Retrieved ${results.length} records.. lastRecordId=${lastRecordId}`);

            await pMap(results, async (profile) => {
                const recentLobbyJoin = await conn.getRepository(S2GameLobbyPlayerJoin).createQueryBuilder('joinInfo')
                    .select([])
                    .addSelect('joinInfo.joinedAt', 'date')
                    .andWhere('joinInfo.profile = :pid', { pid: profile.id })
                    .orderBy('joinInfo.joinedAt', 'DESC')
                    .limit(1)
                    .getRawOne()
                ;
                const recentMapUpload = await conn.getRepository(S2Map).createQueryBuilder('map')
                    .select([])
                    .addSelect('map.updatedAt', 'date')
                    .andWhere('map.author = :pid', { pid: profile.id })
                    .orderBy('map.updatedAt', 'DESC')
                    .limit(1)
                    .getRawOne()
                ;
                const recentMatch = await conn.getRepository(S2ProfileMatch).createQueryBuilder('profMatch')
                    .select([])
                    .addSelect('profMatch.date', 'date')
                    .andWhere('profMatch.regionId = :regionId AND profMatch.realmId = :realmId AND profMatch.profileId = :profileId', {
                        regionId: profile.regionId,
                        realmId: profile.realmId,
                        profileId: profile.profileId,
                    })
                    .orderBy('profMatch.id', 'DESC')
                    .limit(1)
                    .getRawOne()
                ;

                let lastOnlineAt: Date = profile.lastOnlineAt;
                if (recentLobbyJoin?.date && (!lastOnlineAt || recentLobbyJoin.date > lastOnlineAt)) {
                    lastOnlineAt = recentLobbyJoin.date;
                }
                if (recentMapUpload?.date && (!lastOnlineAt || recentMapUpload.date > lastOnlineAt)) {
                    lastOnlineAt = recentMapUpload.date;
                }
                if (recentMatch?.date && (!lastOnlineAt || recentMatch.date > lastOnlineAt)) {
                    lastOnlineAt = recentMatch.date;
                }

                if (lastOnlineAt === null) {
                    logger.debug(`[${profile.id}] ${profile.name}#${profile.discriminator} - null activity`);
                }
                else if (profile.lastOnlineAt === null || lastOnlineAt.getTime() - profile.lastOnlineAt.getTime() > 1000) {
                    await conn.getRepository(S2Profile).update(profile.id, {
                        lastOnlineAt: lastOnlineAt,
                    });

                    logger.info(oneLine`
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
