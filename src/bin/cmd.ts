import * as dotenv from 'dotenv';
import * as util from 'util';
import * as orm from 'typeorm';
import * as program from 'commander';
import { BattleDepot, convertImage, NestedHashDir } from '../depot';
import { buildStatsForPeriod } from '../task/statsBuilder';
import { S2StatsPeriodKind } from '../entity/S2StatsPeriod';

dotenv.config();

program.command('depot-test')
    .action(async () => {
        const bnDepot = new BattleDepot('data/depot');
        const pubBnetDir = new NestedHashDir('data/bnet');
        const filename = '18d81abcc4847b567bc73891213fa29d6f4c9478a142baaa805837350ec3ff2a';
        const s2mvPath = await bnDepot.getPathOrRetrieve('us', `${filename}.s2mv`);
        const jpgPath = pubBnetDir.pathTo(`${filename}.jpg`);
        await convertImage(s2mvPath, jpgPath, ['-format', 'jpg', '-quality', '85', '-strip']);
    })
;

program.command('stats')
    .action(async () => {
        const conn = await orm.createConnection();
        await buildStatsForPeriod(conn, S2StatsPeriodKind.Monthly);
        await buildStatsForPeriod(conn, S2StatsPeriodKind.Weekly);
        await buildStatsForPeriod(conn, S2StatsPeriodKind.Daily);
        await conn.close();
    })
;

import '../cmd/map';
import '../cmd/battle';

process.on('unhandledRejection', e => { throw e; });
program.parse(process.argv);
