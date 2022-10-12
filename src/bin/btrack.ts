import * as dotenv from 'dotenv';
import * as orm from 'typeorm';
import { setupFileLogger, logger } from '../logger';
import { systemdNotifyReady, setupProcessTerminator } from '../helpers';
import { BattleProfileUpdater, BattleProfileRefreshDirector } from '../bnet/updater';
import { BattleMatchTracker, BattleLobbyProvider } from '../bnet/battleTracker';
import { GameRegion } from '../common';
import { createBattleMatchQueue } from '../bnet/battleMatchRelay';

process.on('unhandledRejection', e => {
    if (logger) logger.error('unhandledRejection', e);
    throw e;
});
(async function () {
    dotenv.config();
    if (process.env.NOTIFY_SOCKET) {
        await systemdNotifyReady();
    }
    setupFileLogger('btrack');
    logger.verbose(`initializing btrack..`);

    let activeRegions: GameRegion[] = [
        GameRegion.US,
        GameRegion.EU,
        GameRegion.KR,
        GameRegion.CN,
    ];
    if (process.argv.length > 2) {
        activeRegions = process.argv[2].split(',').map(Number);
    }

    type BattleWorker = {
        region: GameRegion;
        bProfUpdateDirector: BattleProfileRefreshDirector;
    };

    const conn = await orm.createConnection();
    const bProfUpdater = new BattleProfileUpdater(conn);
    const bmTracker = new BattleMatchTracker(conn, {
        concurrency: 30,
    });
    const bmProvider = new BattleLobbyProvider(conn, bmTracker);
    const bWorkers: BattleWorker[] = [];
    const bmrQeueu = createBattleMatchQueue();

    for (const [idx, region] of activeRegions.entries()) {
        if (!GameRegion[region]) throw new Error(`invalid region=${region}`);
        bmTracker.bProfileUpdater = bProfUpdater;
        bWorkers.push({
            region: region,
            bProfUpdateDirector: new BattleProfileRefreshDirector(conn, bProfUpdater, region, {
                startStagger: activeRegions.length > 1 ? idx + 1 : 0,
                concurrency: 2,
            }),
        });
    }

    async function doWorker(idx: number, worker: BattleWorker) {
        await worker.bProfUpdateDirector.start();
    }

    async function doTracking() {
        bmTracker.onLobbyComplete(async (x) => {
            await bmrQeueu.add(x.lobby.globalId, x.match);
        });
        await Promise.all([
            bmTracker.work(),
            bmProvider.start(),
        ]);
    }

    setupProcessTerminator(() => {
        bmProvider.shutdown();
        bmTracker.close();
        bWorkers.forEach(x => x.bProfUpdateDirector.shutdown());
    });

    let cmds: string[] = [
        'refresh',
        'track',
    ];
    if (process.argv.length > 3) {
        cmds = process.argv[3].split(',');
    }
    if (cmds.findIndex(x => x === 'eval') !== -1) {
        for (const worker of bWorkers) {
            await worker.bProfUpdateDirector.evaluatePlans();
        }
    }
    if (cmds.findIndex(x => x === 'refresh') !== -1) {
        Array.from(bWorkers.entries()).forEach(x => doWorker(x[0], x[1]));
    }
    if (cmds.findIndex(x => x === 'track') !== -1) {
        await doTracking();
    }

    logger.verbose(`Waiting for workers..`);
    for (const worker of bWorkers) {
        await worker.bProfUpdateDirector.onDone();
    }
    logger.verbose(`Waiting for tracker..`);
    await bmProvider.onDone();
    await bmTracker.onDone();
    logger.verbose(`Flushing remaining data..`);
    await bProfUpdater.flush();
    logger.verbose(`Closing queue..`);
    await bmrQeueu.close();
    logger.verbose(`Closing database connection..`);
    await conn.close();
})();
