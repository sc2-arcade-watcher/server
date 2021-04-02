import * as orm from 'typeorm';
import * as program from 'commander';
import { createCmdQueueMapReviews, CmdMrevUpdateStrategy } from '../server/runnerExchange';

program.command('s2cmd:mrev')
    .action(async (cmd: program.Command) => {
        const queue = createCmdQueueMapReviews(2);
        const wsize = await queue.getWaitingCount();
        console.log(wsize);
        for (let i = 25000; i < 50000; i++) {
            const j = await queue.add(`mrev_${i}_full`, {
                mapId: i,
                updateStrategy: CmdMrevUpdateStrategy.All,
                newerThan: 0,
            });
            // console.log(j);
        }
        await queue.close();
    })
;

