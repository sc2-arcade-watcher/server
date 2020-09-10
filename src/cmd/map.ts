import * as util from 'util';
import * as orm from 'typeorm';
import * as program from 'commander';
import * as pMap from 'p-map';
import { MapResolver, reprocessMapHeader } from '../task/mapResolver';
import { S2Map } from '../entity/S2Map';
import { logger } from '../logger';
import { MapIndexer } from '../server/mapIndexer';
import { S2MapHeader } from '../entity/S2MapHeader';

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

program.command('map:update-maps')
    .option<Number>('--id [number]', 'db id', (value, previous) => Number(value), null)
    .option<Number>('--offset [number]', 'offset', (value, previous) => Number(value), null)
    .option<Number>('--concurrency [number]', 'concurrency', (value, previous) => Number(value), 5)
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

        if (cmd.offset) {
            qb.andWhere('map.id >= :offset', { offset: cmd.offset });
        }

        const listMapIds = (await qb.getRawMany()).map(x => x.id);
        await pMap(listMapIds, async (mapId) => {
            const map = await conn.getRepository(S2Map).findOneOrFail(mapId, {
                relations: ['currentVersion'],
            });
            // const newestVersion = await conn.getRepository(S2MapHeader).createQueryBuilder('mhead')
            //     .andWhere('mhead.regionId = :regionId AND mhead.bnetId = :bnetId', {
            //         regionId: map.regionId,
            //         bnetId: map.bnetId,
            //     })
            //     .addOrderBy('mhead.majorVersion', 'DESC')
            //     .addOrderBy('mhead.minorVersion', 'DESC')
            //     .limit(1)
            //     .getOne()
            // ;
            // if (map.currentVersion.id === newestVersion.id) {
            //     logger.verbose(`skip ${map.regionId}/${map.bnetId}`);
            //     return;
            // }
            const newestVersion = map.currentVersion;
            await mIndexer.updateMapDataFromHeader(
                map,
                newestVersion,
            );
            await conn.getRepository(S2Map).save(map, { transaction: false });
            logger.verbose(`Completed ${map.id} from ${listMapIds[listMapIds.length - 1]}`);
        }, {
            concurrency: cmd.concurrency,
        });
        await conn.close();
    })
;
