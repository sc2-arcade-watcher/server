import * as orm from 'typeorm';
import * as program from 'commander';
import { createCmdQueueMapReviews, CmdMrevUpdateStrategy } from '../server/runnerExchange';
import { MapDataUpdateRequester, MapDataUpdatePlanner } from '../dataUpdateManager';
import { GameRegion } from '../common';
import { logger } from '../logger';

const reRange = /^(\d+)-(\d+)$/;

function commaListOrRange(value: string): number[] {
    const m = value.match(reRange);
    if (m) {
        const start = Number(m[1]);
        const length = Number(m[2]) - start + 1;
        return Array.from({ length }, (_, i) => start + i);
    }
    else {
        return value.split(',').map(Number);
    }
}

program.command('s2cmd:mrev')
    .requiredOption<Number>('-r, --region <region-id>', '', Number)
    .option<Number[]>('--map <map-id>', '', (value, previous) => commaListOrRange(value), [])
    .option('--lifo', '', false)
    .action(async (cmd: program.Command) => {
        const conn = await orm.createConnection();
        const uRequester = new MapDataUpdateRequester(conn, cmd.region);

        for (const mapId of cmd.map) {
            const j = await uRequester.requestReviews({
                data: {
                    mapId: mapId,
                    updateStrategy: CmdMrevUpdateStrategy.All,
                    newerThan: 0,
                },
                opts: {
                    lifo: cmd.lifo,
                },
            });
            console.log(j.name);
        }

        await uRequester.close();
        await conn.close();
    })
;

program.command('s2cmd:periodic')
    .requiredOption<Number>('-r, --region <region-id>', '', Number)
    .option('-n, --dry-run')
    .action(async (cmd: program.Command) => {
        const conn = await orm.createConnection();
        const uPlanner = new MapDataUpdatePlanner(conn);

        logger.verbose(`Preparing map list..`);

        // await uPlanner.fetchMapsByRecentMatches(cmd.region);
        // return;

        const maps = await uPlanner.fetchActiveMaps(cmd.region, 24 * 14 * 1);
        const mreqs = await uPlanner.prepareMrevRequests(cmd.region, maps);
        if (cmd.dryRun) {
            logger.verbose('dry run', mreqs, mreqs.length);
        }
        else {
            logger.info(`Scheduling ${mreqs.length} mreqs`);
            await uPlanner.updateRequesters[cmd.region as GameRegion].requestBulkReviews(mreqs.map(data => {
                return {
                    data: data,
                };
            }));
        }

        await uPlanner.close();
        await conn.close();
    })
;
