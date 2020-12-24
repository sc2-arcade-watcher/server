import * as util from 'util';
import * as orm from 'typeorm';
import * as program from 'commander';
import * as pMap from 'p-map';
import { MapResolver, reprocessMapHeader } from '../map/mapResolver';
import { S2Map } from '../entity/S2Map';
import { logger } from '../logger';
import { MapIndexer } from '../map/mapIndexer';
import { S2MapHeader } from '../entity/S2MapHeader';
import { S2MapRepository } from '../repository/S2MapRepository';
import { oneLine } from 'common-tags';

program.command('map:dump-header <region> <hash>')
    .action(async (region: string, hash: string) => {
        const conn = await orm.createConnection();
        const mpresolver = new MapResolver(conn);

        const mapHeader = await mpresolver.getMapHeader(region, hash);
        const mapLocalization = await mpresolver.getMapLocalization(region, mapHeader.localeTable[0].stringTable[0].hash);
        const mapDetails = reprocessMapHeader(mapHeader, mapLocalization);
        console.log(util.inspect(mapDetails, {
            depth: 6,
            colors: true,
        }));

        await conn.close();
    })
;

program.command('map:update-info')
    .option<Number>('--id <number>', 'db id', Number, null)
    .option<String>('--global-id <string>', 'bnet map id, in format "regionId/mapId"', (value, previous) => String(value), null)
    .option<Number>('--offset <number>', 'offset', Number, null)
    .option<Number>('--concurrency <number>', 'concurrency', Number, 5)
    .option('--initial-only', 'reindex only initial version', false)
    .option('--latest-only', 'reindex only latest version', false)
    .action(async function (cmd: program.Command) {
        const conn = await orm.createConnection();
        const mIndexer = new MapIndexer(conn);
        await mIndexer.load();
        const qb = conn.getRepository(S2Map).createQueryBuilder('map')
            .select('map.id', 'id')
            .addOrderBy('map.id', 'ASC')
        ;

        if (cmd.id) {
            qb.andWhere('map.id = :id', { id: cmd.id });
        }

        if (cmd.globalId) {
            const matches = (cmd.globalId as string).match(/^(\d+)\/(\d+)$/);
            if (!matches) {
                logger.error('invalid param');
                return;
            }

            qb.andWhere('map.regionId = :regionId AND map.bnetId = :bnetId', {
                regionId: Number(matches[1]),
                bnetId: Number(matches[2]),
            });
        }

        if (cmd.offset) {
            qb.andWhere('map.id >= :offset', { offset: cmd.offset });
        }

        const activeJobIds = new Set<number>();
        const listMapIds = (await qb.getRawMany()).map(x => x.id);
        await pMap(listMapIds, async (mapId) => {
            activeJobIds.add(mapId);
            const qb = conn.getCustomRepository(S2MapRepository).prepareDetailedSelect();
            qb.whereInIds(mapId);
            const map = await qb.getOne();
            const mHeaders = await conn.getRepository(S2MapHeader).createQueryBuilder('mhead')
                .andWhere('mhead.regionId = :regionId AND mhead.bnetId = :bnetId', {
                    regionId: map.regionId,
                    bnetId: map.bnetId,
                })
                .addOrderBy('mhead.majorVersion', 'ASC')
                .addOrderBy('mhead.minorVersion', 'ASC')
                .getMany()
            ;

            const vTotal = mHeaders.length;
            for (const [verIndex, verInfo] of mHeaders.entries()) {
                const isLatest = verIndex === vTotal - 1;
                const isInitial = verIndex === 0;
                if ((cmd.latestOnly && !isLatest) || (cmd.initialOnly && !isInitial)) {
                    continue;
                }
                logger.verbose(oneLine`
                    [${map.id.toString().padStart(6, ' ')}/${listMapIds[listMapIds.length - 1].toString().padStart(6, ' ')}]
                    Processing map version
                    - ${(verIndex + 1).toString().padStart(4, ' ')}/${vTotal.toString().padEnd(4, ' ')}
                    - ${verInfo.linkVer}
                `);
                await mIndexer.updateMapDataFromHeader(map, verInfo, void 0, true);
            }
            await mIndexer.saveMap(map);

            const checkpointId = Array.from(activeJobIds.values()).sort((a, b) => a - b)[0];
            activeJobIds.delete(mapId);
            logger.info(oneLine`
                [${map.id.toString().padStart(6, ' ')}/${listMapIds[listMapIds.length - 1].toString().padStart(6, ' ')}]
                Map done
                ${map.currentVersion.linkVer.padEnd(16, ' ')}
                - checkpoint ${checkpointId}
            `);
        }, {
            concurrency: cmd.concurrency,
        });
        await conn.close();
    })
;


program.command('map:update-header')
    .option<Number>('--id <number>', 'db id', Number, null)
    .option<String>('--global-id <string>', 'bnet map id, in format "regionId/mapId"', (value, previous) => String(value), null)
    .option<Number>('--offset <number>', 'offset', Number, null)
    .option<Number>('--concurrency <number>', 'concurrency', Number, 5)
    .action(async function (cmd: program.Command) {
        const conn = await orm.createConnection();
        const mIndexer = new MapIndexer(conn);
        await mIndexer.load();
        const qb = conn.getRepository(S2MapHeader).createQueryBuilder('mhead')
            .select('mhead.id', 'id')
            .addOrderBy('mhead.id', 'ASC')
        ;

        if (cmd.id) {
            qb.andWhere('mhead.id = :id', { id: cmd.id });
        }

        if (cmd.globalId) {
            const matches = (cmd.globalId as string).match(/^(\d+)\/(\d+)$/);
            if (!matches) {
                logger.error('invalid param');
                return;
            }

            qb.andWhere('mhead.regionId = :regionId AND mhead.bnetId = :bnetId', {
                regionId: Number(matches[1]),
                bnetId: Number(matches[2]),
            });
        }

        if (cmd.offset) {
            qb.andWhere('mhead.id >= :offset', { offset: cmd.offset });
        }

        const lRawIds = (await qb.getRawMany()).map(x => x.id);
        await pMap(lRawIds, async (mapHeaderId) => {
            const mhead = await conn.getRepository(S2MapHeader).findOne({ id: mapHeaderId });
            await mIndexer.populateMapHeader(mhead);
            await conn.getRepository(S2MapHeader).save(mhead, { transaction: false });

            logger.info(oneLine`
                [${mhead.id.toString().padStart(7, ' ')}/${lRawIds[lRawIds.length - 1].toString().padStart(7, ' ')}]
                ${mhead.linkVer}
            `);
        }, {
            concurrency: cmd.concurrency,
        });

        await conn.close();
    })
;
