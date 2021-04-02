import { Queue, QueueScheduler, Worker, Processor, ConnectionOptions, QueueBaseOptions, WorkerOptions } from 'bullmq';
import { GameRegion, AllGameRegions } from '../common';

export enum CmdKind {
    // MapInfo = 'mapi',
    MapReviews = 'mrev',
}

export type CmdKindType = (
    // 'mapi' |
    'mrev'
);

export enum CmdMrevUpdateStrategy {
    All = 'all',
    Newest = 'newest',
}

export interface CmdMrevRequest {
    mapId: number;
    updateStrategy: CmdMrevUpdateStrategy;
    newerThan: number;
}

// ===========================
// - CMD QUEUE - BASE
// ===========================

const redisQueueConnOpts = <ConnectionOptions>{
    host: 'localhost',
    port: 6381,
    db: 0,
};

// ===========================
// - CMD QUEUE - REQUEST
// ===========================

export interface CmdWorkerKindEntry<T = any> {
    queue: Queue<T>;
    // worker: Worker<T>;
    scheduler: QueueScheduler;
}

export interface CmdWorkerKindGroup {
    [CmdKind.MapReviews]: CmdWorkerKindEntry<CmdMrevRequest>;
}

export interface CmdWorkerRegionGroup {
    [GameRegion.US]: CmdWorkerKindGroup;
    [GameRegion.EU]: CmdWorkerKindGroup;
    [GameRegion.KR]: CmdWorkerKindGroup;
    [GameRegion.CN]: CmdWorkerKindGroup;
}

function getCmdQueueOpts(region: GameRegion): QueueBaseOptions {
    return {
        connection: redisQueueConnOpts,
    };
}

export function createCmdQueue<T = any>(queueName: CmdKindType, region: GameRegion) {
    return new Queue<T>(`s2_${GameRegion[region].toLowerCase()}_${queueName}`, {
        ...getCmdQueueOpts(region),
        defaultJobOptions: {
            attempts: 5,
            backoff: {
                type: 'exponential',
                delay: 10000,
            },
        },
        streams: {
            events: {
                maxLen: 5000,
            },
        },
    });
}

function createCmdScheduler(queueName: CmdKindType, region: GameRegion) {
    return new QueueScheduler(`s2_${GameRegion[region].toLowerCase()}_${queueName}`, {
        ...getCmdQueueOpts(region),
        maxStalledCount: 10,
    });
}

export function createCmdWorker<T = any>(queueName: CmdKindType, region: GameRegion, processor?: Processor<T>, opts?: WorkerOptions) {
    return new Worker<T>(`s2_${GameRegion[region].toLowerCase()}_${queueName}`, processor, {
        ...getCmdQueueOpts(region),
        ...opts ?? {},
    });
}

export function createCmdQueueMapReviews(region: GameRegion) {
    return createCmdQueue<CmdMrevRequest>(CmdKind.MapReviews, region);
}

export function createCmdWorkerMapReviews(region: GameRegion) {
    return createCmdWorker<CmdMrevRequest>(CmdKind.MapReviews, region);
}

export function createCmdWorkerKindGroup(region: GameRegion): CmdWorkerKindGroup {
    return {
        [CmdKind.MapReviews]: {
            queue: createCmdQueueMapReviews(region),
            // worker: createCmdWorkerMapReviews(region),
            scheduler: createCmdScheduler(CmdKind.MapReviews, region),
        },
    };
}

export function createCmdWorkerRegionGroup(): CmdWorkerRegionGroup {
    const regionGroup: CmdWorkerRegionGroup = {} as any;
    AllGameRegions.forEach(region => {
        regionGroup[region] = createCmdWorkerKindGroup(region);
    });
    return regionGroup;
}

// ===========================
// - CMD QUEUE - RESULT / DATA PERSISTENCE
// ===========================

// - BASE

export enum DataRecordKind {
    ProfileDiscover = 'pfds',
    MapReviews = 'mrev',
    // MapInfo = 'mapi',
}

export interface DataRecordBase {
    dkind: DataRecordKind;
    payload: any;
}

// - PROFILE

export interface ProfileDiscoverItem {
    regionId: number;
    realmId: number;
    profileId: number;
    profileGameId: number | null;
    characterHandle: string;
    battleHandle: string | null;
}

export interface ProfileDiscover {
    profiles: ProfileDiscoverItem[];
}

// - MAP REVIEWS

export interface MapReviewItem {
    authorLocalProfileId: number;
    timestamp: number;
    rating: number;
    helpfulCount: number;
    body: string;
}

export interface MapReviews {
    regionId: number;
    mapId: number;
    newerThan: number;
    updatedAt: number;
    reviews: MapReviewItem[];
}

// -

export interface DataRecordProfileDiscover extends DataRecordBase {
    dkind: DataRecordKind.ProfileDiscover;
    payload: ProfileDiscover;
}

export interface DataRecordMapReviews extends DataRecordBase {
    dkind: DataRecordKind.MapReviews;
    payload: MapReviews;
}

export type DataRecordType = (
    DataRecordProfileDiscover |
    DataRecordMapReviews
);

// -

function getDataRecordQueueOpts(): QueueBaseOptions {
    return {
        connection: redisQueueConnOpts,
    };
}

export function createDataRecordQueue() {
    return new Queue<DataRecordType>('drecord', {
        ...getDataRecordQueueOpts(),
        defaultJobOptions: {
            attempts: 5,
            backoff: {
                type: 'exponential',
                delay: 20000,
            },
        },
    });
}

export function createDataRecordScheduler() {
    return new QueueScheduler('drecord', {
        ...getDataRecordQueueOpts(),
        maxStalledCount: 60,
        stalledInterval: 60000,
    });
}

export function createDataRecordWorker(processor?: Processor<DataRecordType>, opts?: WorkerOptions) {
    return new Worker<DataRecordType>('drecord', processor, {
        ...getDataRecordQueueOpts(),
        ...opts ?? {},
    });
}

export function cmdKindToRecordKind(ckind: CmdKind): DataRecordKind {
    switch (ckind) {
        case CmdKind.MapReviews: return DataRecordKind.MapReviews;
    }
}
