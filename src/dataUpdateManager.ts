import * as orm from 'typeorm';
import { GameRegion } from './common';
import { CmdMrevRequest, createCmdQueueMapReviews } from './server/runnerExchange';

export class MapDataUpdateRequester {
    protected mrevQueue = createCmdQueueMapReviews(this.region);

    constructor(
        protected conn: orm.Connection,
        protected region: GameRegion
    ) {
    }

    async requestReviews(params: CmdMrevRequest) {
        return this.mrevQueue.add(`mrev_${params.mapId}_${params.updateStrategy.toLowerCase()}`, params);
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
