import * as orm from 'typeorm';
import { GameRegion, GameRegionObjectType, AllGameRegions } from './common';
import { CmdMrevRequest, createCmdQueueMapReviews, CmdMrevUpdateStrategy } from './server/runnerExchange';
import { JobsOptions } from 'bullmq';
import { S2GameLobby } from './entity/S2GameLobby';
import { S2Map } from './entity/S2Map';
import { S2MapTracking } from './entity/S2MapTracking';
import { subDays } from 'date-fns';

export interface CmdJobParams<T> {
    data: T;
    name?: string;
    opts?: Pick<JobsOptions, 'lifo'>;
}

export class MapDataUpdateRequester {
    protected mrevQueue = createCmdQueueMapReviews(this.region);

    constructor(
        protected conn: orm.Connection,
        public readonly region: GameRegion
    ) {
    }

    async requestReviews(jobParams: CmdJobParams<CmdMrevRequest>) {
        return (await this.requestBulkReviews(jobParams)).pop();
    }

    async requestBulkReviews(jobParams: CmdJobParams<CmdMrevRequest> | CmdJobParams<CmdMrevRequest>[]) {
        let myJobParams: CmdJobParams<CmdMrevRequest>[];

        if (!Array.isArray(jobParams)) {
            myJobParams = [jobParams];
        }
        else {
            myJobParams = jobParams;
        }

        myJobParams.forEach(x => {
            if (!x.name) {
                x.name = `${x.data.updateStrategy.toLowerCase()}_${x.data.newerThan}`;
            }
            x.name = `mrev_${x.data.mapId}_${x.name}`;
            x.opts = {};
        });

        // if (!Array.isArray(jobParams)) {
        //     return this.mrevQueue.add(myJobParams[0].name, myJobParams[0].data, myJobParams[0].opts);
        // }
        // else {
        //     return this.mrevQueue.addBulk(myJobParams as Required<CmdJobParams<CmdMrevRequest>>[]);
        // }
        return this.mrevQueue.addBulk(myJobParams as Required<CmdJobParams<CmdMrevRequest>>[]);
    }

    async close() {
        await this.mrevQueue.close();
    }
}

export class MapDataUpdatePlanner {
    public readonly updateRequesters: GameRegionObjectType<MapDataUpdateRequester>;

    constructor(
        protected conn: orm.Connection
    ) {
        this.updateRequesters = {} as any;
        for (const region of AllGameRegions) {
            this.updateRequesters[region] = new MapDataUpdateRequester(conn, region);
        }
    }

    async close() {
        for (const region of AllGameRegions) {
            await this.updateRequesters[region].close();
        }
    }

    public async fetchActiveMaps(region: GameRegion, hoursThreshold: number) {
        const qb = this.conn.getRepository(S2GameLobby).createQueryBuilder('lob')
            .distinct(true)
            .select([])
            .addSelect([
                'lob.mapBnetId',
                'lob.extModBnetId',
            ])
            .andWhere('lob.regionId = :region', { region: region })
            .andWhere('lob.closedAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL :hoursThreshold HOUR)', { hoursThreshold: hoursThreshold })
        ;
        return Array.from(new Set(
            (await qb.getMany()).map(x => x.extModBnetId !== null ? [x.mapBnetId, x.extModBnetId] : [x.mapBnetId]).flat(1)
        ));
    }

    public async prepareMrevRequests(region: GameRegion, maps: number[]) {
        const qb = this.conn.getRepository(S2MapTracking).createQueryBuilder('mTrack')
            .select([
                'mTrack.regionId',
                'mTrack.mapId',
                'mTrack.reviewsUpdatedEntirelyAt',
                'mTrack.reviewsUpdatedPartiallyAt',
            ])
            .andWhere('mTrack.regionId = :region AND mTrack.mapId IN (:maps)', { region: region, maps: maps })
        ;
        const mreqs: CmdMrevRequest[] = [];
        for (const item of await qb.getMany()) {
            if (item.reviewsUpdatedEntirelyAt === null) {
                mreqs.push({
                    mapId: item.mapId,
                    updateStrategy: CmdMrevUpdateStrategy.All,
                    newerThan: 0,
                });
            }
            else {
                let fromDate = subDays(Date.now(), 365);
                if (item.reviewsUpdatedPartiallyAt !== null && item.reviewsUpdatedPartiallyAt < fromDate) {
                    fromDate = subDays(item.reviewsUpdatedPartiallyAt, 1);
                }
                mreqs.push({
                    mapId: item.mapId,
                    updateStrategy: CmdMrevUpdateStrategy.Newest,
                    newerThan: Number((fromDate.getTime() / 1000).toFixed(0)),
                });
            }
        }
        return mreqs;
    }
}
