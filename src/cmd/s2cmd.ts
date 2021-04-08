import * as orm from 'typeorm';
import * as program from 'commander';
import { createCmdQueueMapReviews, CmdMrevUpdateStrategy } from '../server/runnerExchange';
import { MapDataUpdateRequester } from '../dataUpdateManager';

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
                mapId: mapId,
                updateStrategy: CmdMrevUpdateStrategy.All,
                newerThan: 0,
            });
            console.log(j.name);
        }

        await uRequester.close();
        await conn.close();
    })
;

