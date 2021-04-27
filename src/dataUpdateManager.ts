import * as orm from 'typeorm';
import { GameRegion } from './common';
import { CmdMrevRequest, createCmdQueueMapReviews } from './server/runnerExchange';
import { JobsOptions } from 'bullmq';

export class MapDataUpdateRequester {
    protected mrevQueue = createCmdQueueMapReviews(this.region);

    constructor(
        protected conn: orm.Connection,
        protected region: GameRegion
    ) {
    }

    async requestReviews(params: CmdMrevRequest, jobOptions?: JobsOptions) {
        return this.mrevQueue.add(`mrev_${params.mapId}_${params.updateStrategy.toLowerCase()}`, params, jobOptions);
    }

    async close() {
        await this.mrevQueue.close();
    }
}

export class MapDataUpdatePlanner {
    constructor(
        protected conn: orm.Connection
    ) {
    }
}
