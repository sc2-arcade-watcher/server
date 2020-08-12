import * as orm from 'typeorm';
import * as program from 'commander';
import { BattleDepot, convertImage, NestedHashDir } from '../depot';
import { buildStatsForPeriod } from '../task/statsBuilder';
import { S2StatsPeriodKind } from '../entity/S2StatsPeriod';
import { MapResolver, applyMapLocalization } from '../task/mapResolver';
import { S2Map } from '../entity/S2Map';

async function populateBnetDepot() {
    const bnDepot = new BattleDepot('data/depot');
    const pubBnetDir = new NestedHashDir('data/bnet');
    const filename = '18d81abcc4847b567bc73891213fa29d6f4c9478a142baaa805837350ec3ff2a';
    const s2mvPath = await bnDepot.getPathOrRetrieve('us', `${filename}.s2mv`);
    const jpgPath = pubBnetDir.pathTo(`${filename}.jpg`);
    await convertImage(s2mvPath, jpgPath, ['-format', 'jpg', '-quality', '85', '-strip']);
}


async function statsGenerate() {
    await populateBnetDepot();

    const conn = await orm.createConnection();
    await buildStatsForPeriod(conn, S2StatsPeriodKind.Daily);
    await buildStatsForPeriod(conn, S2StatsPeriodKind.Weekly);
    await buildStatsForPeriod(conn, S2StatsPeriodKind.Monthly);
    await conn.close();
}

program.command('depot-test')
    .action(populateBnetDepot)
;

program.command('stats')
    .action(statsGenerate)
;

program.command('map-header <region> <hash>')
    .action(async (region: string, hash: string) => {
        const conn = await orm.createConnection();
        const mpresolver = new MapResolver(conn);

        const mapHeader = await mpresolver.getMapHeader(region, hash);
        const mapLocalization = await mpresolver.getMapLocalization(region, mapHeader.localeTable[0].stringTable[0].hash);
        const mapLocalized = applyMapLocalization(mapHeader, mapLocalization);
        console.log(mapLocalized);

        await conn.close();
    })
;

program.command('map-repopulate')
    .action(async () => {
        const conn = await orm.createConnection();
        const mpresolver = new MapResolver(conn);
        const list = await conn.getRepository(S2Map).find({
            relations: ['currentVersion'],
            order: {
                regionId: 'ASC',
                bnetId: 'ASC',
            },
        });
        for (const map of list) {
            await mpresolver.initializeMapHeader(map.currentVersion);
        }
        await conn.close();
    })
;

process.on('unhandledRejection', e => { throw e; });
program.parse(process.argv);
