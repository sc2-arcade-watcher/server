import * as orm from 'typeorm';
import { Queue, QueueScheduler, Worker, Processor, ConnectionOptions, QueueBaseOptions, WorkerOptions } from 'bullmq';
import { logger } from '../logger';
import { S2LobbyMatch } from '../entity/S2LobbyMatch';

const redisQueueConnOpts = <ConnectionOptions>{
    host: 'localhost',
    port: 6381,
    db: 2,
};
const battleMatchRelayQueue = 'bmatch';

export type BattleMatchRelayItem = S2LobbyMatch;

function getBattleMatchQueueOpts(): QueueBaseOptions {
    return {
        connection: redisQueueConnOpts,
    };
}

export function createBattleMatchQueue() {
    return new Queue<BattleMatchRelayItem>(battleMatchRelayQueue, {
        ...getBattleMatchQueueOpts(),
        defaultJobOptions: {
            attempts: 4,
            backoff: {
                type: 'exponential',
                delay: 12000,
            },
        },
    });
}

export function createBattleMatchScheduler() {
    return new QueueScheduler(battleMatchRelayQueue, {
        ...getBattleMatchQueueOpts(),
        maxStalledCount: 10,
        stalledInterval: 60000,
    });
}

export function createBattleMatchWorker(processor?: Processor<BattleMatchRelayItem>, opts?: WorkerOptions) {
    return new Worker<BattleMatchRelayItem>(battleMatchRelayQueue, processor, {
        ...getBattleMatchQueueOpts(),
        ...opts ?? {},
    });
}
